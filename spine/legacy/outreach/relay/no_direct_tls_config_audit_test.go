package relay

// no_direct_tls_config_audit_test.go — AR4 audit ratchet.
//
// Blocks raw &tls.Config{} literals in production (non-test) Go code outside
// the approved whitelist. All outbound SMTP/IMAP TLS connections must use the
// parrot helpers (SMTPParrotTLS / SMTPParrotTLSInsecure) from
// services/relay/internal/transport/tls_parrot.go.
//
// Approved whitelist (each entry has a reason):
//   cmd/relay/main.go              — httpServer.TLSConfig for the inbound HTTPS listener (not SMTP client)
//   internal/relay/multipath.go   — http.Transport.TLSClientConfig for inter-relay HTTP (not SMTP client)
//   internal/amnesic/submit.go    — HTTPS client to submit endpoint; not SMTP

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

// TestNoDirectTLSConfigInRelay verifies that no production file outside the
// approved whitelist uses a raw &tls.Config{} literal.
//
// Rationale: raw &tls.Config{} defaults to Go's cipher suite order which is
// identifiable as "Go runtime / non-mail-client" by JA3 detection. All SMTP
// and IMAP outbound TLS must use SMTPParrotTLS / SMTPParrotTLSInsecure.
func TestNoDirectTLSConfigInRelay(t *testing.T) {
	relayDir := "."
	if wd, err := os.Getwd(); err == nil && !strings.Contains(wd, "outreach/relay") {
		relayDir = "./features/outreach/relay"
	}

	violations := []string{}

	err := filepath.Walk(relayDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		// Skip all test files — test overrides intentionally use raw &tls.Config{}.
		if strings.HasSuffix(path, "_test.go") {
			return nil
		}

		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, path, src, 0)
		if err != nil {
			// Parse errors OK — skip this file.
			return nil
		}

		ast.Inspect(f, func(n ast.Node) bool {
			lit, ok := n.(*ast.CompositeLit)
			if !ok {
				return true
			}
			// Match: &tls.Config{...} — the type is a StarExpr → SelectorExpr
			// OR tls.Config{...} without pointer.
			if !isTLSConfigLit(lit) {
				return true
			}

			pos := fset.Position(lit.Pos())
			rel := strings.TrimPrefix(path, relayDir+"/")
			if tlsConfigWhitelisted(rel) {
				return true
			}
			violations = append(violations, fmt.Sprintf(
				"%s:%d: raw &tls.Config{} literal (use SMTPParrotTLS / SMTPParrotTLSInsecure)",
				rel, pos.Line,
			))
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walk error: %v", err)
	}

	if len(violations) > 0 {
		var buf bytes.Buffer
		buf.WriteString("AR4 ratchet: raw &tls.Config{} found in production code.\n")
		buf.WriteString("Use transport.SMTPParrotTLS(serverName) instead:\n")
		for _, v := range violations {
			buf.WriteString("  " + v + "\n")
		}
		t.Fatal(buf.String())
	}
}

// isTLSConfigLit returns true when node is a composite literal for tls.Config.
func isTLSConfigLit(lit *ast.CompositeLit) bool {
	switch t := lit.Type.(type) {
	case *ast.SelectorExpr:
		// tls.Config{...}
		if x, ok := t.X.(*ast.Ident); ok && x.Name == "tls" && t.Sel.Name == "Config" {
			return true
		}
	}
	return false
}

// tlsConfigWhitelisted returns true for production callsites that legitimately
// construct a tls.Config for non-SMTP purposes.
func tlsConfigWhitelisted(relPath string) bool {
	approved := []string{
		// inbound HTTPS listener TLS config — this is a SERVER config, not an outbound SMTP client
		"cmd/relay/main.go",
		// inter-relay Shamir-fragment HTTP transport — not SMTP client
		"internal/relay/multipath.go",
		// HTTPS submit to dead-drop endpoint — not SMTP client
		"internal/amnesic/submit.go",
		// The parrot helper itself defines the config — obviously approved
		"internal/transport/tls_parrot.go",
	}
	for _, a := range approved {
		if strings.HasSuffix(relPath, a) {
			return true
		}
	}
	return false
}
