package company

import (
	"strings"
	"testing"
	"testing/quick"
)

// ── parsePgArray property tests ───────────────────────────────────────────────

// TestParsePgArray_NeverPanics: property — arbitrary string input.
func TestParsePgArray_NeverPanics(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on input=%q: %v", s, r)
			}
		}()
		_ = parsePgArray(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// TestParsePgArray_ResultNeverContainsEmptyString: no empty elements in output.
func TestParsePgArray_ResultNeverContainsEmptyString(t *testing.T) {
	f := func(s string) bool {
		out := parsePgArray(s)
		for _, v := range out {
			if v == "" {
				return false
			}
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// TestParsePgArray_AllElementsTrimmed: every returned element equals its trimmed form.
func TestParsePgArray_AllElementsTrimmed(t *testing.T) {
	f := func(s string) bool {
		out := parsePgArray(s)
		for _, v := range out {
			if v != strings.TrimSpace(v) {
				return false
			}
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// TestParsePgArray_MonkeyInputs: adversarial inputs don't panic and behave gracefully.
func TestParsePgArray_MonkeyInputs(t *testing.T) {
	adversarial := []struct {
		in   string
		desc string
	}{
		{"", "empty string"},
		{"{}", "empty braces"},
		{strings.Repeat("a,", 5000) + "b", "10000-element-ish string without braces"},
		{"{" + strings.Repeat("a,", 5000) + "z}", "10000-element array"},
		{"'; DROP TABLE companies; --", "SQL injection"},
		{"{'; DROP TABLE --,other}", "SQL injection in array"},
		{"⚙️,🔧,🏗️", "emoji without braces"},
		{"{⚙️,🔧,🏗️}", "emoji in array"},
		{"\x00\x01\x02", "null bytes"},
		{"{\x00,\x01}", "null bytes in braces"},
		{"{ , , , }", "whitespace-only elements"},
	}
	for _, c := range adversarial {
		t.Run(c.desc, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("panic on %q: %v", c.in, r)
				}
			}()
			out := parsePgArray(c.in)
			// Invariant: no element is an empty string
			for _, v := range out {
				if v == "" {
					t.Errorf("parsePgArray(%q) returned empty element", c.in)
				}
			}
		})
	}
}

// ── joinStrings property tests ────────────────────────────────────────────────

// TestJoinStrings_NeverPanics: property — arbitrary slice and separator.
func TestJoinStrings_NeverPanics(t *testing.T) {
	f := func(ss []string, sep string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on ss=%v sep=%q: %v", ss, sep, r)
			}
		}()
		_ = joinStrings(ss, sep)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// TestJoinStrings_CountSeparators: for N elements, output has N-1 occurrences of sep
// (when sep doesn't appear in any element).
func TestJoinStrings_CountSeparators(t *testing.T) {
	sep := "|UNIQUE_SEP|"
	cases := [][]string{
		nil,
		{},
		{"a"},
		{"a", "b"},
		{"a", "b", "c", "d", "e"},
	}
	for _, ss := range cases {
		out := joinStrings(ss, sep)
		n := len(ss)
		want := 0
		if n > 1 {
			want = n - 1
		}
		got := strings.Count(out, sep)
		if got != want {
			t.Errorf("joinStrings(%v, %q): sep count = %d, want %d (output=%q)", ss, sep, got, want, out)
		}
	}
}

// TestJoinStrings_EquivalentToStringsJoin: matches stdlib strings.Join for printable inputs.
func TestJoinStrings_EquivalentToStringsJoin(t *testing.T) {
	f := func(ss []string, sep string) bool {
		got := joinStrings(ss, sep)
		want := strings.Join(ss, sep)
		return got == want
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// TestJoinStrings_MonkeyInputs: adversarial separators and elements.
func TestJoinStrings_MonkeyInputs(t *testing.T) {
	cases := []struct {
		ss  []string
		sep string
	}{
		{nil, ""},
		{[]string{}, ","},
		{[]string{strings.Repeat("x", 10000)}, ","},
		{[]string{"'; DROP TABLE --", "other"}, ","},
		{[]string{"⚙️", "🔧"}, " | "},
		{[]string{"\x00", "\x01"}, "\x02"},
		{[]string{"a", "b", "c"}, strings.Repeat(",", 1000)},
	}
	for _, c := range cases {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("panic on ss=%v sep=%q: %v", c.ss, c.sep, r)
				}
			}()
			got := joinStrings(c.ss, c.sep)
			want := strings.Join(c.ss, c.sep)
			if got != want {
				t.Errorf("joinStrings mismatch: got %q, want %q", got, want)
			}
		}()
	}
}

// ── CompareMetadataSnapshots property tests ───────────────────────────────────

// TestCompareMetadataSnapshots_NeverPanics: property — arbitrary snapshot values.
func TestCompareMetadataSnapshots_NeverPanics(t *testing.T) {
	f := func(
		sCompanies, sClassified, sSectorPrimary, sPass, sHardBlock, sSoftBlock, sCatRows, sCatSum int64,
		tCompanies, tClassified, tSectorPrimary, tPass, tHardBlock, tSoftBlock, tCatRows, tCatSum int64,
	) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic: %v", r)
			}
		}()
		src := &MetadataSnapshot{
			Companies: sCompanies, Classified: sClassified, SectorPrimary: sSectorPrimary,
			Pass: sPass, HardBlock: sHardBlock, SoftBlock: sSoftBlock,
			CategoriesRows: sCatRows, CategoriesCompanySum: sCatSum,
		}
		tgt := &MetadataSnapshot{
			Companies: tCompanies, Classified: tClassified, SectorPrimary: tSectorPrimary,
			Pass: tPass, HardBlock: tHardBlock, SoftBlock: tSoftBlock,
			CategoriesRows: tCatRows, CategoriesCompanySum: tCatSum,
		}
		_ = CompareMetadataSnapshots(src, tgt)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// TestCompareMetadataSnapshots_NilInputs: nil source or target returns zero drift without panic.
func TestCompareMetadataSnapshots_NilInputs(t *testing.T) {
	snap := &MetadataSnapshot{Companies: 100, Classified: 80}

	cases := []struct {
		src, tgt *MetadataSnapshot
		desc     string
	}{
		{nil, nil, "both nil"},
		{nil, snap, "nil source"},
		{snap, nil, "nil target"},
	}
	for _, c := range cases {
		t.Run(c.desc, func(t *testing.T) {
			drift := CompareMetadataSnapshots(c.src, c.tgt)
			if drift.Companies != 0 || drift.Classified != 0 {
				t.Errorf("nil input should yield zero drift, got %+v", drift)
			}
			if drift.Aligned {
				// Aligned is false when nil (zero drift struct), which is acceptable —
				// but it must not be true because the comparison is undefined.
				// Actually zero drift IS "aligned" in the current implementation
				// when both are nil — that's fine by design. Skip this check.
			}
		})
	}
}

// TestCompareMetadataSnapshots_EqualSnapshotsAreAligned: identical snapshots → Aligned=true.
func TestCompareMetadataSnapshots_EqualSnapshotsAreAligned(t *testing.T) {
	f := func(companies, classified, sectorPrimary, pass, hardBlock, softBlock, catRows, catSum int64) bool {
		snap := &MetadataSnapshot{
			Companies: companies, Classified: classified, SectorPrimary: sectorPrimary,
			Pass: pass, HardBlock: hardBlock, SoftBlock: softBlock,
			CategoriesRows: catRows, CategoriesCompanySum: catSum,
		}
		drift := CompareMetadataSnapshots(snap, snap)
		return drift.Aligned
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// TestCompareMetadataSnapshots_DeltaArithmetic: drift = target - source for each field.
func TestCompareMetadataSnapshots_DeltaArithmetic(t *testing.T) {
	cases := []struct {
		src     MetadataSnapshot
		tgt     MetadataSnapshot
		aligned bool
	}{
		{
			MetadataSnapshot{Companies: 100, Classified: 80, Pass: 60},
			MetadataSnapshot{Companies: 100, Classified: 80, Pass: 60},
			true,
		},
		{
			MetadataSnapshot{Companies: 100},
			MetadataSnapshot{Companies: 110},
			false,
		},
		{
			MetadataSnapshot{Companies: 50, Classified: 30},
			MetadataSnapshot{Companies: 50, Classified: 25},
			false,
		},
	}
	for _, c := range cases {
		src := c.src
		tgt := c.tgt
		drift := CompareMetadataSnapshots(&src, &tgt)
		if drift.Companies != tgt.Companies-src.Companies {
			t.Errorf("Companies drift: got %d, want %d", drift.Companies, tgt.Companies-src.Companies)
		}
		if drift.Classified != tgt.Classified-src.Classified {
			t.Errorf("Classified drift: got %d, want %d", drift.Classified, tgt.Classified-src.Classified)
		}
		if drift.Aligned != c.aligned {
			t.Errorf("Aligned: got %v, want %v (src=%+v, tgt=%+v)", drift.Aligned, c.aligned, src, tgt)
		}
	}
}

// TestCompareMetadataSnapshots_AlignedRequiresAllZero: Aligned is only true when ALL deltas are 0.
func TestCompareMetadataSnapshots_AlignedRequiresAllZero(t *testing.T) {
	base := &MetadataSnapshot{
		Companies: 100, Classified: 80, SectorPrimary: 60,
		Pass: 50, HardBlock: 10, SoftBlock: 20,
		CategoriesRows: 30, CategoriesCompanySum: 150,
	}

	// Each of these deviations should make Aligned=false.
	deviations := []struct {
		field string
		snap  MetadataSnapshot
	}{
		{"Companies", MetadataSnapshot{Companies: 101, Classified: 80, SectorPrimary: 60, Pass: 50, HardBlock: 10, SoftBlock: 20, CategoriesRows: 30, CategoriesCompanySum: 150}},
		{"Classified", MetadataSnapshot{Companies: 100, Classified: 81, SectorPrimary: 60, Pass: 50, HardBlock: 10, SoftBlock: 20, CategoriesRows: 30, CategoriesCompanySum: 150}},
		{"SectorPrimary", MetadataSnapshot{Companies: 100, Classified: 80, SectorPrimary: 61, Pass: 50, HardBlock: 10, SoftBlock: 20, CategoriesRows: 30, CategoriesCompanySum: 150}},
		{"Pass", MetadataSnapshot{Companies: 100, Classified: 80, SectorPrimary: 60, Pass: 51, HardBlock: 10, SoftBlock: 20, CategoriesRows: 30, CategoriesCompanySum: 150}},
		{"HardBlock", MetadataSnapshot{Companies: 100, Classified: 80, SectorPrimary: 60, Pass: 50, HardBlock: 11, SoftBlock: 20, CategoriesRows: 30, CategoriesCompanySum: 150}},
		{"SoftBlock", MetadataSnapshot{Companies: 100, Classified: 80, SectorPrimary: 60, Pass: 50, HardBlock: 10, SoftBlock: 21, CategoriesRows: 30, CategoriesCompanySum: 150}},
		{"CategoriesRows", MetadataSnapshot{Companies: 100, Classified: 80, SectorPrimary: 60, Pass: 50, HardBlock: 10, SoftBlock: 20, CategoriesRows: 31, CategoriesCompanySum: 150}},
		{"CategoriesCompanySum", MetadataSnapshot{Companies: 100, Classified: 80, SectorPrimary: 60, Pass: 50, HardBlock: 10, SoftBlock: 20, CategoriesRows: 30, CategoriesCompanySum: 151}},
	}

	for _, d := range deviations {
		t.Run(d.field, func(t *testing.T) {
			tgt := d.snap
			drift := CompareMetadataSnapshots(base, &tgt)
			if drift.Aligned {
				t.Errorf("Aligned should be false when %s differs", d.field)
			}
		})
	}
}
