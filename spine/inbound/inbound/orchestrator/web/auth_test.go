package web

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// ── secureCompare ──

func TestSecureCompare_EqualStrings(t *testing.T) {
	if !secureCompare("abc", "abc") {
		t.Error("equal strings should match")
	}
}

func TestSecureCompare_DifferentStrings(t *testing.T) {
	if secureCompare("abc", "xyz") {
		t.Error("different strings should not match")
	}
}

func TestSecureCompare_DifferentLengths(t *testing.T) {
	if secureCompare("short", "muchlongerstring") {
		t.Error("different-length strings should not match")
	}
}

func TestSecureCompare_EmptyStrings(t *testing.T) {
	if !secureCompare("", "") {
		t.Error("two empty strings should match")
	}
}

func TestSecureCompare_EmptyVsNonEmpty(t *testing.T) {
	if secureCompare("", "x") {
		t.Error("empty vs non-empty should not match")
	}
}

func TestSecureCompare_LongAPIKey(t *testing.T) {
	key := "sk-live-abcdef1234567890abcdef1234567890abcdef1234567890"
	if !secureCompare(key, key) {
		t.Error("identical long keys should match")
	}
	if secureCompare(key, key+"x") {
		t.Error("key with appended char should not match")
	}
}

// ── apiKeyAuth middleware ──

func TestAPIKeyAuth_NoKeyConfigured(t *testing.T) {
	os.Unsetenv("OUTREACH_API_KEY")
	called := false
	handler := apiKeyAuth(func(w http.ResponseWriter, r *http.Request) { called = true })

	req := httptest.NewRequest("GET", "/health", nil)
	req.Header.Set("X-API-Key", "anything")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("no API_KEY configured: expected 500, got %d", w.Code)
	}
	if called { t.Error("inner handler should not be called") }
}

func TestAPIKeyAuth_MissingHeader(t *testing.T) {
	os.Setenv("OUTREACH_API_KEY", "secret")
	defer os.Unsetenv("OUTREACH_API_KEY")

	called := false
	handler := apiKeyAuth(func(w http.ResponseWriter, r *http.Request) { called = true })

	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("missing header: expected 401, got %d", w.Code)
	}
	if called { t.Error("inner handler should not be called") }
}

func TestAPIKeyAuth_WrongKey(t *testing.T) {
	os.Setenv("OUTREACH_API_KEY", "correct-key")
	defer os.Unsetenv("OUTREACH_API_KEY")

	called := false
	handler := apiKeyAuth(func(w http.ResponseWriter, r *http.Request) { called = true })

	req := httptest.NewRequest("GET", "/health", nil)
	req.Header.Set("X-API-Key", "wrong-key")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("wrong key: expected 403, got %d", w.Code)
	}
	if called { t.Error("inner handler should not be called") }
}

func TestAPIKeyAuth_CorrectKey(t *testing.T) {
	os.Setenv("OUTREACH_API_KEY", "my-secret-key")
	defer os.Unsetenv("OUTREACH_API_KEY")

	called := false
	handler := apiKeyAuth(func(w http.ResponseWriter, r *http.Request) { called = true })

	req := httptest.NewRequest("GET", "/health", nil)
	req.Header.Set("X-API-Key", "my-secret-key")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("correct key: expected 200, got %d", w.Code)
	}
	if !called { t.Error("inner handler should have been called") }
}
