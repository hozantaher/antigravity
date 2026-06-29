package transport

// final_gaps_test.go covers the last uncovered statement groups:
//   1. savePool: json.Marshal error via jsonMarshal seam
//   2. probeSmtpAuth: smtp.NewClient failure path
//   3. runRefreshTicker: ticker-fires + refresh-error → slog.Warn path

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// savePool — json.Marshal error via jsonMarshal seam
// ---------------------------------------------------------------------------

// TestSavePool_MarshalError covers the `slog.Warn("failed to marshal")` branch
// by injecting a marshal failure via the jsonMarshal seam.
func TestSavePool_MarshalError(t *testing.T) {
	orig := jsonMarshal
	jsonMarshal = func(v any) ([]byte, error) {
		return nil, errors.New("injected marshal error")
	}
	defer func() { jsonMarshal = orig }()

	setTempPersistPath(t)
	// Must not panic even when marshal fails.
	savePool([]proxyEntry{{addr: "1.1.1.1:1080"}})
}

// ---------------------------------------------------------------------------
// probeSmtpAuth — smtp.NewClient failure path
// ---------------------------------------------------------------------------

// TestProbeSmtpAuth_SmtpNewClientFails exercises the path where TLS succeeds
// but smtp.NewClient fails (server closes without sending "220" greeting).
//
// We use a raw TLS listener with a self-signed cert (from httptest), complete
// the TLS handshake on the server side, then close without sending "220".
// The client uses InsecureSkipVerify so TLS passes but smtp.NewClient fails
// waiting for the greeting.
func TestProbeSmtpAuth_SmtpNewClientFails(t *testing.T) {
	// Borrow httptest's TLS config for a self-signed cert.
	dummySrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	tlsCert := dummySrv.TLS.Certificates[0]
	dummySrv.Close()

	serverTLSCfg := &tls.Config{Certificates: []tls.Certificate{tlsCert}}
	tlsLn, err := tls.Listen("tcp", "127.0.0.1:0", serverTLSCfg)
	if err != nil {
		t.Fatalf("tls.Listen: %v", err)
	}
	defer tlsLn.Close()

	go func() {
		conn, err := tlsLn.Accept()
		if err != nil {
			return
		}
		// Complete TLS handshake (Accept does this automatically for tls.Conn).
		if tc, ok := conn.(*tls.Conn); ok {
			_ = tc.Handshake()
		}
		// Close WITHOUT sending "220" greeting — smtp.NewClient will fail.
		conn.Close()
	}()

	origOverride := smtpAuthDialOverride
	origTLS := smtpAuthTLSConfigOverride
	defer func() {
		smtpAuthDialOverride = origOverride
		smtpAuthTLSConfigOverride = origTLS
	}()

	// InsecureSkipVerify so TLS handshake passes with self-signed cert.
	smtpAuthTLSConfigOverride = &tls.Config{InsecureSkipVerify: true}
	smtpAuthDialOverride = func(ctx context.Context, proxyAddr string) (net.Conn, error) {
		return net.DialTimeout("tcp", tlsLn.Addr().String(), 2*time.Second)
	}

	cfg := smtpProbeCredentials{host: "127.0.0.1", username: "u", password: "p"}
	result := probeSmtpAuth(context.Background(), NewDirectTransport(), cfg, "test")
	if result {
		t.Fatal("expected false when server closes after TLS without sending 220")
	}
}

