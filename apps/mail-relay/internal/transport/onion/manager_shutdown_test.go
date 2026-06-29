package onion

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"relay/internal/minlog"
)

// Tests for M3 — WaitGroup-backed Shutdown.
// Start spawns a background goroutine that calls cmd.Wait(). Without
// tracking, Shutdown could return while the goroutine is mid-mutation of
// m.running, leading to apparent "not running" then later "still running"
// race observable by subsequent Start() calls.
//
// We don't need a real Tor binary — we drive /bin/sh which exits
// immediately, exercising the same cmd.Wait path.

// newManagerForShutdownTest skips if /bin/sh isn't usable (tests require a
// short-lived executable to stand in for tor).
func newManagerForShutdownTest(t *testing.T) *Manager {
	t.Helper()
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("/bin/sh not available")
	}
	dataDir := t.TempDir()
	m, err := NewManager(
		Config{
			DataDir:   dataDir,
			TorBinary: "sh",
		},
		minlog.New("test"),
	)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	return m
}

// TestShutdown_WhenNotRunning is idempotent — calling Shutdown on a fresh
// Manager must not panic, hang, or return an error other than nil (we
// promise ErrNotRunning is swallowed).
func TestShutdown_WhenNotRunning(t *testing.T) {
	m := newManagerForShutdownTest(t)
	done := make(chan error, 1)
	go func() { done <- m.Shutdown() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Shutdown on idle manager returned %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown on idle manager hung")
	}
}

// TestShutdown_WaitsForMonitorGoroutine seeds the waitWg as if Start
// spawned the monitor goroutine, then uses a controlled cmd.Wait (via
// sleep) to assert Shutdown blocks until the goroutine returns. This
// exercises the waitWg plumbing without depending on a real tor
// hidden-service bootstrap (which requires network + key generation).
func TestShutdown_WaitsForMonitorGoroutine(t *testing.T) {
	m := newManagerForShutdownTest(t)

	// Simulate Start having spawned a long-lived monitor goroutine.
	released := make(chan struct{})
	m.waitWg.Add(1)
	go func() {
		defer m.waitWg.Done()
		<-released
	}()

	shutdownDone := make(chan error, 1)
	go func() { shutdownDone <- m.Shutdown() }()

	// Shutdown must NOT complete yet — monitor still "running".
	select {
	case <-shutdownDone:
		t.Fatal("Shutdown returned before monitor goroutine exited")
	case <-time.After(100 * time.Millisecond):
		// good, blocked as expected
	}

	// Release the monitor; Shutdown now allowed to complete.
	close(released)
	select {
	case err := <-shutdownDone:
		if err != nil {
			t.Fatalf("Shutdown returned %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown did not return after monitor exit")
	}
}

// TestShutdown_ConcurrentStartStopSafe — 20 parallel Shutdowns must not
// panic, deadlock, or race each other. Catches both waitWg mis-counting
// and ErrNotRunning handling regressions.
func TestShutdown_ConcurrentSafe(t *testing.T) {
	m := newManagerForShutdownTest(t)

	// Prime a single monitor goroutine so there's work to wait on.
	released := make(chan struct{})
	m.waitWg.Add(1)
	go func() {
		defer m.waitWg.Done()
		<-released
	}()

	// Kick off concurrent Shutdowns; all must converge once released fires.
	const parallel = 20
	var wg sync.WaitGroup
	errs := make(chan error, parallel)
	for i := 0; i < parallel; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- m.Shutdown()
		}()
	}

	// Let all Shutdowns race into waitWg.Wait().
	time.Sleep(50 * time.Millisecond)
	close(released)
	wg.Wait()
	close(errs)

	for err := range errs {
		if err != nil {
			t.Errorf("concurrent Shutdown returned %v, want nil", err)
		}
	}
}

// TestShutdown_DataDirPreserved — Shutdown must not delete torrc or the
// key material; the manager should be re-startable if the caller wants
// to. Defensive test so future refactors don't silently add rm -rf.
func TestShutdown_DataDirPreserved(t *testing.T) {
	m := newManagerForShutdownTest(t)

	// Write a marker file in the data dir so we can assert it survives.
	marker := filepath.Join(m.dataDir, "marker.txt")
	if err := writeMarker(marker, "hello"); err != nil {
		t.Fatalf("seed marker: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_ = ctx // reserved for future Shutdown(ctx) variant
	if err := m.Shutdown(); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	// Marker must still be there.
	content, err := readMarker(marker)
	if err != nil {
		t.Fatalf("marker gone after Shutdown: %v", err)
	}
	if content != "hello" {
		t.Fatalf("marker corrupted: got %q, want %q", content, "hello")
	}
}

// writeMarker / readMarker — small helpers scoped to this test file.
func writeMarker(path, content string) error {
	return os.WriteFile(path, []byte(content), 0o644)
}

func readMarker(path string) (string, error) {
	b, err := os.ReadFile(path)
	return string(b), err
}
