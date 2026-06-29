package sender

// Anti-trace anonymity bundle — Message-ID audit ratchet.
//
// Asserts that every code path in services/campaigns/sender/engine.go that
// dispatches a SendRequest to antiTrace.Send first writes a Message-ID
// into req.Headers via applyAnonymityHeaders.
//
// Without this ratchet, a future engine.go refactor could silently bypass
// applyAnonymityHeaders (e.g. by extracting the dispatch loop into a new
// function and forgetting to thread it through), breaking per-recipient
// unlinkability without any test failing.
//
// The ratchet is intentionally narrow — it only guards the Message-ID
// emission discipline, not the HMAC strength or the From/Date shape.
// Those are covered by per-fix unit tests in headers_test.go.
//
// Heuristic (matches sender/no_bypass_audit_test.go shape):
//   - AST-scan engine.go for any e.antiTrace.Send call
//   - For each, walk back inside the same function looking for an
//     applyAnonymityHeaders invocation that runs before the dispatch
//   - Baseline 0 = every dispatch site is preceded by anonymity
//     headers within the same function body
//
// To exempt a legitimate site (extremely rare): annotate
// `// anonymity-headers-allowed: <reason>` on the line above the
// antiTrace.Send call (1-3 lines tolerated).

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"
)

// messageIDAuditBaseline is the current count of antiTrace.Send dispatch
// sites in engine.go that are NOT preceded by applyAnonymityHeaders within
// the same function body. Baseline 0 = every dispatch is gated.
const messageIDAuditBaseline = 0

// anonymityHeadersAllowedAnnotation is the comment-marker for explicit
// exception. Annotation must appear on the line directly preceding the
// dispatch (1-3 lines tolerated) and contain
// `anonymity-headers-allowed:` followed by a free-form justification.
const anonymityHeadersAllowedAnnotation = "anonymity-headers-allowed"

func TestMessageIDAudit_EveryDispatchHasAnonymityHeaders(t *testing.T) {
	hits := scanMessageIDViolations(t, "engine.go")
	if len(hits) > messageIDAuditBaseline {
		t.Errorf(
			"message-id ratchet: found %d antiTrace.Send dispatch site(s) without preceding applyAnonymityHeaders (baseline=%d).\n\n"+
				"Hits:\n%s\n\n"+
				"Resolution:\n"+
				"  1. Insert applyAnonymityHeaders(req.Headers, ...) before the dispatch\n"+
				"  2. OR annotate `// %s: <reason>` on the line above the call\n"+
				"  3. To LOWER baseline: refactor existing site, run this test, update messageIDAuditBaseline\n",
			len(hits), messageIDAuditBaseline, formatMessageIDHits(hits), anonymityHeadersAllowedAnnotation,
		)
	}
}

func TestMessageIDAudit_BaselineMatchesActualCount(t *testing.T) {
	// Sanity check: baseline MUST equal the actual count. If they differ,
	// either someone migrated a violation site and forgot to lower the
	// constant, or someone introduced a new violation. Both fail loudly.
	hits := scanMessageIDViolations(t, "engine.go")
	if len(hits) != messageIDAuditBaseline {
		t.Errorf(
			"baseline mismatch: messageIDAuditBaseline=%d but actual count=%d.\n"+
				"Hits:\n%s\n"+
				"If you fixed a violation, lower messageIDAuditBaseline.\n"+
				"If you added a new one, the primary ratchet test will already FAIL above.",
			messageIDAuditBaseline, len(hits), formatMessageIDHits(hits),
		)
	}
}

