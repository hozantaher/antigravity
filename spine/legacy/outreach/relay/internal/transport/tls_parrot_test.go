package transport

// tls_parrot_test.go — sprint AR4: verify SMTPParrotTLS cipher fingerprint.
//
// 12 test cases covering:
//   T1  cipher suite count + order
//   T2  MinVersion = TLS 1.2
//   T3  MaxVersion = TLS 1.3
//   T4  X25519 first curve
//   T5  P-256 present in curve list
//   T6  not the Go default cipher order (first cipher differs)
//   T7  ServerName propagation
//   T8  InsecureSkipVerify NOT set by SMTPParrotTLS (secure variant)
//   T9  InsecureSkipVerify IS set by SMTPParrotTLSInsecure
//   T10 PreferServerCipherSuites = false
//   T11 TLS handshake succeeds against mock TLS server (insecure variant)
//   T12 insecure variant inherits same cipher order as secure variant

import (
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

// ─── T1: cipher suite order ───────────────────────────────────────────────────

func TestSMTPParrotTLS_CipherSuiteOrder(t *testing.T) {
	cfg := SMTPParrotTLS("smtp.test.example")

	want := []uint16{
		tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
		tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
		tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
		tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
		tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
		tls.TLS_RSA_WITH_AES_256_GCM_SHA384,
		tls.TLS_RSA_WITH_AES_128_GCM_SHA256,
	}

	if len(cfg.CipherSuites) != len(want) {
		t.Fatalf("CipherSuites length: got %d, want %d", len(cfg.CipherSuites), len(want))
	}
	for i, suite := range cfg.CipherSuites {
		if suite != want[i] {
			t.Errorf("CipherSuites[%d]: got 0x%04x, want 0x%04x", i, suite, want[i])
		}
	}
}

// ─── T2: MinVersion ───────────────────────────────────────────────────────────

func TestSMTPParrotTLS_MinVersionTLS12(t *testing.T) {
	cfg := SMTPParrotTLS("smtp.test.example")
	if cfg.MinVersion != tls.VersionTLS12 {
		t.Errorf("MinVersion: got 0x%04x, want TLS 1.2 (0x%04x)", cfg.MinVersion, tls.VersionTLS12)
	}
}

// ─── T3: MaxVersion ───────────────────────────────────────────────────────────

func TestSMTPParrotTLS_MaxVersionTLS13(t *testing.T) {
	cfg := SMTPParrotTLS("smtp.test.example")
	if cfg.MaxVersion != tls.VersionTLS13 {
		t.Errorf("MaxVersion: got 0x%04x, want TLS 1.3 (0x%04x)", cfg.MaxVersion, tls.VersionTLS13)
	}
}

// ─── T4: X25519 first ────────────────────────────────────────────────────────

func TestSMTPParrotTLS_X25519First(t *testing.T) {
	cfg := SMTPParrotTLS("smtp.test.example")
	if len(cfg.CurvePreferences) == 0 {
		t.Fatal("CurvePreferences is empty")
	}
	if cfg.CurvePreferences[0] != tls.X25519 {
		t.Errorf("CurvePreferences[0]: got %v, want X25519", cfg.CurvePreferences[0])
	}
}

// ─── T5: P-256 in curve list ─────────────────────────────────────────────────

func TestSMTPParrotTLS_CurvePreferencesContainP256(t *testing.T) {
	cfg := SMTPParrotTLS("smtp.test.example")
	for _, c := range cfg.CurvePreferences {
		if c == tls.CurveP256 {
			return
		}
	}
	t.Error("CurvePreferences does not contain CurveP256")
}

// ─── T6: not Go default cipher order ─────────────────────────────────────────

func TestSMTPParrotTLS_NotGoDefaultCipherOrder(t *testing.T) {
	// Go stdlib default leaves CipherSuites nil — stdlib picks its own order.
	// The parrot config must be non-nil and non-empty.
	cfg := SMTPParrotTLS("smtp.test.example")
	if len(cfg.CipherSuites) == 0 {
		t.Error("CipherSuites is empty — parrot has no effect (Go default would apply)")
	}
	// Go's default TLS 1.2 preference starts with TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256 (0xc02b).
	// Outlook 2019 order starts with TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384 (0xc02c).
	goDefaultFirst := uint16(tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256) // 0xc02b
	if cfg.CipherSuites[0] == goDefaultFirst {
		t.Errorf("CipherSuites[0] = 0x%04x matches Go default first cipher; parrot order unchanged", cfg.CipherSuites[0])
	}
}

// ─── T7: ServerName propagation ───────────────────────────────────────────────

func TestSMTPParrotTLS_ServerName(t *testing.T) {
	cfg := SMTPParrotTLS("smtp.seznam.cz")
	if cfg.ServerName != "smtp.seznam.cz" {
		t.Errorf("ServerName: got %q, want %q", cfg.ServerName, "smtp.seznam.cz")
	}
}

// ─── T8: secure variant does NOT skip verify ──────────────────────────────────

func TestSMTPParrotTLS_SecureVariantDoesNotSkipVerify(t *testing.T) {
	cfg := SMTPParrotTLS("smtp.test.example")
	if cfg.InsecureSkipVerify {
		t.Error("SMTPParrotTLS (secure variant) must not set InsecureSkipVerify")
	}
}

// ─── T9: insecure variant sets InsecureSkipVerify ─────────────────────────────

func TestSMTPParrotTLSInsecure_SetsInsecureSkipVerify(t *testing.T) {
	cfg := SMTPParrotTLSInsecure("smtp.test.example")
	if !cfg.InsecureSkipVerify {
		t.Error("InsecureSkipVerify: want true, got false")
	}
}

// ─── T10: PreferServerCipherSuites is false ───────────────────────────────────

func TestSMTPParrotTLS_PreferServerCipherSuitesFalse(t *testing.T) {
	cfg := SMTPParrotTLS("smtp.test.example")
	if cfg.PreferServerCipherSuites { //nolint:staticcheck
		t.Error("PreferServerCipherSuites must be false (client sends preference list)")
	}
}

// ─── T11: TLS handshake succeeds against mock server (insecure) ───────────────

func TestSMTPParrotTLS_HandshakeSuccess(t *testing.T) {
	// Borrow httptest's self-signed cert for a real TLS listener.
	// This is the same pattern used by final_gaps_test.go in this package.
	dummySrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	tlsCert := dummySrv.TLS.Certificates[0]
	dummySrv.Close()

	serverCfg := &tls.Config{Certificates: []tls.Certificate{tlsCert}}
	ln, err := tls.Listen("tcp", "127.0.0.1:0", serverCfg)
	if err != nil {
		t.Fatalf("tls.Listen: %v", err)
	}
	defer ln.Close()

	// Accept one connection: complete handshake, then wait for client to close.
	serverDone := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			serverDone <- err
			return
		}
		// Force the TLS handshake to complete before closing.
		if tc, ok := conn.(*tls.Conn); ok {
			if he := tc.Handshake(); he != nil {
				conn.Close()
				serverDone <- he
				return
			}
		}
		// Keep connection open until client closes — prevents ECONNRESET.
		buf := make([]byte, 1)
		_, _ = conn.Read(buf) // EOF when client closes
		conn.Close()
		serverDone <- nil
	}()

	clientCfg := SMTPParrotTLSInsecure(ln.Addr().(*net.TCPAddr).IP.String())
	conn, err := tls.Dial("tcp", ln.Addr().String(), clientCfg)
	if err != nil {
		t.Fatalf("TLS dial with parrot config failed: %v", err)
	}
	conn.Close()

	if err := <-serverDone; err != nil {
		t.Errorf("server side error: %v", err)
	}
}

// ─── T12: insecure variant inherits same cipher order as secure ───────────────

func TestSMTPParrotTLSInsecure_SameCipherOrder(t *testing.T) {
	secure := SMTPParrotTLS("smtp.test.example")
	insecure := SMTPParrotTLSInsecure("smtp.test.example")

	if len(secure.CipherSuites) != len(insecure.CipherSuites) {
		t.Fatalf("cipher suite count mismatch: secure=%d insecure=%d",
			len(secure.CipherSuites), len(insecure.CipherSuites))
	}
	for i := range secure.CipherSuites {
		if secure.CipherSuites[i] != insecure.CipherSuites[i] {
			t.Errorf("CipherSuites[%d]: secure=0x%04x insecure=0x%04x",
				i, secure.CipherSuites[i], insecure.CipherSuites[i])
		}
	}
}
