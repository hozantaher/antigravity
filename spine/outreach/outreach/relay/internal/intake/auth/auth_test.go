package auth

import (
	"relay/internal/model"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStaticTokenAuth(t *testing.T) {
	auth := NewStaticTokenAuthenticator(map[string]model.Actor{
		"valid-token": {ID: "user-1", TenantID: "tenant-1"},
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer valid-token")

	actor, err := auth.Authenticate(req)
	if err != nil {
		t.Fatal(err)
	}
	if actor.ID != "user-1" {
		t.Fatalf("expected user-1, got %s", actor.ID)
	}
}

func TestStaticTokenAuthRejectsInvalid(t *testing.T) {
	auth := NewStaticTokenAuthenticator(map[string]model.Actor{
		"valid-token": {ID: "user-1", TenantID: "tenant-1"},
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")

	_, err := auth.Authenticate(req)
	if err != ErrUnauthorized {
		t.Fatalf("expected ErrUnauthorized, got %v", err)
	}
}

func TestStaticTokenAuthNoHeader(t *testing.T) {
	auth := NewStaticTokenAuthenticator(map[string]model.Actor{
		"token": {ID: "user-1", TenantID: "t"},
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	_, err := auth.Authenticate(req)
	if err != ErrUnauthorized {
		t.Fatalf("expected ErrUnauthorized, got %v", err)
	}
}

func TestStaticTokenAuthBadFormat(t *testing.T) {
	auth := NewStaticTokenAuthenticator(map[string]model.Actor{
		"token": {ID: "user-1", TenantID: "t"},
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Basic dXNlcjpwYXNz")
	_, err := auth.Authenticate(req)
	if err != ErrUnauthorized {
		t.Fatalf("expected ErrUnauthorized for Basic auth, got %v", err)
	}
}

func TestCompositeAuthenticator(t *testing.T) {
	tokenAuth := NewStaticTokenAuthenticator(map[string]model.Actor{
		"token-a": {ID: "user-a", TenantID: "t"},
	})
	tokenAuth2 := NewStaticTokenAuthenticator(map[string]model.Actor{
		"token-b": {ID: "user-b", TenantID: "t"},
	})

	composite := NewCompositeAuthenticator(tokenAuth, tokenAuth2)

	// First auth matches
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer token-a")
	actor, err := composite.Authenticate(req)
	if err != nil || actor.ID != "user-a" {
		t.Fatalf("expected user-a, got %v / %v", actor, err)
	}

	// Second auth matches
	req2 := httptest.NewRequest(http.MethodGet, "/", nil)
	req2.Header.Set("Authorization", "Bearer token-b")
	actor2, err := composite.Authenticate(req2)
	if err != nil || actor2.ID != "user-b" {
		t.Fatalf("expected user-b, got %v / %v", actor2, err)
	}

	// Neither matches
	req3 := httptest.NewRequest(http.MethodGet, "/", nil)
	req3.Header.Set("Authorization", "Bearer unknown")
	_, err = composite.Authenticate(req3)
	if err == nil {
		t.Fatal("expected error for unknown token")
	}
}
