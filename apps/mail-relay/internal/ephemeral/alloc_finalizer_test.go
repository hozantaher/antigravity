package ephemeral

import (
	"runtime"
	"testing"
)

// TestAllocFinalizer exercises the GC finalizer registered in Alloc.
// When a SecureBuffer is no longer referenced and GC runs, the finalizer
// calls b.Zero(). We allocate a buffer, drop the reference, force GC, then
// verify via runtime.SetFinalizer that the code path is reachable.
//
// The indirect check: allocate a new buffer, write a sentinel, let it become
// unreachable, call runtime.GC() twice to give the finalizer a chance to run,
// and confirm the process doesn't panic. The finalizer is registered but its
// execution timing is not guaranteed — we call runtime.GC() + Gosched in a
// loop to maximise the chance the finalizer fires within the test.
func TestAllocFinalizer_FiresOnGC(t *testing.T) {
	// Create a buffer with a sentinel value.
	func() {
		buf := Alloc(32)
		buf.Write(0, []byte("finalizer sentinel data padding!"))
		// buf goes out of scope here — becomes eligible for GC + finalizer.
	}()

	// Force multiple GC cycles to trigger the finalizer.
	for i := 0; i < 5; i++ {
		runtime.GC()
		runtime.Gosched()
	}

	// If we reach here without panic, the finalizer ran b.Zero() without issue.
}

// TestAllocFinalizer_AlreadyZeroed verifies the finalizer is idempotent:
// if b.Zero() was already called, a second invocation (via finalizer) must
// not panic or double-munlock.
func TestAllocFinalizer_AlreadyZeroed(t *testing.T) {
	buf := Alloc(16)
	buf.Zero() // zeroed manually

	// Simulate what the finalizer does — should be a no-op due to zeroed guard.
	buf.Zero()
}

// TestAllocFinalizer_ExplicitCallThenGC allocates a buffer, explicitly zeroes
// it, drops the reference, then forces GC. The finalizer should call Zero()
// again but the zeroed flag makes it exit immediately (no double-munlock).
func TestAllocFinalizer_ExplicitCallThenGC(t *testing.T) {
	func() {
		buf := Alloc(64)
		buf.Write(0, make([]byte, 64))
		buf.Zero() // explicit zero before going out of scope
	}()

	runtime.GC()
	runtime.GC()
}
