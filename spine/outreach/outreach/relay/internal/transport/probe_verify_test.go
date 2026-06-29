package transport

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// TestVerifyTLSHandshake_Success confirms the probe verifier accepts a
// genuine TLS endpoint. httptest.StartTLS gives us a real certificate; we
// turn off verification via the test server's own Client so the handshake
// succeeds regardless of local trust store.
func TestVerifyTLSHandshake_Success(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()

	u, _ := url.Parse(srv.URL)
	conn, err := net.DialTimeout("tcp", u.Host, 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// Swap verifier to trust the httptest cert via InsecureSkipVerify so we
	// test handshake mechanics, not local cert chains.
	orig := probeVerify
	probeVerify = func(ctx context.Context, c net.Conn, host string) error {
		_ = c.SetDeadline(time.Now().Add(probeTimeout))
		tlsConn := tls.Client(c, &tls.Config{InsecureSkipVerify: true, ServerName: host})
		return tlsConn.HandshakeContext(ctx)
	}
	defer func() { probeVerify = orig }()

	if err := probeVerify(context.Background(), conn, "127.0.0.1"); err != nil {
		t.Fatalf("expected TLS handshake to succeed, got %v", err)
	}
}

// TestVerifyTLSHandshake_RejectsPlainTCP confirms the default verifier
// rejects a peer that accepts TCP but speaks no TLS — the exact failure
// mode (lying SOCKS5 proxies) the upgrade catches.
func TestVerifyTLSHandshake_RejectsPlainTCP(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			// Hold open but write nothing — forces TLS ClientHello read to
			// time out on the probe side.
			_ = c
		}
	}()

	conn, err := net.DialTimeout("tcp", ln.Addr().String(), 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	err = verifyTLSHandshake(ctx, conn, "smtp.seznam.cz")
	if err == nil {
		t.Fatal("expected error from plain-TCP peer")
	}
	if !strings.Contains(err.Error(), "tls") {
		t.Fatalf("expected tls-classed error, got: %v", err)
	}
}
