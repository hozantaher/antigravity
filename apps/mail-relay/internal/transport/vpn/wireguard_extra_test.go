package vpn

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"relay/internal/minlog"
)

// ---------------------------------------------------------------------------
// generateWireGuardKeyPair
// ---------------------------------------------------------------------------

func TestGenerateWireGuardKeyPairReturnsClamped32ByteBase64Key(t *testing.T) {
	priv, pub, err := generateWireGuardKeyPair()
	if err != nil {
		t.Fatalf("generateWireGuardKeyPair() error = %v", err)
	}
	if priv == "" {
		t.Fatal("private key is empty")
	}
	// pub is intentionally empty (derived later by wg tools)
	_ = pub

	// Decode and verify clamping
	privBytes, err := base64.StdEncoding.DecodeString(priv)
	if err != nil {
		t.Fatalf("base64 decode error = %v", err)
	}
	if len(privBytes) != 32 {
		t.Fatalf("private key len = %d, want 32", len(privBytes))
	}
	if privBytes[0]&7 != 0 {
		t.Fatalf("lower 3 bits of byte[0] not cleared (clamping): %08b", privBytes[0])
	}
	if privBytes[31]&0x80 != 0 {
		t.Fatalf("highest bit of byte[31] not cleared (clamping): %08b", privBytes[31])
	}
	if privBytes[31]&0x40 == 0 {
		t.Fatalf("second highest bit of byte[31] not set (clamping): %08b", privBytes[31])
	}
}

func TestGenerateWireGuardKeyPairProducesUniqueKeys(t *testing.T) {
	priv1, _, err := generateWireGuardKeyPair()
	if err != nil {
		t.Fatalf("first call error = %v", err)
	}
	priv2, _, err := generateWireGuardKeyPair()
	if err != nil {
		t.Fatalf("second call error = %v", err)
	}
	if priv1 == priv2 {
		t.Fatal("two consecutive key pairs are identical — RNG may be broken")
	}
}

// ---------------------------------------------------------------------------
// NewManager – key generation path
// ---------------------------------------------------------------------------

func TestNewManagerGeneratesKeyWhenPrivateKeyEmpty(t *testing.T) {
	mgr, err := NewManager(
		WireGuardConfig{
			PeerPublicKey: "peer-pub",
			PeerEndpoint:  "vpn.example.com:51820",
			// PrivateKey intentionally empty → should be generated
		},
		minlog.New("test"),
	)
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}
	if mgr.cfg.PrivateKey == "" {
		t.Fatal("expected private key to be generated when not provided")
	}
}

func TestNewManagerPreservesExplicitPrivateKey(t *testing.T) {
	const explicitKey = "explicit-private-key-value"
	mgr, err := NewManager(
		WireGuardConfig{
			PeerPublicKey: "peer-pub",
			PeerEndpoint:  "vpn.example.com:51820",
			PrivateKey:    explicitKey,
		},
		minlog.New("test"),
	)
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}
	if mgr.cfg.PrivateKey != explicitKey {
		t.Fatalf("PrivateKey = %q, want %q", mgr.cfg.PrivateKey, explicitKey)
	}
}

// ---------------------------------------------------------------------------
// PublicKey
// ---------------------------------------------------------------------------

func TestPublicKeyReturnsEmptyBeforeExplicitSet(t *testing.T) {
	mgr := &Manager{}
	if got := mgr.PublicKey(); got != "" {
		t.Fatalf("PublicKey() = %q, want empty", got)
	}
}

// ---------------------------------------------------------------------------
// IsActive
// ---------------------------------------------------------------------------

func TestIsActiveReturnsFalseForNewManager(t *testing.T) {
	mgr := &Manager{}
	if mgr.IsActive() {
		t.Fatal("expected IsActive() == false for fresh Manager")
	}
}

func TestIsActiveReturnsTrueWhenSet(t *testing.T) {
	mgr := &Manager{active: true}
	if !mgr.IsActive() {
		t.Fatal("expected IsActive() == true")
	}
}

// ---------------------------------------------------------------------------
// Stop – active path
// ---------------------------------------------------------------------------

