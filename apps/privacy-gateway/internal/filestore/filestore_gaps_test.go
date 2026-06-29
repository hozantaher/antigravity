package filestore

import (
	"os"
	"path/filepath"
	"testing"
)

func mustCodec(t *testing.T, key []byte) Codec {
	t.Helper()
	c, err := NewCodec(key)
	if err != nil {
		t.Fatalf("NewCodec: %v", err)
	}
	return c
}

// ── ReadJSONWithCodec: ReadFile error (non-NotExist) ──

func TestReadJSONWithCodec_ReadError(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "sub")
	os.Mkdir(p, 0o755) // directory, not file → ReadFile fails

	err := ReadJSONWithCodec(p, &struct{}{}, DefaultCodec())
	if err == nil {
		t.Error("expected error reading a directory as file")
	}
}

// ── ReadJSONWithCodec: decode error (bad base64 in envelope) ──

func TestReadJSONWithCodec_BadNonce(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "bad.json")
	os.WriteFile(p, []byte(`{"encrypted":true,"version":1,"algorithm":"aes-256-gcm","nonce":"!bad!","ciphertext":"AA=="}`), 0o600)

	key := make([]byte, 32)
	err := ReadJSONWithCodec(p, &struct{}{}, mustCodec(t, key))
	if err == nil {
		t.Error("expected decode error for bad base64 nonce")
	}
}

// ── WriteJSONAtomicWithCodec: unwritable directory → CreateTemp error ──

func TestWriteJSONAtomicWithCodec_CreateTempError(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root bypasses file permissions")
	}
	dir := t.TempDir()
	os.Chmod(dir, 0o444)
	defer os.Chmod(dir, 0o755)

	p := filepath.Join(dir, "out.json")
	err := WriteJSONAtomicWithCodec(p, "test", DefaultCodec())
	if err == nil {
		t.Error("expected error creating temp file in read-only dir")
	}
}

// ── Encryption roundtrip (covers encode + decode happy path) ──

func TestEncryptedRoundtrip(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "enc.json")

	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	codec := mustCodec(t, key)

	type data struct {
		Value string `json:"value"`
	}

	if err := WriteJSONAtomicWithCodec(p, data{Value: "secret"}, codec); err != nil {
		t.Fatalf("write: %v", err)
	}

	var got data
	if err := ReadJSONWithCodec(p, &got, codec); err != nil {
		t.Fatalf("read: %v", err)
	}
	if got.Value != "secret" {
		t.Errorf("got %q, want secret", got.Value)
	}
}

// ── decode: wrong key (decrypt fails) ──

func TestReadJSONWithCodec_WrongKey(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "enc.json")

	writeKey := make([]byte, 32)
	for i := range writeKey {
		writeKey[i] = byte(i + 1)
	}

	if err := WriteJSONAtomicWithCodec(p, map[string]string{"x": "y"}, mustCodec(t, writeKey)); err != nil {
		t.Fatalf("write: %v", err)
	}

	wrongKey := make([]byte, 32) // all zeros → wrong key
	var out map[string]string
	err := ReadJSONWithCodec(p, &out, mustCodec(t, wrongKey))
	if err == nil {
		t.Error("expected decryption error with wrong key")
	}
}

// ── ReadJSONWithCodec: unsupported envelope ──

func TestReadJSONWithCodec_UnsupportedEnvelope(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "bad_algo.json")
	os.WriteFile(p, []byte(`{"encrypted":true,"version":99,"algorithm":"rsa-4096","nonce":"AA==","ciphertext":"AA=="}`), 0o600)

	key := make([]byte, 32)
	err := ReadJSONWithCodec(p, &struct{}{}, mustCodec(t, key))
	if err == nil {
		t.Error("expected error for unsupported envelope")
	}
}

// ── ReadJSONWithCodec: missing key for encrypted file ──

func TestReadJSONWithCodec_MissingKey(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "encrypted.json")

	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	if err := WriteJSONAtomicWithCodec(p, map[string]string{"k": "v"}, mustCodec(t, key)); err != nil {
		t.Fatalf("write: %v", err)
	}

	var out map[string]string
	err := ReadJSONWithCodec(p, &out, DefaultCodec())
	if err == nil {
		t.Error("expected ErrEncryptedFileRequiresKey")
	}
}

// ── ReadJSONWithCodec: bad ciphertext base64 ──

func TestReadJSONWithCodec_BadCiphertext(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "bad_ct.json")
	// Valid nonce base64 but bad ciphertext
	nonce := "AAAAAAAAAAAAAAAAAAAAAA==" // 16 bytes base64
	os.WriteFile(p, []byte(`{"encrypted":true,"version":1,"algorithm":"aes-256-gcm","nonce":"`+nonce+`","ciphertext":"!bad!"}`), 0o600)

	key := make([]byte, 32)
	err := ReadJSONWithCodec(p, &struct{}{}, mustCodec(t, key))
	if err == nil {
		t.Error("expected error for bad ciphertext base64")
	}
}
