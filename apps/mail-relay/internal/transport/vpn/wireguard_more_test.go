package vpn

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"relay/internal/minlog"
)

// ---------------------------------------------------------------------------
// Helpers to stub external binaries (wg-quick, ip, wg) via PATH shimming.
// ---------------------------------------------------------------------------

// writeShim writes an executable script at <dir>/<name> that either exits
// with exitCode 0 or writes to stdout and exits non-zero.
// On non-Unix systems we skip -- the package itself targets Linux/macOS tooling.
func writeShim(t *testing.T, dir, name string, script string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell shim unsupported on windows")
	}
	path := filepath.Join(dir, name)
	// Always prefix a shebang so exec treats the file as a script.
	body := "#!/bin/sh\n" + script + "\n"
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatalf("writeShim: %v", err)
	}
	return path
}

// isolatePath replaces PATH with just `dir` so that only the shims we created
// are visible to exec.LookPath. This lets us test both the wg-quick branch
// and the manual-setup fallback deterministically.
func isolatePath(t *testing.T, dir string) {
	t.Helper()
	t.Setenv("PATH", dir)
}

// ---------------------------------------------------------------------------
// Start – wg-quick success path
// ---------------------------------------------------------------------------

func TestStartSucceedsWhenWgQuickSucceeds(t *testing.T) {
	shimDir := t.TempDir()
	writeShim(t, shimDir, "wg-quick", `exit 0`)
	isolatePath(t, shimDir)

	mgr := &Manager{
		cfg: WireGuardConfig{
			InterfaceName:       "wg-tst-ok",
			DataDir:             t.TempDir(),
			PrivateKey:          "priv",
			Address:             "10.1.1.2/32",
			PeerPublicKey:       "peer",
			PeerEndpoint:        "vpn.example.com:51820",
			AllowedIPs:          "0.0.0.0/0",
			PersistentKeepalive: 25,
		},
		log: minlog.New("test"),
	}

	if err := mgr.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if !mgr.IsActive() {
		t.Fatal("expected IsActive() == true after successful Start")
	}

	// Cleanup: Stop should also exercise the wg-quick-present branch.
	if err := mgr.Stop(); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if mgr.IsActive() {
		t.Fatal("expected IsActive() == false after Stop")
	}
}

// ---------------------------------------------------------------------------
// Start – wg-quick failure path (exits non-zero with output)
// ---------------------------------------------------------------------------

func TestStartReturnsErrorWhenWgQuickFails(t *testing.T) {
	shimDir := t.TempDir()
	writeShim(t, shimDir, "wg-quick", `echo "wg-quick-stderr-output"; exit 1`)
	isolatePath(t, shimDir)

	mgr := &Manager{
		cfg: WireGuardConfig{
			InterfaceName: "wg-tst-fail",
			DataDir:       t.TempDir(),
			PrivateKey:    "priv",
			Address:       "10.1.1.2/32",
			PeerPublicKey: "peer",
			PeerEndpoint:  "vpn.example.com:51820",
			AllowedIPs:    "0.0.0.0/0",
		},
		log: minlog.New("test"),
	}

	err := mgr.Start(context.Background())
	if err == nil {
		t.Fatal("expected error when wg-quick fails")
	}
	if !strings.Contains(err.Error(), "wg-quick up failed") {
		t.Fatalf("error missing prefix: %v", err)
	}
	if !strings.Contains(err.Error(), "wg-quick-stderr-output") {
		t.Fatalf("error missing shim output: %v", err)
	}
	if mgr.IsActive() {
		t.Fatal("expected IsActive() == false after failed Start")
	}
}

// ---------------------------------------------------------------------------
// Start – manualSetup fallback when wg-quick is absent
// ---------------------------------------------------------------------------

func TestStartFallsBackToManualSetupWhenWgQuickMissing(t *testing.T) {
	shimDir := t.TempDir()
	// NO wg-quick shim -- exec.LookPath("wg-quick") must fail.
	// Provide ip + wg shims so manualSetup can exercise its success path.
	writeShim(t, shimDir, "ip", `exit 0`)
	writeShim(t, shimDir, "wg", `exit 0`)
	isolatePath(t, shimDir)

	mgr := &Manager{
		cfg: WireGuardConfig{
			InterfaceName:       "wg-manual-ok",
			DataDir:             t.TempDir(),
			PrivateKey:          "priv-k",
			Address:             "10.1.1.2/32",
			PeerPublicKey:       "peer-pub",
			PeerEndpoint:        "vpn.example.com:51820",
			AllowedIPs:          "0.0.0.0/0",
			PersistentKeepalive: 25,
		},
		log: minlog.New("test"),
	}

	if err := mgr.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if !mgr.IsActive() {
		t.Fatal("expected active after manual setup")
	}
}

