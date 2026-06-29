package filestore

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func testKey() string {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 10)
	}
	return base64.StdEncoding.EncodeToString(key)
}

func TestDefaultCodecPassthrough(t *testing.T) {
	c := DefaultCodec()
	data := []byte("hello world")

	encrypted, err := c.Encrypt(data)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encrypted, data) {
		t.Fatal("DefaultCodec should passthrough")
	}

	decrypted, err := c.Decrypt(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decrypted, data) {
		t.Fatal("DefaultCodec decrypt should passthrough")
	}
}

func TestEncryptDecrypt(t *testing.T) {
	c, err := NewCodecFromBase64(testKey())
	if err != nil {
		t.Fatal(err)
	}

	data := []byte("sensitive data")
	encrypted, err := c.Encrypt(data)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(encrypted, data) {
		t.Fatal("encrypted should differ from plaintext")
	}

	decrypted, err := c.Decrypt(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decrypted, data) {
		t.Fatalf("decrypted mismatch: %q vs %q", decrypted, data)
	}
}

func TestEncryptedFormat(t *testing.T) {
	c, _ := NewCodecFromBase64(testKey())
	encrypted, _ := c.Encrypt([]byte("test"))

	var env encryptedEnvelope
	if err := json.Unmarshal(encrypted, &env); err != nil {
		t.Fatalf("encrypted data should be valid JSON envelope: %v", err)
	}
	if env.Version != 1 {
		t.Fatalf("expected version 1, got %d", env.Version)
	}
	if env.Algorithm != "aes-256-gcm" {
		t.Fatalf("expected aes-256-gcm, got %s", env.Algorithm)
	}
}

func TestInvalidKeyLength(t *testing.T) {
	short := base64.StdEncoding.EncodeToString([]byte("short"))
	_, err := NewCodecFromBase64(short)
	if err == nil {
		t.Fatal("expected error for short key")
	}
}

func TestEmptyKeyReturnsDefault(t *testing.T) {
	c, err := NewCodecFromBase64("")
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("test")
	encrypted, _ := c.Encrypt(data)
	if !bytes.Equal(encrypted, data) {
		t.Fatal("empty key should return DefaultCodec")
	}
}

func TestWriteAndReadJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.json")
	c, _ := NewCodecFromBase64(testKey())

	type testData struct {
		Name  string `json:"name"`
		Value int    `json:"value"`
	}

	original := testData{Name: "test", Value: 42}
	if err := WriteJSONAtomic(path, c, original); err != nil {
		t.Fatal(err)
	}

	// Raw file should be encrypted
	raw, _ := os.ReadFile(path)
	if bytes.Contains(raw, []byte("test")) {
		t.Fatal("file should be encrypted, but contains plaintext")
	}

	var loaded testData
	if err := ReadJSON(path, c, &loaded); err != nil {
		t.Fatal(err)
	}
	if loaded.Name != "test" || loaded.Value != 42 {
		t.Fatalf("loaded data mismatch: %+v", loaded)
	}
}

func TestReadNonExistentFileReturnsNil(t *testing.T) {
	var result []string
	err := ReadJSON("/nonexistent/path.json", DefaultCodec(), &result)
	if err != nil {
		t.Fatal(err)
	}
	if result != nil {
		t.Fatal("expected nil for nonexistent file")
	}
}
