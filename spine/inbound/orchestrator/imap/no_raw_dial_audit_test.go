package imap

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestNoRawNetDialerOutsideHelper is an AST-based audit ratchet that ensures
// raw net.Dialer{}.DialContext calls to IMAP are only inside the designated
// helper (resolveImapSOCKSAddr / connect). Any new caller that bypasses the
// SOCKS5 path will fail this test.
//
// Rule: non-test .go files in this package must not contain composite literals
// of type "net.Dialer" except inside the connect() function body. Calls via
// the injected dial function argument are permitted (tests use fakeDialer).
//
// Ratchet target: 0 violations outside connect().
func TestNoRawNetDialerOutsideHelper(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	pkgDir := filepath.Dir(thisFile)

	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, pkgDir, func(fi os.FileInfo) bool {
		name := fi.Name()
		// Skip test files in the AST scan — they may use net.Dialer legitimately
		// (e.g. TestConnect_InvalidAddress uses connect() directly).
		return !strings.HasSuffix(name, "_test.go")
	}, 0)
	if err != nil {
		t.Fatalf("parse dir %s: %v", pkgDir, err)
	}

	type violation struct {
		file string
		line int
		fn   string
	}
	var violations []violation

	for _, pkg := range pkgs {
		for filename, file := range pkg.Files {
			// Walk top-level declarations.
			for _, decl := range file.Decls {
				fd, ok := decl.(*ast.FuncDecl)
				if !ok {
					continue
				}
				fnName := fd.Name.Name
				// connect() is the designated helper — raw net.Dialer is permitted there.
				if fnName == "connect" {
					continue
				}
				// Inspect all composite literals inside this function for net.Dialer.
				ast.Inspect(fd.Body, func(n ast.Node) bool {
					cl, ok := n.(*ast.CompositeLit)
					if !ok {
						return true
					}
					sel, ok := cl.Type.(*ast.SelectorExpr)
					if !ok {
						return true
					}
					pkg, ok := sel.X.(*ast.Ident)
					if !ok {
						return true
					}
					if pkg.Name == "net" && sel.Sel.Name == "Dialer" {
						pos := fset.Position(cl.Pos())
						violations = append(violations, violation{
							file: filepath.Base(filename),
							line: pos.Line,
							fn:   fnName,
						})
					}
					return true
				})
			}
		}
	}

	if len(violations) > 0 {
		t.Errorf("AO2 ratchet: raw net.Dialer{} found outside connect() — use connect() which routes through SOCKS5:")
		for _, v := range violations {
			t.Errorf("  %s:%d in func %s", v.file, v.line, v.fn)
		}
		t.Error("Fix: route all IMAP dials through connect(ctx, mb) so SOCKS5 env is honoured (feedback_no_direct_smtp)")
	}
}
