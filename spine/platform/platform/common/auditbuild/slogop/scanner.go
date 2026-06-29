// Package slogop provides a static-analysis scanner that flags slog.Error
// and slog.Warn calls that omit the "op" string-keyed argument.
//
// The "op" field carries the logical operation name
// ("<package>.<func>/<branch>") and is the primary group key in Sentry.
// See docs/playbooks/slog-conventions.md.
//
// This package is a refactor of the byte-identical scanSlogOpViolations
// helpers that previously lived inside each per-package
// slog_op_audit_test.go file. Each service now keeps a tiny test that
// pins a per-package baseline (a ratchet) and delegates the AST walk
// here. See docs/audits/2026-04-30-duplicate-hunt-deep.md item 5.
package slogop

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
)

// Violation describes a single slog.Error / slog.Warn call that does not
// include an "op" string-keyed argument.
type Violation struct {
	// File is the relative path to the .go source file containing the
	// call (relative to the dir passed to Scan).
	File string
	// Line is the 1-based source line number of the slog call.
	Line int
	// Column is the 1-based column number of the slog call.
	Column int
	// Method is either "Error" or "Warn".
	Method string
}

// String renders the violation in the legacy
// "<file>:<line>:<col>: slog.<Method> missing \"op\" field" shape so
// downstream test logs stay grep-stable across the migration.
func (v Violation) String() string {
	col := v.Column
	if col < 1 {
		col = 1
	}
	return fmt.Sprintf("%s:%d:%d: slog.%s missing \"op\" field",
		v.File, v.Line, col, v.Method)
}

// Scan walks every non-test .go file in dir (non-recursive — same shape
// as the legacy per-package helper) and returns a slice of violations.
//
// A call site qualifies as a violation when:
//   - the called function is slog.Error or slog.Warn (selector with
//     receiver identifier "slog"), AND
//   - none of the keyed arguments after the message is the literal
//     string "op".
//
// Non-string and non-literal keys (e.g. constants, variables) are
// intentionally ignored — they cannot be statically verified to equal
// "op" without resolving the package's symbol table, and the
// convention is to use the literal "op" key.
func Scan(dir string) ([]Violation, error) {
	fset := token.NewFileSet()
	var violations []Violation
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
			// Skip the message (first arg). Remaining args should
			// include "op" as a string-literal key.
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
				violations = append(violations, Violation{
					File:   pos.Filename,
					Line:   pos.Line,
					Column: pos.Column,
					Method: sel.Sel.Name,
				})
			}
			return true
		})
	}
	return violations, nil
}
