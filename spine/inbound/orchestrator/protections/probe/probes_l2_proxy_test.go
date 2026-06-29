package probe

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestProxyPoolL2_WorkingAbove3_OK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"working":[{},{},{},{}]}`))
	}))
	defer srv.Close()

	p := &ProxyPoolL2{BFFURL: srv.URL, Cadence: 30 * time.Second}
	r := p.Run(context.Background())
	if r.Status != StatusOK {
		t.Fatalf("expected ok (4 working), got %s: %s", r.Status, r.Detail)
	}
}

func TestProxyPoolL2_Working1_Warn(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"working":[{}]}`))
	}))
	defer srv.Close()

	p := &ProxyPoolL2{BFFURL: srv.URL, Cadence: 30 * time.Second}
	r := p.Run(context.Background())
	if r.Status != StatusWarn {
		t.Fatalf("expected warn (1 working), got %s", r.Status)
	}
}

func TestProxyPoolL2_Working0_Err(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"working":[]}`))
	}))
	defer srv.Close()

	p := &ProxyPoolL2{BFFURL: srv.URL, Cadence: 30 * time.Second}
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("expected err (0 working), got %s", r.Status)
	}
}

func TestProxyPoolL2_HTTP500_Err(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
	}))
	defer srv.Close()

	p := &ProxyPoolL2{BFFURL: srv.URL, Cadence: 30 * time.Second}
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("expected err on 500, got %s", r.Status)
	}
}

func TestProxyPoolL2_APIKeyHeader(t *testing.T) {
	var gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("X-API-Key")
		_, _ = w.Write([]byte(`{"working":[{},{},{}]}`))
	}))
	defer srv.Close()

	p := &ProxyPoolL2{BFFURL: srv.URL, APIKey: "secret", Cadence: 30 * time.Second}
	p.Run(context.Background())
	if gotKey != "secret" {
		t.Fatalf("expected X-API-Key=secret, got %q", gotKey)
	}
}

func TestProxyPoolL2_NetworkErr(t *testing.T) {
	p := &ProxyPoolL2{BFFURL: "http://127.0.0.1:1", Cadence: 5 * time.Second}
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("expected err on refused conn, got %s", r.Status)
	}
}
