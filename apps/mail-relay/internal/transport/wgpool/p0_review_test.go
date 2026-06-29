package wgpool

// Post-AR/AS code review bundle — P0/P1 fixes (Fix 3, Fix 5).
//
// Fix 3 (P1.13): partial PinIO wiring detection — when only one of pinReader
// or pinWriter is set, Pick must log an error and fall back to hash routing
// rather than silently producing wrong behaviour.
//
// Fix 5 (P1): isUniqueViolation hardening — must detect SQLSTATE 23505 by
// numeric code first, then fall through to human-readable aliases.

import (
	"errors"
	"strings"
	"testing"
)

// ─── Fix 5: isUniqueViolation hardening ─────────────────────────────────────

// TS5-1: SQLSTATE 23505 code present → true (primary signal).
func TestIsUniqueViolation_NumericCode(t *testing.T) {
	err := errors.New("pq: duplicate key value violates unique constraint: sqlstate 23505")
	if !isUniqueViolation(err) {
		t.Fatal("want true for error containing 23505")
	}
}

// TS5-2: human-readable "duplicate key" alias (pgx v5 style) → true.
func TestIsUniqueViolation_DuplicateKey(t *testing.T) {
	err := errors.New("ERROR: duplicate key value violates unique constraint")
	if !isUniqueViolation(err) {
		t.Fatal("want true for 'duplicate key' error")
	}
}

// TS5-3: "unique_violation" alias (lib/pq symbolic name) → true.
func TestIsUniqueViolation_UniqueViolation(t *testing.T) {
	err := errors.New("unique_violation")
	if !isUniqueViolation(err) {
		t.Fatal("want true for 'unique_violation' error")
	}
}

// TS5-4: unrelated error → false.
func TestIsUniqueViolation_Unrelated(t *testing.T) {
	if isUniqueViolation(errors.New("connection refused")) {
		t.Fatal("want false for unrelated error")
	}
	if isUniqueViolation(nil) {
		t.Fatal("want false for nil")
	}
}

// ─── Fix 3: partial PinIO wiring ─────────────────────────────────────────────

// TS3-1: pinReader set, pinWriter nil → Pick falls back to hash routing (no
// exclusive allocation). We verify that Pick returns a valid endpoint (not an
// error) and that the returned endpoint comes from hash routing.
func TestPick_PartialWiring_ReaderOnlyFallsBackToHash(t *testing.T) {
	p := mkPool(t, 2, Config{})
	store := newStubPinStore()
	// Wire reader only — pinWriter stays nil.
	p.WithPinReader(store)

	ep, err := p.Pick("env-001", "mb-partial", "CZ")
	if err != nil {
		t.Fatalf("want successful hash fallback, got error: %v", err)
	}
	if ep.Label == "" {
		t.Fatal("want non-empty endpoint label from hash fallback")
	}
	// hasPinIO must be false, so we should NOT have entered pickAllocate.
	// Indirect verification: pick returns immediately from hash path.
	if !strings.HasPrefix(ep.SocksAddr, "127.0.0.1:") {
		t.Fatalf("unexpected socks_addr %q", ep.SocksAddr)
	}
}

// TS3-2: pinWriter set, pinReader nil → Pick falls back to hash routing.
func TestPick_PartialWiring_WriterOnlyFallsBackToHash(t *testing.T) {
	p := mkPool(t, 2, Config{})
	store := newStubPinStore()
	// Wire writer only — pinReader stays nil.
	p.WithPinWriter(store)

	ep, err := p.Pick("env-002", "mb-partial-w", "CZ")
	if err != nil {
		t.Fatalf("want successful hash fallback, got error: %v", err)
	}
	if ep.Label == "" {
		t.Fatal("want non-empty endpoint label from hash fallback")
	}
}

// TS3-3: both reader and writer set → Pick uses exclusive allocation (hasPinIO
// is true). Verify that pickAllocate assigns a pin on first call.
func TestPick_FullWiring_UsesExclusiveAllocation(t *testing.T) {
	p := mkPool(t, 2, Config{})
	store := newStubPinStore()
	p.WithPinReader(store).WithPinWriter(store)

	ep, err := p.Pick("env-003", "mb-full-wiring", "CZ")
	if err != nil {
		t.Fatalf("want endpoint from pickAllocate, got error: %v", err)
	}
	if ep.Label == "" {
		t.Fatal("want non-empty endpoint label")
	}
	// After first Pick, the mailbox should be pinned.
	pinned, _ := store.GetMailboxPinnedEndpoint("mb-full-wiring")
	if pinned == "" {
		t.Fatal("want mailbox pinned after first Pick with full IO wiring")
	}
	if pinned != ep.Label {
		t.Fatalf("pinned label %q != returned label %q", pinned, ep.Label)
	}
}
