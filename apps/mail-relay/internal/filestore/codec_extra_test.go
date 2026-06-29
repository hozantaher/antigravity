package filestore

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestNewCodecFromBase64_InvalidBase64(t *testing.T) {
	_, err := NewCodecFromBase64("not$$base64!!")
	if err == nil {
		t.Fatal("expected error on invalid base64")
	}
}

func TestNewCodecFromBase64_Valid32Bytes(t *testing.T) {
	b := make([]byte, 32)
	for i := range b {
		b[i] = 0x5A
	}
	c, err := NewCodecFromBase64(base64.StdEncoding.EncodeToString(b))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !c.encrypted() {
		t.Fatal("codec with 32-byte key must be encrypted()")
	}
}

func TestDecrypt_InvalidJSONEnvelope(t *testing.T) {
	c, _ := NewCodecFromBase64(testKey())
	_, err := c.Decrypt([]byte("{not valid json"))
	if err == nil {
		t.Fatal("expected error decrypting non-JSON")
	}
}

func TestDecrypt_UnsupportedVersion(t *testing.T) {
	c, _ := NewCodecFromBase64(testKey())
	env := encryptedEnvelope{
		Version:    2,
		Algorithm:  "aes-256-gcm",
		Nonce:      base64.StdEncoding.EncodeToString(make([]byte, 12)),
		Ciphertext: base64.StdEncoding.EncodeToString([]byte{0x00}),
	}
	data, _ := json.Marshal(env)
	if _, err := c.Decrypt(data); err == nil {
		t.Fatal("expected error for unsupported version")
	}
}

func TestDecrypt_UnsupportedAlgorithm(t *testing.T) {
	c, _ := NewCodecFromBase64(testKey())
	env := encryptedEnvelope{
		Version:    1,
		Algorithm:  "chacha20",
		Nonce:      base64.StdEncoding.EncodeToString(make([]byte, 12)),
		Ciphertext: base64.StdEncoding.EncodeToString([]byte{0x00}),
	}
	data, _ := json.Marshal(env)
	if _, err := c.Decrypt(data); err == nil {
		t.Fatal("expected error for unsupported algorithm")
	}
}

func TestDecrypt_InvalidNonceBase64(t *testing.T) {
	c, _ := NewCodecFromBase64(testKey())
	env := encryptedEnvelope{
		Version:    1,
		Algorithm:  "aes-256-gcm",
		Nonce:      "???",
		Ciphertext: base64.StdEncoding.EncodeToString([]byte{0x00}),
	}
	data, _ := json.Marshal(env)
	if _, err := c.Decrypt(data); err == nil {
		t.Fatal("expected error for invalid nonce base64")
	}
}

func TestDecrypt_InvalidCiphertextBase64(t *testing.T) {
	c, _ := NewCodecFromBase64(testKey())
	env := encryptedEnvelope{
		Version:    1,
		Algorithm:  "aes-256-gcm",
		Nonce:      base64.StdEncoding.EncodeToString(make([]byte, 12)),
		Ciphertext: "$$$",
	}
	data, _ := json.Marshal(env)
	if _, err := c.Decrypt(data); err == nil {
		t.Fatal("expected error for invalid ciphertext base64")
	}
}

