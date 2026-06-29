package transport

// socks5_mock_test.go provides mock net.Conn implementations to exercise
// the SOCKS5 error paths that require exact failure points
// (SetDeadline, Write, Read, ClearDeadline).

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"
)

// failConn is a net.Conn whose individual operations can be made to fail.
type failConn struct {
	// inner is used for successful ops; operations listed in failOps return errors.
	inner           net.Conn
	failSetDeadline bool
	failWrite       bool // fails on first write
	failConnWrite   bool // fails on second write (after handshake)
	failConnRead    bool // fails on second read (CONNECT resp)
	failClearDL     bool // fails on SetDeadline(zero)
	writeCount      int
	readCount       int
	setDLCount      int
}

func (f *failConn) Read(b []byte) (int, error) {
	f.readCount++
	// For failConnRead: let handshake read succeed, fail CONNECT read.
	if f.failConnRead && f.readCount >= 2 {
		return 0, errors.New("mock read error")
	}
	return f.inner.Read(b)
}
func (f *failConn) Write(b []byte) (int, error) {
	f.writeCount++
	if f.failWrite && f.writeCount == 1 {
		return 0, errors.New("mock write error")
	}
	if f.failConnWrite && f.writeCount == 2 {
		return 0, errors.New("mock connect write error")
	}
	return f.inner.Write(b)
}
func (f *failConn) Close() error {
	if f.inner != nil {
		return f.inner.Close()
	}
	return nil
}
func (f *failConn) LocalAddr() net.Addr {
	if f.inner != nil {
		return f.inner.LocalAddr()
	}
	return nil
}
func (f *failConn) RemoteAddr() net.Addr {
	if f.inner != nil {
		return f.inner.RemoteAddr()
	}
	return nil
}
func (f *failConn) SetDeadline(t time.Time) error {
	f.setDLCount++
	if f.failSetDeadline && f.setDLCount == 1 {
		// Fail the initial SetDeadline (handshake deadline).
		return errors.New("mock SetDeadline error")
	}
	if f.failClearDL && t.IsZero() {
		// Fail the final SetDeadline(zero) = clear deadline.
		return errors.New("mock clear deadline error")
	}
	if f.inner != nil {
		return f.inner.SetDeadline(t)
	}
	return nil
}
func (f *failConn) SetReadDeadline(t time.Time) error {
	if f.inner != nil {
		return f.inner.SetReadDeadline(t)
	}
	return nil
}
func (f *failConn) SetWriteDeadline(t time.Time) error {
	if f.inner != nil {
		return f.inner.SetWriteDeadline(t)
	}
	return nil
}

// newDialFnWith creates a dialFn that injects a failConn wrapping a
// connection to the given mockSOCKS5Server, with the specified failure mode.
func newDialFnWith(srv *mockSOCKS5Server, fc *failConn) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		inner, err := net.DialTimeout("tcp", srv.addr, 2*time.Second)
		if err != nil {
			return nil, err
		}
		fc.inner = inner
		return fc, nil
	}
}

// TestSOCKS5Transport_SetDeadlineFailure exercises the SetDeadline error path
// immediately after the TCP connection is established.
func TestSOCKS5Transport_SetDeadlineFailure(t *testing.T) {
	srv := newMockSOCKS5Server(t)
	srv.start()

	fc := &failConn{failSetDeadline: true}
	s := NewSOCKS5Transport(srv.addr, 5*time.Second)
	s.dialFn = newDialFnWith(srv, fc)

	_, err := s.DialContext(context.Background(), "tcp", "example.com:80")
	if err == nil {
		t.Fatal("expected error when SetDeadline fails")
	}
	if !strings.Contains(err.Error(), "socks5 set deadline") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestSOCKS5Transport_HandshakeWriteFailure exercises the handshake Write error.
func TestSOCKS5Transport_HandshakeWriteFailure(t *testing.T) {
	srv := newMockSOCKS5Server(t)
	srv.start()

	fc := &failConn{failWrite: true}
	s := NewSOCKS5Transport(srv.addr, 5*time.Second)
	s.dialFn = newDialFnWith(srv, fc)

	_, err := s.DialContext(context.Background(), "tcp", "example.com:80")
	if err == nil {
		t.Fatal("expected error when handshake Write fails")
	}
	if !strings.Contains(err.Error(), "socks5 handshake write") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestSOCKS5Transport_ConnectWriteFailure exercises the CONNECT Write error
// (second write, after handshake succeeds).
func TestSOCKS5Transport_ConnectWriteFailure(t *testing.T) {
	srv := newMockSOCKS5Server(t)
	srv.start()

	fc := &failConn{failConnWrite: true}
	s := NewSOCKS5Transport(srv.addr, 5*time.Second)
	s.dialFn = newDialFnWith(srv, fc)

	_, err := s.DialContext(context.Background(), "tcp", "example.com:80")
	if err == nil {
		t.Fatal("expected error when CONNECT Write fails")
	}
	if !strings.Contains(err.Error(), "socks5 connect write") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestSOCKS5Transport_ConnectReadFailure exercises the CONNECT read error
// (second read, after handshake response succeeds).
func TestSOCKS5Transport_ConnectReadFailure(t *testing.T) {
	srv := newMockSOCKS5Server(t)
	srv.start()

	fc := &failConn{failConnRead: true}
	s := NewSOCKS5Transport(srv.addr, 5*time.Second)
	s.dialFn = newDialFnWith(srv, fc)

	_, err := s.DialContext(context.Background(), "tcp", "example.com:80")
	if err == nil {
		t.Fatal("expected error when CONNECT Read fails")
	}
	if !strings.Contains(err.Error(), "socks5 connect read") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestSOCKS5Transport_ClearDeadlineFailure exercises the clear-deadline error
// path (SetDeadline(zero) fails after successful CONNECT).
func TestSOCKS5Transport_ClearDeadlineFailure(t *testing.T) {
	srv := newMockSOCKS5Server(t)
	srv.start()

	fc := &failConn{failClearDL: true}
	s := NewSOCKS5Transport(srv.addr, 5*time.Second)
	s.dialFn = newDialFnWith(srv, fc)

	_, err := s.DialContext(context.Background(), "tcp", "example.com:80")
	if err == nil {
		t.Fatal("expected error when clear deadline fails")
	}
	if !strings.Contains(err.Error(), "socks5 clear deadline") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestSOCKS5Transport_dialFn_Error verifies that a dialFn that returns an
// error is wrapped as ErrProxyUnreachable.
func TestSOCKS5Transport_dialFn_Error(t *testing.T) {
	s := NewSOCKS5Transport("127.0.0.1:1080", 5*time.Second)
	s.dialFn = func(ctx context.Context, network, addr string) (net.Conn, error) {
		return nil, fmt.Errorf("injected dial error")
	}
	_, err := s.DialContext(context.Background(), "tcp", "example.com:80")
	if err == nil {
		t.Fatal("expected error from dialFn")
	}
	if !errors.Is(err, ErrProxyUnreachable) {
		t.Fatalf("expected ErrProxyUnreachable, got: %v", err)
	}
}
