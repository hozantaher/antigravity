package campaignsweb

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// S-H2 audit — locks the rule that handlers in this package must NOT
// echo raw err.Error() / fmt.Sprintf(..., err) into HTTP response bodies.
// Goes RED if anyone reverts to leaking pq schema names, FK constraint
// labels, or pgx wire details to clients.
//
// Pre-fix (commit pre-S-H2): 17 sites across campaigns.go + segments.go
// shipped raw err to clients. Post-fix: all routed through safeError().
func TestNoRawErrorEchoedToClient(t *testing.T) {
	files := []string{"campaigns.go", "segments.go"}

	// Forbidden patterns: any http.Error call whose 2nd arg references
	// err / err.Error() / fmt.Sprintf with err. Allow the safeError
	// helper itself (it does the safe formatting internally).
	forbidden := []*regexp.Regexp{
		regexp.MustCompile(`http\.Error\([^)]*err\.Error\(\)`),
		regexp.MustCompile(`http\.Error\([^)]*fmt\.Sprintf\([^)]*err\b`),
		regexp.MustCompile(`http\.Error\([^)]*"\s*\+\s*err\b`),
	}

	for _, f := range files {
		raw, err := os.ReadFile(filepath.Join(f))
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		src := string(raw)
		for _, rx := range forbidden {
			if loc := rx.FindStringIndex(src); loc != nil {
				snippet := src[loc[0]:min(loc[1]+40, len(src))]
				t.Errorf("%s leaks err to client (regex %q): %q", f, rx.String(), snippet)
			}
		}
	}
}

func TestSafeErrorHelperPresent(t *testing.T) {
	// Locks that the safeError helper exists and is referenced by the
	// handlers — guards against partial reverts that drop the helper
	// without replacing the call sites.
	raw, err := os.ReadFile(filepath.Join("campaigns.go"))
	if err != nil {
		t.Fatalf("read campaigns.go: %v", err)
	}
	src := string(raw)
	if !regexp.MustCompile(`func safeError\(`).MatchString(src) {
		t.Error("safeError helper missing from campaigns.go")
	}
	for _, f := range []string{"campaigns.go", "segments.go"} {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		if !regexp.MustCompile(`safeError\(`).MatchString(string(b)) {
			t.Errorf("%s does not call safeError — partial revert?", f)
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
