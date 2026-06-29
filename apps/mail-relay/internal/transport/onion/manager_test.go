package onion

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"relay/internal/minlog"
)

func TestNewManagerRequiresDataDir(t *testing.T) {
	_, err := NewManager(Config{}, minlog.New("test"))
	if err == nil || !strings.Contains(err.Error(), "tor data directory required") {
		t.Fatalf("expected data-dir validation error, got %v", err)
	}
}

func TestNewManagerReturnsErrTorNotFoundWhenBinaryMissing(t *testing.T) {
	_, err := NewManager(
		Config{
			DataDir:   t.TempDir(),
			TorBinary: "definitely-missing-tor-binary-for-tests",
		},
		minlog.New("test"),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, ErrTorNotFound) {
		t.Fatalf("expected ErrTorNotFound, got %v", err)
	}
}

func TestNewManagerAppliesDefaults(t *testing.T) {
	dataDir := t.TempDir()
	m, err := NewManager(
		Config{
			DataDir:   dataDir,
			TorBinary: "sh",
		},
		minlog.New("test"),
	)
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}

	if m.socksPort != 9050 {
		t.Fatalf("socksPort = %d, want 9050", m.socksPort)
	}
	if m.hiddenPort != 80 {
		t.Fatalf("hiddenPort = %d, want 80", m.hiddenPort)
	}
	if m.targetAddr != "127.0.0.1:8091" {
		t.Fatalf("targetAddr = %q, want 127.0.0.1:8091", m.targetAddr)
	}
	if !filepath.IsAbs(m.dataDir) {
		t.Fatalf("expected absolute dataDir, got %q", m.dataDir)
	}
}

func TestWriteTorrcContainsRequiredSecurityDirectives(t *testing.T) {
	tempDir := t.TempDir()
	torrcPath := filepath.Join(tempDir, "torrc")
	hsDir := filepath.Join(tempDir, "hidden_service")

	m := &Manager{
		socksPort:  9051,
		hiddenPort: 443,
		targetAddr: "127.0.0.1:18090",
	}

	if err := m.writeTorrc(torrcPath, tempDir, hsDir); err != nil {
		t.Fatalf("writeTorrc() error = %v", err)
	}

	data, err := os.ReadFile(torrcPath)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	content := string(data)

	required := []string{
		"SocksPort 9051",
		"DataDirectory " + tempDir,
		"HiddenServiceDir " + hsDir,
		"HiddenServicePort 443 127.0.0.1:18090",
		"HiddenServiceVersion 3",
		"SafeSocks 1",
		"ExitPolicy reject *:*",
		"Log notice stderr",
	}
	for _, token := range required {
		if !strings.Contains(content, token) {
			t.Fatalf("torrc missing %q\n%s", token, content)
		}
	}
}

func TestExpandEd25519SeedClampsBits(t *testing.T) {
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = 0xff
	}
	expanded := expandEd25519Seed(seed)
	if len(expanded) != 64 {
		t.Fatalf("expanded len = %d, want 64", len(expanded))
	}
	if expanded[0]&7 != 0 {
		t.Fatalf("expected lower 3 bits cleared, got byte0=%08b", expanded[0])
	}
	if expanded[31]&0x80 != 0 {
		t.Fatalf("expected highest bit of byte31 cleared, got byte31=%08b", expanded[31])
	}
	if expanded[31]&0x40 == 0 {
		t.Fatalf("expected second-highest bit of byte31 set, got byte31=%08b", expanded[31])
	}
}

func TestDeriveOnionAddressValidation(t *testing.T) {
	tempDir := t.TempDir()

	shortPath := filepath.Join(tempDir, "short.pub")
	if err := os.WriteFile(shortPath, []byte("short"), 0o600); err != nil {
		t.Fatalf("WriteFile(short) error = %v", err)
	}
	if _, err := deriveOnionAddress(shortPath); err == nil || !strings.Contains(err.Error(), "invalid public key file") {
		t.Fatalf("expected invalid public key file error, got %v", err)
	}

	validPath := filepath.Join(tempDir, "valid.pub")
	pubData := make([]byte, 64) // 32-byte header + 32-byte pubkey
	copy(pubData[:32], []byte("== ed25519v1-public: type0 ==\x00\x00\x00"))
	for i := 32; i < 64; i++ {
		pubData[i] = byte(i)
	}
	if err := os.WriteFile(validPath, pubData, 0o600); err != nil {
		t.Fatalf("WriteFile(valid) error = %v", err)
	}

	addr, err := deriveOnionAddress(validPath)
	if err != nil {
		t.Fatalf("deriveOnionAddress(valid) error = %v", err)
	}
	if !strings.HasSuffix(addr, ".onion") {
		t.Fatalf("expected .onion suffix, got %q", addr)
	}
	if len(addr) <= len(".onion") {
		t.Fatalf("unexpected onion address %q", addr)
	}
}
