package auth

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"privacy-gateway/internal/model"
)

// W2-B — locks the rule that StaticTokenAuthenticator does NOT use Go
// map lookup on the bearer token (timing leak) and DOES use
// subtle.ConstantTimeCompare. Mirrors the pattern in
// services/relay/internal/intake/auth/auth.go.

func TestStaticAuth_ValidToken_AcceptsActor(t *testing.T) {
	want := model.Actor{TenantID: "t1", ID: "u1"}
	a := NewStaticTokenAuthenticator(map[string]model.Actor{
		"valid-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": want,
	})
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer valid-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	got, err := a.Authenticate(r)
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if got.TenantID != want.TenantID || got.ID != want.ID {
		t.Errorf("actor = %+v, want %+v", got, want)
	}
}

func TestStaticAuth_InvalidToken_Unauthorized(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{
		"valid-token": {TenantID: "t1", ID: "u1"},
	})
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer wrong-token")
	if _, err := a.Authenticate(r); err == nil {
		t.Error("expected ErrUnauthorized")
	}
}

func TestStaticAuth_NoAuthHeader_Unauthorized(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{"x": {}})
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if _, err := a.Authenticate(r); err == nil {
		t.Error("expected ErrUnauthorized")
	}
}

func TestStaticAuth_NonBearerScheme_Unauthorized(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{"x": {}})
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Basic dXNlcjpwYXNz")
	if _, err := a.Authenticate(r); err == nil {
		t.Error("expected ErrUnauthorized for Basic scheme")
	}
}

func TestStaticAuth_EmptyTokenAfterBearer_Unauthorized(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]model.Actor{"x": {}})
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer ")
	if _, err := a.Authenticate(r); err == nil {
		t.Error("expected ErrUnauthorized for empty token")
	}
}

func TestStaticAuth_MultipleTokens_PicksRightActor(t *testing.T) {
	alice := model.Actor{TenantID: "t1", ID: "alice"}
	bob := model.Actor{TenantID: "t2", ID: "bob"}
	a := NewStaticTokenAuthenticator(map[string]model.Actor{
		"alice-token-xxxxxxxxxxxxxxxxxxxxxxxx": alice,
		"bob-token-yyyyyyyyyyyyyyyyyyyyyyyyyy": bob,
	})

	r1 := httptest.NewRequest(http.MethodGet, "/", nil)
	r1.Header.Set("Authorization", "Bearer alice-token-xxxxxxxxxxxxxxxxxxxxxxxx")
	got, err := a.Authenticate(r1)
	if err != nil || got.ID != "alice" {
		t.Errorf("alice token: got %+v err %v", got, err)
	}

	r2 := httptest.NewRequest(http.MethodGet, "/", nil)
	r2.Header.Set("Authorization", "Bearer bob-token-yyyyyyyyyyyyyyyyyyyyyyyyyy")
	got, err = a.Authenticate(r2)
	if err != nil || got.ID != "bob" {
		t.Errorf("bob token: got %+v err %v", got, err)
	}
}

func TestStaticAuth_DifferentLengthToken_StillRejects(t *testing.T) {
	// ConstantTimeCompare returns 0 on length mismatch. Verify that
	// path: candidate longer/shorter than registered tokens → not auth.
	a := NewStaticTokenAuthenticator(map[string]model.Actor{
		"exactly-32-chars-aaaaaaaaaaaaaaaa": {ID: "u"},
	})
	for _, candidate := range []string{
		"short",
		"way-longer-than-the-registered-token-aaaaaaaaaa",
		"exactly-32-chars-aaaaaaaaaaaaaaab", // off by one byte
	} {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.Header.Set("Authorization", "Bearer "+candidate)
		if _, err := a.Authenticate(r); err == nil {
			t.Errorf("candidate %q: expected ErrUnauthorized", candidate)
		}
	}
}

// Source-level audit: the file MUST use subtle.ConstantTimeCompare and
// MUST NOT do a bare map lookup on the bearer token.
func TestStaticAuth_SourceAudit_ConstantTimeOnly(t *testing.T) {
	src, err := os.ReadFile("static.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(src)

	if !strings.Contains(s, "subtle.ConstantTimeCompare") {
		t.Error("static.go must use subtle.ConstantTimeCompare for token comparison")
	}
	if !strings.Contains(s, `"crypto/subtle"`) {
		t.Error("static.go must import crypto/subtle")
	}

	// Forbidden: `a.tokens[token]` — Go map lookup leaks timing on
	// the hash + bucket compare. The `tokens` field type changed from
	// map[string]Actor to []tokenEntry post-W2-B; if anyone reverts
	// the type the compile will fail anyway, but the audit checks
	// the code SHAPE.
	if strings.Contains(s, "a.tokens[token]") {
		t.Error("static.go reverted to a.tokens[token] map lookup — timing leak")
	}
}
