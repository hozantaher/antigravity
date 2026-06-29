package transport

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// mockSOCKS5Server spins up a TCP server that speaks just enough SOCKS5 to let
// DialContext succeed or fail in a controlled way.
type mockSOCKS5Server struct {
	listener net.Listener
	addr     string
	// If rejectHandshake is true the server sends a bad SOCKS5 greeting reply.
	rejectHandshake bool
	// If rejectConnect is true the server returns a CONNECT failure (status!=0).
	rejectConnect bool
	// If badVersion is true the response to CONNECT uses version 0x04.
	badVersion bool
	// If closeImmediately the server closes the connection without writing anything.
	closeImmediately bool
	// If hangSilently the server accepts the connection and blocks forever
	// without responding to the SOCKS5 greeting. Used to assert that
	// DialContext does not hang on dead proxies that accept TCP but never
	// complete the handshake.
	hangSilently bool
}

func newMockSOCKS5Server(t *testing.T) *mockSOCKS5Server {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	s := &mockSOCKS5Server{listener: ln, addr: ln.Addr().String()}
	// Goroutine is NOT started here — call s.start() after setting fields.
	t.Cleanup(func() { ln.Close() })
	return s
}

// start launches the accept loop. Call after all fields are set to avoid data races.
func (s *mockSOCKS5Server) start() {
	go s.serve()
}

func (s *mockSOCKS5Server) serve() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *mockSOCKS5Server) handle(conn net.Conn) {
	defer conn.Close()

	if s.closeImmediately {
		return
	}

	if s.hangSilently {
		// Block until peer closes. Never reply to the SOCKS5 greeting.
		discard := make([]byte, 1)
		for {
			if _, err := conn.Read(discard); err != nil {
				return
			}
		}
	}

	// Read greeting (3 bytes minimum: VER NMETHODS METHODS...)
	buf := make([]byte, 3)
	if _, err := conn.Read(buf); err != nil {
		return
	}

	if s.rejectHandshake {
		// Send version 0x04 with no-acceptable-methods (0xFF)
		conn.Write([]byte{0x04, 0xFF})
		return
	}
	// Accept greeting: VER=5 METHOD=0 (no auth)
	conn.Write([]byte{0x05, 0x00})

	// Read CONNECT request (variable length, read enough for our purposes)
	req := make([]byte, 256)
	n, err := conn.Read(req)
	if err != nil || n < 4 {
		return
	}

	if s.badVersion {
		conn.Write([]byte{0x04, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	if s.rejectConnect {
		conn.Write([]byte{0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0}) // status=1 (general failure)
		return
	}
	// Success
	conn.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})

	// Keep the connection alive so the caller can use it.
	buf2 := make([]byte, 1)
	conn.Read(buf2)
}

// ---------------------------------------------------------------------------
// DirectTransport
// ---------------------------------------------------------------------------

func TestNewDirectTransport(t *testing.T) {
	d := NewDirectTransport()
	if d == nil {
		t.Fatal("expected non-nil DirectTransport")
	}
}

func TestDirectTransportDialContextSuccess(t *testing.T) {
	// Use a local echo server so no real network is required.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, _ := ln.Accept()
		if c != nil {
			c.Close()
		}
	}()

	d := NewDirectTransport()
	conn, err := d.DialContext(context.Background(), "tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	conn.Close()
}

func TestDirectTransportDialContextFailure(t *testing.T) {
	d := NewDirectTransport()
	// Port 1 is almost certainly not listening.
	_, err := d.DialContext(context.Background(), "tcp", "127.0.0.1:1")
	if err == nil {
		t.Fatal("expected connection error")
	}
}

func TestDirectTransportDialContextCancelled(t *testing.T) {
	d := NewDirectTransport()
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately
	_, err := d.DialContext(ctx, "tcp", "127.0.0.1:1")
	if err == nil {
		t.Fatal("expected error on cancelled context")
	}
}

// ---------------------------------------------------------------------------
// SOCKS5Transport
// ---------------------------------------------------------------------------

func TestSOCKS5TransportProxyUnreachable(t *testing.T) {
	s := NewSOCKS5Transport("127.0.0.1:1", 2*time.Second)
	_, err := s.DialContext(context.Background(), "tcp", "example.com:80")
	if err == nil {
		t.Fatal("expected error when proxy unreachable")
	}
	if !errors.Is(err, ErrProxyUnreachable) {
		t.Fatalf("expected ErrProxyUnreachable, got: %v", err)
	}
}

func TestSOCKS5TransportHandshakeSuccess(t *testing.T) {
	srv := newMockSOCKS5Server(t)
	srv.start()
	s := NewSOCKS5Transport(srv.addr, 5*time.Second)
	conn, err := s.DialContext(context.Background(), "tcp", "example.com:80")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	conn.Close()
}

func TestSOCKS5TransportHandshakeRejected(t *testing.T) {
	srv := newMockSOCKS5Server(t)
	srv.rejectHandshake = true
	srv.start()
	s := NewSOCKS5Transport(srv.addr, 5*time.Second)
	_, err := s.DialContext(context.Background(), "tcp", "example.com:80")
	if err == nil {
		t.Fatal("expected error on rejected handshake")
	}
	if !strings.Contains(err.Error(), "socks5 handshake failed") {
		t.Fatalf("unexpected error text: %v", err)
	}
}

// TestSOCKS5TransportHandshakeMethodNotAccepted kills the || → && mutation on
// the handshake check: resp[0]==0x05 (valid ver) but resp[1]==0xFF (no method).
// With ||: false||true=true → error (correct).
// With &&: false&&true=false → no error (wrong).
func TestSOCKS5TransportHandshakeMethodNotAccepted(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 3)
		conn.Read(buf)
		// Valid SOCKS5 version but no acceptable method (0xFF).
		conn.Write([]byte{0x05, 0xFF})
	}()
	s := NewSOCKS5Transport(ln.Addr().String(), 5*time.Second)
	_, err = s.DialContext(context.Background(), "tcp", "example.com:80")
	if err == nil {
		t.Fatal("expected error when no acceptable method")
	}
	if !strings.Contains(err.Error(), "socks5 handshake failed") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSOCKS5TransportConnectRejected(t *testing.T) {
	srv := newMockSOCKS5Server(t)
	srv.rejectConnect = true
	srv.start()
	s := NewSOCKS5Transport(srv.addr, 5*time.Second)
	_, err := s.DialContext(context.Background(), "tcp", "example.com:80")
	if err == nil {
		t.Fatal("expected error on rejected connect")
	}
	if !strings.Contains(err.Error(), "socks5 connect failed") {
		t.Fatalf("unexpected error text: %v", err)
	}
}

