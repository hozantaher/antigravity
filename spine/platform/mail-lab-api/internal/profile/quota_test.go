package profile

import (
	"sync"
	"sync/atomic"
	"testing"
)

// ════════════════════════════════════════════════════════════════════════
// Brutal coverage for ML2.6 — per-mailbox quota tracker.
// ════════════════════════════════════════════════════════════════════════

// 1. Empty tracker reports 0.
func TestS26_Quota_EmptyZero(t *testing.T) {
	q := NewQuotaTracker()
	if got := q.Bytes("a@x"); got != 0 {
		t.Errorf("empty %d, want 0", got)
	}
}

// 2. AddBytes increments + returns post-add total.
func TestS26_Quota_AddIncrements(t *testing.T) {
	q := NewQuotaTracker()
	if got := q.AddBytes("a@x", 100); got != 100 {
		t.Errorf("first add %d, want 100", got)
	}
	if got := q.AddBytes("a@x", 50); got != 150 {
		t.Errorf("second add %d, want 150", got)
	}
}

// 3. Negative AddBytes ignored (use Remove).
func TestS26_Quota_NegativeAddIgnored(t *testing.T) {
	q := NewQuotaTracker()
	q.AddBytes("a@x", 100)
	if got := q.AddBytes("a@x", -50); got != 100 {
		t.Errorf("after neg-add %d, want 100", got)
	}
}

// 4. Zero AddBytes is no-op.
func TestS26_Quota_ZeroAddNoop(t *testing.T) {
	q := NewQuotaTracker()
	q.AddBytes("a@x", 100)
	q.AddBytes("a@x", 0)
	if got := q.Bytes("a@x"); got != 100 {
		t.Errorf("after 0-add %d, want 100", got)
	}
}

// 5. RemoveBytes decrements.
func TestS26_Quota_Remove(t *testing.T) {
	q := NewQuotaTracker()
	q.AddBytes("a@x", 100)
	if got := q.RemoveBytes("a@x", 30); got != 70 {
		t.Errorf("after remove %d, want 70", got)
	}
}

// 6. RemoveBytes clamps at 0 (no negative).
func TestS26_Quota_RemoveClampsZero(t *testing.T) {
	q := NewQuotaTracker()
	q.AddBytes("a@x", 100)
	if got := q.RemoveBytes("a@x", 999); got != 0 {
		t.Errorf("over-remove %d, want 0 (clamped)", got)
	}
}

// 7. Negative RemoveBytes ignored.
func TestS26_Quota_NegativeRemoveIgnored(t *testing.T) {
	q := NewQuotaTracker()
	q.AddBytes("a@x", 100)
	if got := q.RemoveBytes("a@x", -50); got != 100 {
		t.Errorf("neg-remove %d, want 100", got)
	}
}

// 8. Per-mailbox isolation.
func TestS26_Quota_PerMailboxIsolation(t *testing.T) {
	q := NewQuotaTracker()
	q.AddBytes("a@x", 100)
	q.AddBytes("b@x", 200)
	if got := q.Bytes("a@x"); got != 100 {
		t.Errorf("a %d, want 100", got)
	}
	if got := q.Bytes("b@x"); got != 200 {
		t.Errorf("b %d, want 200", got)
	}
}

// 9. Allow returns true under cap.
func TestS26_Quota_AllowUnderCap(t *testing.T) {
	q := NewQuotaTracker()
	p := &Profile{MailboxQuotaBytes: 1000}
	q.AddBytes("a@x", 500)
	if !q.Allow("a@x", 400, p) {
		t.Error("Allow false at 500+400<=1000")
	}
}

// 10. Allow at exact cap (boundary, <=).
func TestS26_Quota_AllowAtCap(t *testing.T) {
	q := NewQuotaTracker()
	p := &Profile{MailboxQuotaBytes: 1000}
	q.AddBytes("a@x", 500)
	if !q.Allow("a@x", 500, p) {
		t.Error("Allow false at exactly cap")
	}
}

// 11. Allow false over cap (boundary +1).
func TestS26_Quota_AllowOverCap(t *testing.T) {
	q := NewQuotaTracker()
	p := &Profile{MailboxQuotaBytes: 1000}
	q.AddBytes("a@x", 500)
	if q.Allow("a@x", 501, p) {
		t.Error("Allow true at 500+501>1000")
	}
}

// 12. Nil profile = unlimited.
func TestS26_Quota_NilProfile(t *testing.T) {
	q := NewQuotaTracker()
	q.AddBytes("a@x", 1<<60)
	if !q.Allow("a@x", 1<<60, nil) {
		t.Error("nil profile not unlimited")
	}
}

