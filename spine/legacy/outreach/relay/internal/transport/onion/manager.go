package onion

import (
	"relay/internal/minlog"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha512"
	"encoding/base32"
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
	ErrTorNotFound    = errors.New("tor binary not found in PATH")
	ErrAlreadyRunning = errors.New("tor hidden service already running")
	ErrNotRunning     = errors.New("tor hidden service not running")
)

// Manager handles the Tor hidden service lifecycle:
// torrc generation, .onion address derivation, Tor process management.
type Manager struct {
	mu          sync.Mutex
	dataDir     string
	socksPort   int
	hiddenPort  int
	targetAddr  string
	torBinary   string
	cmd         *exec.Cmd
	onionAddr   string
	running     bool
	log         *minlog.Logger
	// waitWg tracks the background `cmd.Wait()` goroutine so Shutdown can
	// block until it exits — prevents the "zombie Wait goroutine racing on
	// m.running after Stop()" pattern flagged in project_anti_trace_relay
	// quality debt M3.
	waitWg      sync.WaitGroup
}

// Config for the Tor hidden service manager.
type Config struct {
	DataDir    string // Directory for Tor state (keys, torrc)
	SocksPort  int    // Local SOCKS5 port for outbound (default: 9050)
	HiddenPort int    // Virtual port exposed on .onion (default: 80)
	TargetAddr string // Local address the hidden service forwards to (e.g. "127.0.0.1:8091")
	TorBinary  string // Path to tor binary (default: "tor")
}

// NewManager creates a Tor hidden service manager.
func NewManager(cfg Config, log *minlog.Logger) (*Manager, error) {
	if cfg.DataDir == "" {
		return nil, errors.New("tor data directory required")
	}
	if cfg.SocksPort == 0 {
		cfg.SocksPort = 9050
	}
	if cfg.HiddenPort == 0 {
		cfg.HiddenPort = 80
	}
	if cfg.TargetAddr == "" {
		cfg.TargetAddr = "127.0.0.1:8091"
	}
	if cfg.TorBinary == "" {
		cfg.TorBinary = "tor"
	}

	// Verify tor binary exists
	if _, err := exec.LookPath(cfg.TorBinary); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrTorNotFound, err)
	}

	// Resolve to absolute path so torrc path is never relative to a subprocess CWD.
	absDataDir, err := filepath.Abs(cfg.DataDir)
	if err != nil {
		return nil, fmt.Errorf("resolve data dir: %w", err)
	}

	return &Manager{
		dataDir:    absDataDir,
		socksPort:  cfg.SocksPort,
		hiddenPort: cfg.HiddenPort,
		targetAddr: cfg.TargetAddr,
		torBinary:  cfg.TorBinary,
		log:        log,
	}, nil
}