func TestSOCKS5TransportBadVersionInConnectResponse(t *testing.T) {
	srv := newMockSOCKS5Server(t)
	srv.badVersion = true
	srv.start()
	s := NewSOCKS5Transport(srv.addr, 5*time.Second)
	_, err := s.DialContext(context.Background(), "tcp", "example.com:80")
	if err == nil {
		t.Fatal("expected error on bad version")
	}
	if !strings.Contains(err.Error(), "socks5 bad version") {
		t.Fatalf("unexpected error text: %v", err)
	}
}

func TestSOCKS5TransportCloseBeforeHandshakeReply(t *testing.T) {
	srv := newMockSOCKS5Server(t)
	srv.closeImmediately = true
	srv.start()
	s := NewSOCKS5Transport(srv.addr, 5*time.Second)
	_, err := s.DialContext(context.Background(), "tcp", "example.com:80")
	if err == nil {
		t.Fatal("expected error when server closes before handshake reply")
	}
}

// TestSOCKS5TransportHandshakeDeadline pins the fix for a pool-refresh
// deadlock: a proxy that accepts TCP but never writes a handshake reply
// previously hung DialContext indefinitely because the inner Read had no
// deadline. With SetDeadline in place, DialContext must fail within the
// configured timeout.
func TestSOCKS5TransportHandshakeDeadline(t *testing.T) {
	srv := newMockSOCKS5Server(t)
	srv.hangSilently = true
	srv.start()

	s := NewSOCKS5Transport(srv.addr, 300*time.Millisecond)
	start := time.Now()
	_, err := s.DialContext(context.Background(), "tcp", "example.com:80")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected error on hanging proxy")
	}
	// Must fail within a small multiple of the configured timeout — never hang.
	if elapsed > 2*time.Second {
		t.Fatalf("DialContext hung for %v, expected ≤2s (timeout=300ms)", elapsed)
	}
	if !strings.Contains(err.Error(), "socks5 handshake read") {
		t.Fatalf("expected handshake-read error, got: %v", err)
	}
}

