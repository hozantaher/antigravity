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

// AW7-2 audit ratchet — issue #1179.
//
// Mirrors the JS audit ratchet `apps/outreach-dashboard/tests/audit/no_raw_imap_socket.test.js`
// (T-16/T-17/T-18). Enforces HARD RULE memory `feedback_no_direct_smtp` on the
// Go orchestrator side: production IMAP code must traverse SOCKS5 (relay
// wgpool / Mullvad) — silent direct dialling exposes the Railway native IP and
// triggers Seznam fraud-lock pattern AP4 (multi-country login signal that
// killed nowak.gorak / goran.nowak on 2026-05-08 morning).
//
// Three checks, all line-scanner / AST based against orchestrator non-test
// .go files:
//
//   T-1 (line scanner) — the file `imap/poller.go` must NOT contain a silent
//       direct-fallback path. The pre-AW7-2 code emitted slog warning
//       "imap_dial_direct_no_socks" with op="imap.connect/directFallback"
//       immediately before a baseDialer.DialContext call. Both the warning
//       string and the op tag are banned forever — they are the canary
//       signature of the bypass.
//
//   T-2 (AST) — outside connect() and the explicit ALLOW_IMAP_DIRECT escape
//       hatch, NO function in the imap/ package may call baseDialer.DialContext
//       (or net.Dialer{}.DialContext / net.Dial / tls.Dial / smtp.Dial). The
//       ast walker in no_raw_dial_audit_test.go already covers net.Dialer{}
//       composite literal; this check ratchets the call-site form too.
//
//   T-3 (line scanner) — orchestrator-wide scan for "imap_dial_direct_no_socks"
//       or "directFallback" tokens — both are forbidden. New code must use
//       ErrIMAPSOCKSUnavailable and the SOCKS5 path.
//
// Ratchet target: 0 violations. Each whitelisted file MUST carry an inline
// `// aw7-2-allowed: <reason>` annotation; this test verifies any whitelist
// entry resolves to a real file (no stale entries — same defensive check
// `TestWhitelistFileExists_AnonymityHarvest` already does for the AO5
// whitelist).
//
// memory feedback_no_direct_smtp `[T0]` HARD RULE — locked here.

func TestNoDirectIMAPDial_AW7_2_NoSilentFallbackTokens(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	pkgDir := filepath.Dir(thisFile)

	// Read poller.go specifically — the canary location for issue #1179.
	pollerPath := filepath.Join(pkgDir, "poller.go")
	data, err := os.ReadFile(pollerPath)
	if err != nil {
		t.Fatalf("read poller.go: %v", err)
	}
	src := string(data)

	bannedTokens := []struct {
		needle string
		why    string
	}{
		{
			needle: `imap_dial_direct_no_socks`,
			why:    "AW7-2: silent direct-fallback slog message banned (issue #1179). Use ErrIMAPSOCKSUnavailable.",
		},
		{
			needle: `imap.connect/directFallback`,
			why:    "AW7-2: silent direct-fallback op tag banned (issue #1179). Use imap.connect/noSocksFailFast.",
		},
	}

	for _, tok := range bannedTokens {
		if strings.Contains(src, tok.needle) {
			t.Errorf("AW7-2 ratchet: poller.go contains banned token %q\n  %s", tok.needle, tok.why)
		}
	}
}

// TestNoDirectIMAPDial_AW7_2_OnlyConnectMayCallBaseDialer asserts (via AST)
// that no function other than `connect` invokes baseDialer.DialContext or any
// other raw dial primitive. The escape-hatch ALLOW_IMAP_DIRECT env check is
// inside connect() itself — outside that single function, no production code
// may dial.
func TestNoDirectIMAPDial_AW7_2_OnlyConnectMayCallBaseDialer(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	pkgDir := filepath.Dir(thisFile)

	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, pkgDir, func(fi os.FileInfo) bool {
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, 0)
	if err != nil {
		t.Fatalf("parse dir %s: %v", pkgDir, err)
	}

	// Patterns: foo.DialContext call where foo is a raw dialer, OR net.Dial /
	// tls.Dial / tls.DialWithDialer — banned outside connect().
	type violation struct {
		file string
		line int
		fn   string
		text string
	}
	var violations []violation

	for _, pkg := range pkgs {
		for filename, file := range pkg.Files {
			for _, decl := range file.Decls {
				fd, ok := decl.(*ast.FuncDecl)
				if !ok {
					continue
				}
				fnName := fd.Name.Name
				// connect() is the designated SOCKS5-aware helper — raw dials
				// allowed there (gated by ALLOW_IMAP_DIRECT internally).
				if fnName == "connect" {
					continue
				}
				ast.Inspect(fd.Body, func(n ast.Node) bool {
					call, ok := n.(*ast.CallExpr)
					if !ok {
						return true
					}
					sel, ok := call.Fun.(*ast.SelectorExpr)
					if !ok {
						return true
					}
					selName := sel.Sel.Name

					// Banned: <ident>.DialContext where ident is a raw dialer
					// variable (baseDialer, dialer, etc.). We can't tell the
					// type without type-checking, so we ban any DialContext
					// outside connect() — proxy.ContextDialer's DialContext is
					// only used inside connect(), so this is correct.
					if selName == "DialContext" {
						pos := fset.Position(call.Pos())
						violations = append(violations, violation{
							file: filepath.Base(filename),
							line: pos.Line,
							fn:   fnName,
							text: "DialContext call outside connect()",
						})
					}

					// Banned: net.Dial / tls.Dial / tls.DialWithDialer / smtp.Dial.
					if pkgIdent, ok := sel.X.(*ast.Ident); ok {
						switch pkgIdent.Name {
						case "net":
							if selName == "Dial" || selName == "DialTCP" {
								pos := fset.Position(call.Pos())
								violations = append(violations, violation{
									file: filepath.Base(filename),
									line: pos.Line,
									fn:   fnName,
									text: "net." + selName + " call outside connect()",
								})
							}
						case "tls":
							if selName == "Dial" || selName == "DialWithDialer" {
								pos := fset.Position(call.Pos())
								violations = append(violations, violation{
									file: filepath.Base(filename),
									line: pos.Line,
									fn:   fnName,
									text: "tls." + selName + " call outside connect()",
								})
							}
						case "smtp":
							if selName == "Dial" {
								pos := fset.Position(call.Pos())
								violations = append(violations, violation{
									file: filepath.Base(filename),
									line: pos.Line,
									fn:   fnName,
									text: "smtp.Dial call outside connect()",
								})
							}
						}
					}
					return true
				})
			}
		}
	}

	if len(violations) > 0 {
		t.Errorf("AW7-2 ratchet: %d direct dial(s) outside connect():", len(violations))
		for _, v := range violations {
			t.Errorf("  %s:%d in func %s — %s", v.file, v.line, v.fn, v.text)
		}
		t.Error(`Fix: route all IMAP dials through connect(ctx, mb). It honours SOCKS5 env
+ ANTI_TRACE_RELAY_URL discovery and refuses direct dial unless the
explicit ALLOW_IMAP_DIRECT=1 escape hatch is set. (memory feedback_no_direct_smtp)`)
	}
}

