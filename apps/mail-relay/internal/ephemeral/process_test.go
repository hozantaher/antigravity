package ephemeral

import (
	"testing"
	"time"
)

func TestPanicGuardWithPanic(t *testing.T) {
	cleanupCalled := false
	cleanup := func() { cleanupCalled = true }

	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected panic to propagate")
		}
		if r != "boom" {
			t.Errorf("panic value = %v, want boom", r)
		}
		if !cleanupCalled {
			t.Error("cleanup was not called before re-panic")
		}
	}()

	PanicGuard(cleanup, func() {
		panic("boom")
	})
}

func TestPanicGuardNoPanic(t *testing.T) {
	cleanupCalled := false
	cleanup := func() { cleanupCalled = true }

	PanicGuard(cleanup, func() {})

	if cleanupCalled {
		t.Error("cleanup should NOT be called when fn returns normally")
	}
}

func TestPanicGuardNilCleanupSafeOnPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != "oops" {
			t.Errorf("expected re-panic with 'oops', got %v", r)
		}
	}()
	PanicGuard(nil, func() { panic("oops") })
}

func TestGuardNilCleanupSafe(t *testing.T) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		Guard(nil)
	}()
	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("Guard(nil) hung")
	}
}

func TestIsLockedFalseAfterZero(t *testing.T) {
	buf := Alloc(32)
	_ = buf.IsLocked()
	buf.Zero()
	if buf.IsLocked() {
		t.Error("buffer should not be locked after Zero")
	}
}

func TestIsLockedAfterAlloc(t *testing.T) {
	buf := Alloc(64)
	defer buf.Zero()
	_ = buf.IsLocked()
}

func TestGuard_NilCleanup_NoPanic(t *testing.T) {
	// Guard with nil cleanup must not panic during setup
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("Guard(nil) panicked: %v", r)
		}
	}()
	Guard(nil) // installs signal handler; goroutine won't fire in test
}

func TestPanicGuard_NilCleanup_FnPanics_Repanics(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Error("expected re-panic from PanicGuard")
		}
	}()
	PanicGuard(nil, func() { panic("test panic") })
}

func TestPanicGuard_NilCleanup_FnSucceeds_NoPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("PanicGuard panicked unexpectedly: %v", r)
		}
	}()
	PanicGuard(nil, func() { /* no-op */ })
}

func TestPanicGuard_WithCleanup_FnSucceeds(t *testing.T) {
	called := false
	PanicGuard(func() { called = true }, func() { /* no-op */ })
	if called {
		t.Error("cleanup should not be called when fn succeeds")
	}
}
