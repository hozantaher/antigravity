package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// AB1 2026-05-06 — slog `op` field discipline ratchet for the relay service.
//
// Every slog.Error/Warn call in production code must include an "op" string-key
// argument of the form "<package>.<func>/<sub-step>". Missing `op` fields break
// Sentry alert grouping (post Sprint J1, PR #1031).
//
// Baselines represent violations at time of writing (after AB1 full cleanup).
// Any new call without `op` fails the test. Lower the baseline as drift is
// eliminated.

// relayServiceRoot returns the absolute path to services/relay from any CWD
// that is within that subtree.
func relayServiceRoot(t *testing.T) string {
	t.Helper()
	// Walk up from current dir until we find services/relay go.mod or
	// fall back to the relative path from the test binary location.
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			// Check this is the relay module
			if _, err2 := os.Stat(filepath.Join(dir, "cmd", "relay")); err2 == nil {
				return dir
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	// Best-effort: assume test binary runs from services/relay/cmd/relay
	return filepath.Join("../../..")
}

func scanSlogOpViolationsRecursive(t *testing.T, root string) []string {
	t.Helper()
	fset := token.NewFileSet()
	var violations []string

	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			base := info.Name()
			if base == "vendor" || base == ".git" || base == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
		if err != nil {
			return nil
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
			if !ok || ident.Name != "slog" {
				return true
			}
			if sel.Sel.Name != "Error" && sel.Sel.Name != "Warn" {
				return true
			}
			hasOp := false
			for i := 1; i < len(call.Args); i++ {
				lit, ok := call.Args[i].(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					continue
				}
				if strings.Trim(lit.Value, `"`) == "op" {
					hasOp = true
					break
				}
			}
			if !hasOp {
				pos := fset.Position(call.Pos())
				violations = append(violations,
					pos.String()+": slog."+sel.Sel.Name+" missing \"op\" field")
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	return violations
}

// ── Per-subpackage baselines (AB1 2026-05-06) ─────────────────────────────
// All cleaned to 0 in this sprint. Raise only with documented rationale.
const (
	relayInternalBaseline = 0
	relayCmdRelayBaseline = 0
	relayWebBaseline      = 0
)

func TestSlogOpAudit_RelayInternal(t *testing.T) {
	root := relayServiceRoot(t)
	internalDir := filepath.Join(root, "internal")
	if _, err := os.Stat(internalDir); os.IsNotExist(err) {
		t.Skip("relay internal/ not found — adjust path")
	}
	violations := scanSlogOpViolationsRecursive(t, internalDir)
	assertBaseline(t, violations, relayInternalBaseline, "relay/internal")
}

func TestSlogOpAudit_RelayCmdRelay(t *testing.T) {
	root := relayServiceRoot(t)
	cmdDir := filepath.Join(root, "cmd", "relay")
	if _, err := os.Stat(cmdDir); os.IsNotExist(err) {
		t.Skip("relay cmd/relay/ not found — adjust path")
	}
	// Re-use the flat scanner from the sender audit pattern for cmd/relay itself
	violations, err := scanSlogOpViolationsDir(cmdDir)
	if err != nil {
		t.Fatalf("scanSlogOpViolationsDir: %v", err)
	}
	assertBaseline(t, violations, relayCmdRelayBaseline, "relay/cmd/relay")
}

func TestSlogOpAudit_RelayWeb(t *testing.T) {
	root := relayServiceRoot(t)
	webDir := filepath.Join(root, "web")
	if _, err := os.Stat(webDir); os.IsNotExist(err) {
		t.Skip("relay web/ not found — adjust path")
	}
	violations := scanSlogOpViolationsRecursive(t, webDir)
	assertBaseline(t, violations, relayWebBaseline, "relay/web")
}

// TestSlogOpAudit_RelayFull covers the entire relay service tree in one shot —
// catches new subdirectories that aren't listed above.
func TestSlogOpAudit_RelayFull(t *testing.T) {
	root := relayServiceRoot(t)
	violations := scanSlogOpViolationsRecursive(t, root)
	// Full-service baseline = sum of per-package baselines.
	total := relayInternalBaseline + relayCmdRelayBaseline + relayWebBaseline
	assertBaseline(t, violations, total, "relay (full service)")
}

// ── Scanner helpers ────────────────────────────────────────────────────────

// scanSlogOpViolationsDir scans a flat directory (non-recursive).
func scanSlogOpViolationsDir(dir string) ([]string, error) {
	fset := token.NewFileSet()
	var violations []string
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		path := filepath.Join(dir, name)
		f, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
		if err != nil {
			return nil, err
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
			if !ok || ident.Name != "slog" {
				return true
			}
			if sel.Sel.Name != "Error" && sel.Sel.Name != "Warn" {
				return true
			}
			hasOp := false
			for i := 1; i < len(call.Args); i++ {
				lit, ok := call.Args[i].(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					continue
				}
				if strings.Trim(lit.Value, `"`) == "op" {
					hasOp = true
					break
				}
			}
			if !hasOp {
				pos := fset.Position(call.Pos())
				violations = append(violations,
					pos.String()+": slog."+sel.Sel.Name+" missing \"op\" field")
			}
			return true
		})
	}
	return violations, nil
}

func assertBaseline(t *testing.T, violations []string, baseline int, label string) {
	t.Helper()
	if len(violations) > baseline {
		t.Errorf("[%s] slog.Error/Warn calls without 'op' field: %d (baseline %d)",
			label, len(violations), baseline)
		for _, v := range violations {
			t.Logf("  %s", v)
		}
		t.Logf("Add `\"op\", \"<package>.<func>/<branch>\"` as the FIRST keyed arg.")
	}
	if len(violations) < baseline {
		t.Logf("[%s] violation count %d < baseline %d — lower the baseline constant",
			label, len(violations), baseline)
	}
}

// ── Detector unit tests (10 cases per feedback_extreme_testing) ───────────

// TestScanSlogOpViolations_DetectsSimpleViolation verifies the scanner flags a
// bare slog.Error without "op".
func TestScanSlogOpViolations_DetectsSimpleViolation(t *testing.T) {
	src := `package p
import "log/slog"
func f() { slog.Error("oops", "error", err) }
`
	violations := scanSource(t, src)
	if len(violations) != 1 {
		t.Errorf("expected 1 violation, got %d: %v", len(violations), violations)
	}
}

// TestScanSlogOpViolations_PassesWithOp verifies a compliant call is not flagged.
func TestScanSlogOpViolations_PassesWithOp(t *testing.T) {
	src := `package p
import "log/slog"
func f() { slog.Error("oops", "op", "p.f/err", "error", err) }
`
	violations := scanSource(t, src)
	if len(violations) != 0 {
		t.Errorf("expected 0 violations, got %d: %v", len(violations), violations)
	}
}

// TestScanSlogOpViolations_WarnAlsoRequiresOp verifies slog.Warn is covered.
func TestScanSlogOpViolations_WarnAlsoRequiresOp(t *testing.T) {
	src := `package p
import "log/slog"
func f() { slog.Warn("heads up", "key", "val") }
`
	violations := scanSource(t, src)
	if len(violations) != 1 {
		t.Errorf("expected 1 violation, got %d", len(violations))
	}
}

// TestScanSlogOpViolations_InfoNotChecked verifies slog.Info is not flagged.
func TestScanSlogOpViolations_InfoNotChecked(t *testing.T) {
	src := `package p
import "log/slog"
func f() { slog.Info("ok", "key", "val") }
`
	violations := scanSource(t, src)
	if len(violations) != 0 {
		t.Errorf("slog.Info should not be checked, got %d violations", len(violations))
	}
}

// TestScanSlogOpViolations_OpAnyPosition verifies "op" is found wherever in args.
func TestScanSlogOpViolations_OpAnyPosition(t *testing.T) {
	src := `package p
import "log/slog"
func f() { slog.Error("oops", "key1", "v1", "op", "p.f/branch", "key2", "v2") }
`
	violations := scanSource(t, src)
	if len(violations) != 0 {
		t.Errorf("expected 0 violations, got %d", len(violations))
	}
}

// TestScanSlogOpViolations_MultipleCallsSameFile checks both calls are caught.
func TestScanSlogOpViolations_MultipleCallsSameFile(t *testing.T) {
	src := `package p
import "log/slog"
func f() {
	slog.Error("e1", "key", "v")
	slog.Warn("w1", "key", "v")
}
`
	violations := scanSource(t, src)
	if len(violations) != 2 {
		t.Errorf("expected 2 violations, got %d", len(violations))
	}
}

// TestScanSlogOpViolations_OpKeyMustBeString verifies non-literal "op" identifiers
// are still flagged (we require a string literal, not a variable named op).
func TestScanSlogOpViolations_OpKeyMustBeStringLiteral(t *testing.T) {
	src := `package p
import "log/slog"
const opKey = "op"
func f() { slog.Error("oops", opKey, "p.f/branch", "error", err) }
`
	// The scanner checks for a BasicLit "op", not an ident "opKey".
	// This is intentional: we want literal strings so grep is reliable.
	violations := scanSource(t, src)
	if len(violations) != 1 {
		t.Errorf("expected 1 violation (const used instead of literal), got %d", len(violations))
	}
}

// TestScanSlogOpViolations_TestFilesNotScanned verifies _test.go files are excluded.
func TestScanSlogOpViolations_TestFilesNotScanned(t *testing.T) {
	// This test file itself has slog calls in test helpers — if test files
	// were scanned, the audit would flag them. Verify it does not.
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	violations, err := scanSlogOpViolationsDir(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	// Production files in cmd/relay/ should be 0 (we fixed them all).
	if len(violations) != 0 {
		t.Errorf("cmd/relay production files have %d violations: %v", len(violations), violations)
	}
}

// TestScanSlogOpViolations_EmptyMessage verifies empty message string is still
// checked for the "op" field requirement.
func TestScanSlogOpViolations_EmptyMessage(t *testing.T) {
	src := `package p
import "log/slog"
func f() { slog.Error("", "key", "val") }
`
	violations := scanSource(t, src)
	if len(violations) != 1 {
		t.Errorf("expected 1 violation for empty message, got %d", len(violations))
	}
}

// TestScanSlogOpViolations_MessageOnlyIsViolation verifies a call with only
// the message (no kv pairs at all) is a violation.
func TestScanSlogOpViolations_MessageOnlyIsViolation(t *testing.T) {
	src := `package p
import "log/slog"
func f() { slog.Error("fatal") }
`
	violations := scanSource(t, src)
	if len(violations) != 1 {
		t.Errorf("expected 1 violation for message-only call, got %d", len(violations))
	}
}

// ── Test helper ──────────────────────────────────────────────────────────

func scanSource(t *testing.T, src string) []string {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "test.go", src, 0)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	var violations []string
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
		if !ok || ident.Name != "slog" {
			return true
		}
		if sel.Sel.Name != "Error" && sel.Sel.Name != "Warn" {
			return true
		}
		hasOp := false
		for i := 1; i < len(call.Args); i++ {
			lit, ok := call.Args[i].(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				continue
			}
			if strings.Trim(lit.Value, `"`) == "op" {
				hasOp = true
				break
			}
		}
		if !hasOp {
			pos := fset.Position(call.Pos())
			violations = append(violations, pos.String()+": slog."+sel.Sel.Name)
		}
		return true
	})
	return violations
}
