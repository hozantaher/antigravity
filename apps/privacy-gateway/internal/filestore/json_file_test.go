package filestore

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestReadJSONMissingFileReturnsNil(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.json")
	target := map[string]string{"kept": "value"}

	if err := ReadJSON(path, &target); err != nil {
		t.Fatalf("ReadJSON() error = %v", err)
	}
	if target["kept"] != "value" {
		t.Fatalf("expected target to remain unchanged, got %+v", target)
	}
}

func TestReadJSONLoadsExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte("{\"name\":\"relay\"}\n"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	var target struct {
		Name string `json:"name"`
	}
	if err := ReadJSON(path, &target); err != nil {
		t.Fatalf("ReadJSON() error = %v", err)
	}
	if target.Name != "relay" {
		t.Fatalf("expected decoded name relay, got %s", target.Name)
	}
}

func TestReadJSONRejectsEmptyPath(t *testing.T) {
	var target map[string]string
	if err := ReadJSON("", &target); err == nil {
		t.Fatal("expected empty path error")
	}
}

func TestWriteJSONAtomicPersistsWithRestrictedPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "state.json")
	payload := map[string]string{"status": "ok"}

	if err := WriteJSONAtomic(path, payload); err != nil {
		t.Fatalf("WriteJSONAtomic() error = %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(data) == "" {
		t.Fatal("expected persisted data to be non-empty")
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat() error = %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("expected file mode 0600, got %o", info.Mode().Perm())
	}
}

func TestWriteJSONAtomicRejectsEmptyPath(t *testing.T) {
	if err := WriteJSONAtomic("", map[string]string{"status": "ok"}); err == nil {
		t.Fatal("expected empty path error")
	}
}

func TestCodecRoundTripEncryptsAtRest(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	codec, err := NewCodec(key)
	if err != nil {
		t.Fatalf("NewCodec() error = %v", err)
	}

	path := filepath.Join(t.TempDir(), "state.json")
	payload := map[string]string{"status": "ok"}
	if err := WriteJSONAtomicWithCodec(path, payload, codec); err != nil {
		t.Fatalf("WriteJSONAtomicWithCodec() error = %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(raw) == "" {
		t.Fatal("expected encrypted file to be non-empty")
	}
	if string(raw) == "{\n  \"status\": \"ok\"\n}\n" {
		t.Fatal("expected encrypted file to differ from plaintext JSON")
	}

	var decoded map[string]string
	if err := ReadJSONWithCodec(path, &decoded, codec); err != nil {
		t.Fatalf("ReadJSONWithCodec() error = %v", err)
	}
	if decoded["status"] != "ok" {
		t.Fatalf("expected decrypted status ok, got %+v", decoded)
	}
}

func TestReadJSONWithCodecRejectsEncryptedFileWithoutKey(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	codec, err := NewCodec(key)
	if err != nil {
		t.Fatalf("NewCodec() error = %v", err)
	}

	path := filepath.Join(t.TempDir(), "state.json")
	if err := WriteJSONAtomicWithCodec(path, map[string]string{"status": "ok"}, codec); err != nil {
		t.Fatalf("WriteJSONAtomicWithCodec() error = %v", err)
	}

	var decoded map[string]string
	if err := ReadJSONWithCodec(path, &decoded, DefaultCodec()); err != ErrEncryptedFileRequiresKey {
		t.Fatalf("expected ErrEncryptedFileRequiresKey, got %v", err)
	}
}

func TestReadJSONWithCodecRejectsWrongKey(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	codec, err := NewCodec(key)
	if err != nil {
		t.Fatalf("NewCodec() error = %v", err)
	}

	path := filepath.Join(t.TempDir(), "state.json")
	if err := WriteJSONAtomicWithCodec(path, map[string]string{"status": "ok"}, codec); err != nil {
		t.Fatalf("WriteJSONAtomicWithCodec() error = %v", err)
	}

	wrongCodec, err := NewCodec([]byte("abcdef0123456789abcdef0123456789"))
	if err != nil {
		t.Fatalf("NewCodec() wrong key error = %v", err)
	}

	var decoded map[string]string
	if err := ReadJSONWithCodec(path, &decoded, wrongCodec); err == nil {
		t.Fatal("expected decrypt failure with wrong key")
	}
}

func TestReadJSONWithCodecAllowsPlaintextMigrationWithKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte("{\"status\":\"ok\"}\n"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	codec, err := NewCodec([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("NewCodec() error = %v", err)
	}

	var decoded map[string]string
	if err := ReadJSONWithCodec(path, &decoded, codec); err != nil {
		t.Fatalf("ReadJSONWithCodec() error = %v", err)
	}
	if decoded["status"] != "ok" {
		t.Fatalf("expected plaintext migration read ok, got %+v", decoded)
	}
}

func TestNewCodecFromBase64(t *testing.T) {
	value := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
	codec, err := NewCodecFromBase64(value)
	if err != nil {
		t.Fatalf("NewCodecFromBase64() error = %v", err)
	}
	if len(codec.key) != 32 {
		t.Fatalf("expected 32-byte key, got %d", len(codec.key))
	}
}

func TestNewCodecFromBase64RejectsInvalidKey(t *testing.T) {
	if _, err := NewCodecFromBase64("invalid-base64"); err != ErrInvalidEncryptionKey {
		t.Fatalf("expected ErrInvalidEncryptionKey, got %v", err)
	}
	if _, err := NewCodec([]byte("short")); err != ErrInvalidEncryptionKey {
		t.Fatalf("expected ErrInvalidEncryptionKey for short key, got %v", err)
	}
}