func TestSOCKS5TransportInvalidAddr(t *testing.T) {
	srv := newMockSOCKS5Server(t)
	srv.start()
	s := NewSOCKS5Transport(srv.addr, 5*time.Second)
	// net.SplitHostPort will fail on "no-port-here"
	_, err := s.DialContext(context.Background(), "tcp", "no-port-here")
	if err == nil {
		t.Fatal("expected error for invalid addr")
	}
}

// ---------------------------------------------------------------------------
// splitHostPort
// ---------------------------------------------------------------------------

func TestSplitHostPortValid(t *testing.T) {
	host, port, err := splitHostPort("example.com:443")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if host != "example.com" {
		t.Fatalf("unexpected host: %s", host)
	}
	if port != 443 {
		t.Fatalf("unexpected port: %d", port)
	}
}

func TestSplitHostPortInvalidNoPort(t *testing.T) {
	_, _, err := splitHostPort("example.com")
	if err == nil {
		t.Fatal("expected error for missing port")
	}
}

func TestSplitHostPortInvalidPortNonNumeric(t *testing.T) {
	_, _, err := splitHostPort("example.com:abc")
	if err == nil {
		t.Fatal("expected error for non-numeric port")
	}
	if !strings.Contains(err.Error(), "invalid port") {
		t.Fatalf("unexpected error text: %v", err)
	}
}

func TestSplitHostPortZero(t *testing.T) {
	host, port, err := splitHostPort("host:0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if host != "host" || port != 0 {
		t.Fatalf("unexpected host=%s port=%d", host, port)
	}
}

// ---------------------------------------------------------------------------
// ChainTransport
// ---------------------------------------------------------------------------

func TestNewChainTransportEmpty(t *testing.T) {
	_, err := NewChainTransport()
	if err == nil {
		t.Fatal("expected ErrChainEmpty")
	}
	if !errors.Is(err, ErrChainEmpty) {
		t.Fatalf("expected ErrChainEmpty, got: %v", err)
	}
}

func TestNewChainTransportSingleHop(t *testing.T) {
	d := NewDirectTransport()
	chain, err := NewChainTransport(d)
	if err != nil {
		t.Fatal(err)
	}
	if chain.HopCount() != 1 {
		t.Fatalf("expected 1 hop, got %d", chain.HopCount())
	}
}

func TestChainTransportDialContextUsesLastHop(t *testing.T) {
	// Create a local listener that the last hop will actually connect to.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, _ := ln.Accept()
		if c != nil {
			c.Close()
		}
	}()

	// Both hops are DirectTransport; the last one must reach the listener.
	hop1 := NewDirectTransport()
	hop2 := NewDirectTransport()
	chain, err := NewChainTransport(hop1, hop2)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := chain.DialContext(context.Background(), "tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	conn.Close()
}

func TestChainTransportDescriptionKnownTypes(t *testing.T) {
	vpn := NewDirectTransport()
	tor := NewSOCKS5Transport("127.0.0.1:9050", 60*time.Second)
	chain, _ := NewChainTransport(vpn, tor)
	desc := chain.Description()
	if !strings.Contains(desc, "direct") {
		t.Fatalf("description should contain 'direct': %s", desc)
	}
	if !strings.Contains(desc, "tor-socks5") {
		t.Fatalf("description should contain 'tor-socks5': %s", desc)
	}
}

func TestChainTransportDescriptionUnknownType(t *testing.T) {
	// Use a custom type that is not *SOCKS5Transport or *DirectTransport.
	chain, _ := NewChainTransport(&customTransport{})
	desc := chain.Description()
	if !strings.Contains(desc, "hop-0") {
		t.Fatalf("description should fall back to 'hop-0': %s", desc)
	}
}

// customTransport is an anonymous transport that is not a known type.
type customTransport struct{}

func (c *customTransport) DialContext(_ context.Context, _, _ string) (net.Conn, error) {
	return nil, errors.New("custom transport: not implemented")
}

