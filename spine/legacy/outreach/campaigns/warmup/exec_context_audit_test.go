package warmup

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// D-3 audit — locks the rule that warmup/plan.go uses ExecContext/
// QueryContext (not Exec/Query). The 2026-04-22 closure wave fixed
// the silent-drop sites in the SEND path (campaign runner, bounce
// processor, intelligence domain) but warmup remained on the
// non-context API. Sprint D-3 closes that gap.
//
// This test goes RED if anyone reverts a call site to Exec()/Query()/
// QueryRow() — i.e. drops ctx propagation. Auto-generated callers
// should hit ExecContext/QueryContext through Daemon receiver methods.
func TestPlanGo_UsesContextAwareSqlMethods(t *testing.T) {
	bytes, err := os.ReadFile(filepath.Join("plan.go"))
	if err != nil {
		t.Fatalf("read plan.go: %v", err)
	}
	src := string(bytes)

	// Forbidden patterns: bare Exec(/Query(/QueryRow( on a db handle.
	// We allow whitespace around the method dot. The receiver is
	// `d.db` for the Daemon; lock on that prefix to avoid catching
	// unrelated `.Exec(` on other types (e.g. exec.Cmd in tests).
	forbidden := []*regexp.Regexp{
		regexp.MustCompile(`d\.db\.Exec\(`),
		regexp.MustCompile(`d\.db\.Query\(`),
		regexp.MustCompile(`d\.db\.QueryRow\(`),
	}
	for _, rx := range forbidden {
		if rx.MatchString(src) {
			t.Errorf("plan.go contains non-context SQL call %q — should use ExecContext/QueryContext/QueryRowContext", rx.String())
		}
	}

	// Required: at least one ExecContext + one QueryRowContext (the
	// file should have both shapes).
	required := []string{
		`d.db.ExecContext(ctx`,
		`d.db.QueryRowContext(ctx`,
	}
	for _, want := range required {
		if !strings.Contains(src, want) {
			t.Errorf("plan.go missing required call: %q", want)
		}
	}
}