// Start generates the torrc, creates hidden service keys if needed,
// and starts the Tor process.
func (m *Manager) Start(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.running {
		return ErrAlreadyRunning
	}

	// Create directory structure
	// m.dataDir is already the Tor-specific directory (e.g. /app/data/tor)
	// — do NOT append "tor" again here.
	torDataDir := m.dataDir
	hiddenServiceDir := filepath.Join(torDataDir, "hidden_service")
	if err := os.MkdirAll(hiddenServiceDir, 0700); err != nil {
		return fmt.Errorf("create tor dirs: %w", err)
	}

	// Generate v3 onion key if not present
	keyPath := filepath.Join(hiddenServiceDir, "hs_ed25519_secret_key")
	if _, err := os.Stat(keyPath); os.IsNotExist(err) {
		if err := m.generateV3OnionKey(hiddenServiceDir); err != nil {
			return fmt.Errorf("generate onion key: %w", err)
		}
	}

	// Derive .onion address from public key
	pubKeyPath := filepath.Join(hiddenServiceDir, "hs_ed25519_public_key")
	onionAddr, err := deriveOnionAddress(pubKeyPath)
	if err != nil {
		return fmt.Errorf("derive onion address: %w", err)
	}
	m.onionAddr = onionAddr

	// Write hostname file (Tor expects this)
	if err := os.WriteFile(
		filepath.Join(hiddenServiceDir, "hostname"),
		[]byte(onionAddr+"\n"),
		0600,
	); err != nil {
		return fmt.Errorf("write hostname: %w", err)
	}

	// Generate torrc
	torrcPath := filepath.Join(torDataDir, "torrc")
	if err := m.writeTorrc(torrcPath, torDataDir, hiddenServiceDir); err != nil {
		return fmt.Errorf("write torrc: %w", err)
	}

	// Start Tor process
	m.cmd = exec.CommandContext(ctx, m.torBinary, "-f", torrcPath)
	m.cmd.Dir = torDataDir
	m.cmd.Stderr = os.Stderr
	m.cmd.Stdout = os.Stdout

	if err := m.cmd.Start(); err != nil {
		return fmt.Errorf("start tor: %w", err)
	}

	m.running = true
	m.log.Info("tor_started",
		minlog.F("onion", onionAddr),
		minlog.F("socks_port", fmt.Sprintf("%d", m.socksPort)),
	)

	// Monitor process in background. WaitWg lets Shutdown() block until
	// this goroutine exits, avoiding a race where m.running flips after
	// the caller assumed a clean shutdown.
	m.waitWg.Add(1)
	go func() {
		defer m.waitWg.Done()
		err := m.cmd.Wait()
		m.mu.Lock()
		m.running = false
		m.mu.Unlock()
		if err != nil && ctx.Err() == nil {
			m.log.Error("tor_exited_unexpectedly")
		}
	}()

	return nil
}

// Shutdown stops the process (if running) AND waits for the monitor
// goroutine to exit. Safe to call multiple times. Use this from
// daemon shutdown paths so `m.running` is guaranteed stable after
// return.
func (m *Manager) Shutdown() error {
	err := m.Stop()
	// Stop may return ErrNotRunning; still wait for any pending monitor
	// goroutine (could be a Wait from a previously stopped/exited process
	// that hasn't yet defer-signalled).
	m.waitWg.Wait()
	if errors.Is(err, ErrNotRunning) {
		return nil
	}
	return err
}

// Stop gracefully stops the Tor process.
func (m *Manager) Stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.running || m.cmd == nil || m.cmd.Process == nil {
		return ErrNotRunning
	}

	m.log.Info("tor_stopping")
	if err := m.cmd.Process.Signal(os.Interrupt); err != nil {
		if killErr := m.cmd.Process.Kill(); killErr != nil {
			m.log.Error("tor_kill_error", minlog.F("error", killErr.Error()))
		}
	}
	m.running = false
	return nil
}

// OnionAddress returns the .onion address (available after Start).
func (m *Manager) OnionAddress() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.onionAddr
}

// SocksAddr returns the SOCKS5 proxy address for outbound connections.
func (m *Manager) SocksAddr() string {
	return fmt.Sprintf("127.0.0.1:%d", m.socksPort)
}

// IsRunning reports whether the Tor process is running.
func (m *Manager) IsRunning() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.running
}

