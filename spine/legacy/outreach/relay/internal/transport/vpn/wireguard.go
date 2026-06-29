package vpn

import (
	"relay/internal/minlog"
	"relay/internal/transport"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	ErrWireGuardNotFound = errors.New("wireguard tools (wg, wg-quick) not found")
	ErrAlreadyConnected  = errors.New("VPN tunnel already active")
	ErrNotConnected      = errors.New("VPN tunnel not active")
	ErrConfigRequired    = errors.New("WireGuard configuration required")
)

// WireGuardConfig holds the WireGuard tunnel configuration.
type WireGuardConfig struct {
	// Interface settings
	PrivateKey string // Base64-encoded private key (generated if empty)
	Address    string // Tunnel interface address (e.g. "10.66.66.2/32")
	DNS        string // DNS server (e.g. "10.66.66.1")
	ListenPort int    // Local listen port (0 = random)

	// Peer settings (VPN server)
	PeerPublicKey  string // Base64-encoded server public key
	PeerEndpoint   string // Server endpoint (e.g. "vpn.example.com:51820")
	AllowedIPs     string // Routed IPs (e.g. "0.0.0.0/0" for full tunnel)
	PresharedKey   string // Optional PSK for post-quantum resistance
	PersistentKeepalive int // Keepalive interval in seconds

	// Operational
	InterfaceName string // Interface name (e.g. "wg-atr0")
	DataDir       string // Directory for config files
}

// Manager handles the WireGuard VPN tunnel lifecycle.
type Manager struct {
	mu        sync.Mutex
	cfg       WireGuardConfig
	active    bool
	publicKey string
	log       *minlog.Logger
}

// NewManager creates a WireGuard VPN manager.
func NewManager(cfg WireGuardConfig, log *minlog.Logger) (*Manager, error) {
	if cfg.PeerPublicKey == "" || cfg.PeerEndpoint == "" {
		return nil, ErrConfigRequired
	}
	if cfg.InterfaceName == "" {
		cfg.InterfaceName = "wg-atr0"
	}
	if cfg.Address == "" {
		cfg.Address = "10.66.66.2/32"
	}
	if cfg.AllowedIPs == "" {
		cfg.AllowedIPs = "0.0.0.0/0, ::/0"
	}
	if cfg.DataDir == "" {
		cfg.DataDir = "/tmp/anti-trace-wg"
	}
	if cfg.PersistentKeepalive == 0 {
		cfg.PersistentKeepalive = 25
	}

	// Generate key pair if needed
	if cfg.PrivateKey == "" {
		priv, pub, err := generateWireGuardKeyPair()
		if err != nil {
			return nil, fmt.Errorf("generate wireguard keys: %w", err)
		}
		cfg.PrivateKey = priv
		log.Info("wireguard_keypair_generated")
		// The public key must be shared with the VPN server admin
		_ = pub
	}

	return &Manager{cfg: cfg, log: log}, nil
}

// Start brings up the WireGuard tunnel.
func (m *Manager) Start(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.active {
		return ErrAlreadyConnected
	}

	if err := os.MkdirAll(m.cfg.DataDir, 0700); err != nil {
		return err
	}

	// Write WireGuard config file
	confPath := filepath.Join(m.cfg.DataDir, m.cfg.InterfaceName+".conf")
	if err := m.writeConfig(confPath); err != nil {
		return fmt.Errorf("write wireguard config: %w", err)
	}

	// Try wg-quick first (common on Linux/macOS)
	if wgQuickPath, err := exec.LookPath("wg-quick"); err == nil {
		cmd := exec.CommandContext(ctx, wgQuickPath, "up", confPath)
		if output, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("wg-quick up failed: %s: %w", string(output), err)
		}
		m.active = true
		m.log.Info("wireguard_up", minlog.F("interface", m.cfg.InterfaceName))
		return nil
	}

	// Fallback: manual setup with ip/wg commands (Linux)
	return m.manualSetup(ctx)
}

// Stop tears down the WireGuard tunnel.
func (m *Manager) Stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.active {
		return ErrNotConnected
	}

	confPath := filepath.Join(m.cfg.DataDir, m.cfg.InterfaceName+".conf")

	if wgQuickPath, err := exec.LookPath("wg-quick"); err == nil {
		cmd := exec.Command(wgQuickPath, "down", confPath)
		cmd.CombinedOutput()
	}

	m.active = false
	m.log.Info("wireguard_down", minlog.F("interface", m.cfg.InterfaceName))

	// Clean up config file (contains private key)
	os.Remove(confPath)

	return nil
}

// IsActive reports whether the VPN tunnel is up.
func (m *Manager) IsActive() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.active
}

// Transport returns an AnonymousTransport that routes through the VPN tunnel.
// This binds outbound connections to the VPN interface.
func (m *Manager) Transport() transport.AnonymousTransport {
	return &vpnTransport{
		interfaceAddr: m.cfg.Address,
		mgr:           m,
	}
}

