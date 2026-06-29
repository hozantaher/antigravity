package envconfig

import (
	"encoding/base64"
	"strings"
	"testing"
)

// Tests for RequireBase64Bytes — the boot-time validator used by the
// anti-trace anonymity bundle to seed MESSAGE_ID_HMAC_KEY.

func TestRequireBase64Bytes_Missing(t *testing.T) {
	t.Setenv("KEY_ABSENT", "")
	if _, err := RequireBase64Bytes("KEY_ABSENT", 32); err == nil {
		t.Error("missing env var must error")
	} else if !strings.Contains(err.Error(), "missing") {
		t.Errorf("missing-var error must mention 'missing', got %q", err.Error())
	}
}

func TestRequireBase64Bytes_StdEncodingPadded(t *testing.T) {
	raw := []byte("0123456789abcdef0123456789abcdef")
	t.Setenv("KEY_OK", base64.StdEncoding.EncodeToString(raw))
	got, err := RequireBase64Bytes("KEY_OK", 32)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if string(got) != string(raw) {
		t.Errorf("decoded mismatch: got %q want %q", got, raw)
	}
}

func TestRequireBase64Bytes_RawStdEncoding(t *testing.T) {
	raw := []byte("0123456789abcdef0123456789abcdef")
	// RawStdEncoding has no padding.
	t.Setenv("KEY_OK", base64.RawStdEncoding.EncodeToString(raw))
	got, err := RequireBase64Bytes("KEY_OK", 32)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if string(got) != string(raw) {
		t.Errorf("decoded mismatch")
	}
}

func TestRequireBase64Bytes_URLEncoding(t *testing.T) {
	raw := []byte("0123456789abcdef0123456789abcdef")
	t.Setenv("KEY_OK", base64.URLEncoding.EncodeToString(raw))
	got, err := RequireBase64Bytes("KEY_OK", 32)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if string(got) != string(raw) {
		t.Errorf("URL-base64 decoded mismatch")
	}
}

func TestRequireBase64Bytes_TooShort(t *testing.T) {
	short := []byte("short-key")
	t.Setenv("KEY_SHORT", base64.StdEncoding.EncodeToString(short))
	_, err := RequireBase64Bytes("KEY_SHORT", 32)
	if err == nil {
		t.Fatal("short key must error")
	}
	if !strings.Contains(err.Error(), "decodes to") {
		t.Errorf("short-key error must mention decoded length, got %q", err.Error())
	}
}

func TestRequireBase64Bytes_NotBase64(t *testing.T) {
	t.Setenv("KEY_BAD", "not!valid!base64")
	_, err := RequireBase64Bytes("KEY_BAD", 32)
	if err == nil {
		t.Fatal("non-base64 must error")
	}
	if !strings.Contains(err.Error(), "not valid base64") {
		t.Errorf("invalid-encoding error must mention base64, got %q", err.Error())
	}
}

func TestRequireBase64Bytes_TrimsWhitespace(t *testing.T) {
	// Operators sometimes paste with trailing newlines from shell heredocs.
	raw := []byte("0123456789abcdef0123456789abcdef")
	t.Setenv("KEY_OK", "  "+base64.StdEncoding.EncodeToString(raw)+"\n")
	got, err := RequireBase64Bytes("KEY_OK", 32)
	if err != nil {
		t.Fatalf("expected no error after trim, got %v", err)
	}
	if string(got) != string(raw) {
		t.Errorf("decode after trim mismatch")
	}
}
