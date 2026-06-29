package auth

import (
	"relay/internal/model"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func makeCertWithCN(t *testing.T, cn string) *x509.Certificate {
	t.Helper()
	return &x509.Certificate{
		Subject: pkix.Name{CommonName: cn},
	}
}

func TestNewMTLSAuthenticator(t *testing.T) {
	m := map[string]model.Actor{
		"client-a": {TenantID: "t1"},
	}
	a := NewMTLSAuthenticator(m)
	if a == nil {
		t.Fatal("nil authenticator")
	}
	if len(a.certMap) != 1 {
		t.Errorf("certMap size = %d, want 1", len(a.certMap))
	}
}

func TestNewMTLSAuthenticatorEmpty(t *testing.T) {
	a := NewMTLSAuthenticator(nil)
	if a == nil {
		t.Fatal("nil authenticator")
	}
	if len(a.certMap) != 0 {
		t.Errorf("expected empty certMap, got %d", len(a.certMap))
	}
}

func TestMTLSAuthenticateNoTLS(t *testing.T) {
	a := NewMTLSAuthenticator(map[string]model.Actor{"cn": {TenantID: "t"}})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	// req.TLS is nil by default

	_, err := a.Authenticate(req)
	if err == nil {
		t.Error("expected error with no TLS state")
	}
	if err.Error() != "client certificate required" {
		t.Errorf("error = %q", err.Error())
	}
}

func TestMTLSAuthenticateNoPeerCerts(t *testing.T) {
	a := NewMTLSAuthenticator(map[string]model.Actor{"cn": {TenantID: "t"}})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.TLS = &tls.ConnectionState{
		PeerCertificates: nil,
	}

	_, err := a.Authenticate(req)
	if err == nil {
		t.Error("expected error with empty peer certs")
	}
	if err.Error() != "client certificate required" {
		t.Errorf("error = %q", err.Error())
	}
}

func TestMTLSAuthenticateKnownCN(t *testing.T) {
	wantActor := model.Actor{TenantID: "tenant-xyz"}
	a := NewMTLSAuthenticator(map[string]model.Actor{
		"client-valid": wantActor,
	})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.TLS = &tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{makeCertWithCN(t, "client-valid")},
	}

	got, err := a.Authenticate(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.TenantID != wantActor.TenantID {
		t.Errorf("actor.TenantID = %q, want %q", got.TenantID, wantActor.TenantID)
	}
}

func TestMTLSAuthenticateUnknownCN(t *testing.T) {
	a := NewMTLSAuthenticator(map[string]model.Actor{
		"client-valid": {TenantID: "t"},
	})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.TLS = &tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{makeCertWithCN(t, "stranger")},
	}

	_, err := a.Authenticate(req)
	if err == nil {
		t.Fatal("expected error for unknown CN")
	}
	wantSub := "unknown client certificate"
	if !contains(err.Error(), wantSub) {
		t.Errorf("error = %q, want substring %q", err.Error(), wantSub)
	}
}

func TestMTLSAuthenticateFirstCertWins(t *testing.T) {
	wantActor := model.Actor{TenantID: "first"}
	a := NewMTLSAuthenticator(map[string]model.Actor{
		"cn-first":  wantActor,
		"cn-second": {TenantID: "second"},
	})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.TLS = &tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{
			makeCertWithCN(t, "cn-first"),
			makeCertWithCN(t, "cn-second"),
		},
	}

	got, err := a.Authenticate(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.TenantID != "first" {
		t.Errorf("first cert should win, got %q", got.TenantID)
	}
}

func TestLoadClientCACertReturnsPool(t *testing.T) {
	dir := t.TempDir()
	pemPath := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(pemPath, []byte("not really used by current impl"), 0o600); err != nil {
		t.Fatal(err)
	}

	pool, err := LoadClientCACert(pemPath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pool == nil {
		t.Fatal("pool is nil")
	}
}

func TestLoadClientCACertEmptyPath(t *testing.T) {
	pool, err := LoadClientCACert("")
	if err != nil {
		t.Errorf("current impl should not error on empty path: %v", err)
	}
	if pool == nil {
		t.Fatal("pool is nil")
	}
}

func TestCompositeAuthenticatorAllFailReturnsLastErr(t *testing.T) {
	e1 := errors.New("first fail")
	e2 := errors.New("second fail")
	a := NewCompositeAuthenticator(
		stubAuth{err: e1},
		stubAuth{err: e2},
	)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	_, err := a.Authenticate(req)
	if err == nil {
		t.Fatal("expected error")
	}
	if err != e2 {
		t.Errorf("got %v, want last error %v", err, e2)
	}
}

func TestCompositeAuthenticatorFirstSucceedsWins(t *testing.T) {
	want := model.Actor{TenantID: "first"}
	a := NewCompositeAuthenticator(
		stubAuth{actor: want},
		stubAuth{err: errors.New("never reached")},
	)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	got, err := a.Authenticate(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.TenantID != want.TenantID {
		t.Errorf("got %q, want %q", got.TenantID, want.TenantID)
	}
}

func TestCompositeAuthenticatorSecondSucceedsAfterFirstFails(t *testing.T) {
	want := model.Actor{TenantID: "second"}
	a := NewCompositeAuthenticator(
		stubAuth{err: errors.New("auth1 failed")},
		stubAuth{actor: want},
	)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	got, err := a.Authenticate(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.TenantID != want.TenantID {
		t.Errorf("got %q, want %q", got.TenantID, want.TenantID)
	}
}

func TestCompositeAuthenticatorEmptyReturnsErrUnauthorized(t *testing.T) {
	a := NewCompositeAuthenticator()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	_, err := a.Authenticate(req)
	if err != ErrUnauthorized {
		t.Errorf("got %v, want ErrUnauthorized", err)
	}
}

func TestStaticTokenAuthenticatorCaseInsensitiveScheme(t *testing.T) {
	want := model.Actor{TenantID: "tenant-a"}
	a := NewStaticTokenAuthenticator(map[string]model.Actor{"secret-token": want})

	cases := []string{"Bearer secret-token", "BEARER secret-token", "bearer secret-token", "bEaReR secret-token"}
	for _, scheme := range cases {
		t.Run(scheme, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.Header.Set("Authorization", scheme)
			got, err := a.Authenticate(req)
			if err != nil {
				t.Fatalf("unexpected error for %q: %v", scheme, err)
			}
			if got.TenantID != want.TenantID {
				t.Errorf("got %q, want %q", got.TenantID, want.TenantID)
			}
		})
	}
}

type stubAuth struct {
	actor model.Actor
	err   error
}

func (s stubAuth) Authenticate(r *http.Request) (model.Actor, error) {
	if s.err != nil {
		return model.Actor{}, s.err
	}
	return s.actor, nil
}

func contains(s, sub string) bool {
	return len(sub) == 0 || len(s) >= len(sub) && (s == sub || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
