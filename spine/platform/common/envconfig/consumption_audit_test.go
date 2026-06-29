package envconfig_test

// T2.7 (synthesis PR #428) — discipline ratchet: count ad-hoc os.Getenv
// invocations across services/*/**.go (excluding _test.go and the
// envconfig package itself).
//
// Goal:
//   - Force every NEW caller to go through services/common/envconfig
//     (Required, MustHave, GetOr, BoolOr).
//   - Existing callers stay tolerated until intentionally migrated; the
//     baseline below pins the current count.
//
// Migrating an existing site to GetOr / Required → operator lowers the
// baseline. Adding a new bare os.Getenv → test fails.
//
// Ratchet pattern: services/campaigns/sender/airtight_audit_test.go
// (PR #394) and services/common/auditbuild/slogop (PR #404). Same shape:
// AST scan + comment-based allow-list + frozen integer baseline.
//
// Source: docs/audits/2026-04-30-synthesis-optimization-plan.md (T2.7).

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// consumptionAuditBaseline is the locked count of bare os.Getenv calls
// in production Go files under services/*/, EXCLUDING:
//   - services/common/envconfig/* (this package may call os.Getenv)
//   - any *_test.go file
//   - any call site annotated with `// envconfig-allowed: <reason>` on
//     the line directly above (or up to 3 lines above) the call.
//
// To lower the baseline: migrate a call to envconfig.GetOr / Required /
// MustHave / BoolOr, run this test locally, and update the constant.
const consumptionAuditBaseline = 0

// allowedAnnotation is the comment marker for explicit exceptions.
// Place `// envconfig-allowed: <důvod>` 1–3 lines above the call site
// (or as a same-line trailing comment) to whitelist a specific call.
const allowedAnnotation = "envconfig-allowed"

// envconfigPkgPathFragment is the substring that identifies files
// belonging to the envconfig package itself. Skipped because the
// package's whole purpose is to wrap os.Getenv.
const envconfigPkgPathFragment = "common/envconfig/"

func TestEnvconfigConsumption_RatchetBaseline(t *testing.T) {
	root := servicesRoot(t)
	violations, err := scanEnvconfigViolations(root)
	if err != nil {
		t.Fatalf("scanEnvconfigViolations(%q): %v", root, err)
	}
	if len(violations) > consumptionAuditBaseline {
		t.Errorf("ad-hoc os.Getenv calls in services/*/: %d (baseline %d)",
			len(violations), consumptionAuditBaseline)
		// Show first 25 to keep CI logs readable.
		for i, v := range violations {
			if i >= 25 {
				t.Logf("  ... %d more", len(violations)-25)
				break
			}
			t.Logf("  %s", v)
		}
		t.Logf("Fix:")
		t.Logf("  - Replace bare os.Getenv with envconfig.GetOr / Required / MustHave / BoolOr, NEBO")
		t.Logf("  - Annotate `// envconfig-allowed: <reason>` 1–3 lines above the call.")
		t.Logf("Then lower consumptionAuditBaseline by the number of fixes you made.")
	}
	// Allow lowering: when a contributor migrates calls without
	// updating the const, the test should remind them.
	if len(violations) < consumptionAuditBaseline {
		t.Logf("os.Getenv count dropped: %d < baseline %d. Lower the constant in this file.",
			len(violations), consumptionAuditBaseline)
	}
}

// servicesRoot returns the absolute path to the services/ directory.
// Tests run from services/common/envconfig/ — so services/ = ../../.
func servicesRoot(t *testing.T) string {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd: %v", err)
	}
	root, err := filepath.Abs(filepath.Join(cwd, "..", ".."))
	if err != nil {
		t.Fatalf("filepath.Abs: %v", err)
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("services root not found at %s: %v", root, err)
	}
	return root
}

// scanEnvconfigViolations walks dir recursively and returns one
// violation entry per bare os.Getenv call site that is NOT covered by
// an envconfig-allowed annotation.
//
// Skipped:
//   - any *_test.go file
//   - any file under */common/envconfig/ (the package itself)
//   - any vendor/ directory
//   - any non-.go file
//
// Returned slice is sorted (file then line) for deterministic output.
func scanEnvconfigViolations(root string) ([]string, error) {
	var violations []string
	fset := token.NewFileSet()

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			name := d.Name()
			if name == "vendor" || name == "node_modules" || name == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if !strings.HasSuffix(name, ".go") {
			return nil
		}
		if strings.HasSuffix(name, "_test.go") {
			return nil
		}
		// Skip the envconfig package files themselves.
		// Use forward-slash form for portability of the substring check.
		slashed := filepath.ToSlash(path)
		if strings.Contains(slashed, envconfigPkgPathFragment) {
			return nil
		}

		f, parseErr := parser.ParseFile(fset, path, nil, parser.ParseComments)
		if parseErr != nil {
			return parseErr
		}

		// Build line → comment map for this file.
		commentLines := make(map[int]string)
		for _, cg := range f.Comments {
			for _, c := range cg.List {
				pos := fset.Position(c.Pos())
				commentLines[pos.Line] = c.Text
			}
		}

		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			ident, ok := sel.X.(*ast.Ident)
			if !ok || ident.Name != "os" {
				return true
			}
			if sel.Sel.Name != "Getenv" {
				return true
			}
			pos := fset.Position(call.Pos())
			if hasEnvconfigAllowed(commentLines, pos.Line) {
				return true
			}
			rel, relErr := filepath.Rel(root, path)
			if relErr != nil {
				rel = path
			}
			rel = filepath.ToSlash(rel)
			violations = append(violations, rel+":"+strconv.Itoa(pos.Line)+": os.Getenv(...)")
			return true
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(violations)
	return violations, nil
}

// hasEnvconfigAllowed checks whether a call on callLine is whitelisted
// by an `// envconfig-allowed: ...` comment within the 3 lines directly
// above the call, or as a trailing comment on the same line.
func hasEnvconfigAllowed(comments map[int]string, callLine int) bool {
	for delta := 1; delta <= 3; delta++ {
		if c, ok := comments[callLine-delta]; ok {
			if strings.Contains(c, allowedAnnotation) {
				return true
			}
		}
	}
	if c, ok := comments[callLine]; ok {
		if strings.Contains(c, allowedAnnotation) {
			return true
		}
	}
	return false
}