// TestMessageIDAudit_AnonymityHeaderApplyEmitsMessageID is a structural
// smoke test on applyAnonymityHeaders itself: given any valid input, the
// returned messageID must be non-empty and start with '<'. This guards
// against a regression where someone replaces applyAnonymityHeaders'
// implementation with a no-op stub.
func TestMessageIDAudit_AnonymityHeaderApplyEmitsMessageID(t *testing.T) {
	dst := map[string]string{}
	_, mid, _, _ := applyAnonymityHeaders(dst, "to@target.cz",
		"sender@alias.cz", "Jan Novak", "Europe/Prague",
		[]byte("0123456789abcdef0123456789abcdef"), nowForTests())
	if mid == "" {
		t.Fatal("applyAnonymityHeaders must always emit a non-empty Message-ID")
	}
	if !strings.HasPrefix(mid, "<") || !strings.HasSuffix(mid, ">") {
		t.Errorf("Message-ID must be wrapped in angle brackets, got %q", mid)
	}
	if dst["Message-ID"] != mid {
		t.Errorf("dst[Message-ID] = %q, want %q", dst["Message-ID"], mid)
	}
	if dst["From"] == "" {
		t.Error("From must be populated")
	}
	if dst["Date"] == "" {
		t.Error("Date must be populated")
	}
}

type messageIDHit struct {
	File string
	Line int
	Func string
}

func formatMessageIDHits(hits []messageIDHit) string {
	var sb strings.Builder
	for _, h := range hits {
		sb.WriteString("  - ")
		sb.WriteString(h.File)
		sb.WriteString(":")
		sb.WriteString(bypassItoa(h.Line))
		sb.WriteString(" (in ")
		sb.WriteString(h.Func)
		sb.WriteString(")\n")
	}
	return sb.String()
}

// scanMessageIDViolations parses engineFile and collects every
// antiTrace.Send call site whose enclosing function does NOT also
// contain an applyAnonymityHeaders call earlier in source order.
// Annotation `anonymity-headers-allowed:` on the 1-3 lines above
// the dispatch exempts that site.
func scanMessageIDViolations(t *testing.T, engineFile string) []messageIDHit {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, engineFile, nil, parser.ParseComments)
	if err != nil {
		t.Fatalf("parse %s: %v", engineFile, err)
	}

	// Build the allow-set from comment annotations.
	allowed := map[int]bool{}
	for _, cg := range file.Comments {
		for _, c := range cg.List {
			if strings.Contains(c.Text, anonymityHeadersAllowedAnnotation) {
				line := fset.Position(c.End()).Line
				for i := 1; i <= 3; i++ {
					allowed[line+i] = true
				}
			}
		}
	}

	var hits []messageIDHit
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		hits = append(hits, scanFuncForMessageIDViolation(fset, fn, allowed)...)
	}
	return hits
}

// scanFuncForMessageIDViolation returns one hit per antiTrace.Send call
// inside fn that is NOT preceded by an applyAnonymityHeaders call within
// the same function body (in source order).
func scanFuncForMessageIDViolation(fset *token.FileSet, fn *ast.FuncDecl, allowed map[int]bool) []messageIDHit {
	type sitePos struct {
		line int
		kind string // "anonymity" | "dispatch"
	}
	var sites []sitePos

	ast.Inspect(fn.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		// applyAnonymityHeaders(...) — direct identifier
		if id, ok := call.Fun.(*ast.Ident); ok && id.Name == "applyAnonymityHeaders" {
			sites = append(sites, sitePos{line: fset.Position(call.Pos()).Line, kind: "anonymity"})
			return true
		}
		// e.antiTrace.Send(...) — selector chain
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "Send" {
			return true
		}
		// The receiver must end with antiTrace
		recv, ok := sel.X.(*ast.SelectorExpr)
		if !ok || recv.Sel.Name != "antiTrace" {
			return true
		}
		sites = append(sites, sitePos{line: fset.Position(call.Pos()).Line, kind: "dispatch"})
		return true
	})

	var hits []messageIDHit
	anonymitySeen := false
	for _, s := range sites {
		switch s.kind {
		case "anonymity":
			anonymitySeen = true
		case "dispatch":
			if !anonymitySeen && !allowed[s.line] {
				hits = append(hits, messageIDHit{
					File: "engine.go",
					Line: s.line,
					Func: fn.Name.Name,
				})
			}
		}
	}
	return hits
}
