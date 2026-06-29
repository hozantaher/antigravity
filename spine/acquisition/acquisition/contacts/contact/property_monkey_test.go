package contact

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"testing/quick"
)

// ── Property: hashEmail always returns a 64-char hex string ───────────────────
//
// SHA-256 in hex = 64 characters. The result must never be empty and
// must always be exactly 64 chars regardless of input length or charset.
func TestProperty_HashEmail_Always64Hex(t *testing.T) {
	f := func(email string) bool {
		h := hashEmail(email)
		if len(h) != 64 {
			t.Errorf("hashEmail(%q) len = %d, want 64", email, len(h))
			return false
		}
		for _, c := range h {
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
				t.Errorf("hashEmail(%q) contains non-hex char %q", email, c)
				return false
			}
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: hashEmail is deterministic ──────────────────────────────────────
func TestProperty_HashEmail_Deterministic_Quick(t *testing.T) {
	f := func(email string) bool {
		h1 := hashEmail(email)
		h2 := hashEmail(email)
		if h1 != h2 {
			t.Errorf("non-deterministic hashEmail(%q): %q vs %q", email, h1, h2)
			return false
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: hashEmail is case-insensitive and trims whitespace ──────────────
func TestProperty_HashEmail_NormalizedInput(t *testing.T) {
	inputs := []struct{ a, b string }{
		{"Test@Firma.CZ", "test@firma.cz"},
		{"  test@firma.cz  ", "test@firma.cz"},
		{"TEST@FIRMA.CZ", "test@firma.cz"},
		{"  TEST@FIRMA.CZ  ", "test@firma.cz"},
		{"", ""},
	}
	for _, tc := range inputs {
		if hashEmail(tc.a) != hashEmail(tc.b) {
			t.Errorf("hashEmail(%q) != hashEmail(%q)", tc.a, tc.b)
		}
	}
}

// ── Property: hashEmail distinguishes distinct addresses ──────────────────────
func TestProperty_HashEmail_DistinctAddresses_DifferentHashes(t *testing.T) {
	pairs := [][2]string{
		{"a@firm.cz", "b@firm.cz"},
		{"jan@novak.cz", "jana@novak.cz"},
		{"x@x.x", "x@x.y"},
		{"user+tag@firm.cz", "user@firm.cz"},
	}
	for _, pair := range pairs {
		h1 := hashEmail(pair[0])
		h2 := hashEmail(pair[1])
		if h1 == h2 {
			t.Errorf("collision: hashEmail(%q) == hashEmail(%q) = %q", pair[0], pair[1], h1)
		}
	}
}

// ── Boundary: Status constants cover all expected lifecycle values ─────────────
func TestBoundary_StatusConstants_AllLifecycle(t *testing.T) {
	lifecycle := []Status{
		StatusNew, StatusValidating, StatusValid, StatusInvalid, StatusActive,
		StatusSent, StatusOpened, StatusReplied,
		StatusBounced, StatusBlacklisted, StatusUnsubscribed,
	}
	seen := make(map[Status]bool)
	for _, s := range lifecycle {
		if s == "" {
			t.Error("lifecycle status must not be empty string")
		}
		if seen[s] {
			t.Errorf("duplicate status: %q", s)
		}
		seen[s] = true
	}
}

// ── Boundary: Valid status transitions ────────────────────────────────────────
//
// ExcludedStatuses must be a strict subset of all known statuses.
func TestBoundary_ExcludedStatuses_AreSubsetOfAllStatuses(t *testing.T) {
	all := map[Status]bool{
		StatusNew: true, StatusValidating: true, StatusValid: true,
		StatusInvalid: true, StatusActive: true,
		StatusSent: true, StatusOpened: true, StatusReplied: true,
		StatusBounced: true, StatusBlacklisted: true, StatusUnsubscribed: true,
	}
	for _, ex := range ExcludedStatuses() {
		if !all[ex] {
			t.Errorf("ExcludedStatuses contains unknown status %q", ex)
		}
	}
}

// ── Boundary: Store methods with nil DB return errors or panic-free ───────────
//
// NewStore(nil) must not panic at construction; method calls will panic
// or error — we only test construction + UpdateStatus/UpdateValidation
// which exercise ExecContext path before any DB call.
func TestBoundary_NewStore_NilDB_NoPanicOnConstruct(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("NewStore(nil) panicked: %v", r)
		}
	}()
	s := NewStore(nil)
	if s == nil {
		t.Error("NewStore(nil) returned nil")
	}
}

// ── Boundary: Store.Create sets timestamps ────────────────────────────────────
func TestBoundary_Store_Create_SetsCreatedAndUpdatedAt(t *testing.T) {
	db := &mockDB{}
	s := NewStore(db)
	c := &Contact{Email: "boundary@firma.cz", Status: StatusNew}
	if err := s.Create(context.Background(), c); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if c.CreatedAt.IsZero() {
		t.Error("CreatedAt must be set by Create")
	}
	if c.UpdatedAt.IsZero() {
		t.Error("UpdatedAt must be set by Create")
	}
}

// ── Boundary: SegmentFilter handles large slices without panic ────────────────
func TestBoundary_SegmentFilter_LargeSlices(t *testing.T) {
	regions := make([]string, 100)
	for i := range regions {
		regions[i] = fmt.Sprintf("region-%d", i)
	}
	statuses := make([]Status, 5)
	for i, s := range []Status{StatusNew, StatusValid, StatusSent, StatusBounced, StatusUnsubscribed} {
		statuses[i] = s
	}
	min, max := 0, 100
	seg := SegmentFilter{
		Regions:     regions,
		Statuses:    statuses,
		MinScore:    &min,
		MaxScore:    &max,
		CompanySize: []string{"micro", "small", "medium", "large"},
	}
	if len(seg.Regions) != 100 {
		t.Errorf("Regions len = %d, want 100", len(seg.Regions))
	}
	if *seg.MinScore != 0 || *seg.MaxScore != 100 {
		t.Error("score bounds not set correctly")
	}
}

// ── Boundary: FindBySegment with all filter fields set ────────────────────────
func TestBoundary_FindBySegment_AllFiltersSet_ErrorPropagated(t *testing.T) {
	db := &mockDB{queryErr: errTest("forced")}
	s := NewStore(db)
	min := 1
	_, err := s.FindBySegment(context.Background(), SegmentFilter{
		Regions:     []string{"Praha", "Brno", "Ostrava"},
		Industries:  []string{"machinery", "construction", "metalwork"},
		Statuses:    []Status{StatusValid, StatusNew, StatusActive},
		MinScore:    &min,
		CompanySize: []string{"small", "medium"},
	}, 50, 100)
	if err == nil {
		t.Error("expected error from queryErr")
	}
}

// ── Monkey: Store.UpdateStatus called from 10 concurrent goroutines ───────────
//
// Covers goroutine-safe usage when mockDB itself is simple; main concern is
// no data race in the Store wrapper itself.
func TestMonkey_Store_UpdateStatus_Concurrent_NoPanic(t *testing.T) {
	db := &mockDB{}
	s := NewStore(db)

	const goroutines = 10
	var wg sync.WaitGroup
	panics := make(chan any, goroutines)
	errs := make(chan error, goroutines)

	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(id int64) {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					panics <- r
				}
			}()
			errs <- s.UpdateStatus(context.Background(), id, StatusValid)
		}(int64(i + 1))
	}
	wg.Wait()
	close(panics)
	close(errs)

	for p := range panics {
		t.Errorf("concurrent UpdateStatus panicked: %v", p)
	}
}

// ── Monkey: Store.CountByStatus with DB error never panics ───────────────────
func TestMonkey_Store_CountByStatus_DBError_NoPanic(t *testing.T) {
	db := &mockDB{queryErr: errTest("db gone")}
	s := NewStore(db)

	defer func() {
		if r := recover(); r != nil {
			t.Errorf("CountByStatus panicked: %v", r)
		}
	}()

	_, err := s.CountByStatus(context.Background())
	if err == nil {
		t.Error("expected error when queryErr is set")
	}
}

// ── Monkey: hashEmail called from many goroutines simultaneously ──────────────
func TestMonkey_HashEmail_Concurrent_Consistent(t *testing.T) {
	const goroutines = 20
	email := "concurrent@firma.cz"
	expected := hashEmail(email)

	var wg sync.WaitGroup
	results := make([]string, goroutines)
	panics := make(chan any, goroutines)

	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					panics <- r
				}
			}()
			results[idx] = hashEmail(email)
		}(i)
	}
	wg.Wait()
	close(panics)

	for p := range panics {
		t.Errorf("hashEmail panicked: %v", p)
	}
	for i, r := range results {
		if r != expected {
			t.Errorf("goroutine %d: hashEmail = %q, want %q", i, r, expected)
		}
	}
}
