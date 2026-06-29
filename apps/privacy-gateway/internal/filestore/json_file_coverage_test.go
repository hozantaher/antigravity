package filestore

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestNewCodecFromBase64EmptyReturnsDefault covers the empty-value branch.
func TestNewCodecFromBase64EmptyReturnsDefault(t *testing.T) {
	codec, err := NewCodecFromBase64("")
	if err != nil {
		t.Fatalf("NewCodecFromBase64(\"\") error = %v", err)
	}
	if len(codec.key) != 0 {
		t.Fatalf("expected empty codec for empty input, got key len %d", len(codec.key))
	}
}

// TestNewCodecFromBase64WrongLength covers the 32-byte length validation on decoded bytes.
func TestNewCodecFromBase64WrongLength(t *testing.T) {
	value := base64.StdEncoding.EncodeToString([]byte("too-short"))
	if _, err := NewCodecFromBase64(value); err != ErrInvalidEncryptionKey {
		t.Fatalf("expected ErrInvalidEncryptionKey for wrong length, got %v", err)
	}
}

// TestNewCodecEmptyKeyReturnsDefault covers the empty-key branch of NewCodec.
func TestNewCodecEmptyKeyReturnsDefault(t *testing.T) {
	codec, err := NewCodec(nil)
	if err != nil {
		t.Fatalf("NewCodec(nil) error = %v", err)
	}
	if len(codec.key) != 0 {
		t.Fatalf("expected empty codec key, got len %d", len(codec.key))
	}
}

// TestReadJSONEmptyFileReturnsNil covers the empty-file short-circuit of ReadJSONWithCodec.
func TestReadJSONEmptyFileReturnsNil(t *testing.T) {
	path := filepath.Join(t.TempDir(), "empty.json")
	if err := os.WriteFile(path, []byte{}, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	var target map[string]string
	if err := ReadJSON(path, &target); err != nil {
		t.Fatalf("ReadJSON() empty file error = %v", err)
	}
}

// TestReadJSONWithCodecRejectsUnsupportedEnvelope covers the ErrUnsupportedEnvelope branch.
func TestReadJSONWithCodecRejectsUnsupportedEnvelope(t *testing.T) {
	path := filepath.Join(t.TempDir(), "future.json")

	envelope := map[string]any{
		"version":    2,
		"algorithm":  "aes-512-gcm",
		"nonce":      base64.StdEncoding.EncodeToString([]byte("nonceNonceNon")),
		"ciphertext": base64.StdEncoding.EncodeToString([]byte("ciphertextBytes!")),
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	codec, err := NewCodec([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("NewCodec() error = %v", err)
	}
	var target map[string]string
	if err := ReadJSONWithCodec(path, &target, codec); err != ErrUnsupportedEnvelope {
		t.Fatalf("expected ErrUnsupportedEnvelope, got %v", err)
	}
}

// TestReadJSONWithCodecRejectsInvalidNonceBase64 covers the nonce-decoding branch.
func TestReadJSONWithCodecRejectsInvalidNonceBase64(t *testing.T) {
	path := filepath.Join(t.TempDir(), "badnonce.json")

	envelope := map[string]any{
		"version":    1,
		"algorithm":  "aes-256-gcm",
		"nonce":      "!!!invalid base64!!!",
		"ciphertext": base64.StdEncoding.EncodeToString([]byte("ciphertextBytes!")),
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	codec, err := NewCodec([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("NewCodec() error = %v", err)
	}
	var target map[string]string
	if err := ReadJSONWithCodec(path, &target, codec); err == nil {
		t.Fatal("expected decode failure for invalid base64 nonce")
	}
}

// TestReadJSONWithCodecRejectsInvalidCiphertextBase64 covers the ciphertext-decoding branch.
func TestReadJSONWithCodecRejectsInvalidCiphertextBase64(t *testing.T) {
	path := filepath.Join(t.TempDir(), "badciphertext.json")

	envelope := map[string]any{
		"version":    1,
		"algorithm":  "aes-256-gcm",
		"nonce":      base64.StdEncoding.EncodeToString([]byte("123456789012")),
		"ciphertext": "@@not-base64@@",
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	codec, err := NewCodec([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("NewCodec() error = %v", err)
	}
	var target map[string]string
	if err := ReadJSONWithCodec(path, &target, codec); err == nil {
		t.Fatal("expected decode failure for invalid base64 ciphertext")
	}
}

// TestWriteJSONAtomicReturnsMkdirError covers the MkdirAll error branch by making
// a regular file occupy the parent directory path.
func TestWriteJSONAtomicReturnsMkdirError(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(parent, []byte("occupied"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	path := filepath.Join(parent, "nested", "state.json")
	if err := WriteJSONAtomic(path, map[string]string{"ok": "y"}); err == nil {
		t.Fatal("expected MkdirAll error")
	}
}

// TestWriteJSONAtomicReturnsMarshalError covers the MarshalIndent error branch
// by passing a non-marshalable value (a channel).
func TestWriteJSONAtomicReturnsMarshalError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	ch := make(chan int)
	if err := WriteJSONAtomic(path, ch); err == nil {
		t.Fatal("expected marshal error for channel value")
	}
}

// TestParseEnvelopeMissingFieldsReturnsPlaintext covers the envelope-missing-fields branch.
func TestParseEnvelopeMissingFieldsReturnsPlaintext(t *testing.T) {
	// nonce and ciphertext missing; parseEnvelope should return (_, false, nil).
	raw := []byte(`{"version":1,"algorithm":"aes-256-gcm"}`)
	_, encrypted, err := parseEnvelope(raw)
	if err != nil {
		t.Fatalf("parseEnvelope() error = %v", err)
	}
	if encrypted {
		t.Fatal("expected plaintext when nonce/ciphertext missing")
	}
}

// TestParseEnvelopeNonJSONReturnsPlaintext covers the json.Unmarshal error branch.
func TestParseEnvelopeNonJSONReturnsPlaintext(t *testing.T) {
	_, encrypted, err := parseEnvelope([]byte("plain string"))
	if err != nil {
		t.Fatalf("parseEnvelope() error = %v", err)
	}
	if encrypted {
		t.Fatal("expected plaintext for non-JSON input")
	}
}
