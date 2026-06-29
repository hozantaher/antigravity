package campaign

import (
	"fmt"
	"strings"
	"testing"
	"testing/quick"
)

// helper: build N contacts with same domain
func buildSameDomain(n int, domain string) []dedupContact {
	out := make([]dedupContact, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, dedupContact{
			ContactID: int64(i + 1),
			Email:     fmt.Sprintf("u%d@%s", i, domain),
		})
	}
	return out
}

// ── Property: ApplyDomainCap never panics ────────────────────
func TestProperty_ApplyDomainCap_NoPanic(t *testing.T) {
	f := func(n uint8, cap int8) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic n=%d cap=%d: %v", n, cap, r)
			}
		}()
		contacts := buildSameDomain(int(n), "example.com")
		_ = ApplyDomainCap(contacts, int(cap))
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: cap <= 0 → empty result ────────────────────────
func TestProperty_ApplyDomainCap_ZeroCapEmpty(t *testing.T) {
	contacts := buildSameDomain(10, "example.com")
	for _, cap := range []int{0, -1, -100} {
		got := ApplyDomainCap(contacts, cap)
		if len(got) != 0 {
			t.Fatalf("cap=%d: want empty, got %d items", cap, len(got))
		}
	}
}

// ── Property: output length ≤ input length ───────────────────
func TestProperty_ApplyDomainCap_ShrinksOnly(t *testing.T) {
	f := func(n uint8, cap uint8) bool {
		contacts := buildSameDomain(int(n), "example.com")
		got := ApplyDomainCap(contacts, int(cap))
		return len(got) <= len(contacts)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: cap≥n → no filter ──────────────────────────────
func TestProperty_ApplyDomainCap_HighCapNoFilter(t *testing.T) {
	contacts := buildSameDomain(5, "example.com")
	for _, cap := range []int{5, 10, 100, 1000} {
		got := ApplyDomainCap(contacts, cap)
		if len(got) != 5 {
			t.Fatalf("cap=%d: want all 5, got %d", cap, len(got))
		}
	}
}

// ── Property: per-domain count exactly cap (if enough) ───────
func TestProperty_ApplyDomainCap_CountPerDomain(t *testing.T) {
	contacts := buildSameDomain(10, "example.com")
	for cap := 1; cap <= 10; cap++ {
		got := ApplyDomainCap(contacts, cap)
		if len(got) != cap {
			t.Fatalf("10 contacts/1 domain, cap=%d: want %d, got %d", cap, cap, len(got))
		}
	}
}

// ── Property: multiple domains isolated ──────────────────────
func TestProperty_ApplyDomainCap_IndependentDomains(t *testing.T) {
	contacts := []dedupContact{
		{Email: "a1@x.com"}, {Email: "a2@x.com"}, {Email: "a3@x.com"},
		{Email: "b1@y.com"}, {Email: "b2@y.com"},
		{Email: "c1@z.com"},
	}
	// cap=2: 2 from x, 2 from y, 1 from z = 5
	got := ApplyDomainCap(contacts, 2)
	if len(got) != 5 {
		t.Fatalf("independent domains cap=2: want 5, got %d", len(got))
	}
}

// ── Property: order preserved (stable) ───────────────────────
func TestProperty_ApplyDomainCap_OrderPreserved(t *testing.T) {
	contacts := []dedupContact{
		{ContactID: 1, Email: "a@x.com"},
		{ContactID: 2, Email: "b@x.com"},
		{ContactID: 3, Email: "c@x.com"}, // dropped at cap=2
		{ContactID: 4, Email: "d@y.com"},
	}
	got := ApplyDomainCap(contacts, 2)
	wantIDs := []int64{1, 2, 4}
	if len(got) != len(wantIDs) {
		t.Fatalf("want %d items, got %d", len(wantIDs), len(got))
	}
	for i, want := range wantIDs {
		if got[i].ContactID != want {
			t.Fatalf("idx=%d: want ContactID=%d, got %d", i, want, got[i].ContactID)
		}
	}
}

// ── Property: malformed email domain counts as "" domain ─────
func TestProperty_ApplyDomainCap_MalformedEmail(t *testing.T) {
	// All 3 have empty domain (no @). Cap=2 means 2 pass, 1 drops.
	contacts := []dedupContact{
		{Email: "noAt1"},
		{Email: "noAt2"},
		{Email: "noAt3"},
	}
	got := ApplyDomainCap(contacts, 2)
	if len(got) != 2 {
		t.Fatalf("3 noAt contacts, cap=2: want 2, got %d", len(got))
	}
}

// ── Property: ApplyHoldingCluster never panics ───────────────
func TestProperty_ApplyHoldingCluster_NoPanic(t *testing.T) {
	f := func(n uint8, cap int8) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic: %v", r)
			}
		}()
		contacts := make([]dedupContact, 0, n)
		for i := 0; i < int(n); i++ {
			contacts = append(contacts, dedupContact{ContactID: int64(i), ParentICO: "P"})
		}
		_ = ApplyHoldingCluster(contacts, int(cap))
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: empty ParentICO pass unconditionally ───────────
func TestProperty_ApplyHoldingCluster_EmptyParentPassesThrough(t *testing.T) {
	contacts := []dedupContact{
		{ContactID: 1, ParentICO: ""},
		{ContactID: 2, ParentICO: ""},
		{ContactID: 3, ParentICO: ""},
		{ContactID: 4, ParentICO: ""},
	}
	got := ApplyHoldingCluster(contacts, 1)
	if len(got) != 4 {
		t.Fatalf("4 standalone companies (empty ParentICO), cap=1: want all 4 pass, got %d", len(got))
	}
}

// ── Property: holding cluster cap enforced per parent_ico ────
func TestProperty_ApplyHoldingCluster_CapPerParent(t *testing.T) {
	contacts := []dedupContact{
		{ContactID: 1, ParentICO: "HOLDING-A"},
		{ContactID: 2, ParentICO: "HOLDING-A"},
		{ContactID: 3, ParentICO: "HOLDING-A"},
		{ContactID: 4, ParentICO: "HOLDING-B"},
		{ContactID: 5, ParentICO: "HOLDING-B"},
	}
	// cap=1 → 1 from A, 1 from B = 2
	got := ApplyHoldingCluster(contacts, 1)
	if len(got) != 2 {
		t.Fatalf("2 holdings with cap=1: want 2, got %d", len(got))
	}
}

// ── Property: mixed standalone + holding ─────────────────────
func TestProperty_ApplyHoldingCluster_Mixed(t *testing.T) {
	contacts := []dedupContact{
		{ContactID: 1, ParentICO: "H-A"},
		{ContactID: 2, ParentICO: "H-A"},
		{ContactID: 3, ParentICO: ""},   // standalone
		{ContactID: 4, ParentICO: "H-A"}, // capped out
		{ContactID: 5, ParentICO: ""},   // standalone
	}
	// cap=1 → ContactID=1 (H-A), 3 (standalone), 5 (standalone) = 3 items
	got := ApplyHoldingCluster(contacts, 1)
	if len(got) != 3 {
		t.Fatalf("mixed cap=1: want 3, got %d", len(got))
	}
	want := []int64{1, 3, 5}
	for i, w := range want {
		if got[i].ContactID != w {
			t.Fatalf("idx=%d: want ContactID=%d, got %d", i, w, got[i].ContactID)
		}
	}
}

// ── Property: extractEmailDomain never panics ────────────────
func TestProperty_ExtractEmailDomain_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", s, r)
			}
		}()
		_ = extractEmailDomain(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: extractEmailDomain no-@ → empty ────────────────
func TestProperty_ExtractEmailDomain_NoAtEmpty(t *testing.T) {
	f := func(s string) bool {
		if strings.Contains(s, "@") {
			return true
		}
		return extractEmailDomain(s) == ""
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: extractEmailDomain last @ wins ─────────────────
// LastIndex semantics: "a@b@c" → "c".
func TestProperty_ExtractEmailDomain_LastAtWins(t *testing.T) {
	cases := map[string]string{
		"user@example.com":  "example.com",
		"a@b@c":             "c",
		"@domain.com":       "domain.com",
		"noAt":              "",
		"":                  "",
		"user@":             "",
		"a@b@c@d.cz":        "d.cz",
	}
	for in, want := range cases {
		if got := extractEmailDomain(in); got != want {
			t.Fatalf("extractEmailDomain(%q) = %q, want %q", in, got, want)
		}
	}
}