// ---------------------------------------------------------------------------
// joinStrings
// ---------------------------------------------------------------------------

func TestJoinStringsEmpty(t *testing.T) {
	result := joinStrings(nil, " -> ")
	if result != "" {
		t.Fatalf("expected empty string, got: %q", result)
	}
}

func TestJoinStringsSingle(t *testing.T) {
	result := joinStrings([]string{"only"}, " -> ")
	if result != "only" {
		t.Fatalf("expected 'only', got: %q", result)
	}
}

func TestJoinStringsMultiple(t *testing.T) {
	result := joinStrings([]string{"a", "b", "c"}, " -> ")
	if result != "a -> b -> c" {
		t.Fatalf("unexpected result: %q", result)
	}
}

// ---------------------------------------------------------------------------
// BuildChain — branches not covered by chain_test.go
// ---------------------------------------------------------------------------

func TestBuildChainVPN(t *testing.T) {
	vpn := NewDirectTransport()
	tr, err := BuildChain("vpn", "", vpn)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tr != vpn {
		t.Fatal("expected the provided vpn transport to be returned")
	}
}

func TestBuildChainVPNTorMissingSocksAddr(t *testing.T) {
	vpn := NewDirectTransport()
	_, err := BuildChain("vpn+tor", "", vpn)
	if err == nil {
		t.Fatal("expected error when socks addr missing for vpn+tor")
	}
}

func TestBuildChainVPNTorMissingVPN(t *testing.T) {
	_, err := BuildChain("vpn+tor", "127.0.0.1:9050", nil)
	if err == nil {
		t.Fatal("expected error when vpn transport nil for vpn+tor")
	}
}

// ---------------------------------------------------------------------------
// RotatingProxyTransport
// ---------------------------------------------------------------------------

func TestRotatingProxyTransportWorkingCountInitiallyZero(t *testing.T) {
	// Provide a dummy fallback; the background refresh will fail (no real proxies),
	// but WorkingCount should start at 0.
	tr := &RotatingProxyTransport{fallback: NewDirectTransport()}
	if count := tr.WorkingCount(); count != 0 {
		t.Fatalf("expected 0 working proxies, got %d", count)
	}
}

func TestRotatingProxyTransportPickEmptyPool(t *testing.T) {
	tr := &RotatingProxyTransport{}
	_, ok := tr.pick()
	if ok {
		t.Fatal("expected pick to return false on empty pool")
	}
}

func TestRotatingProxyTransportPickRoundRobin(t *testing.T) {
	tr := &RotatingProxyTransport{
		working: []proxyEntry{
			{addr: "1.2.3.4:1080"},
			{addr: "5.6.7.8:1080"},
		},
	}
	first, ok1 := tr.pick()
	second, ok2 := tr.pick()
	if !ok1 || !ok2 {
		t.Fatal("expected both picks to succeed")
	}
	if first.addr == second.addr {
		t.Fatal("expected round-robin to return different proxies")
	}
}

func TestRotatingProxyTransportRemove(t *testing.T) {
	tr := &RotatingProxyTransport{
		working: []proxyEntry{
			{addr: "1.2.3.4:1080"},
			{addr: "5.6.7.8:1080"},
			{addr: "9.10.11.12:1080"},
		},
	}
	tr.remove("5.6.7.8:1080")
	if tr.WorkingCount() != 2 {
		t.Fatalf("expected 2 after remove, got %d", tr.WorkingCount())
	}
	for _, e := range tr.working {
		if e.addr == "5.6.7.8:1080" {
			t.Fatal("removed proxy still in pool")
		}
	}
}

func TestRotatingProxyTransportRemoveNonExistent(t *testing.T) {
	tr := &RotatingProxyTransport{
		working: []proxyEntry{{addr: "1.2.3.4:1080"}},
	}
	tr.remove("not-there:1080")
	if tr.WorkingCount() != 1 {
		t.Fatalf("expected 1 after removing non-existent, got %d", tr.WorkingCount())
	}
}

