package transport

import (
	"testing"
)

func TestNewStaticRotatingProxy_SeedsWithoutFetch(t *testing.T) {
	addrs := []string{"10.0.0.1:1080", "10.0.0.2:1080", "10.0.0.3:1080"}
	tr := NewStaticRotatingProxy(addrs, nil)

	if got := tr.WorkingCount(); got != 3 {
		t.Fatalf("WorkingCount = %d, want 3", got)
	}

	pool := tr.Pool()
	if len(pool) != 3 {
		t.Fatalf("Pool length = %d, want 3", len(pool))
	}
}

func TestNewStaticRotatingProxy_RotatesRoundRobin(t *testing.T) {
	addrs := []string{"a:1080", "b:1080", "c:1080"}
	tr := NewStaticRotatingProxy(addrs, nil)

	seen := make(map[string]int)
	for i := 0; i < 9; i++ {
		p, ok := tr.pick()
		if !ok {
			t.Fatalf("pick() returned !ok on iteration %d", i)
		}
		seen[p.addr]++
	}
	for _, a := range addrs {
		if seen[a] != 3 {
			t.Errorf("addr %s picked %d times, want 3 (round-robin over 9)", a, seen[a])
		}
	}
}

func TestNewStaticRotatingProxy_EmptyListUsesFallback(t *testing.T) {
	tr := NewStaticRotatingProxy(nil, nil)
	if tr.WorkingCount() != 0 {
		t.Errorf("expected empty pool, got %d", tr.WorkingCount())
	}
	if _, ok := tr.pick(); ok {
		t.Error("pick() should return !ok on empty pool")
	}
}

func TestNewStaticRotatingProxy_RemoveEvictsDeadProxy(t *testing.T) {
	tr := NewStaticRotatingProxy([]string{"a:1080", "b:1080", "c:1080"}, nil)
	tr.remove("b:1080")
	pool := tr.Pool()
	if len(pool) != 2 {
		t.Fatalf("after remove, pool len = %d, want 2", len(pool))
	}
	for _, a := range pool {
		if a == "b:1080" {
			t.Errorf("dead proxy b:1080 still in pool")
		}
	}
}

func TestNewStaticRotatingProxy_TrimsBlankAddresses(t *testing.T) {
	tr := NewStaticRotatingProxy([]string{" a:1080 ", "", "b:1080", "   "}, nil)
	if got := tr.WorkingCount(); got != 2 {
		t.Errorf("blank-trimmed pool = %d, want 2", got)
	}
	pool := tr.Pool()
	want := map[string]bool{"a:1080": true, "b:1080": true}
	for _, a := range pool {
		if !want[a] {
			t.Errorf("unexpected addr %q in pool", a)
		}
	}
}
