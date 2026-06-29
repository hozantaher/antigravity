package category

import (
	"strings"
	"testing"
	"testing/quick"
)

// ── Property: pathToSlug never panics ────────────────────────
func TestProperty_PathToSlug_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", s, r)
			}
		}()
		_ = pathToSlug(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: pathToSlug is deterministic ────────────────────
func TestProperty_PathToSlug_Deterministic(t *testing.T) {
	f := func(s string) bool {
		return pathToSlug(s) == pathToSlug(s)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: pathToSlug output is always lowercase ──────────
func TestProperty_PathToSlug_Lowercase(t *testing.T) {
	f := func(s string) bool {
		return pathToSlug(s) == strings.ToLower(pathToSlug(s))
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: pathToSlug replaces " > " with "~" ─────────────
func TestProperty_PathToSlug_SeparatorSwap(t *testing.T) {
	cases := map[string]string{
		"Remesla-a-sluzby > Stavebni-sluzby":            "remesla-a-sluzby~stavebni-sluzby",
		"Auto-moto":                                      "auto-moto",
		"A > B > C":                                      "a~b~c",
		"":                                               "",
	}
	for in, want := range cases {
		if got := pathToSlug(in); got != want {
			t.Fatalf("pathToSlug(%q) = %q, want %q", in, got, want)
		}
	}
}

// ── Property: pathToSlug output never contains " > " ─────────
// Post-condition: separator is fully replaced.
func TestProperty_PathToSlug_NoRawSeparator(t *testing.T) {
	f := func(s string) bool {
		out := pathToSlug(s)
		return !strings.Contains(out, " > ")
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: pathName returns last segment ──────────────────
func TestProperty_PathName_LastSegment(t *testing.T) {
	cases := map[string]string{
		"Auto-moto":                       "Auto moto",
		"Auto-moto > Prodejci":            "Prodejci",
		"Remesla-a-sluzby > Stavebni-vybor": "Stavebni vybor",
		"single-segment":                  "single segment",
		"":                                "",
	}
	for in, want := range cases {
		if got := pathName(in); got != want {
			t.Fatalf("pathName(%q) = %q, want %q", in, got, want)
		}
	}
}

// ── Property: pathName never panics ──────────────────────────
func TestProperty_PathName_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", s, r)
			}
		}()
		_ = pathName(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: pathName output never contains hyphens ─────────
// (hyphens replaced with spaces)
func TestProperty_PathName_NoHyphens(t *testing.T) {
	f := func(s string) bool {
		out := pathName(s)
		return !strings.Contains(out, "-")
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: parentPath of root is empty ────────────────────
func TestProperty_ParentPath_RootEmpty(t *testing.T) {
	for _, root := range []string{"", "Auto-moto", "singleword", "no separators"} {
		if got := parentPath(root); got != "" {
			t.Fatalf("parentPath(%q) = %q, want empty (root)", root, got)
		}
	}
}

// ── Property: parentPath strips last segment ─────────────────
func TestProperty_ParentPath_StripsLastSegment(t *testing.T) {
	cases := map[string]string{
		"A > B > C": "A > B",
		"A > B":     "A",
		"A":         "",
		"A > B > C > D > E": "A > B > C > D",
	}
	for in, want := range cases {
		if got := parentPath(in); got != want {
			t.Fatalf("parentPath(%q) = %q, want %q", in, got, want)
		}
	}
}

// ── Property: parentPath applied repeatedly converges to "" ──
func TestProperty_ParentPath_ConvergesToRoot(t *testing.T) {
	f := func(s string) bool {
		current := s
		// Max 50 iterations to guard against pathological non-convergence.
		for i := 0; i < 50; i++ {
			next := parentPath(current)
			if next == "" {
				return true
			}
			if next == current {
				return false // infinite loop
			}
			if !strings.HasPrefix(current, next) {
				return false // parent must be a prefix
			}
			current = next
		}
		return false
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: ancestorPaths always includes the path itself ──
func TestProperty_AncestorPaths_IncludesSelf(t *testing.T) {
	f := func(s string) bool {
		paths := ancestorPaths(s)
		if len(paths) == 0 {
			return false
		}
		return paths[len(paths)-1] == s
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: ancestorPaths length == segment count ──────────
func TestProperty_AncestorPaths_LengthMatchesSegments(t *testing.T) {
	cases := map[string]int{
		"":            1, // empty split → [""]
		"A":           1,
		"A > B":       2,
		"A > B > C":   3,
		"A > B > C > D > E": 5,
	}
	for in, wantLen := range cases {
		got := ancestorPaths(in)
		if len(got) != wantLen {
			t.Fatalf("ancestorPaths(%q) len = %d, want %d (got %v)", in, len(got), wantLen, got)
		}
	}
}

// ── Property: ancestorPaths[0] has no separator (is root) ────
func TestProperty_AncestorPaths_FirstIsRoot(t *testing.T) {
	f := func(s string) bool {
		paths := ancestorPaths(s)
		if len(paths) == 0 {
			return false
		}
		// Root element must not contain the " > " separator.
		return !strings.Contains(paths[0], " > ")
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: ancestor[i] is parent of ancestor[i+1] ─────────
func TestProperty_AncestorPaths_ChainInvariant(t *testing.T) {
	paths := ancestorPaths("A > B > C > D")
	want := []string{"A", "A > B", "A > B > C", "A > B > C > D"}
	if len(paths) != len(want) {
		t.Fatalf("len mismatch: got %d want %d (%v)", len(paths), len(want), paths)
	}
	for i, w := range want {
		if paths[i] != w {
			t.Fatalf("ancestor[%d] = %q, want %q", i, paths[i], w)
		}
	}
}

// ── Property: pathToSlug is NOT reversible but preserves depth ─
// The slug uses ~ as the separator; counting ~ equals " > " count in input.
func TestTable_PathToSlug_DepthPreserved(t *testing.T) {
	// Table-driven check: " > " count in input must equal "~" count in output.
	cases := []string{
		"a",
		"a > b",
		"a > b > c",
		"category > sub > leaf",
		"",
		" > ",
		"x > y > z > w",
	}
	for _, s := range cases {
		inSep := strings.Count(s, " > ")
		outSep := strings.Count(pathToSlug(s), "~")
		if inSep != outSep {
			t.Errorf("input %q: depth mismatch: inSep=%d outSep=%d slug=%q", s, inSep, outSep, pathToSlug(s))
		}
	}
}