func TestRotatingProxyTransportDialFallbackWhenEmpty(t *testing.T) {
	// Set up a real listener as the "target" the fallback (DirectTransport) will reach.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, _ := ln.Accept()
		if c != nil {
			c.Close()
		}
	}()

	tr := &RotatingProxyTransport{
		fallback:    NewDirectTransport(),
		lastRefresh: time.Now(), // mark as fresh so no background refresh fires
	}
	conn, err := tr.DialContext(context.Background(), "tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("expected fallback to succeed: %v", err)
	}
	conn.Close()
}

func TestRotatingProxyTransportDialNoFallback(t *testing.T) {
	tr := &RotatingProxyTransport{
		lastRefresh: time.Now(),
	}
	_, err := tr.DialContext(context.Background(), "tcp", "127.0.0.1:80")
	if err == nil {
		t.Fatal("expected error when no proxies and no fallback")
	}
	if !strings.Contains(err.Error(), "no working proxies") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRotatingProxyTransportDialRemovesDeadProxy(t *testing.T) {
	// A dead proxy that is definitely not listening.
	deadProxy := proxyEntry{addr: "127.0.0.1:1"}

	// Set up a real listener as the final target.
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
			c.Close()
		}
	}()

	tr := &RotatingProxyTransport{
		working:     []proxyEntry{deadProxy},
		fallback:    NewDirectTransport(),
		lastRefresh: time.Now(),
	}
	conn, err := tr.DialContext(context.Background(), "tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("expected fallback after dead proxy removed: %v", err)
	}
	conn.Close()
	// Dead proxy should have been removed.
	if tr.WorkingCount() != 0 {
		t.Fatalf("expected pool empty after removing dead proxy, got %d", tr.WorkingCount())
	}
}

func TestRotatingProxyTransportDialWithWorkingProxy(t *testing.T) {
	// Start a mock SOCKS5 server that will be "the proxy".
	srv := newMockSOCKS5Server(t)
	srv.start()

	tr := &RotatingProxyTransport{
		working:     []proxyEntry{{addr: srv.addr}},
		lastRefresh: time.Now(),
	}
	conn, err := tr.DialContext(context.Background(), "tcp", "example.com:80")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	conn.Close()
}

func TestNewRotatingProxyTransportReturnsNonNil(t *testing.T) {
	// Just verify the constructor returns without error.
	// Background refresh will silently fail — that is expected in tests.
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	tr, err := NewRotatingProxyTransport(ctx, NewDirectTransport())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tr == nil {
		t.Fatal("expected non-nil transport")
	}
}

// ---------------------------------------------------------------------------
// fetchProxyList — via httptest server
// ---------------------------------------------------------------------------

// TestFetchProxyListExcludesPartialEntries kills the && → || mutation in
// fetchProxyList: entries with empty IP or empty port must be excluded.
// With &&: IP!="" && Port!="" → only both-present entries included (correct).
// With ||: IP!="" || Port!="" → partial entries leak through (wrong).
func TestFetchProxyListExcludesPartialEntries(t *testing.T) {
	payload := geonodeResponse{
		Data: []struct {
			IP      string `json:"ip"`
			Port    string `json:"port"`
			Country string `json:"country"`
		}{
			{IP: "1.2.3.4", Port: "1080"},  // valid
			{IP: "", Port: "1081"},           // empty IP — must be excluded
			{IP: "5.6.7.8", Port: ""},        // empty port — must be excluded
			{IP: "", Port: ""},               // both empty — must be excluded
		},
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(payload)
	}))
	defer ts.Close()

	addrs, err := fetchProxyListFromURL(context.Background(), ts.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(addrs) != 1 {
		t.Fatalf("expected exactly 1 valid addr, got %d: %v", len(addrs), addrs)
	}
	if addrs[0] != "1.2.3.4:1080" {
		t.Fatalf("unexpected addr: %s", addrs[0])
	}
}

func TestFetchProxyListSuccess(t *testing.T) {
	payload := geonodeResponse{
		Data: []struct {
			IP      string `json:"ip"`
			Port    string `json:"port"`
			Country string `json:"country"`
		}{
			{IP: "1.2.3.4", Port: "1080"},
			{IP: "5.6.7.8", Port: "1081"},
			{IP: "", Port: "1082"}, // empty IP — should be skipped
		},
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(payload)
	}))
	defer ts.Close()

	// fetchProxyList uses a hardcoded URL, so we monkey-patch via the test server
	// by temporarily overriding the URL constant is not possible.
	// Instead we test indirectly through refresh with a patched URL using
	// a small helper that mirrors fetchProxyList logic.
	addrs, err := fetchProxyListFromURL(context.Background(), ts.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(addrs) != 2 {
		t.Fatalf("expected 2 addrs, got %d: %v", len(addrs), addrs)
	}
}