// TestProbeSmtpAuth_CtxWithDeadline exercises the deadline branch:
// `if deadline, ok := ctx.Deadline(); ok { _ = conn.SetDeadline(deadline) }`.
func TestProbeSmtpAuth_CtxWithDeadline(t *testing.T) {
	origOverride := smtpAuthDialOverride
	defer func() { smtpAuthDialOverride = origOverride }()

	clientConn, serverConn := net.Pipe()
	go func() { serverConn.Close() }()

	smtpAuthDialOverride = func(ctx context.Context, proxyAddr string) (net.Conn, error) {
		return clientConn, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cfg := smtpProbeCredentials{host: "smtp.example.com", username: "u", password: "p"}
	_ = probeSmtpAuth(ctx, NewDirectTransport(), cfg, "test")
	// Must not panic. Deadline path exercises `conn.SetDeadline(deadline)`.
}

// ---------------------------------------------------------------------------
// runRefreshTicker — ticker-fires + refresh-error → slog.Warn path
// ---------------------------------------------------------------------------

// TestRunRefreshTicker_RefreshErrorOnTick exercises the
// `slog.Warn("proxy_pool: ticker refresh failed")` branch by having the
// ticker fire when all proxy sources are unreachable.
func TestRunRefreshTicker_RefreshErrorOnTick(t *testing.T) {
	// Point all sources at unreachable endpoints so refresh() returns error.
	origGeo, origPS, origPF, origPFFB := proxyListEndpoint, proxyscrapeEndpoint, proxiflyEndpoint, proxiflyFallbackURL
	proxyListEndpoint = "http://127.0.0.1:1"
	proxyscrapeEndpoint = "http://127.0.0.1:1"
	proxiflyEndpoint = "http://127.0.0.1:1"
	proxiflyFallbackURL = "http://127.0.0.1:1"
	defer func() {
		proxyListEndpoint = origGeo
		proxyscrapeEndpoint = origPS
		proxiflyEndpoint = origPF
		proxiflyFallbackURL = origPFFB
	}()

	origTicker := tickerInterval
	tickerInterval = 10 * time.Millisecond
	defer func() { tickerInterval = origTicker }()

	tr := &RotatingProxyTransport{fallback: NewDirectTransport()}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	// runRefreshTicker blocks until ctx is cancelled; run in goroutine.
	done := make(chan struct{})
	go func() {
		defer close(done)
		tr.runRefreshTicker(ctx)
	}()

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("runRefreshTicker did not return after ctx cancel")
	}
	// If we get here, the ticker fired at least once, refresh returned error,
	// and the warning was logged. No panic or deadlock.
}

// TestProbeSmtpAuth_AuthLoginFails exercises the `c.Auth` failure path when
// the SMTP server rejects the AUTH LOGIN credentials (returns 535).
func TestProbeSmtpAuth_AuthLoginFails(t *testing.T) {
	// Build a minimal mock SMTP server that:
	// 1. Accepts TCP + TLS
	// 2. Sends "220 greeting"
	// 3. Accepts EHLO
	// 4. Responds "334 Username:" to AUTH LOGIN
	// 5. Rejects password with "535 5.7.8 authentication failed"
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()

	// Use a raw TLS listener to do our own SMTP conversation.
	tlsLn, err := tls.Listen("tcp", "127.0.0.1:0", srv.TLS)
	if err != nil {
		t.Fatalf("tls.Listen: %v", err)
	}
	defer tlsLn.Close()

	go func() {
		conn, err := tlsLn.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		// SMTP greeting
		conn.Write([]byte("220 mock.smtp.server ESMTP\r\n"))
		buf := make([]byte, 256)
		// Read EHLO
		conn.Read(buf)
		conn.Write([]byte("250-mock.smtp.server\r\n250 AUTH LOGIN\r\n"))
		// Read AUTH LOGIN
		conn.Read(buf)
		conn.Write([]byte("334 VXNlcm5hbWU6\r\n")) // base64("Username:")
		// Read username
		conn.Read(buf)
		conn.Write([]byte("334 UGFzc3dvcmQ6\r\n")) // base64("Password:")
		// Read password
		conn.Read(buf)
		// Reject
		conn.Write([]byte("535 5.7.8 Authentication credentials invalid\r\n"))
	}()

	origOverride := smtpAuthDialOverride
	origTLS := smtpAuthTLSConfigOverride
	defer func() {
		smtpAuthDialOverride = origOverride
		smtpAuthTLSConfigOverride = origTLS
	}()

	smtpAuthTLSConfigOverride = &tls.Config{InsecureSkipVerify: true}
	smtpAuthDialOverride = func(ctx context.Context, proxyAddr string) (net.Conn, error) {
		return net.DialTimeout("tcp", tlsLn.Addr().String(), 2*time.Second)
	}

	cfg := smtpProbeCredentials{host: "mock.smtp.server", username: "user", password: "wrong"}
	result := probeSmtpAuth(context.Background(), NewDirectTransport(), cfg, "test")
	if result {
		t.Fatal("expected false when AUTH LOGIN is rejected")
	}
}
