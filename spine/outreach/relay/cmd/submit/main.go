package main

import (
	"common/envconfig"
	"relay/internal/amnesic"
	"relay/internal/intake/duress"
	"relay/internal/ephemeral"
	"context"
	"fmt"
	"os"
	"time"
)

// Amnesic submission client.
// Derives everything from a memorizable passphrase. No persistent state.
//
// Usage:
//   echo "my secret passphrase" | ./submit \
//     --relay https://relay.example.com \
//     --recipient-key <hex-encoded-x25519-public-key> \
//     --message "I need help"
//
// Or pipe the message:
//   echo "my passphrase" | ./submit --relay ... --recipient-key ... < message.txt
//
// The binary reads the passphrase from stdin with echo disabled,
// then reads the message from args or a second stdin read.
//
// Build: go build -ldflags "-s -w" -o submit ./cmd/submit/
func main() {
	// Install emergency cleanup
	ephemeral.Guard(func() {
		ephemeral.WipeAll()
	})

	// Parse args
	relayURL := envOrArg("RELAY_URL", "--relay", "")
	recipientKeyHex := envOrArg("RECIPIENT_KEY", "--recipient-key", "")
	message := envOrArg("MESSAGE", "--message", "")

	if relayURL == "" {
		fmt.Fprintln(os.Stderr, "Error: --relay or RELAY_URL required")
		os.Exit(1)
	}
	if message == "" {
		fmt.Fprintln(os.Stderr, "Error: --message or MESSAGE required")
		os.Exit(1)
	}

	// Read passphrase from stdin (echo disabled where possible)
	fmt.Fprint(os.Stderr, "Passphrase: ")
	passphrase := readPassphrase()
	if len(passphrase) == 0 {
		fmt.Fprintln(os.Stderr, "Error: empty passphrase")
		os.Exit(1)
	}

	// Decode recipient key (optional -- if empty, derived from passphrase+epoch)
	var recipientKey []byte
	if recipientKeyHex != "" {
		recipientKey = decodeHex(recipientKeyHex)
		if len(recipientKey) != 32 {
			fmt.Fprintln(os.Stderr, "Error: recipient key must be 32 bytes (64 hex chars)")
			ephemeral.WipeSlice(passphrase)
			os.Exit(1)
		}
	}

	// Optional duress check
	if envconfig.BoolOr("DURESS_CHECK", false) {
		identity := amnesic.Derive(append([]byte{}, passphrase...)) // copy for check
		detector := duress.NewDetector(relayURL, func() {
			fmt.Fprintln(os.Stderr, "Authentication failed. Please try again.")
		})
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		if !detector.Check(ctx, identity) {
			cancel()
			os.Exit(1) // duress or wrong passphrase -- state already wiped
		}
		cancel()
		identity.Zero()
	}

	// Submit
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	insecureTLS := envconfig.BoolOr("INSECURE_TLS", false)
	socksProxy := envconfig.GetOr("SOCKS_PROXY", "")
	shamirK := envIntOr("SHAMIR_K", 0)
	shamirN := envIntOr("SHAMIR_N", 0)
	// P2 FIX: TLSVerify replaces InsecureTLS bool; only allowed for .onion hosts
	tlsVerify := amnesic.TLSVerifyDefault
	if insecureTLS {
		tlsVerify = amnesic.TLSVerifySkipForOnion
	}
	err := amnesic.Submit(ctx, passphrase, []byte(message), amnesic.SubmitConfig{
		RelayURL:     relayURL,
		RecipientKey: recipientKey,
		TLSVerify:    tlsVerify,
		SocksProxy:   socksProxy,
		ShamirK:      shamirK,
		ShamirN:      shamirN,
	})

	// Zero everything
	ephemeral.WipeAll()

	if err != nil {
		fmt.Fprintf(os.Stderr, "Submission failed: %v\n", err)
		os.Exit(1)
	}

	fmt.Fprintln(os.Stderr, "Submitted successfully.")
}

func readPassphrase() []byte {
	// Disable echo on terminal
	oldState, err := disableEcho()
	if err == nil {
		defer restoreEcho(oldState)
	}

	buf := make([]byte, 1024)
	n, _ := os.Stdin.Read(buf)
	fmt.Fprintln(os.Stderr) // newline after hidden input

	// Trim trailing newline
	passphrase := buf[:n]
	for len(passphrase) > 0 && (passphrase[len(passphrase)-1] == '\n' || passphrase[len(passphrase)-1] == '\r') {
		passphrase = passphrase[:len(passphrase)-1]
	}

	result := make([]byte, len(passphrase))
	copy(result, passphrase)
	ephemeral.WipeSlice(buf)
	return result
}

// disableEcho and restoreEcho are in terminal_unix.go / terminal_windows.go

func decodeHex(s string) []byte {
	if len(s)%2 != 0 {
		return nil
	}
	result := make([]byte, len(s)/2)
	for i := 0; i < len(s); i += 2 {
		hi := hexDigit(s[i])
		lo := hexDigit(s[i+1])
		if hi < 0 || lo < 0 {
			return nil
		}
		result[i/2] = byte(hi<<4 | lo)
	}
	return result
}

func hexDigit(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c - 'a' + 10)
	case c >= 'A' && c <= 'F':
		return int(c - 'A' + 10)
	default:
		return -1
	}
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