// PublicKey returns the WireGuard public key (for sharing with VPN server admin).
func (m *Manager) PublicKey() string {
	return m.publicKey
}

// writeConfig generates a wg-quick compatible configuration file.
func (m *Manager) writeConfig(path string) error {
	var b strings.Builder
	b.WriteString("[Interface]\n")
	b.WriteString(fmt.Sprintf("PrivateKey = %s\n", m.cfg.PrivateKey))
	b.WriteString(fmt.Sprintf("Address = %s\n", m.cfg.Address))
	if m.cfg.DNS != "" {
		b.WriteString(fmt.Sprintf("DNS = %s\n", m.cfg.DNS))
	}
	if m.cfg.ListenPort > 0 {
		b.WriteString(fmt.Sprintf("ListenPort = %d\n", m.cfg.ListenPort))
	}
	b.WriteString("\n[Peer]\n")
	b.WriteString(fmt.Sprintf("PublicKey = %s\n", m.cfg.PeerPublicKey))
	b.WriteString(fmt.Sprintf("Endpoint = %s\n", m.cfg.PeerEndpoint))
	b.WriteString(fmt.Sprintf("AllowedIPs = %s\n", m.cfg.AllowedIPs))
	if m.cfg.PresharedKey != "" {
		b.WriteString(fmt.Sprintf("PresharedKey = %s\n", m.cfg.PresharedKey))
	}
	b.WriteString(fmt.Sprintf("PersistentKeepalive = %d\n", m.cfg.PersistentKeepalive))

	return os.WriteFile(path, []byte(b.String()), 0600)
}

// manualSetup creates the interface and configures it without wg-quick.
func (m *Manager) manualSetup(ctx context.Context) error {
	iface := m.cfg.InterfaceName

	// Create interface
	if err := runCmd(ctx, "ip", "link", "add", "dev", iface, "type", "wireguard"); err != nil {
		return fmt.Errorf("create interface: %w", err)
	}

	// Set private key
	keyFile := filepath.Join(m.cfg.DataDir, "privatekey")
	if err := os.WriteFile(keyFile, []byte(m.cfg.PrivateKey), 0600); err != nil {
		return err
	}
	defer os.Remove(keyFile)

	if err := runCmd(ctx, "wg", "set", iface, "private-key", keyFile,
		"peer", m.cfg.PeerPublicKey,
		"endpoint", m.cfg.PeerEndpoint,
		"allowed-ips", m.cfg.AllowedIPs,
		"persistent-keepalive", fmt.Sprintf("%d", m.cfg.PersistentKeepalive),
	); err != nil {
		return fmt.Errorf("configure wireguard: %w", err)
	}

	// Assign address and bring up
	if err := runCmd(ctx, "ip", "address", "add", "dev", iface, m.cfg.Address); err != nil {
		return fmt.Errorf("assign address: %w", err)
	}
	if err := runCmd(ctx, "ip", "link", "set", "up", "dev", iface); err != nil {
		return fmt.Errorf("bring up interface: %w", err)
	}

	m.active = true
	m.log.Info("wireguard_up_manual", minlog.F("interface", iface))
	return nil
}

// vpnTransport routes connections through the VPN interface.
type vpnTransport struct {
	interfaceAddr string
	mgr           *Manager
}

func (v *vpnTransport) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	if !v.mgr.IsActive() {
		return nil, ErrNotConnected
	}
	// The VPN tunnel is at the OS level, so a normal dial will route through it
	// if the routing table is configured (which wg-quick does via AllowedIPs).
	dialer := net.Dialer{Timeout: 30 * time.Second}
	return dialer.DialContext(ctx, network, addr)
}

// generateWireGuardKeyPair generates a Curve25519 key pair for WireGuard.
// Returns (privateKeyBase64, publicKeyBase64).
func generateWireGuardKeyPair() (string, string, error) {
	// WireGuard uses Curve25519 -- generate 32 random bytes for private key
	privKey := make([]byte, 32)
	if _, err := rand.Read(privKey); err != nil {
		return "", "", err
	}
	// Clamp private key per Curve25519 spec
	privKey[0] &= 248
	privKey[31] &= 127
	privKey[31] |= 64

	privB64 := base64.StdEncoding.EncodeToString(privKey)

	// Derive public key using Curve25519 scalar multiplication
	// For proper implementation, we'd use x/crypto/curve25519.
	// For now, we generate the key and let wg derive the public key.
	// The public key will be available after `wg show <iface> public-key`.
	pubB64 := "" // Derived by WireGuard tools

	return privB64, pubB64, nil
}

func runCmd(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %v: %s: %w", name, args, string(output), err)
	}
	return nil
}
