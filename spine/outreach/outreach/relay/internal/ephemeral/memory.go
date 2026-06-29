package ephemeral

import (
	"runtime"
	"sync"
)

// SecureBuffer is a byte slice that is mlocked (pinned in RAM,
// never swapped to disk) and zeroed on free.
//
// This prevents key material from being written to swap/pagefile
// and ensures it doesn't linger in memory after use.
type SecureBuffer struct {
	mu     sync.Mutex
	data   []byte
	locked bool
	zeroed bool
}

// Alloc allocates n bytes and attempts to mlock via syscall.
// If mlock fails (unprivileged process), the buffer is still usable
// but may be swapped to disk -- a degraded security state.
func Alloc(n int) *SecureBuffer {
	buf := &SecureBuffer{
		data: make([]byte, n),
	}

	// Attempt mlock to prevent swapping
	if err := mlock(buf.data); err == nil {
		buf.locked = true
	}

	// Safety net: register finalizer to zero on GC
	runtime.SetFinalizer(buf, func(b *SecureBuffer) {
		b.Zero()
	})

	return buf
}

// Bytes returns the underlying byte slice.
func (s *SecureBuffer) Bytes() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data
}

// Write copies data into the secure buffer at the given offset.
func (s *SecureBuffer) Write(offset int, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	copy(s.data[offset:], data)
}

// Zero overwrites the buffer with zeros and unlocks memory.
// Safe to call multiple times.
func (s *SecureBuffer) Zero() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.zeroed {
		return
	}

	// Zero the data
	for i := range s.data {
		s.data[i] = 0
	}

	// Unlock memory
	if s.locked {
		munlock(s.data)
		s.locked = false
	}

	s.zeroed = true
}

// IsLocked reports whether the buffer is mlocked.
func (s *SecureBuffer) IsLocked() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.locked
}

// Len returns the buffer length.
func (s *SecureBuffer) Len() int {
	return len(s.data)
}

// WipeSlice zeros a regular byte slice.
// Use for ephemeral data that doesn't need mlock.
func WipeSlice(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// registry tracks all allocated SecureBuffers for emergency wipe.
var (
	registryMu sync.Mutex
	registry   []*SecureBuffer
)

// Register adds a buffer to the global registry for emergency wipe.
func Register(buf *SecureBuffer) {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry = append(registry, buf)
}

// WipeAll zeros all registered SecureBuffers.
// Called during emergency shutdown or duress response.
func WipeAll() {
	registryMu.Lock()
	defer registryMu.Unlock()
	for _, buf := range registry {
		buf.Zero()
	}
	registry = nil
}
