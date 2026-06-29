package imap

import (
	"os"
	"strings"
	"testing"
)

// F4-2 — locks the rule that connect() honors ctx during BOTH the TCP
// dial AND the TLS handshake. Pre-fix the TLS path used
// tls.DialWithDialer which respects only dialer.Timeout (10s); ctx
// cancellation could not unblock a hanging handshake. Behavioral
// runtime testing of the 993 branch requires a real TLS server with
// an InsecureSkipVerify hook the package doesn't expose; the source
// audit catches the regression more reliably.

// stripComments returns Go source with line + block comments removed.
// Lets the audit assert against runtime statements only — the F4-2
// fix's regression-doc comment legitimately mentions
// "tls.DialWithDialer" in the explanation, but the runtime code must
// not call it.
func stripComments(src string) string {
	out := []byte{}
	i := 0
	for i < len(src) {
		// Block comment.
		if i+1 < len(src) && src[i] == '/' && src[i+1] == '*' {
			i += 2
			for i+1 < len(src) && !(src[i] == '*' && src[i+1] == '/') {
				i++
			}
			i += 2
			continue
		}
		// Line comment.
		if i+1 < len(src) && src[i] == '/' && src[i+1] == '/' {
			for i < len(src) && src[i] != '\n' {
				i++
			}
			continue
		}
		out = append(out, src[i])
		i++
	}
	return string(out)
}

func TestConnect_TLS_SourceAudit_HandshakeContext(t *testing.T) {
	src, err := os.ReadFile("poller.go")
	if err != nil {
		t.Fatal(err)
	}
	code := stripComments(string(src))

	// connect() must NOT use tls.DialWithDialer at runtime.
	if strings.Contains(code, "tls.DialWithDialer") {
		t.Error("poller.go runtime code still uses tls.DialWithDialer — does not honor ctx")
	}
	// connect() MUST use HandshakeContext on the TLS path.
	if !strings.Contains(code, "HandshakeContext(ctx)") {
		t.Error("poller.go does not call HandshakeContext(ctx) — TLS handshake won't honor ctx cancel")
	}
	// connect() MUST construct the TLS conn via tls.Client(...) wrapping
	// a ctx-dialed TCP conn (rather than tls.DialWithDialer).
	if !strings.Contains(code, "tls.Client(") {
		t.Error("poller.go does not use tls.Client(...) — TLS path is not ctx-aware")
	}
	// connect() MUST close the underlying TCP conn on TLS handshake error.
	if !strings.Contains(code, "tcpConn.Close()") {
		t.Error("poller.go does not close tcpConn on TLS handshake error — FD leak")
	}
}

func TestConnect_SourceAudit_GreetingErrorPropagated(t *testing.T) {
	// F4-2 also fixes the silent greeting-read swallow.
	src, err := os.ReadFile("poller.go")
	if err != nil {
		t.Fatal(err)
	}
	code := stripComments(string(src))

	// Must NOT have the bare `conn.Read(buf) //nolint:errcheck` form.
	// (nolint comments themselves are stripped, so we look for the bare
	// statement pattern.)
	if strings.Contains(code, "conn.Read(buf)\n") &&
		!strings.Contains(code, "if _, err := conn.Read(buf)") {
		t.Error("poller.go silently calls conn.Read(buf) without checking error in greeting region")
	}
	// MUST surface the read error.
	if !strings.Contains(code, `read greeting %s`) {
		t.Error("poller.go does not surface greeting read error (expected wrapped error string)")
	}
}

func TestConnect_SourceAudit_BothBranchesUseDialContext(t *testing.T) {
	// Both the TLS (993) and non-TLS branches must use the ctx-aware TCP
	// dial path so ctx cancel works at the dial step regardless of which
	// path fires.
	//
	// AO2 (2026-05-07): connect() was refactored to route all TCP dials
	// through a local dialTCP closure (which internally calls either
	// DialContext or a SOCKS5 ContextDialer). The two branch call sites
	// are now `dialTCP(ctx, "tcp", addr)`. The original `dialer.DialContext`
	// pattern is only used once inside the dialTCP closure definition.
	src, err := os.ReadFile("poller.go")
	if err != nil {
		t.Fatal(err)
	}
	code := stripComments(string(src))

	// connect() MUST define a dialTCP closure that wraps DialContext or
	// SOCKS5 — both branches call dialTCP(ctx, ...).
	// Accept either the old pattern (≥2 direct dialer.DialContext calls)
	// OR the new pattern (dialTCP closure defined + called ≥2 times).
	directCount := strings.Count(code, "DialContext(ctx,")
	dialTCPCallCount := strings.Count(code, "dialTCP(ctx,")
	if directCount < 2 && dialTCPCallCount < 2 {
		t.Errorf("connect() must call a ctx-aware dial in both TLS and non-TLS branches; "+
			"found DialContext(ctx,...) count=%d, dialTCP(ctx,...) count=%d",
			directCount, dialTCPCallCount)
	}
}
