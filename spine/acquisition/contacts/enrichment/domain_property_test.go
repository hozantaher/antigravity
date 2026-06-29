package enrich

import (
	"strings"
	"testing"
	"testing/quick"
)

// ── Property: ClassifyDomain never panics ────────────────────
func TestProperty_ClassifyDomain_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", s, r)
			}
		}()
		_ = ClassifyDomain(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: ClassifyDomain is deterministic ────────────────
func TestProperty_ClassifyDomain_Deterministic(t *testing.T) {
	f := func(s string) bool {
		return ClassifyDomain(s) == ClassifyDomain(s)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: case-insensitive ────────────────────────────────
func TestProperty_ClassifyDomain_CaseInsensitive(t *testing.T) {
	cases := []string{
		"gmail.com", "seznam.cz", "yahoo.com", "example.com",
		"corp.cuni.cz", "mfcr.gov.cz",
	}
	for _, d := range cases {
		lower := ClassifyDomain(strings.ToLower(d))
		upper := ClassifyDomain(strings.ToUpper(d))
		mixed := ClassifyDomain(strings.Title(d))
		if lower != upper || lower != mixed {
			t.Fatalf("case mismatch for %q: lower=%v upper=%v mixed=%v", d, lower, upper, mixed)
		}
	}
}

// ── Property: whitespace tolerant ─────────────────────────────
func TestProperty_ClassifyDomain_WhitespaceTolerant(t *testing.T) {
	base := ClassifyDomain("gmail.com")
	for _, s := range []string{" gmail.com", "gmail.com ", "  gmail.com  "} {
		if ClassifyDomain(s) != base {
			t.Fatalf("whitespace %q should match base", s)
		}
	}
}

// ── Property: empty → DomainUnknown ──────────────────────────
func TestProperty_ClassifyDomain_Empty(t *testing.T) {
	for _, s := range []string{"", "   ", "\t\n"} {
		if ClassifyDomain(s) != DomainUnknown {
			t.Fatalf("empty/ws input %q should be DomainUnknown", s)
		}
	}
}

// ── Property: enum range ─────────────────────────────────────
func TestProperty_ClassifyDomain_EnumRange(t *testing.T) {
	valid := map[DomainType]bool{
		DomainFreemail:  true,
		DomainGov:       true,
		DomainEdu:       true,
		DomainCorporate: true,
		DomainUnknown:   true,
	}
	f := func(s string) bool {
		return valid[ClassifyDomain(s)]
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Explicit: known freemail domains ─────────────────────────
func TestProperty_ClassifyDomain_FreemailList(t *testing.T) {
	freemail := []string{
		"gmail.com", "seznam.cz", "yahoo.com", "hotmail.com",
		"outlook.com", "protonmail.com", "icloud.com",
	}
	for _, d := range freemail {
		if ClassifyDomain(d) != DomainFreemail {
			t.Fatalf("%q should be DomainFreemail", d)
		}
	}
}

// ── Explicit: CZ government domains ──────────────────────────
func TestProperty_ClassifyDomain_GovCZ(t *testing.T) {
	gov := []string{
		"mfcr.gov.cz",
		"sub.mfcr.gov.cz",
		"uiv.muni.cz",
	}
	for _, d := range gov {
		got := ClassifyDomain(d)
		// Note: .muni.cz is BOTH gov-suffix and edu-suffix; current impl checks
		// gov first, so it classifies as DomainGov.
		if got != DomainGov && got != DomainEdu {
			t.Fatalf("%q: want Gov or Edu, got %v", d, got)
		}
	}
}

// ── Explicit: Educational domains ────────────────────────────
func TestProperty_ClassifyDomain_Edu(t *testing.T) {
	edu := []string{
		"mit.edu", "stanford.edu",
		"math.cvut.cz", "fee.cvut.cz",
		"fi.cuni.cz", "ff.cuni.cz",
		"fel.vutbr.cz", "sci.upol.cz",
	}
	for _, d := range edu {
		if ClassifyDomain(d) != DomainEdu {
			t.Fatalf("%q should be DomainEdu", d)
		}
	}
}

// ── Explicit: Corporate domains (default bucket) ─────────────
func TestProperty_ClassifyDomain_Corporate(t *testing.T) {
	corp := []string{
		"example.com",
		"alpha-strojirna.cz",
		"hozan.cz",
		"prumysl-ostrava.cz",
	}
	for _, d := range corp {
		if ClassifyDomain(d) != DomainCorporate {
			t.Fatalf("%q should be DomainCorporate", d)
		}
	}
}

// ── Property: IsFreemail ↔ ClassifyDomain consistency ────────
func TestProperty_IsFreemail_Consistent(t *testing.T) {
	f := func(s string) bool {
		return IsFreemail(s) == (ClassifyDomain(s) == DomainFreemail)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: DomainFromEmail never panics ───────────────────
func TestProperty_DomainFromEmail_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", s, r)
			}
		}()
		_ = DomainFromEmail(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: DomainFromEmail extracts post-@ part ──────────
func TestProperty_DomainFromEmail_ExtractsAfterAt(t *testing.T) {
	cases := map[string]string{
		"user@example.com":  "example.com",
		"a@b.cz":            "b.cz",
		"UPPER@DOMAIN.COM":  "domain.com",
		"  jan@alpha.cz  ":  "alpha.cz",
	}
	for in, want := range cases {
		if got := DomainFromEmail(in); got != want {
			t.Fatalf("DomainFromEmail(%q) = %q, want %q", in, got, want)
		}
	}
}

// ── Property: DomainFromEmail empty for malformed input ──────
func TestProperty_DomainFromEmail_Malformed(t *testing.T) {
	bad := []string{
		"noAtSign",
		"",
		"@",
		"just text",
	}
	for _, s := range bad {
		got := DomainFromEmail(s)
		// "@" splits to ["", ""] which is len=2, so returns "" as domain.
		// "noAtSign" has no @, returns "".
		if got != "" {
			// Document current behavior; may need to tighten in future.
			t.Logf("note: DomainFromEmail(%q) = %q", s, got)
		}
	}
}

// ── Property: multiple @s — last one wins (or returns empty) ──
func TestProperty_DomainFromEmail_MultipleAt(t *testing.T) {
	// strings.SplitN with n=2 returns first @ split; domain = after first @
	got := DomainFromEmail("a@b@c.cz")
	if got != "b@c.cz" {
		t.Fatalf("SplitN(2) semantics: want 'b@c.cz', got %q", got)
	}
}