func TestDecrypt_TamperedCiphertext(t *testing.T) {
	c, _ := NewCodecFromBase64(testKey())
	enc, err := c.Encrypt([]byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	var env encryptedEnvelope
	if err := json.Unmarshal(enc, &env); err != nil {
		t.Fatal(err)
	}
	// Flip a byte in the ciphertext.
	ct, _ := base64.StdEncoding.DecodeString(env.Ciphertext)
	if len(ct) == 0 {
		t.Fatal("empty ciphertext")
	}
	ct[0] ^= 0xFF
	env.Ciphertext = base64.StdEncoding.EncodeToString(ct)
	tampered, _ := json.Marshal(env)
	if _, err := c.Decrypt(tampered); err == nil {
		t.Fatal("expected GCM auth failure on tampered ciphertext")
	}
}

func TestReadJSON_EmptyFileIsNoop(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.json")
	if err := os.WriteFile(path, []byte{}, 0600); err != nil {
		t.Fatal(err)
	}
	var target []string
	if err := ReadJSON(path, DefaultCodec(), &target); err != nil {
		t.Fatalf("ReadJSON on empty file: %v", err)
	}
	if target != nil {
		t.Fatalf("target = %v, want nil", target)
	}
}

func TestReadJSON_ReadError(t *testing.T) {
	// A directory path is readable with os.Stat but os.ReadFile returns an error
	// that is not a not-exist error, exercising the non-IsNotExist branch.
	dir := t.TempDir()
	var target []string
	if err := ReadJSON(dir, DefaultCodec(), &target); err == nil {
		t.Fatal("expected error reading a directory")
	}
}

func TestReadJSON_DecryptError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(path, []byte("not-decryptable"), 0600); err != nil {
		t.Fatal(err)
	}
	c, _ := NewCodecFromBase64(testKey())
	var target []string
	if err := ReadJSON(path, c, &target); err == nil {
		t.Fatal("expected decrypt error")
	}
}

func TestReadJSON_InvalidJSONTarget(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "plaintext.json")
	if err := os.WriteFile(path, []byte("not-json"), 0600); err != nil {
		t.Fatal(err)
	}
	var target []string
	if err := ReadJSON(path, DefaultCodec(), &target); err == nil {
		t.Fatal("expected json unmarshal error")
	}
}

func TestWriteJSONAtomic_MkdirsParent(t *testing.T) {
	dir := t.TempDir()
	nested := filepath.Join(dir, "a", "b", "c", "out.json")
	if err := WriteJSONAtomic(nested, DefaultCodec(), map[string]int{"x": 1}); err != nil {
		t.Fatalf("WriteJSONAtomic: %v", err)
	}
	if _, err := os.Stat(nested); err != nil {
		t.Fatalf("file not created: %v", err)
	}
}

func TestWriteJSONAtomic_MarshalError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "out.json")
	// channels cannot be JSON marshaled.
	ch := make(chan int)
	if err := WriteJSONAtomic(path, DefaultCodec(), ch); err == nil {
		t.Fatal("expected marshal error for unsupported type")
	}
}

func TestWriteJSONAtomic_MkdirError(t *testing.T) {
	dir := t.TempDir()
	// Create a file where a directory is expected in the path.
	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	// Put the target under the blocker file -> MkdirAll should fail.
	target := filepath.Join(blocker, "nested", "out.json")
	if err := WriteJSONAtomic(target, DefaultCodec(), map[string]int{"x": 1}); err == nil {
		t.Fatal("expected MkdirAll error when parent path is a file")
	}
}

func TestWriteJSONAtomic_DefaultCodecPlaintext(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "plain.json")
	if err := WriteJSONAtomic(path, DefaultCodec(), []int{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// DefaultCodec passthrough — raw bytes should be the JSON-indented form.
	if len(raw) == 0 {
		t.Fatal("expected non-empty file")
	}
	if raw[0] != '[' {
		t.Fatalf("expected raw JSON, got %q", raw)
	}
}

// ── WriteJSONAtomic coverage ───────────────────────────────────────────────

func TestWriteJSONAtomic_Success(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.json")
	codec, _ := NewCodecFromBase64(testKey())
	err := WriteJSONAtomic(path, codec, map[string]string{"key": "value"})
	if err != nil {
		t.Fatalf("WriteJSONAtomic: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("file not created: %v", err)
	}
}

func TestWriteJSONAtomic_NestedDir_Created(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "dir", "test.json")
	codec, _ := NewCodecFromBase64(testKey())
	if err := WriteJSONAtomic(path, codec, struct{ X int }{42}); err != nil {
		t.Fatalf("WriteJSONAtomic nested: %v", err)
	}
}

func TestWriteJSONAtomic_InvalidPath_ReturnsError(t *testing.T) {
	codec, _ := NewCodecFromBase64(testKey())
	// Null byte in path is invalid on all platforms
	err := WriteJSONAtomic("/dev/null/\x00/invalid", codec, "data")
	if err == nil {
		t.Error("expected error for invalid path")
	}
}
