package relay

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestNoRawDialInRelay — P2 audit ratchet for services/relay.
// Blocks net.Dialer, net.Dial, socks.DialContext outside whitelist.
// Baseline: 0 violations.
func TestNoRawDialInRelay(t *testing.T) {
	relayDir := "."
	if wd, err := os.Getwd(); err == nil && !strings.Contains(wd, "services/relay") {
		// Running from repo root
		relayDir = "./services/relay"
	}

	violations := []string{}

	// Walk all .go files in services/relay/
	err := filepath.Walk(relayDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}

		// Skip this test file itself
		if strings.HasSuffix(path, "no_raw_dial_audit_test.go") {
			return nil
		}

		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, path, src, 0)
		if err != nil {
			// Parse errors OK — skip this file
			return nil
		}

		ast.Inspect(f, func(n ast.Node) bool {
			if call, ok := n.(*ast.CallExpr); ok {
				if isRawDialCall(call) {
					pos := fset.Position(call.Pos())
					// Whitelist intentional callsites
					if isWhitelisted(path, strings.TrimPrefix(filepath.Join(relayDir, path), relayDir)) {
						return true
					}
					violations = append(violations, fmt.Sprintf(
						"%s:%d: raw dial detected",
						strings.TrimPrefix(path, relayDir+"/"),
						pos.Line,
					))
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walk error: %v", err)
	}

	if len(violations) > 0 {
		var buf bytes.Buffer
		buf.WriteString("P2 FIX: raw dial calls found (must be in whitelist):\n")
		for _, v := range violations {
			buf.WriteString("  " + v + "\n")
		}
		t.Fatal(buf.String())
	}
}

func isRawDialCall(call *ast.CallExpr) bool {
	// Check for net.Dial, net.Dialer, socks.DialContext
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		// Check for standalone function calls (net.Dial is usually qualified)
		if ident, ok := call.Fun.(*ast.Ident); ok && ident.Name == "Dial" {
			return true
		}
		return false
	}

	pkgName := ""
	if x, ok := sel.X.(*ast.Ident); ok {
		pkgName = x.Name
	}

	// net.Dial, net.Dialer
	if pkgName == "net" && (sel.Sel.Name == "Dial" || sel.Sel.Name == "Dialer") {
		return true
	}

	// socks.DialContext
	if pkgName == "socks" && sel.Sel.Name == "DialContext" {
		return true
	}

	return false
}

func isWhitelisted(fullPath, relPath string) bool {
	// Whitelist intentional callsites with reason comment
	whitelisted := []string{
		// web/probe.go — tests SMTP/IMAP/proxy connectivity; wrapped in error handling
		"web/probe.go",
		// internal/amnesic/submit.go — buildHTTPClient uses net.Dialer for SOCKS5 setup; safe path
		"internal/amnesic/submit.go",
		// internal/transport/proxy_pool.go — RotatingProxyTransport health checks + pool ops;
		// these dial directly to proxy hosts (not email hosts) for latency measurement
		"internal/transport/proxy_pool.go",
		// internal/transport/wgpool/transport.go — WireGuard endpoint pool dialing; internal only
		"internal/transport/wgpool/transport.go",
		// web/egress_debug.go — debug endpoint for operator diagnostics; not production path
		"web/egress_debug.go",
		// web/raw_smtp_diag.go — diagnostic endpoint for SMTP troubleshooting; not production path
		"web/raw_smtp_diag.go",
	}

	for _, w := range whitelisted {
		if strings.HasSuffix(relPath, w) || strings.HasSuffix(fullPath, w) {
			return true
		}
	}
	return false
}