// ---------------------------------------------------------------------------
// manualSetup – error paths (each of the four runCmd calls can fail)
// ---------------------------------------------------------------------------

func TestManualSetupReturnsErrorWhenIpLinkAddFails(t *testing.T) {
	shimDir := t.TempDir()
	// ip fails on every call -- first call ("ip link add") returns error.
	writeShim(t, shimDir, "ip", `echo "ip-failed"; exit 1`)
	writeShim(t, shimDir, "wg", `exit 0`)
	isolatePath(t, shimDir)

	mgr := &Manager{
		cfg: WireGuardConfig{
			InterfaceName: "wg-manual-err",
			DataDir:       t.TempDir(),
			PrivateKey:    "priv-k",
			Address:       "10.1.1.2/32",
			PeerPublicKey: "peer-pub",
			PeerEndpoint:  "vpn.example.com:51820",
			AllowedIPs:    "0.0.0.0/0",
		},
		log: minlog.New("test"),
	}

	err := mgr.manualSetup(context.Background())
	if err == nil {
		t.Fatal("expected error when ip link add fails")
	}
	if !strings.Contains(err.Error(), "create interface") {
		t.Fatalf("expected 'create interface' in error, got %v", err)
	}
}

func TestManualSetupReturnsErrorWhenWgSetFails(t *testing.T) {
	shimDir := t.TempDir()
	// `ip` succeeds; `wg` fails. This exercises the second error branch.
	writeShim(t, shimDir, "ip", `exit 0`)
	writeShim(t, shimDir, "wg", `echo "wg-set-failed"; exit 1`)
	isolatePath(t, shimDir)

	mgr := &Manager{
		cfg: WireGuardConfig{
			InterfaceName: "wg-manual-wgfail",
			DataDir:       t.TempDir(),
			PrivateKey:    "priv-k",
			Address:       "10.1.1.2/32",
			PeerPublicKey: "peer-pub",
			PeerEndpoint:  "vpn.example.com:51820",
			AllowedIPs:    "0.0.0.0/0",
		},
		log: minlog.New("test"),
	}

	err := mgr.manualSetup(context.Background())
	if err == nil {
		t.Fatal("expected error when wg set fails")
	}
	if !strings.Contains(err.Error(), "configure wireguard") {
		t.Fatalf("expected 'configure wireguard' in error, got %v", err)
	}
}

func TestManualSetupReturnsErrorWhenAddressAddFails(t *testing.T) {
	shimDir := t.TempDir()
	// Make the 3rd argv determine whether `ip` fails: succeed on "link"/"set"
	// (first and fourth calls), fail on "address" (third call).
	// Easiest: counter-based shim.
	writeShim(t, shimDir, "ip", `
case "$1" in
  address)
    echo "address-failed"; exit 1;;
esac
exit 0
`)
	writeShim(t, shimDir, "wg", `exit 0`)
	isolatePath(t, shimDir)

	mgr := &Manager{
		cfg: WireGuardConfig{
			InterfaceName: "wg-manual-addrfail",
			DataDir:       t.TempDir(),
			PrivateKey:    "priv-k",
			Address:       "10.1.1.2/32",
			PeerPublicKey: "peer-pub",
			PeerEndpoint:  "vpn.example.com:51820",
			AllowedIPs:    "0.0.0.0/0",
		},
		log: minlog.New("test"),
	}

	err := mgr.manualSetup(context.Background())
	if err == nil {
		t.Fatal("expected error when ip address add fails")
	}
	if !strings.Contains(err.Error(), "assign address") {
		t.Fatalf("expected 'assign address' in error, got %v", err)
	}
}

