package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

// TestImapConnectSOCKS5_DirectFallbackBlocked verifies that imapConnectSOCKS5
// returns ErrAnonymityHarvestSOCKSUnavailable when no SOCKS5 endpoint is
// available and ALLOW_IMAP_DIRECT is not set (HARD RULE enforcement).
func TestImapConnectSOCKS5_DirectFallbackBlocked(t *testing.T) {
	os.Clearenv()
	os.Setenv("ALLOW_IMAP_DIRECT", "")
	os.Setenv("IMAP_SOCKS_DEFAULT", "")
	os.Setenv("ANTI_TRACE_RELAY_URL", "")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	mb := &mailboxRow{
		id:       1,
		address:  "test@seznam.cz",
		imapHost: "imap.seznam.cz",
		imapPort: 993,
		password: "dummy",
	}

	_, err := imapConnectSOCKS5(ctx, mb)
	if err == nil {
		t.Fatal("expected ErrAnonymityHarvestSOCKSUnavailable, got nil")
	}
	if !strings.Contains(err.Error(), "SOCKS5 endpoint unavailable") {
		t.Fatalf("expected SOCKS5 unavailable error, got: %v", err)
	}
}

// TestImapConnectSOCKS5_AllowDirectPermitsDirectDial verifies that when
// ALLOW_IMAP_DIRECT=1 is set, imapConnectSOCKS5 permits direct dial (local dev).
func TestImapConnectSOCKS5_AllowDirectPermitsDirectDial(t *testing.T) {
	os.Clearenv()
	os.Setenv("ALLOW_IMAP_DIRECT", "1")
	os.Setenv("IMAP_SOCKS_DEFAULT", "")
	os.Setenv("ANTI_TRACE_RELAY_URL", "")

	// This will attempt a real connection; we expect it to fail at TCP level
	// (no server listening), not at the SOCKS5 validation level.
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	mb := &mailboxRow{
		id:       1,
		address:  "test@localhost",
		imapHost: "localhost",
		imapPort: 9999,
		password: "dummy",
	}

	_, err := imapConnectSOCKS5(ctx, mb)
	// Should fail at TCP dial (connection refused), not at SOCKS5 validation.
	if err == nil {
		t.Fatal("expected TCP dial error, got nil")
	}
	if strings.Contains(err.Error(), "SOCKS5 endpoint unavailable") {
		t.Fatalf("should not fail at SOCKS5 validation when ALLOW_IMAP_DIRECT=1, got: %v", err)
	}
}

// TestResolveAnonymityHarvestSOCKSAddr_EnvOverride verifies that
// resolveAnonymityHarvestSOCKSAddr respects the IMAP_SOCKS_DEFAULT env var.
func TestResolveAnonymityHarvestSOCKSAddr_EnvOverride(t *testing.T) {
	os.Clearenv()
	os.Setenv("IMAP_SOCKS_DEFAULT", "127.0.0.1:1085")

	addr := resolveAnonymityHarvestSOCKSAddr()
	if addr != "127.0.0.1:1085" {
		t.Fatalf("expected 127.0.0.1:1085, got %q", addr)
	}
}

// TestResolveAnonymityHarvestSOCKSAddr_EmptyWhenNoEnv verifies that
// resolveAnonymityHarvestSOCKSAddr returns empty when no env vars are set.
func TestResolveAnonymityHarvestSOCKSAddr_EmptyWhenNoEnv(t *testing.T) {
	os.Clearenv()

	addr := resolveAnonymityHarvestSOCKSAddr()
	if addr != "" {
		t.Fatalf("expected empty, got %q", addr)
	}
}

// TestDiscoverAnonymityHarvestSOCKSAddr_NoRelayURLReturnsEmpty verifies that
// discoverAnonymityHarvestSOCKSAddr returns empty when ANTI_TRACE_RELAY_URL
// is not set.
func TestDiscoverAnonymityHarvestSOCKSAddr_NoRelayURLReturnsEmpty(t *testing.T) {
	os.Clearenv()

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	addr := discoverAnonymityHarvestSOCKSAddr(ctx)
	if addr != "" {
		t.Fatalf("expected empty (no relay URL), got %q", addr)
	}
}

// TestDiscoverAnonymityHarvestSOCKSAddr_InvalidRelayURLReturnsEmpty verifies
// that discoverAnonymityHarvestSOCKSAddr returns empty when the relay URL
// is unreachable.
func TestDiscoverAnonymityHarvestSOCKSAddr_InvalidRelayURLReturnsEmpty(t *testing.T) {
	os.Clearenv()
	os.Setenv("ANTI_TRACE_RELAY_URL", "http://localhost:19999")
	os.Setenv("ANTI_TRACE_RELAY_TOKEN", "")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	addr := discoverAnonymityHarvestSOCKSAddr(ctx)
	if addr != "" {
		t.Fatalf("expected empty (relay unreachable), got %q", addr)
	}
}

