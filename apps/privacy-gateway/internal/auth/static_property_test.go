package auth

import (
	"net/http/httptest"
	"strings"
	"testing"
	"testing/quick"

	"privacy-gateway/internal/model"
)

// ── Property: Authenticate never panics ──────────────────────
func TestProperty_Authenticate_NoPanic(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{
		"tok-1": {ID: "u1", TenantID: "t1"},
	})
	f := func(header string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on header %q: %v", header, r)
			}
		}()
		req := httptest.NewRequest("GET", "/x", nil)
		req.Header.Set("Authorization", header)
		_, _ = a.Authenticate(req)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: deterministic — same header → same outcome ─────
func TestProperty_Authenticate_Deterministic(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{
		"tok-1": {ID: "u1", TenantID: "t1"},
	})
	f := func(header string) bool {
		req1 := httptest.NewRequest("GET", "/x", nil)
		req1.Header.Set("Authorization", header)
		req2 := httptest.NewRequest("GET", "/x", nil)
		req2.Header.Set("Authorization", header)
		a1, e1 := a.Authenticate(req1)
		a2, e2 := a.Authenticate(req2)
		return a1 == a2 && (e1 == nil) == (e2 == nil)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: missing/empty header → ErrUnauthorized ─────────
func TestProperty_Authenticate_MissingHeader(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{"tok-1": {ID: "u1"}})
	for _, h := range []string{"", "   ", "\t"} {
		req := httptest.NewRequest("GET", "/x", nil)
		if h != "" {
			req.Header.Set("Authorization", h)
		}
		if _, err := a.Authenticate(req); err != ErrUnauthorized {
			t.Fatalf("header %q: want ErrUnauthorized, got %v", h, err)
		}
	}
}

// ── Property: non-Bearer scheme → ErrUnauthorized ────────────
func TestProperty_Authenticate_NonBearerRejected(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{"tok-1": {ID: "u1"}})
	bad := []string{
		"Basic tok-1",
		"Digest tok-1",
		"Token tok-1",
		"bearer tok-1",   // lowercase
		"BEARER tok-1",   // uppercase
		"tok-1",          // no scheme
		"Bear tok-1",     // prefix-only
	}
	for _, h := range bad {
		req := httptest.NewRequest("GET", "/x", nil)
		req.Header.Set("Authorization", h)
		if _, err := a.Authenticate(req); err != ErrUnauthorized {
			t.Fatalf("header %q: want ErrUnauthorized, got %v", h, err)
		}
	}
}

// ── Property: unknown tokens rejected ────────────────────────
func TestProperty_Authenticate_UnknownTokenRejected(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{"tok-1": {ID: "u1"}})
	f := func(token string) bool {
		// Only care about tokens that differ from the registered one.
		if strings.TrimSpace(token) == "tok-1" {
			return true
		}
		req := httptest.NewRequest("GET", "/x", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		_, err := a.Authenticate(req)
		return err == ErrUnauthorized
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: every registered token → corresponding actor ───
func TestProperty_Authenticate_RegisteredTokensAccepted(t *testing.T) {
	tokens := map[string]model.Actor{
		"t-alpha": {ID: "u-alpha", TenantID: "ten-1"},
		"t-bravo": {ID: "u-bravo", TenantID: "ten-2"},
		"t-charlie-with-dashes": {ID: "u-c", TenantID: "ten-3"},
	}
	a := NewStaticTokenAuthenticator(tokens)
	for tok, expected := range tokens {
		req := httptest.NewRequest("GET", "/x", nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		actor, err := a.Authenticate(req)
		if err != nil {
			t.Fatalf("token %q: unexpected err %v", tok, err)
		}
		if actor != expected {
			t.Fatalf("token %q: want actor %+v, got %+v", tok, expected, actor)
		}
	}
}

// ── Property: whitespace around token tolerated ──────────────
func TestProperty_Authenticate_WhitespaceAroundToken(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{"tok-1": {ID: "u1"}})
	variants := []string{
		"Bearer tok-1",
		"Bearer  tok-1",  // extra space after scheme — TrimSpace on suffix
		"Bearer tok-1 ",  // trailing space
		"  Bearer tok-1", // leading whitespace on whole header
	}
	for _, h := range variants {
		req := httptest.NewRequest("GET", "/x", nil)
		req.Header.Set("Authorization", h)
		_, err := a.Authenticate(req)
		if err != nil {
			t.Fatalf("header %q: want success, got %v", h, err)
		}
	}
}

// ── Property: case-sensitive token match ─────────────────────
// Tokens are an exact-match map lookup; uppercase ≠ lowercase.
func TestProperty_Authenticate_CaseSensitive(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{"tok-1": {ID: "u1"}})
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("Authorization", "Bearer TOK-1")
	if _, err := a.Authenticate(req); err != ErrUnauthorized {
		t.Fatalf("uppercase token: want ErrUnauthorized, got %v", err)
	}
}

// ── Property: error path returns zero Actor ──────────────────
// Security invariant: no stale actor leaked on failure.
func TestProperty_Authenticate_ZeroActorOnError(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{"tok-1": {ID: "u1", TenantID: "t1"}})
	bad := []string{"", "Basic x", "Bearer unknown", "garbage"}
	for _, h := range bad {
		req := httptest.NewRequest("GET", "/x", nil)
		if h != "" {
			req.Header.Set("Authorization", h)
		}
		actor, err := a.Authenticate(req)
		if err == nil {
			continue
		}
		if actor != (model.Actor{}) {
			t.Fatalf("header %q errored but leaked actor %+v", h, actor)
		}
	}
}

// ── Property: empty token map rejects everything ─────────────
func TestProperty_Authenticate_EmptyTokenMap(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{})
	f := func(token string) bool {
		req := httptest.NewRequest("GET", "/x", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		_, err := a.Authenticate(req)
		return err == ErrUnauthorized
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: nil request panics or errors — documented behavior ─
// NewStaticTokenAuthenticator + Authenticate must behave consistently
// for all valid http.Request objects. We test with an empty-body req
// to cover the "no auth header" case explicitly.
func TestProperty_Authenticate_NoAuthHeaderSet(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{"tok-1": {ID: "u1"}})
	req := httptest.NewRequest("GET", "/x", nil)
	// Do NOT set Authorization header.
	if _, err := a.Authenticate(req); err != ErrUnauthorized {
		t.Fatalf("no auth header: want ErrUnauthorized, got %v", err)
	}
}