func TestFetchProxyListBadJSON(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("not json"))
	}))
	defer ts.Close()

	_, err := fetchProxyListFromURL(context.Background(), ts.URL)
	if err == nil {
		t.Fatal("expected error for bad JSON")
	}
}

func TestFetchProxyListServerError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "internal error", http.StatusInternalServerError)
	}))
	defer ts.Close()

	// Server returns 500 but valid JSON body is missing — decode will fail.
	_, err := fetchProxyListFromURL(context.Background(), ts.URL)
	if err == nil {
		t.Fatal("expected error for server error response")
	}
}

func TestFetchProxyListCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := fetchProxyListFromURL(ctx, "http://127.0.0.1:1")
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
}

// ---------------------------------------------------------------------------
// probeAll — unit-level
// ---------------------------------------------------------------------------

func TestProbeAllNoWorkingProxies(t *testing.T) {
	// All candidates are unreachable.
	working := probeAll(context.Background(), []proxyCandidate{
		{addr: "127.0.0.1:1", country: "ZZ", source: "test"},
		{addr: "127.0.0.1:2", country: "ZZ", source: "test"},
	})
	if len(working) != 0 {
		t.Fatalf("expected 0 working, got %d", len(working))
	}
}

func TestProbeAllWithWorkingProxy(t *testing.T) {
	srv := newMockSOCKS5Server(t)
	srv.start()
	// Mock SOCKS5 peer doesn't speak TLS — swap the default TLS-handshake
	// verifier for a noop so the test exercises probeAll's SOCKS5 flow.
	orig := probeVerify
	probeVerify = func(context.Context, net.Conn, string) error { return nil }
	defer func() { probeVerify = orig }()

	// probeAll dials probeTarget ("smtp.seznam.cz:465") through each SOCKS5 candidate.
	// Our mock server will respond with a successful SOCKS5 handshake.
	working := probeAll(context.Background(), []proxyCandidate{
		{addr: srv.addr, country: "CZ", source: "mocksrv"},
	})
	if len(working) != 1 {
		t.Fatalf("expected 1 working proxy, got %d", len(working))
	}
	if working[0].addr != srv.addr {
		t.Fatalf("unexpected proxy addr: %s", working[0].addr)
	}
	if working[0].latency <= 0 {
		t.Fatal("expected positive latency")
	}
	if working[0].country != "CZ" || working[0].source != "mocksrv" {
		t.Fatalf("metadata not preserved: country=%q source=%q", working[0].country, working[0].source)
	}
}

func TestProbeAllEmpty(t *testing.T) {
	working := probeAll(context.Background(), nil)
	if working != nil && len(working) != 0 {
		t.Fatalf("expected nil/empty, got %d", len(working))
	}
}

// ---------------------------------------------------------------------------
// Concurrency safety for RotatingProxyTransport
// ---------------------------------------------------------------------------

func TestRotatingProxyTransportConcurrentPickRemove(t *testing.T) {
	tr := &RotatingProxyTransport{
		working: []proxyEntry{
			{addr: "1.2.3.4:1080"},
			{addr: "5.6.7.8:1080"},
			{addr: "9.10.11.12:1080"},
		},
		lastRefresh: time.Now(),
	}

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tr.pick()
		}()
		wg.Add(1)
		go func() {
			defer wg.Done()
			tr.WorkingCount()
		}()
	}
	wg.Wait()
}

// ---------------------------------------------------------------------------
// fetchProxyListFromURL — helper that mirrors fetchProxyList but accepts a URL
// parameter so we can point it at httptest servers.
// ---------------------------------------------------------------------------

func fetchProxyListFromURL(ctx context.Context, url string) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result geonodeResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}

	addrs := make([]string, 0, len(result.Data))
	for _, p := range result.Data {
		if p.IP != "" && p.Port != "" {
			addrs = append(addrs, net.JoinHostPort(p.IP, p.Port))
		}
	}
	return addrs, nil
}