func TestManualSetupReturnsErrorWhenLinkSetUpFails(t *testing.T) {
	shimDir := t.TempDir()
	// Succeed on first two `ip` calls (link add, address add),
	// fail on `ip link set up`.
	writeShim(t, shimDir, "ip", `
if [ "$1" = "link" ] && [ "$2" = "set" ]; then
  echo "link-up-failed"; exit 1
fi
exit 0
`)
	writeShim(t, shimDir, "wg", `exit 0`)
	isolatePath(t, shimDir)

	mgr := &Manager{
		cfg: WireGuardConfig{
			InterfaceName: "wg-manual-upfail",
			DataDir:       t.TempDir(),
			PrivateKey:    "priv-k",
			Address:       "10.1.1.2/32",
			PeerPublicKey: "peer-pub",
			PeerEndpoint:  "vpn.example.com:51820",
			AllowedIPs:    "0.0.0.0/0",
		},
		log: minlog.New("test"),
	}

	err := mgr.manualSetup(context.Background())
	if err == nil {
		t.Fatal("expected error when ip link set up fails")
	}
	if !strings.Contains(err.Error(), "bring up interface") {
		t.Fatalf("expected 'bring up interface' in error, got %v", err)
	}
}

// manualSetup writes the private key to a keyFile; if the DataDir does not
// exist, os.WriteFile returns an error. Exercises lines 207-209.
func TestManualSetupReturnsErrorWhenKeyFileCannotBeWritten(t *testing.T) {
	shimDir := t.TempDir()
	writeShim(t, shimDir, "ip", `exit 0`)
	writeShim(t, shimDir, "wg", `exit 0`)
	isolatePath(t, shimDir)

	mgr := &Manager{
		cfg: WireGuardConfig{
			InterfaceName: "wg-manual-keyfail",
			DataDir:       "/nonexistent-dir-xyz/definitely/not/here",
			PrivateKey:    "priv-k",
			Address:       "10.1.1.2/32",
			PeerPublicKey: "peer-pub",
			PeerEndpoint:  "vpn.example.com:51820",
			AllowedIPs:    "0.0.0.0/0",
		},
		log: minlog.New("test"),
	}

	// `ip link add` succeeds (shim exits 0), then os.WriteFile(keyFile) fails
	// because DataDir doesn't exist.
	if err := mgr.manualSetup(context.Background()); err == nil {
		t.Fatal("expected error when private key file cannot be written")
	}
}

// ---------------------------------------------------------------------------
// NewManager – remaining key-generation defaulting for InterfaceName etc.
// is already covered; the only uncovered branch is rand.Read failure in
// generateWireGuardKeyPair, which is unreachable by design.
// ---------------------------------------------------------------------------

// Sanity: NewManager with empty PrivateKey still succeeds (the generated
// key goes through the rest of the default-setting code block).
func TestNewManagerDefaultsWhenAllOptionalFieldsUnset(t *testing.T) {
	mgr, err := NewManager(
		WireGuardConfig{
			PeerPublicKey: "peer",
			PeerEndpoint:  "vpn.example.com:51820",
		},
		minlog.New("test"),
	)
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}
	if mgr.cfg.InterfaceName == "" || mgr.cfg.Address == "" || mgr.cfg.AllowedIPs == "" || mgr.cfg.DataDir == "" {
		t.Fatalf("defaults not applied: %+v", mgr.cfg)
	}
	if mgr.cfg.PersistentKeepalive != 25 {
		t.Fatalf("PersistentKeepalive default = %d, want 25", mgr.cfg.PersistentKeepalive)
	}
	if mgr.cfg.PrivateKey == "" {
		t.Fatal("PrivateKey should have been generated")
	}
}

// ---------------------------------------------------------------------------
// Start – ErrAlreadyConnected is reported without mutating state.
// (complements the existing basic test)
// ---------------------------------------------------------------------------

func TestStartErrAlreadyConnectedDoesNotOverwriteConfigFile(t *testing.T) {
	shimDir := t.TempDir()
	writeShim(t, shimDir, "wg-quick", `exit 0`)
	isolatePath(t, shimDir)

	mgr := &Manager{
		cfg: WireGuardConfig{
			InterfaceName: "wg-already",
			DataDir:       t.TempDir(),
			PrivateKey:    "priv",
			Address:       "10.1.1.2/32",
			PeerPublicKey: "peer",
			PeerEndpoint:  "vpn.example.com:51820",
			AllowedIPs:    "0.0.0.0/0",
		},
		active: true,
		log:    minlog.New("test"),
	}

	if err := mgr.Start(context.Background()); !errors.Is(err, ErrAlreadyConnected) {
		t.Fatalf("expected ErrAlreadyConnected, got %v", err)
	}
	// Since Start returned early, DataDir should NOT have been created.
	if _, err := os.Stat(filepath.Join(mgr.cfg.DataDir, mgr.cfg.InterfaceName+".conf")); !os.IsNotExist(err) {
		t.Fatalf("expected no config file to be written on early return, stat err = %v", err)
	}
}