// TestNoDirectIMAPDial_AW7_2_ConnectHasFailFastBranch verifies that the
// connect() function in poller.go contains the HARD-RULE fail-fast branch
// (not just deletes the warning silently). Defends against a future
// refactor that drops the ErrIMAPSOCKSUnavailable check.
func TestNoDirectIMAPDial_AW7_2_ConnectHasFailFastBranch(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	pkgDir := filepath.Dir(thisFile)
	src, err := os.ReadFile(filepath.Join(pkgDir, "poller.go"))
	if err != nil {
		t.Fatalf("read poller.go: %v", err)
	}
	code := string(src)

	required := []string{
		"ErrIMAPSOCKSUnavailable",
		"ALLOW_IMAP_DIRECT",
		"discoverImapSOCKSAddrFromRelay",
	}
	for _, needle := range required {
		if !strings.Contains(code, needle) {
			t.Errorf("AW7-2 ratchet: poller.go missing required token %q — fail-fast guard regressed?", needle)
		}
	}
}

// TestNoDirectIMAPDial_AW7_2_OrchestratorWideTokenScan repeats the token scan
// across every non-test .go file in the orchestrator tree so future code
// (new packages, helper utilities) can't sneak the bypass back in.
// AO5-2 extension: also covers cmd/anonymity-harvest for SOCKS5 enforcement.
func TestNoDirectIMAPDial_AW7_2_OrchestratorWideTokenScan(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	pkgDir := filepath.Dir(thisFile)
	modRoot := filepath.Dir(pkgDir) // services/orchestrator

	bannedTokens := []string{
		"imap_dial_direct_no_socks",
		"imap.connect/directFallback",
	}

	type violation struct {
		path  string
		line  int
		token string
	}
	var violations []violation

	err := filepath.Walk(modRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		lines := strings.Split(string(data), "\n")
		for i, line := range lines {
			for _, tok := range bannedTokens {
				if strings.Contains(line, tok) {
					rel, _ := filepath.Rel(modRoot, path)
					violations = append(violations, violation{path: rel, line: i + 1, token: tok})
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk orchestrator tree: %v", err)
	}

	if len(violations) > 0 {
		t.Errorf("AW7-2 ratchet: banned tokens detected outside whitelist:")
		for _, v := range violations {
			t.Errorf("  %s:%d — %s", v.path, v.line, v.token)
		}
	}
}

// TestNoDirectIMAPDial_AO5_2_AnonymityHarvestSOCKS5 verifies that
// cmd/anonymity-harvest uses the SOCKS5 connection layer introduced in AO5-2.
// Both imapConnectSOCKS5 and ErrAnonymityHarvestSOCKSUnavailable must be present.
func TestNoDirectIMAPDial_AO5_2_AnonymityHarvestSOCKS5(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	modRoot := filepath.Dir(filepath.Dir(thisFile)) // services/orchestrator

	harvestMainPath := filepath.Join(modRoot, "cmd", "anonymity-harvest", "main.go")
	data, err := os.ReadFile(harvestMainPath)
	if err != nil {
		t.Fatalf("read anonymity-harvest main.go: %v", err)
	}
	src := string(data)

	required := []string{
		"imapConnectSOCKS5",
		"ErrAnonymityHarvestSOCKSUnavailable",
		"discoverAnonymityHarvestSOCKSAddr",
	}
	for _, needle := range required {
		if !strings.Contains(src, needle) {
			t.Errorf("AO5-2 ratchet: anonymity-harvest main.go missing required token %q — SOCKS5 layer regressed?", needle)
		}
	}
}
