package imap

import (
	"fmt"
	"testing"
)

// F4-1 — locks the rule that the IMAP poller's seen set is bounded.
// Pre-fix it was an unbounded map[string]bool that grew by one entry
// per processed message-id forever — long-running pollers leaked
// hundreds of MB over weeks.

func TestPoller_SeenSet_Bounded(t *testing.T) {
	p := NewPoller(nil, nil).WithSeenCap(100)
	for i := 0; i < 250; i++ {
		p.markSeen(fmt.Sprintf("msg-%d", i))
	}
	// At most cap entries should remain.
	if got := len(p.seen); got > 100 {
		t.Errorf("seen set exceeds cap: got %d, want <= 100", got)
	}
	if got := len(p.seenList); got > 100 {
		t.Errorf("seenList exceeds cap: got %d, want <= 100", got)
	}
}

func TestPoller_SeenSet_FIFOEvictionDropsOldest(t *testing.T) {
	p := NewPoller(nil, nil).WithSeenCap(3)
	p.markSeen("oldest")
	p.markSeen("middle")
	p.markSeen("newest")

	// All three present.
	for _, id := range []string{"oldest", "middle", "newest"} {
		if !p.isSeen(id) {
			t.Errorf("expected %q to be seen", id)
		}
	}

	// Add a 4th — oldest must be evicted.
	p.markSeen("post-overflow")
	if p.isSeen("oldest") {
		t.Error("oldest should have been evicted on overflow")
	}
	for _, id := range []string{"middle", "newest", "post-overflow"} {
		if !p.isSeen(id) {
			t.Errorf("expected %q to remain after overflow", id)
		}
	}
}

func TestPoller_SeenSet_IdempotentMark(t *testing.T) {
	p := NewPoller(nil, nil).WithSeenCap(2)
	p.markSeen("a")
	p.markSeen("a") // duplicate must not advance the FIFO list
	p.markSeen("b")
	p.markSeen("c") // overflow → "a" evicted, "b" + "c" remain

	if p.isSeen("a") {
		t.Error("'a' should be evicted (idempotent mark must not refresh recency)")
	}
	if !p.isSeen("b") {
		t.Error("'b' should still be seen")
	}
	if !p.isSeen("c") {
		t.Error("'c' should be seen")
	}
}

func TestPoller_SeenSet_MemoryStaysBoundedUnderHeavyChurn(t *testing.T) {
	p := NewPoller(nil, nil).WithSeenCap(1000)
	// Simulate 100k inbounds (a few months of busy mailbox traffic).
	for i := 0; i < 100_000; i++ {
		p.markSeen(fmt.Sprintf("mid-%d", i))
	}
	if got := len(p.seen); got != 1000 {
		t.Errorf("seen set len = %d after 100k inserts, want exactly cap=1000", got)
	}
	if got := len(p.seenList); got != 1000 {
		t.Errorf("seenList len = %d after 100k inserts, want exactly cap=1000", got)
	}
	// Latest 1000 must be retained.
	for i := 99_000; i < 100_000; i++ {
		if !p.isSeen(fmt.Sprintf("mid-%d", i)) {
			t.Errorf("expected mid-%d (within last 1000) to be retained", i)
			break
		}
	}
}

func TestPoller_DefaultCap_IsReasonable(t *testing.T) {
	p := NewPoller(nil, nil)
	if p.seenCap < 1000 {
		t.Errorf("default seen cap %d is too small for production traffic", p.seenCap)
	}
	if p.seenCap > 10_000_000 {
		t.Errorf("default seen cap %d is too large (memory unbounded in practice)", p.seenCap)
	}
}

func TestPoller_WithSeenCap_ClampsBelowOne(t *testing.T) {
	p := NewPoller(nil, nil).WithSeenCap(0)
	if p.seenCap < 1 {
		t.Errorf("WithSeenCap(0) must clamp to >=1, got %d", p.seenCap)
	}
	p2 := NewPoller(nil, nil).WithSeenCap(-100)
	if p2.seenCap < 1 {
		t.Errorf("WithSeenCap(-100) must clamp to >=1, got %d", p2.seenCap)
	}
}