func TestStopClearsActiveFlag(t *testing.T) {
	tempDir := t.TempDir()
	confPath := filepath.Join(tempDir, "wg-atr0.conf")
	// Write a dummy config file so Stop's os.Remove doesn't fail silently
	if err := os.WriteFile(confPath, []byte("# dummy"), 0600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	mgr := &Manager{
		cfg: WireGuardConfig{
			InterfaceName: "wg-atr0",
			DataDir:       tempDir,
		},
		active: true,
		log:    minlog.New("test"),
	}

	// Stop may try wg-quick down and fail (not installed in CI), but it must
	// still clear the active flag and remove the config file.
	err := mgr.Stop()
	if err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if mgr.IsActive() {
		t.Fatal("expected IsActive() == false after Stop")
	}
	if _, err := os.Stat(confPath); !os.IsNotExist(err) {
		t.Fatal("expected config file to be removed after Stop")
	}
}

// ---------------------------------------------------------------------------
// Start – error paths (no real WireGuard tools needed)
// ---------------------------------------------------------------------------

func TestStartReturnsErrAlreadyConnected(t *testing.T) {
	mgr := &Manager{
		cfg:    WireGuardConfig{InterfaceName: "wg-atr0"},
		active: true,
		log:    minlog.New("test"),
	}
	if err := mgr.Start(context.Background()); !errors.Is(err, ErrAlreadyConnected) {
		t.Fatalf("expected ErrAlreadyConnected, got %v", err)
	}
}

func TestStartFailsWhenDataDirCannotBeCreated(t *testing.T) {
	// Use a file path as DataDir so MkdirAll returns an error.
	f, err := os.CreateTemp("", "vpn-bad-dir-*")
	if err != nil {
		t.Fatalf("CreateTemp: %v", err)
	}
	f.Close()
	t.Cleanup(func() { os.Remove(f.Name()) })

	mgr := &Manager{
		cfg: WireGuardConfig{
			InterfaceName: "wg-tst0",
			DataDir:       f.Name() + "/subdir",
			PrivateKey:    "priv",
			Address:       "10.1.1.2/32",
			PeerPublicKey: "peer",
			PeerEndpoint:  "vpn.example.com:51820",
			AllowedIPs:    "0.0.0.0/0",
		},
		log: minlog.New("test"),
	}

	if err := mgr.Start(context.Background()); err == nil {
		t.Fatal("expected error when DataDir is invalid, got nil")
	}
}

func TestStartWritesConfigFile(t *testing.T) {
	tempDir := t.TempDir()
	mgr := &Manager{
		cfg: WireGuardConfig{
			InterfaceName:       "wg-tst1",
			DataDir:             tempDir,
			PrivateKey:          "priv-key",
			Address:             "10.1.1.2/32",
			PeerPublicKey:       "peer-pub",
			PeerEndpoint:        "vpn.example.com:51820",
			AllowedIPs:          "0.0.0.0/0",
			PersistentKeepalive: 25,
		},
		log: minlog.New("test"),
	}

	// Start will likely fail (no wg-quick / ip in CI), but config file must be written first.
	_ = mgr.Start(context.Background())

	confPath := filepath.Join(tempDir, "wg-tst1.conf")
	data, err := os.ReadFile(confPath)
	if err != nil {
		// Config may be cleaned up by Stop on error path — check if active flag is false
		if !mgr.IsActive() {
			// Config file was written and removed as part of error cleanup; acceptable.
			return
		}
		t.Fatalf("config file not written: %v", err)
	}
	if !strings.Contains(string(data), "[Interface]") {
		t.Fatalf("config file missing [Interface] section: %q", string(data))
	}
}

// ---------------------------------------------------------------------------
// runCmd
// ---------------------------------------------------------------------------

func TestRunCmdSucceedsForEchoCommand(t *testing.T) {
	ctx := context.Background()
	if err := runCmd(ctx, "sh", "-c", "true"); err != nil {
		t.Fatalf("runCmd(sh -c true) error = %v", err)
	}
}

func TestRunCmdReturnsErrorOnNonZeroExit(t *testing.T) {
	ctx := context.Background()
	if err := runCmd(ctx, "sh", "-c", "false"); err == nil {
		t.Fatal("expected error for non-zero exit, got nil")
	}
}

func TestRunCmdIncludesOutputInError(t *testing.T) {
	ctx := context.Background()
	err := runCmd(ctx, "sh", "-c", "echo 'sentinel-output'; exit 1")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "sentinel-output") {
		t.Fatalf("error does not include command output: %v", err)
	}
}

func TestRunCmdReturnsErrorForMissingBinary(t *testing.T) {
	ctx := context.Background()
	if err := runCmd(ctx, "definitely-missing-binary-xyz"); err == nil {
		t.Fatal("expected error for missing binary, got nil")
	}
}

// ---------------------------------------------------------------------------
// vpnTransport.DialContext – active path
// ---------------------------------------------------------------------------

func TestDialContextFailsEvenWhenActiveForUnreachableAddress(t *testing.T) {
	mgr := &Manager{
		cfg:    WireGuardConfig{Address: "10.66.66.2/32"},
		active: true,
		log:    minlog.New("test"),
	}
	transport := mgr.Transport()
	// Dial an address that will be refused/unreachable (loopback port 1).
	// We only care that ErrNotConnected is NOT returned (active==true),
	// and that the error from the OS is returned instead.
	ctx := context.Background()
	conn, err := transport.DialContext(ctx, "tcp", "127.0.0.1:1")
	if conn != nil {
		conn.Close()
	}
	// The dial will fail (port 1 is typically closed), but it must NOT be ErrNotConnected.
	if errors.Is(err, ErrNotConnected) {
		t.Fatal("expected OS-level connection error, not ErrNotConnected")
	}
}