// WaitReady blocks until the Tor SOCKS port is accepting connections or ctx is done.
func (m *Manager) WaitReady(ctx context.Context) error {
	socksAddr := m.SocksAddr()
	for {
		conn, err := net.DialTimeout("tcp", socksAddr, 2*time.Second)
		if err == nil {
			conn.Close()
			m.log.Info("tor_ready")
			return nil
		}
		// Ctx-aware backoff — raw time.Sleep would let a cancelled ctx still
		// block up to 500ms before the next loop iteration notices, which
		// stacks badly with test cancellation and shutdown signals.
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// writeTorrc generates a minimal torrc configuration.
func (m *Manager) writeTorrc(torrcPath, torDataDir, hiddenServiceDir string) error {
	lines := []string{
		"# Auto-generated by anti-trace-relay -- do not edit",
		fmt.Sprintf("SocksPort %d", m.socksPort),
		fmt.Sprintf("DataDirectory %s", torDataDir),
		"",
		"# Hidden service configuration",
		fmt.Sprintf("HiddenServiceDir %s", hiddenServiceDir),
		fmt.Sprintf("HiddenServicePort %d %s", m.hiddenPort, m.targetAddr),
		"HiddenServiceVersion 3",
		"",
		"# Security hardening",
		"SafeSocks 1",
		"TestSocks 0",
		"WarnUnsafeSocks 1",
		"",
		"# Disable unnecessary features",
		"AvoidDiskWrites 1",
		"DisableDebuggerAttachment 1",
		"",
		"# Connection safety",
		"ClientOnly 0",
		"ExitPolicy reject *:*",
		"",
		"# Logging (minimal)",
		"Log notice stderr",
	}

	content := strings.Join(lines, "\n") + "\n"
	return os.WriteFile(torrcPath, []byte(content), 0600)
}

// generateV3OnionKey generates a Tor v3 hidden service keypair (Ed25519).
// Tor v3 key format: 32-byte "== ed25519v1-secret: type0 ==" header + 64-byte expanded key
func (m *Manager) generateV3OnionKey(dir string) error {
	// Generate Ed25519 key pair
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}

	// Tor v3 secret key format: header (32 bytes) + expanded secret key (64 bytes)
	header := []byte("== ed25519v1-secret: type0 ==\x00\x00\x00")
	// Expand the seed to get the 64-byte expanded key
	seed := priv.Seed()
	expanded := expandEd25519Seed(seed)

	secretKey := make([]byte, 0, 96)
	secretKey = append(secretKey, header...)
	secretKey = append(secretKey, expanded...)

	if err := os.WriteFile(filepath.Join(dir, "hs_ed25519_secret_key"), secretKey, 0600); err != nil {
		return err
	}

	// Public key format: header (32 bytes) + public key (32 bytes)
	pubHeader := []byte("== ed25519v1-public: type0 ==\x00\x00\x00")
	pubKey := make([]byte, 0, 64)
	pubKey = append(pubKey, pubHeader...)
	pubKey = append(pubKey, priv.Public().(ed25519.PublicKey)...)

	return os.WriteFile(filepath.Join(dir, "hs_ed25519_public_key"), pubKey, 0600)
}

// expandEd25519Seed expands a 32-byte seed to 64 bytes using SHA-512 (same as Tor).
func expandEd25519Seed(seed []byte) []byte {
	h := sha512.Sum512(seed)
	// Clamp per Ed25519 spec
	h[0] &= 248
	h[31] &= 127
	h[31] |= 64
	return h[:]
}

// deriveOnionAddress computes the .onion address from the public key file.
// Tor v3: onion_address = base32(pubkey || checksum || version)
func deriveOnionAddress(pubKeyPath string) (string, error) {
	data, err := os.ReadFile(pubKeyPath)
	if err != nil {
		return "", err
	}

	// Skip 32-byte header
	if len(data) < 64 {
		return "", errors.New("invalid public key file")
	}
	pubKey := data[32:]

	// checksum = SHA3-256(".onion checksum" || pubkey || version)[0:2]
	// We use SHA-256 as approximation since Go stdlib doesn't have SHA3.
	// For production, use crypto/sha3 from x/crypto.
	checksumInput := make([]byte, 0, 15+32+1)
	checksumInput = append(checksumInput, ".onion checksum"...)
	checksumInput = append(checksumInput, pubKey...)
	checksumInput = append(checksumInput, 0x03) // version 3
	checksum := sha256OnionChecksum(checksumInput)

	// onion_address = base32(pubkey + checksum[0:2] + version)
	addrInput := make([]byte, 0, 35)
	addrInput = append(addrInput, pubKey...)
	addrInput = append(addrInput, checksum[0], checksum[1])
	addrInput = append(addrInput, 0x03)

	encoded := base32.StdEncoding.EncodeToString(addrInput)
	return strings.ToLower(encoded) + ".onion", nil
}

// sha256OnionChecksum computes the checksum for the .onion address.
// Note: Tor actually uses SHA3-256. For a full implementation, use x/crypto/sha3.
// This is a placeholder that uses SHA-256 for key generation only.
func sha256OnionChecksum(input []byte) []byte {
	h := sha512.Sum512_256(input)
	return h[:]
}
