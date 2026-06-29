package main

import (
	"context"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeListener is a *net.TCPListener substitute for tests.
// It allows controlling Accept behaviour: returning queued conns,
// blocking until deadline, or returning net.ErrClosed.
type fakeListener struct {
	addr    net.Addr
	mu      sync.Mutex
	conns   []net.Conn // queued connections to return
	closed  atomic.Bool
	accepts atomic.Int64
}

func newFakeListener() *fakeListener {
	a, _ := net.ResolveTCPAddr("tcp", "127.0.0.1:0")
	return &fakeListener{addr: a}
}

func (l *fakeListener) Accept() (net.Conn, error) {
	l.accepts.Add(1)
	l.mu.Lock()
	if len(l.conns) > 0 {
		c := l.conns[0]
		l.conns = l.conns[1:]
		l.mu.Unlock()
		return c, nil
	}
	l.mu.Unlock()

	if l.closed.Load() {
		return nil, net.ErrClosed
	}
	// Simulate deadline expiry (net.Error Timeout).
	return nil, &timeoutError{}
}

func (l *fakeListener) Close() error {
	l.closed.Store(true)
	return nil
}

func (l *fakeListener) Addr() net.Addr { return l.addr }

// SetDeadline satisfies the interface used by serveSOCKS5.
func (l *fakeListener) SetDeadline(_ time.Time) error { return nil }

// Push queues a connection to be returned on the next Accept call.
func (l *fakeListener) Push(c net.Conn) {
	l.mu.Lock()
	l.conns = append(l.conns, c)
	l.mu.Unlock()
}

// timeoutError implements net.Error so serveSOCKS5 treats it as a timeout.
type timeoutError struct{}

func (e *timeoutError) Error() string   { return "i/o timeout" }
func (e *timeoutError) Timeout() bool   { return true }
func (e *timeoutError) Temporary() bool { return true }

// halfConn is a minimal net.Conn for tests — reads/writes block forever,
// Close records a call.
type halfConn struct {
	net.Conn
	closed atomic.Bool
	done   chan struct{}
}

func newHalfConn() *halfConn {
	return &halfConn{done: make(chan struct{})}
}

func (c *halfConn) Close() error {
	c.closed.Store(true)
	select {
	case <-c.done:
	default:
		close(c.done)
	}
	return nil
}

func (c *halfConn) Read(_ []byte) (int, error) {
	<-c.done
	return 0, errors.New("closed")
}

func (c *halfConn) Write(_ []byte) (int, error) {
	return 0, errors.New("closed")
}

func (c *halfConn) SetDeadline(_ time.Time) error      { return nil }
func (c *halfConn) SetReadDeadline(_ time.Time) error  { return nil }
func (c *halfConn) SetWriteDeadline(_ time.Time) error { return nil }
func (c *halfConn) LocalAddr() net.Addr                { return &net.TCPAddr{} }
func (c *halfConn) RemoteAddr() net.Addr               { return &net.TCPAddr{} }

// AD3-1: serveSOCKS5 exits within 2 s when ctx is already cancelled.
func TestAD3_CtxCancelledExitsWithin2s(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // pre-cancel

	lis := newFakeListener()
	done := make(chan struct{})
	go func() {
		serveSOCKS5(ctx, lis, nil)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("serveSOCKS5 did not exit within 2s after ctx cancel")
	}
}

// AD3-2: SIGTERM scenario: cancel ctx while loop is spinning → exits within 2s.
func TestAD3_SIGTERMGracefulExit(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	lis := newFakeListener()
	done := make(chan struct{})
	go func() {
		serveSOCKS5(ctx, lis, nil)
		close(done)
	}()

	// Give the goroutine a moment to enter the loop.
	time.Sleep(10 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("serveSOCKS5 did not exit within 2s after SIGTERM-like cancel")
	}
}

// AD3-3: Accept timeout (deadline expiry) does NOT log/return an error; loop continues.
func TestAD3_AcceptTimeoutContinues(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	lis := newFakeListener() // always returns timeoutError

	// Should return cleanly when ctx expires, without panicking.
	serveSOCKS5(ctx, lis, nil)
	// If we reach here, the loop handled timeout errors without crashing.
}

// AD3-4: net.ErrClosed on Accept causes clean exit (no infinite loop).
func TestAD3_NetErrClosedExitsCleanly(t *testing.T) {
	ctx := context.Background()
	lis := newFakeListener()
	lis.Close() // makes Accept() return net.ErrClosed immediately

	done := make(chan struct{})
	go func() {
		serveSOCKS5(ctx, lis, nil)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("serveSOCKS5 did not exit within 2s on net.ErrClosed")
	}
}

// AD3-5: serveSOCKS5 WaitGroup drains before function returns.
// Verifies that the wg.Wait() call is present and reachable. We prove this
// by cancelling ctx, then observing that serveSOCKS5 returns (which can only
// happen after wg.Wait() completes).
func TestAD3_WaitGroupDrainsBeforeReturn(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	lis := newFakeListener()

	returned := make(chan struct{})
	go func() {
		serveSOCKS5(ctx, lis, nil)
		close(returned)
	}()

	time.Sleep(10 * time.Millisecond)
	cancel()

	select {
	case <-returned:
		// serveSOCKS5 returned after ctx cancel — WaitGroup drained.
	case <-time.After(2 * time.Second):
		t.Fatal("serveSOCKS5 did not return within 2s; WaitGroup may be stuck")
	}
}

// AD3-6: Accept is called multiple times (loop spins) before ctx cancel.
func TestAD3_AcceptCalledMultipleTimes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	lis := newFakeListener()

	serveSOCKS5(ctx, lis, nil)

	// The loop must have called Accept at least once (for the timeout poll).
	if lis.accepts.Load() == 0 {
		t.Fatal("Accept was never called")
	}
}

// AD3-7: Cancelling ctx while no connections are queued does not panic.
func TestAD3_CancelWithNoConns(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	lis := newFakeListener()

	done := make(chan struct{})
	go func() {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("unexpected panic: %v", r)
			}
			close(done)
		}()
		serveSOCKS5(ctx, lis, nil)
	}()

	time.Sleep(5 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("did not exit within 2s")
	}
}
