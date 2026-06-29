package health

import (
	"testing"
	"time"
)

func TestStale_NoEntries(t *testing.T) {
	r := New()
	stale := r.Stale(time.Minute)
	if len(stale) != 0 {
		t.Fatalf("expected no stale entries, got %v", stale)
	}
}

func TestStale_FreshEntry(t *testing.T) {
	r := New()
	r.Report("imap", true, "")
	stale := r.Stale(time.Hour)
	if len(stale) != 0 {
		t.Fatalf("expected no stale entries for fresh daemon, got %v", stale)
	}
}

func TestStale_StaleEntry(t *testing.T) {
	r := New()
	r.Report("old_daemon", true, "")

	// Move the LastRun back in time by directly manipulating via a re-report
	// won't work, but we can test using a very short maxAge.
	// Sleep a tiny bit so the entry is "old" relative to a 1ns threshold.
	time.Sleep(2 * time.Millisecond)

	stale := r.Stale(time.Millisecond)
	if len(stale) != 1 || stale[0] != "old_daemon" {
		t.Fatalf("expected [old_daemon] to be stale, got %v", stale)
	}
}

func TestStale_MixedFreshnessEntries(t *testing.T) {
	r := New()
	r.Report("fresh", true, "")

	time.Sleep(2 * time.Millisecond)
	// Now fresh is slightly old. Re-report "fresh" so it's actually fresh,
	// and leave "stale_one" only recorded before the sleep.
	r.Report("stale_one", false, "timeout")

	time.Sleep(2 * time.Millisecond)
	// Re-report fresh to refresh its LastRun.
	r.Report("fresh", true, "")

	// With a 3ms threshold, stale_one (reported ~2ms ago) is borderline;
	// use a tighter window to reliably flag stale_one but not fresh.
	stale := r.Stale(1 * time.Millisecond)
	found := false
	for _, name := range stale {
		if name == "fresh" {
			t.Errorf("fresh daemon should not be stale")
		}
		if name == "stale_one" {
			found = true
		}
	}
	if !found {
		t.Error("stale_one should be in stale list")
	}
}

func TestStale_MultipleStaleEntries(t *testing.T) {
	r := New()
	r.Report("daemon_a", true, "")
	r.Report("daemon_b", false, "err")

	time.Sleep(2 * time.Millisecond)

	stale := r.Stale(time.Millisecond)
	if len(stale) != 2 {
		t.Fatalf("expected 2 stale entries, got %d: %v", len(stale), stale)
	}
}
