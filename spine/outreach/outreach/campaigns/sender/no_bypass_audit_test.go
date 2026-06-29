package sender

// CAD-M3 — discipline ratchet: prevent direct construction of
// AntiTraceClient outside Engine.WithAntiTrace.
//
// Background: 2026-05-01 cmd/anonymity-test bypassed Engine entirely,
// called sender.NewAntiTraceClient directly. Sent 36 burst e-mails;
// 0/18 delivered; 6h debugging traced to architectural bypass of
// ~25 of 42 production gates documented in docs/subsystem-maps/
// anti-trace.md. HARD RULE memory feedback_anti_trace_full_stack
// states the policy; this test enforces it strojově.
//
// Heuristika:
//   - calls to sender.NewAntiTraceClient(...) outside engine.go
//   - composite literals sender.AntiTraceClient{...} outside engine.go
//   - HTTP POST to relay /v1/submit outside antitrace.go (defensive
//     guard against re-implementing the client raw)
//
// Pattern matches sender/airtight_audit_test.go ratchet shape: AST scan
// + baseline-locked count. New bypass → test FAIL. Existing bypass
// migration through Engine → operator may lower baseline.
//
// Source: docs/initiatives/2026-05-01-codebase-awareness-discipline.md
// sprint M3, issue #558.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// noBypassAuditBaseline is the current count of legitimate-but-grandfathered
// bypass sites monorepo-wide. Each must be either:
//   (a) refactored to construct sender.Engine and call WithAntiTrace
//   (b) annotated `// engine-bypass-allowed: <reason>` on the line above
//       the call (1-3 lines max)
//
// Baseline 0 = all known bypass sites have been migrated through
// Engine.WithAntiTrace(). The last remaining site was
// services/orchestrator/cmd/anonymity-test/main.go which was
// refactored through sender.Engine in the feat/anonymity-engine-refactor
// branch (closes #558). The remaining NewAntiTraceClient call in
// anonymity-test/main.go is annotated `// engine-bypass-allowed` because
// it is passed straight to Engine.WithAntiTrace — never invoked directly.
//
// If a new site is added without annotation, the ratchet test will fail
// with count > 0. Lower this constant only after migrating/annotating.
const noBypassAuditBaseline = 0

// engineBypassAllowedAnnotation is the comment-marker for explicit
// exception. Annotation must appear on the line directly preceding
// the call/literal (1-3 lines tolerated) and contain
// `engine-bypass-allowed:` followed by a free-form justification.
const engineBypassAllowedAnnotation = "engine-bypass-allowed"

// senderBypassNames is the closed set of names whose direct invocation
// outside services/campaigns/sender/engine.go triggers the ratchet.
// Add new names if the package surface grows (e.g. new construction
// functions that bypass Engine orchestration).
var senderBypassNames = map[string]bool{
	"NewAntiTraceClient": true,
}

// senderBypassTypes is the closed set of types whose composite-literal
// construction (e.g. AntiTraceClient{...}) outside engine.go bypasses
// the constructor. Caught separately because go AST distinguishes
// CallExpr from CompositeLit.
var senderBypassTypes = map[string]bool{
	"AntiTraceClient": true,
}

