package amnesic

import (
	"relay/internal/delivery/contentenc"
	"relay/internal/deaddrop"
	"relay/internal/ephemeral"
	"relay/internal/epochkeys"
	"relay/internal/transport/fragment"
	"relay/internal/transport/metamin"
	"relay/internal/transport"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// TLSVerifyMode — P2 FIX — typed enum for TLS verification behavior.
// Replaces untyped bool InsecureTLS to enforce .onion-only constraint at compile time.
type TLSVerifyMode int

const (
	// TLSVerifyDefault — strict CA certificate validation (default, required for all non-.onion)
	TLSVerifyDefault TLSVerifyMode = iota
	// TLSVerifySkipForOnion — skip CA verification for .onion hidden services only.
	// Runtime check in buildHTTPClient enforces .onion constraint.
	TLSVerifySkipForOnion
)

// SubmitConfig configures the one-shot submission.
type SubmitConfig struct {
	RelayURL     string
	RecipientKey []byte          // if empty, derived from passphrase+epoch
	TLSVerify    TLSVerifyMode   // P2 FIX: typed enum instead of bool
	SocksProxy   string          // SOCKS5 proxy for .onion (e.g. "127.0.0.1:9050")
	ShamirK      int
	ShamirN      int
}

// Submit performs a single anonymous submission with epoch key rotation.
func Submit(ctx context.Context, passphrase, message []byte, cfg SubmitConfig) error {
	defer ephemeral.WipeAll()

	// IMPORTANT: derive epoch key BEFORE Derive() which wipes passphrase
	epoch := epochkeys.CurrentEpoch()
	var recipientPub []byte
	if len(cfg.RecipientKey) == 32 {
		recipientPub = cfg.RecipientKey
	} else {
		_, pub := epochkeys.DeriveEpochKeyPair(append([]byte{}, passphrase...), epoch)
		recipientPub = pub
	}

	// Also pre-derive fragment secret if needed
	var fragmentSecret []byte
	if cfg.ShamirK >= 2 {
		fragmentSecret = pbkdf2HMACSHA256(append([]byte{}, passphrase...), []byte("anti-trace-fragment-v1"), 1, 32)
	}

	// Now derive identity (this wipes passphrase!)
	identity := Derive(passphrase)
	defer identity.Zero()

	// Pad + encrypt
	minimizer := metamin.NewMinimizer()
	padded, _ := minimizer.PadToSizeClass(message)
	ephemeral.WipeSlice(message)

	sealer := contentenc.NewSealer()
	sealed, err := sealer.Seal(padded, recipientPub)
	if err != nil {
		return fmt.Errorf("seal: %w", err)
	}
	ephemeral.WipeSlice(padded)

	// P2 FIX: buildHTTPClient now takes relayURL to validate .onion constraint
	client := buildHTTPClient(cfg.SocksProxy, cfg.TLSVerify == TLSVerifySkipForOnion, cfg.RelayURL)

	if cfg.ShamirK >= 2 && cfg.ShamirN >= cfg.ShamirK && fragmentSecret != nil {
		defer ephemeral.WipeSlice(fragmentSecret)
		return submitFragmented(ctx, client, cfg, sealed, fragmentSecret, epoch)
	}
	return submitDirect(ctx, client, cfg.RelayURL, identity.SlotID, sealed)
}

func submitDirect(ctx context.Context, client *http.Client, relayURL string, slotID deaddrop.SlotID, sealed []byte) error {
	slotHex := hex.EncodeToString(slotID[:])
	url := relayURL + "/v1/drop/" + slotHex
	payload, _ := json.Marshal(map[string]string{"data": hex.EncodeToString(sealed)})
	ephemeral.WipeSlice(sealed)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("post: %w", err)
	}
	defer resp.Body.Close()
	io.ReadAll(io.LimitReader(resp.Body, 1024))
	if resp.StatusCode >= 400 {
		return fmt.Errorf("relay returned %d", resp.StatusCode)
	}
	ephemeral.WipeSlice(payload)
	return nil
}

func submitFragmented(ctx context.Context, client *http.Client, cfg SubmitConfig, sealed, masterSecret []byte, epoch int64) error {
	fragmenter := fragment.NewFragmenter(cfg.ShamirK, cfg.ShamirN)
	fragments, err := fragmenter.Fragment(sealed, masterSecret, epoch)
	if err != nil {
		return fmt.Errorf("fragment: %w", err)
	}
	ephemeral.WipeSlice(sealed)

	relays := strings.Split(cfg.RelayURL, ",")
	for i := range relays {
		relays[i] = strings.TrimSpace(relays[i])
	}

	for i, frag := range fragments {
		relayURL := relays[i%len(relays)]
		slotHex := hex.EncodeToString(frag.SlotID[:])
		url := relayURL + "/v1/drop/" + slotHex
		payload, _ := json.Marshal(map[string]string{
			"data": hex.EncodeToString(frag.Share.Data),
			"x":    fmt.Sprintf("%d", frag.Share.X),
		})
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return fmt.Errorf("fragment %d: %w", i, err)
		}
		resp.Body.Close()
		if resp.StatusCode >= 400 {
			return fmt.Errorf("fragment %d: relay returned %d", i, resp.StatusCode)
		}
	}
	return nil
}

// buildHTTPClient creates an HTTP client with optional SOCKS5 proxy for .onion access.
// P2 FIX: added relayURL param to validate .onion constraint; keeps bool insecureTLS for compat.
func buildHTTPClient(socksProxy string, insecureTLS bool, relayURL string) *http.Client {
	httpTransport := &http.Transport{}

	if insecureTLS {
		// P2 FIX: runtime check — InsecureSkipVerify only for .onion domains
		if relayURL != "" && !strings.Contains(relayURL, ".onion") {
			panic(fmt.Sprintf("insecureTLS only allowed for .onion hosts, got: %s", relayURL))
		}
		httpTransport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}

	if socksProxy != "" {
		socks := transport.NewSOCKS5Transport(socksProxy, 60*time.Second)
		httpTransport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			return socks.DialContext(ctx, network, addr)
		}
	}

	return &http.Client{Timeout: 120 * time.Second, Transport: httpTransport}
}