// TestDiscoverAnonymityHarvestSOCKSAddr_ContextCancellation verifies that
// discoverAnonymityHarvestSOCKSAddr respects context cancellation.
func TestDiscoverAnonymityHarvestSOCKSAddr_ContextCancellation(t *testing.T) {
	os.Clearenv()
	os.Setenv("ANTI_TRACE_RELAY_URL", "http://httpbin.org/delay/30") // long delay
	os.Setenv("ANTI_TRACE_RELAY_TOKEN", "")

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	addr := discoverAnonymityHarvestSOCKSAddr(ctx)
	if addr != "" {
		t.Fatalf("expected empty (context deadline), got %q", addr)
	}
}

// TestImapConnectSOCKS5_PlainPortConnect verifies that imapConnectSOCKS5
// correctly handles non-993 ports as plain IMAP (no TLS).
func TestImapConnectSOCKS5_PlainPortConnect(t *testing.T) {
	os.Clearenv()
	os.Setenv("ALLOW_IMAP_DIRECT", "1")

	// Create a plain listener.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	// Server that sends greeting.
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		fmt.Fprintf(conn, "* OK IMAP4rev1 Server Ready\r\n")
		time.Sleep(1 * time.Second)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	addr := listener.Addr().(*net.TCPAddr)
	mb := &mailboxRow{
		id:       1,
		address:  "test@test.local",
		imapHost: "127.0.0.1",
		imapPort: addr.Port, // Non-993 port = plain IMAP
		password: "dummy",
	}

	// Should succeed for plain port (no TLS).
	conn, err := imapConnectSOCKS5(ctx, mb)
	if err != nil {
		t.Fatalf("unexpected error for plain port: %v", err)
	}
	conn.Close()

	<-done
}

// TestImapConnectSOCKS5_NoGreetingReturnsError verifies that imapConnectSOCKS5
// fails when the server doesn't send a greeting.
func TestImapConnectSOCKS5_NoGreetingReturnsError(t *testing.T) {
	os.Clearenv()
	os.Setenv("ALLOW_IMAP_DIRECT", "1")

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	// Server that closes without sending greeting.
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		conn.Close()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	addr := listener.Addr().(*net.TCPAddr)
	mb := &mailboxRow{
		id:       1,
		address:  "test@test.local",
		imapHost: "127.0.0.1",
		imapPort: addr.Port,
		password: "dummy",
	}

	_, err = imapConnectSOCKS5(ctx, mb)
	if err == nil {
		t.Fatal("expected error from no greeting, got nil")
	}

	<-done
}

// TestImapConnectSOCKS5_ContextDeadline verifies that imapConnectSOCKS5
// respects context deadlines during greeting read.
func TestImapConnectSOCKS5_ContextDeadline(t *testing.T) {
	os.Clearenv()
	os.Setenv("ALLOW_IMAP_DIRECT", "1")

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	// Server that accepts but hangs without responding.
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		time.Sleep(5 * time.Second) // hang longer than context
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	addr := listener.Addr().(*net.TCPAddr)
	mb := &mailboxRow{
		id:       1,
		address:  "test@test.local",
		imapHost: "127.0.0.1",
		imapPort: addr.Port,
		password: "dummy",
	}

	_, err = imapConnectSOCKS5(ctx, mb)
	if err == nil {
		t.Fatal("expected context deadline error, got nil")
	}

	<-done
}

// TestImapConnectSOCKS5_EnvSOCKSDefault verifies that imapConnectSOCKS5
// uses IMAP_SOCKS_DEFAULT when set (though the actual SOCKS5 dial would fail
// without a real proxy).
func TestImapConnectSOCKS5_EnvSOCKSDefault(t *testing.T) {
	os.Clearenv()
	os.Setenv("IMAP_SOCKS_DEFAULT", "127.0.0.1:1080")
	os.Setenv("ALLOW_IMAP_DIRECT", "")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	mb := &mailboxRow{
		id:       1,
		address:  "test@seznam.cz",
		imapHost: "imap.seznam.cz",
		imapPort: 993,
		password: "dummy",
	}

	_, err := imapConnectSOCKS5(ctx, mb)
	if err == nil {
		t.Fatal("expected SOCKS5 dial error (no proxy), got nil")
	}
	// Should fail at SOCKS5 layer, not at HARD RULE validation.
	if strings.Contains(err.Error(), "HARD RULE") {
		t.Fatalf("should fail at SOCKS5 dial, not HARD RULE: %v", err)
	}
}

