package main

import (
	"common/envconfig"
	"relay/internal/amnesic"
	"relay/internal/ephemeral"
	"relay/internal/epochkeys"
	"context"
	"encoding/hex"
	"fmt"
	"os"
	"time"
)

// Amnesic receive client.
// Derives the same dead drop slot from the shared passphrase,
// polls the relay, and decrypts any waiting messages.
//
// Usage:
//   echo "shared passphrase" | ./receive --relay https://xxxx.onion
//
// Or show the recipient public key (for sharing with sender):
//   echo "shared passphrase" | ./receive --show-key
//
// Build: go build -ldflags "-s -w" -o receive ./cmd/receive/
func main() {
	ephemeral.Guard(func() {
		ephemeral.WipeAll()
	})

	relayURL := envOrArg("RELAY_URL", "--relay", "")
	showKey := hasFlag("--show-key")
	insecureTLS := envconfig.BoolOr("INSECURE_TLS", false)

	// Read passphrase
	fmt.Fprint(os.Stderr, "Passphrase: ")
	passphrase := readPassphrase()
	if len(passphrase) == 0 {
		fmt.Fprintln(os.Stderr, "Error: empty passphrase")
		os.Exit(1)
	}

	// Mode: show recipient public key (epoch-based)
	if showKey {
		_, pubKey := epochkeys.DeriveEpochKeyPair(append([]byte{}, passphrase...), epochkeys.CurrentEpoch())
		ephemeral.WipeSlice(passphrase)
		fmt.Fprintf(os.Stderr, "\nRecipient public key (share with sender):\n")
		fmt.Println(hex.EncodeToString(pubKey))
		ephemeral.WipeAll()
		return
	}

	// Mode: receive messages
	if relayURL == "" {
		fmt.Fprintln(os.Stderr, "Error: --relay or RELAY_URL required")
		ephemeral.WipeSlice(passphrase)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	socksProxy := envconfig.GetOr("SOCKS_PROXY", "")
	shamirK := envIntOr("SHAMIR_K", 0)
	shamirN := envIntOr("SHAMIR_N", 0)
	messages, err := amnesic.Receive(ctx, passphrase, amnesic.ReceiveConfig{
		RelayURL:    relayURL,
		InsecureTLS: insecureTLS,
		SocksProxy:  socksProxy,
		ShamirK:     shamirK,
		ShamirN:     shamirN,
	})

	ephemeral.WipeAll()

	if err != nil {
		fmt.Fprintf(os.Stderr, "Receive failed: %v\n", err)
		os.Exit(1)
	}

	if len(messages) == 0 {
		fmt.Fprintln(os.Stderr, "No messages.")
		return
	}

	fmt.Fprintf(os.Stderr, "%d message(s) received:\n\n", len(messages))
	for i, msg := range messages {
		if len(messages) > 1 {
			fmt.Fprintf(os.Stderr, "--- Message %d ---\n", i+1)
		}
		os.Stdout.Write(msg.Plaintext)
		fmt.Println()
	}
}

func readPassphrase() []byte {
	buf := make([]byte, 1024)
	n, _ := os.Stdin.Read(buf)
	fmt.Fprintln(os.Stderr)

	passphrase := buf[:n]
	for len(passphrase) > 0 && (passphrase[len(passphrase)-1] == '\n' || passphrase[len(passphrase)-1] == '\r') {
		passphrase = passphrase[:len(passphrase)-1]
	}

	result := make([]byte, len(passphrase))
	copy(result, passphrase)
	ephemeral.WipeSlice(buf)
	return result
}

func envOrArg(envKey, flag, fallback string) string {
	if v := envconfig.GetOr(envKey, ""); v != "" {
		return v
	}
	args := os.Args[1:]
	for i, arg := range args {
		if arg == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return fallback
}

func hasFlag(flag string) bool {
	for _, arg := range os.Args[1:] {
		if arg == flag {
			return true
		}
	}
	return false
}

func envIntOr(key string, fallback int) int {
	// envconfig-allowed: int parse; envconfig.GetOr is string-only
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n := 0
	for _, c := range v {
		if c < '0' || c > '9' {
			return fallback
		}
		n = n*10 + int(c-'0')
	}
	return n
}