// 13. Profile with cap<=0 = unlimited.
func TestS26_Quota_ZeroCap(t *testing.T) {
	q := NewQuotaTracker()
	q.AddBytes("a@x", 1<<60)
	if !q.Allow("a@x", 1<<60, &Profile{MailboxQuotaBytes: 0}) {
		t.Error("zero-cap profile not unlimited")
	}
}

// 14. Reset clears all state.
func TestS26_Quota_Reset(t *testing.T) {
	q := NewQuotaTracker()
	q.AddBytes("a@x", 100)
	q.AddBytes("b@x", 200)
	q.Reset()
	if got := q.Bytes("a@x") + q.Bytes("b@x"); got != 0 {
		t.Errorf("post-reset total %d, want 0", got)
	}
}

// 15. Mailbox key normalized (case + whitespace).
func TestS26_Quota_KeyNormalization(t *testing.T) {
	q := NewQuotaTracker()
	q.AddBytes(" Alice@X ", 100)
	if got := q.Bytes("alice@x"); got != 100 {
		t.Errorf("normalized %d, want 100", got)
	}
}

// 16. Concurrent AddBytes race-free + correct sum.
func TestS26_Quota_ConcurrentAdd(t *testing.T) {
	q := NewQuotaTracker()
	var wg sync.WaitGroup
	const N = 100
	var added int64
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			q.AddBytes("a@x", 10)
			atomic.AddInt64(&added, 10)
		}()
	}
	wg.Wait()
	if got := q.Bytes("a@x"); got != atomic.LoadInt64(&added) {
		t.Errorf("got %d, want %d", got, added)
	}
}

// 17. Concurrent Add/Remove race-free.
func TestS26_Quota_ConcurrentMixed(t *testing.T) {
	q := NewQuotaTracker()
	q.AddBytes("a@x", 1000)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func() { defer wg.Done(); q.AddBytes("a@x", 1) }()
		go func() { defer wg.Done(); q.RemoveBytes("a@x", 1) }()
	}
	wg.Wait()
}

// 18. Registry QuotaAdd returns post-add + profile cap.
func TestS26_Registry_QuotaAdd(t *testing.T) {
	r := loadedRegistry(t)
	used, cap, err := r.QuotaAdd("seznam.lab", "a@seznam.lab", 1024)
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	if used != 1024 {
		t.Errorf("used %d, want 1024", used)
	}
	if cap != 1073741824 { // seznam = 1GB
		t.Errorf("cap %d, want 1073741824", cap)
	}
}

// 19. Registry QuotaUsage returns 0 for unrecorded.
func TestS26_Registry_QuotaUsage_Empty(t *testing.T) {
	r := loadedRegistry(t)
	used, cap, err := r.QuotaUsage("gmail.lab", "fresh@gmail.lab")
	if err != nil {
		t.Fatalf("usage: %v", err)
	}
	if used != 0 || cap != 16106127360 { // gmail = 15GB
		t.Errorf("used=%d cap=%d, want 0/16106127360", used, cap)
	}
}

// 20. Registry QuotaAdd unknown domain → ErrUnknownDomain.
func TestS26_Registry_QuotaAdd_Unknown(t *testing.T) {
	r := loadedRegistry(t)
	_, _, err := r.QuotaAdd("never.lab", "a@x", 100)
	if err != ErrUnknownDomain {
		t.Errorf("got %v, want ErrUnknownDomain", err)
	}
}

// 21. Registry QuotaAllow respects per-domain cap.
func TestS26_Registry_QuotaAllow_PerDomain(t *testing.T) {
	r := loadedRegistry(t)
	// outlook cap = 50MB = 52428800
	r.QuotaAdd("outlook.lab", "a@outlook.lab", 50*1024*1024)
	allow, _ := r.QuotaAllow("outlook.lab", "a@outlook.lab", 1)
	if allow {
		t.Error("Allow true at cap+1")
	}
}

// 22. Registry QuotaRemove decrements.
func TestS26_Registry_QuotaRemove(t *testing.T) {
	r := loadedRegistry(t)
	r.QuotaAdd("seznam.lab", "a@seznam.lab", 500)
	used, _, err := r.QuotaRemove("seznam.lab", "a@seznam.lab", 200)
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	if used != 300 {
		t.Errorf("used %d, want 300", used)
	}
}

// 23. Registry QuotaReset clears.
func TestS26_Registry_QuotaReset(t *testing.T) {
	r := loadedRegistry(t)
	r.QuotaAdd("seznam.lab", "a@seznam.lab", 500)
	r.QuotaReset()
	used, _, _ := r.QuotaUsage("seznam.lab", "a@seznam.lab")
	if used != 0 {
		t.Errorf("post-reset used %d, want 0", used)
	}
}
