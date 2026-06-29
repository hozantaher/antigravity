package ephemeral

import (
	"os"
	"syscall"
	"testing"
	"time"
)

// TestGuard_SignalFires_ExecPath exercises the goroutine body inside Guard
// (process.go lines 14-21): cleanup(), WipeAll(), osExit(0).
// We override osExit so the test process is not killed.
func TestGuard_SignalFires_ExecPath(t *testing.T) {
	// Register buffers so WipeAll has work to do.
	buf1 := Alloc(16)
	buf2 := Alloc(16)
	Register(buf1)
	Register(buf2)
	buf1.Write(0, []byte("sensitiveAAAAAAA"))
	buf2.Write(0, []byte("sensitiveBBBBBBB"))

	cleanupCalled := make(chan struct{}, 1)
	exitCalled := make(chan int, 1)

	// Patch osExit so Guard's goroutine doesn't kill the test runner.
	origExit := osExit
	osExit = func(code int) { exitCalled <- code }
	defer func() { osExit = origExit }()

	Guard(func() { cleanupCalled <- struct{}{} })

	// Send SIGTERM to self to fire the Guard goroutine.
	proc, err := os.FindProcess(os.Getpid())
	if err != nil {
		t.Fatalf("FindProcess: %v", err)
	}
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("Signal(SIGTERM): %v", err)
	}

	select {
	case code := <-exitCalled:
		if code != 0 {
			t.Fatalf("expected exit code 0, got %d", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Guard goroutine did not fire within 3s")
	}

	select {
	case <-cleanupCalled:
	default:
		t.Fatal("cleanup was not called by Guard goroutine")
	}
}

// TestGuard_SignalFires_NilCleanup verifies Guard doesn't panic when cleanup
// is nil and a signal fires.
func TestGuard_SignalFires_NilCleanup(t *testing.T) {
	exitCalled := make(chan int, 1)
	origExit := osExit
	osExit = func(code int) { exitCalled <- code }
	defer func() { osExit = origExit }()

	Guard(nil)

	proc, _ := os.FindProcess(os.Getpid())
	_ = proc.Signal(syscall.SIGTERM)

	select {
	case <-exitCalled:
	case <-time.After(3 * time.Second):
		t.Fatal("nil-cleanup Guard goroutine did not fire")
	}
}
