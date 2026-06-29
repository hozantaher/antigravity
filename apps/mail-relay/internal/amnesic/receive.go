package amnesic

import (
	"relay/internal/delivery/contentenc"
	"relay/internal/ephemeral"
	"relay/internal/epochkeys"
	"relay/internal/transport/fragment"
	"relay/internal/transport/metamin"
	"relay/internal/shamir"
	"context"
	"crypto/ecdh"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// ReceiveConfig configures the one-shot receive operation.
type ReceiveConfig struct {
	RelayURL    string // Relay URL (or comma-separated for multi-path)
	InsecureTLS bool
	SocksProxy  string // SOCKS5 proxy for .onion (e.g. "127.0.0.1:9050")
	ShamirK     int
	ShamirN     int
}

// ReceivedMessage holds a decrypted message from a dead drop.
type ReceivedMessage struct {
	Plaintext []byte
	SlotID    string
}

// Receive polls dead drop(s), decrypts with epoch-rotated keys.
// Supports both direct polling and Shamir fragment reassembly.
func Receive(ctx context.Context, passphrase []byte, cfg ReceiveConfig) ([]ReceivedMessage, error) {
	defer ephemeral.WipeAll()

	// Pre-derive what we need before Derive wipes passphrase
	currentEpoch := epochkeys.CurrentEpoch()
	epochs := []int64{currentEpoch, currentEpoch - 1}

	// Derive epoch keys for each epoch
	type epochKey struct {
		epoch int64
		priv  []byte
	}
	var keys []epochKey
	for _, ep := range epochs {
		priv, _ := epochkeys.DeriveEpochKeyPair(append([]byte{}, passphrase...), ep)
		if priv != nil {
			keys = append(keys, epochKey{ep, priv})
		}
	}
	// Also legacy key
	legacyPriv, _ := DeriveX25519KeyPair(append([]byte{}, passphrase...))

	// Fragment secret (if Shamir enabled)
	var fragmentSecret []byte
	if cfg.ShamirK >= 2 {
		fragmentSecret = pbkdf2HMACSHA256(append([]byte{}, passphrase...), []byte("anti-trace-fragment-v1"), 1, 32)
	}

	// Now derive identity (wipes passphrase)
	identity := Derive(passphrase)
	defer identity.Zero()

	// Build HTTP client (with optional SOCKS5 for .onion)
	// P2 FIX: pass relayURL for .onion constraint enforcement in buildHTTPClient
	client := buildHTTPClient(cfg.SocksProxy, cfg.InsecureTLS, cfg.RelayURL)

	relays := strings.Split(cfg.RelayURL, ",")
	for i := range relays {
		relays[i] = strings.TrimSpace(relays[i])
	}

	var rawMessages [][]byte

	if cfg.ShamirK >= 2 && cfg.ShamirN >= cfg.ShamirK && fragmentSecret != nil {
		// Shamir mode: poll N fragment slots, reassemble from K
		rawMessages = receiveFragmented(ctx, client, relays, fragmentSecret, currentEpoch, cfg.ShamirK, cfg.ShamirN)
		ephemeral.WipeSlice(fragmentSecret)
	} else {
		// Direct mode: poll single slot
		slotHex := hex.EncodeToString(identity.SlotID[:])
		rawMessages = pollSlot(ctx, client, relays[0], slotHex)
	}

	if len(rawMessages) == 0 {
		// Cleanup keys
		for _, k := range keys {
			ephemeral.WipeSlice(k.priv)
		}
		ephemeral.WipeSlice(legacyPriv)
		return nil, nil
	}

	// Decrypt with epoch keys
	sealer := contentenc.NewSealer()
	minimizer := metamin.NewMinimizer()
	var messages []ReceivedMessage

	for _, raw := range rawMessages {
		var decrypted bool

		// Try epoch keys
		for _, k := range keys {
			plaintext, err := sealer.Open(raw, k.priv)
			if err != nil {
				continue
			}
			unpadded := minimizer.UnpadFromSizeClass(plaintext)
			ephemeral.WipeSlice(plaintext)
			if unpadded != nil {
				messages = append(messages, ReceivedMessage{Plaintext: unpadded})
				decrypted = true
				break
			}
		}

		// Try legacy key
		if !decrypted && legacyPriv != nil {
			plaintext, err := sealer.Open(raw, legacyPriv)
			if err == nil {
				unpadded := minimizer.UnpadFromSizeClass(plaintext)
				ephemeral.WipeSlice(plaintext)
				if unpadded != nil {
					messages = append(messages, ReceivedMessage{Plaintext: unpadded})
				}
			}
		}
	}

	// Cleanup keys
	for _, k := range keys {
		ephemeral.WipeSlice(k.priv)
	}
	ephemeral.WipeSlice(legacyPriv)

	return messages, nil
}

func receiveFragmented(ctx context.Context, client *http.Client, relays []string, fragmentSecret []byte, epoch int64, k, n int) [][]byte {
	fragmenter := fragment.NewFragmenter(k, n)
	slotIDs := fragmenter.DeriveFragmentSlotIDs(fragmentSecret, epoch)

	// Poll each fragment slot from its assigned relay
	var shares []shamir.Share
	for i, slotID := range slotIDs {
		relayURL := relays[i%len(relays)]
		slotHex := hex.EncodeToString(slotID[:])
		msgs := pollSlotRaw(ctx, client, relayURL, slotHex)

		for _, msg := range msgs {
			// Parse share data and x coordinate
			var shareData struct {
				Data string `json:"data"`
				X    string `json:"x"`
			}
			// Try JSON first (fragmented format)
			if err := json.Unmarshal([]byte(msg), &shareData); err == nil && shareData.Data != "" {
				data, _ := hex.DecodeString(shareData.Data)
				x := byte(i + 1)
				if len(shareData.X) > 0 {
					for _, c := range shareData.X {
						if c >= '0' && c <= '9' {
							x = byte(c - '0')
						}
					}
				}
				shares = append(shares, shamir.Share{X: x, Data: data})
			} else {
				// Plain hex (non-fragmented)
				data, _ := hex.DecodeString(msg)
				if data != nil {
					shares = append(shares, shamir.Share{X: byte(i + 1), Data: data})
				}
			}
		}
	}

	if len(shares) < k {
		return nil
	}

	// Reassemble
	secret, err := shamir.Combine(shares, k)
	if err != nil {
		return nil
	}

	return [][]byte{secret}
}

func pollSlot(ctx context.Context, client *http.Client, relayURL, slotHex string) [][]byte {
	raw := pollSlotRaw(ctx, client, relayURL, slotHex)
	var result [][]byte
	for _, msg := range raw {
		data, err := hex.DecodeString(msg)
		if err == nil {
			result = append(result, data)
		}
	}
	return result
}

func pollSlotRaw(ctx context.Context, client *http.Client, relayURL, slotHex string) []string {
	url := relayURL + "/v1/drop/" + slotHex
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	if resp.StatusCode >= 400 {
		return nil
	}

	var pollResp struct {
		Messages []string `json:"messages"`
	}
	json.Unmarshal(body, &pollResp)
	return pollResp.Messages
}

// DeriveX25519KeyPair derives a static X25519 key pair (LEGACY).
func DeriveX25519KeyPair(passphrase []byte) (privateKey, publicKey []byte) {
	salt := []byte("anti-trace-amnesic-v1")
	master := pbkdf2HMACSHA256(passphrase, salt, pbkdf2Iterations, 64)
	defer ephemeral.WipeSlice(master)

	seed := hkdfExpand(master, []byte("x25519-recipient"), 32)
	defer ephemeral.WipeSlice(seed)

	curve := ecdh.X25519()
	priv, err := curve.NewPrivateKey(seed)
	if err != nil {
		return nil, nil
	}

	privBytes := make([]byte, 32)
	copy(privBytes, priv.Bytes())
	pubBytes := make([]byte, 32)
	copy(pubBytes, priv.PublicKey().Bytes())
	return privBytes, pubBytes
}
