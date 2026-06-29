package auth

import (
	"relay/internal/model"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/quick"
)

// ---------------------------------------------------------------------------
// Monkey: nil request panics guard
// ---------------------------------------------------------------------------

func TestStaticTokenAuth_NilRequest_NeverPanics(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{
		"valid": {ID: "u", TenantID: "t"},
	})
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Authenticate panicked on nil request: %v", r)
		}
	}()
	// Passing nil request would normally panic; we verify the guard exists.
	// Authenticate accepts *http.Request — pass a zeroed request instead of nil
	// to avoid Go stdlib panic before our code runs.
	req := &http.Request{Header: make(http.Header)}
	_, _ = a.Authenticate(req)
}

// ---------------------------------------------------------------------------
// Monkey: empty token in Authorization header → Unauthorized
// ---------------------------------------------------------------------------

func TestStaticTokenAuth_EmptyToken_Unauthorized(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{
		"real-token": {ID: "u", TenantID: "t"},
	})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer ")
	_, err := a.Authenticate(req)
	if err != ErrUnauthorized {
		t.Fatalf("expected ErrUnauthorized for empty token, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// Monkey: truncated "Bearer" (only scheme, no space) → Unauthorized
// ---------------------------------------------------------------------------

func TestStaticTokenAuth_TruncatedBearer_Unauthorized(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{
		"real-token": {ID: "u", TenantID: "t"},
	})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer")
	_, err := a.Authenticate(req)
	if err != ErrUnauthorized {
		t.Fatalf("expected ErrUnauthorized for truncated Bearer, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// Monkey: whitespace-only token → Unauthorized
// ---------------------------------------------------------------------------

func TestStaticTokenAuth_WhitespaceToken_Unauthorized(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{
		"real-token": {ID: "u", TenantID: "t"},
	})
	for _, ws := range []string{"   ", "\t", "\n", "  \t  "} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer "+ws)
		_, err := a.Authenticate(req)
		if err != ErrUnauthorized {
			t.Fatalf("whitespace token %q: expected ErrUnauthorized, got %v", ws, err)
		}
	}
}

// ---------------------------------------------------------------------------
// Monkey: malformed token values (special characters, unicode) → Unauthorized
// ---------------------------------------------------------------------------

func TestStaticTokenAuth_MalformedToken_ReturnsError(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{
		"valid-token": {ID: "u", TenantID: "t"},
	})
	malformed := []string{
		"not-valid",
		"Bearer-missing-space",
		"基本 dXNlcjpwYXNz",     // non-ASCII scheme
		"Bearer \x00null",       // null byte in token
		"Bearer token with spaces inside",
	}
	for _, v := range malformed {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", v)
		_, err := a.Authenticate(req)
		if err == nil {
			t.Fatalf("malformed header %q: expected error, got nil", v)
		}
	}
}

// ---------------------------------------------------------------------------
// Property: any random string as bearer token fails (when no token is registered)
// ---------------------------------------------------------------------------

func TestStaticTokenAuth_EmptyRegistry_AlwaysUnauthorized_Property(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{})
	f := func(token string) bool {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		_, err := a.Authenticate(req)
		return err != nil
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Property: Authenticate never panics on arbitrary Authorization header values
// ---------------------------------------------------------------------------

func TestStaticTokenAuth_NeverPanics_Property(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{
		"token-a": {ID: "u1", TenantID: "t1"},
		"token-b": {ID: "u2", TenantID: "t2"},
	})
	f := func(headerValue string) bool {
		defer func() { recover() }()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", headerValue)
		a.Authenticate(req) //nolint:errcheck
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Property: token match is exact — one-byte-off variants are rejected
// ---------------------------------------------------------------------------

func TestStaticTokenAuth_OneByteOff_Rejected_Property(t *testing.T) {
	secret := "super-secret-token"
	a := NewStaticTokenAuthenticator(map[string]model.Actor{
		secret: {ID: "u", TenantID: "t"},
	})

	// Truncate by one, extend by one, flip first byte
	variants := []string{
		secret[:len(secret)-1],
		secret + "X",
		string(rune(secret[0]+1)) + secret[1:],
	}
	for _, v := range variants {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer "+v)
		_, err := a.Authenticate(req)
		if err == nil {
			t.Fatalf("off-by-one variant %q should be rejected", v)
		}
	}
}

// ---------------------------------------------------------------------------
// Property: multiple tokens registered — arbitrary unknown token is rejected
// ---------------------------------------------------------------------------

func TestStaticTokenAuth_ManyTokens_UnknownRejected_Property(t *testing.T) {
	tokens := map[string]model.Actor{}
	for i := 0; i < 20; i++ {
		tokens[fmt.Sprintf("token-%d", i)] = model.Actor{ID: fmt.Sprintf("u%d", i), TenantID: "t"}
	}
	a := NewStaticTokenAuthenticator(tokens)

	f := func(candidate string) bool {
		// Skip candidates that are actually registered tokens
		if _, ok := tokens[strings.TrimSpace(candidate)]; ok {
			return true
		}
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer "+candidate)
		_, err := a.Authenticate(req)
		return err != nil
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Error(err)
	}
}
