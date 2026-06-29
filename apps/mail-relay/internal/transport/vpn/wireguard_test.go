package vpn

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"relay/internal/minlog"
)

func TestNewManagerRequiresPeerConfiguration(t *testing.T) {
	_, err := NewManager(WireGuardConfig{}, minlog.New("test"))
	if !errors.Is(err, ErrConfigRequired) {
		t.Fatalf("expected ErrConfigRequired, got %v", err)
	}
}

func TestNewManagerAppliesDefaults(t *testing.T) {
	mgr, err := NewManager(
		WireGuardConfig{
			PeerPublicKey: "peer-public-key",
			PeerEndpoint:  "vpn.example.com:51820",
			PrivateKey:    "private-key",
		},
		minlog.New("test"),
	)
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}

	if mgr.cfg.InterfaceName != "wg-atr0" {
		t.Fatalf("InterfaceName = %q, want wg-atr0", mgr.cfg.InterfaceName)
	}
	if mgr.cfg.Address != "10.66.66.2/32" {
		t.Fatalf("Address = %q, want default", mgr.cfg.Address)
	}
	if mgr.cfg.AllowedIPs != "0.0.0.0/0, ::/0" {
		t.Fatalf("AllowedIPs = %q, want default", mgr.cfg.AllowedIPs)
	}
	if mgr.cfg.DataDir != "/tmp/anti-trace-wg" {
		t.Fatalf("DataDir = %q, want default", mgr.cfg.DataDir)
	}
	if mgr.cfg.PersistentKeepalive != 25 {
		t.Fatalf("PersistentKeepalive = %d, want 25", mgr.cfg.PersistentKeepalive)
	}
}

func TestWriteConfigIncludesOptionalFields(t *testing.T) {
	tempDir := t.TempDir()
	mgr := &Manager{
		cfg: WireGuardConfig{
			PrivateKey:          "priv-1",
			Address:             "10.1.1.2/32",
			DNS:                 "1.1.1.1",
			ListenPort:          51820,
			PeerPublicKey:       "peer-1",
			PeerEndpoint:        "vpn.example.com:51820",
			AllowedIPs:          "0.0.0.0/0",
			PresharedKey:        "psk-1",
			PersistentKeepalive: 30,
		},
	}

	confPath := filepath.Join(tempDir, "wg-test.conf")
	if err := mgr.writeConfig(confPath); err != nil {
		t.Fatalf("writeConfig() error = %v", err)
	}

	data, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	content := string(data)
	required := []string{
		"[Interface]",
		"PrivateKey = priv-1",
		"Address = 10.1.1.2/32",
		"DNS = 1.1.1.1",
		"ListenPort = 51820",
		"[Peer]",
		"PublicKey = peer-1",
		"Endpoint = vpn.example.com:51820",
		"AllowedIPs = 0.0.0.0/0",
		"PresharedKey = psk-1",
		"PersistentKeepalive = 30",
	}
	for _, token := range required {
		if !strings.Contains(content, token) {
			t.Fatalf("config missing %q\n%s", token, content)
		}
	}
}

func TestWriteConfigOmitsOptionalFieldsWhenUnset(t *testing.T) {
	tempDir := t.TempDir()
	mgr := &Manager{
		cfg: WireGuardConfig{
			PrivateKey:          "priv-2",
			Address:             "10.2.2.2/32",
			PeerPublicKey:       "peer-2",
			PeerEndpoint:        "vpn.example.com:51821",
			AllowedIPs:          "0.0.0.0/0, ::/0",
			PersistentKeepalive: 25,
		},
	}

	confPath := filepath.Join(tempDir, "wg-min.conf")
	if err := mgr.writeConfig(confPath); err != nil {
		t.Fatalf("writeConfig() error = %v", err)
	}
	contentBytes, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	content := string(contentBytes)

	if strings.Contains(content, "DNS = ") {
		t.Fatalf("unexpected DNS line in config:\n%s", content)
	}
	if strings.Contains(content, "ListenPort = ") {
		t.Fatalf("unexpected ListenPort line in config:\n%s", content)
	}
	if strings.Contains(content, "PresharedKey = ") {
		t.Fatalf("unexpected PresharedKey line in config:\n%s", content)
	}
}

func TestTransportReturnsErrNotConnectedWhenInactive(t *testing.T) {
	mgr := &Manager{
		cfg: WireGuardConfig{
			Address: "10.66.66.2/32",
		},
	}
	conn, err := mgr.Transport().DialContext(context.Background(), "tcp", "127.0.0.1:80")
	if !errors.Is(err, ErrNotConnected) {
		t.Fatalf("expected ErrNotConnected, got %v", err)
	}
	if conn != nil {
		t.Fatal("expected nil conn when manager is inactive")
	}
}

func TestStopReturnsErrNotConnectedWhenInactive(t *testing.T) {
	mgr := &Manager{}
	if err := mgr.Stop(); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("expected ErrNotConnected, got %v", err)
	}
}