// scanRoots returns the monorepo root — located by walking up from the test's
// CWD to the directory that holds go.work — as the single scan root. This makes
// the ratchet LOCATION-INDEPENDENT: it scans every Go module wherever it lives
// (services/ OR features/<domain>/ after the features-reroot), so a bypass can
// no longer hide by relocating a module out of services/. WalkDir below recurses
// and prunes excludedDirs (node_modules/.git/vendor + the campaigns/sender
// constructor-owner dir). Replaces the old relative ["../..", …] climb, which
// silently scoped to the parent dir once the package left services/.
func scanRoots() []string {
	dir, err := os.Getwd()
	if err != nil {
		return []string{"../.."} // fallback: legacy services/ scope
	}
	for i := 0; i < 10; i++ {
		if _, statErr := os.Stat(filepath.Join(dir, "go.work")); statErr == nil {
			return []string{dir} // repo root — scan the whole tree
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return []string{"../.."} // fallback: legacy services/ scope
}

// excludedDirs are paths that legitimately host the bypassable
// constructors (engine.go itself + its tests + the antitrace.go
// implementation). Any caller from these dirs is allowed.
var excludedDirs = []string{
	"campaigns/sender",   // engine.go owns construction; sender/*_test.go also
	"node_modules",
	".git",
	".claude/worktrees",
	"vendor",
}

func TestNoBypassAudit_NoDirectAntiTraceClientConstruction(t *testing.T) {
	hits := scanBypassViolations(t)
	if len(hits) > noBypassAuditBaseline {
		t.Errorf(
			"engine-bypass ratchet: found %d direct constructions of AntiTraceClient outside engine.go (baseline=%d). New bypass detected.\n\n"+
				"Hits:\n%s\n\n"+
				"Resolution:\n"+
				"  1. Refactor through sender.Engine.WithAntiTrace().Run() — see docs/subsystem-maps/anti-trace.md\n"+
				"  2. OR annotate `// engine-bypass-allowed: <reason>` on the line above the call (1-3 lines)\n"+
				"  3. To LOWER baseline: refactor existing site, run this test, update noBypassAuditBaseline.\n",
			len(hits), noBypassAuditBaseline, formatHits(hits),
		)
	}
}

type bypassHit struct {
	File string
	Line int
	Kind string // "call" | "literal"
	Name string
}

func formatHits(hits []bypassHit) string {
	var sb strings.Builder
	for _, h := range hits {
		sb.WriteString("  - ")
		sb.WriteString(h.File)
		sb.WriteString(":")
		sb.WriteString(bypassItoa(h.Line))
		sb.WriteString(" (")
		sb.WriteString(h.Kind)
		sb.WriteString(" ")
		sb.WriteString(h.Name)
		sb.WriteString(")\n")
	}
	return sb.String()
}

func bypassItoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

func scanBypassViolations(t *testing.T) []bypassHit {
	t.Helper()
	var hits []bypassHit
	for _, root := range scanRoots() {
		err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				for _, ex := range excludedDirs {
					if strings.Contains(path, ex) {
						return filepath.SkipDir
					}
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") {
				return nil
			}
			if strings.HasSuffix(path, "_test.go") {
				return nil
			}
			fset := token.NewFileSet()
			file, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
			if err != nil {
				return nil
			}
			fileHits := scanFile(fset, file, path)
			hits = append(hits, fileHits...)
			return nil
		})
		if err != nil {
			t.Fatalf("scan root %s: %v", root, err)
		}
	}
	return hits
}

func scanFile(fset *token.FileSet, file *ast.File, path string) []bypassHit {
	var hits []bypassHit

	// Build set of allowed line ranges from `engine-bypass-allowed:` comments.
	allowed := map[int]bool{}
	for _, cg := range file.Comments {
		for _, c := range cg.List {
			if strings.Contains(c.Text, engineBypassAllowedAnnotation) {
				// Allow the next 1-3 lines.
				line := fset.Position(c.End()).Line
				for i := 1; i <= 3; i++ {
					allowed[line+i] = true
				}
			}
		}
	}

	ast.Inspect(file, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.CallExpr:
			if sel, ok := x.Fun.(*ast.SelectorExpr); ok {
				if pkg, ok := sel.X.(*ast.Ident); ok {
					if pkg.Name == "sender" && senderBypassNames[sel.Sel.Name] {
						line := fset.Position(x.Pos()).Line
						if !allowed[line] {
							hits = append(hits, bypassHit{
								File: path, Line: line, Kind: "call", Name: sel.Sel.Name,
							})
						}
					}
				}
			}
		case *ast.CompositeLit:
			if sel, ok := x.Type.(*ast.SelectorExpr); ok {
				if pkg, ok := sel.X.(*ast.Ident); ok {
					if pkg.Name == "sender" && senderBypassTypes[sel.Sel.Name] {
						line := fset.Position(x.Pos()).Line
						if !allowed[line] {
							hits = append(hits, bypassHit{
								File: path, Line: line, Kind: "literal", Name: sel.Sel.Name,
							})
						}
					}
				}
			}
		}
		return true
	})
	return hits
}

func TestNoBypassAudit_BaselineMatchesActualCount(t *testing.T) {
	// Sanity check: the baseline constant MUST equal the actual count.
	// If they differ, either (a) someone migrated a bypass and forgot
	// to update the constant, or (b) someone introduced a new bypass
	// without lowering the threshold first. Both fail loudly.
	hits := scanBypassViolations(t)
	if len(hits) != noBypassAuditBaseline {
		t.Errorf(
			"baseline mismatch: noBypassAuditBaseline=%d but actual count=%d.\n"+
				"Hits:\n%s\n"+
				"If you migrated a bypass site, lower noBypassAuditBaseline.\n"+
				"If you added a new site, the primary ratchet test will already FAIL above.",
			noBypassAuditBaseline, len(hits), formatHits(hits),
		)
	}
}
