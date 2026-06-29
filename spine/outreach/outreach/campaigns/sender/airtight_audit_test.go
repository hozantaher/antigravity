package sender

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// AT2.3 — discipline ratchet: scan services/campaigns/sender/*.go pro
// volání které mohou napřímo vytočit reálný SMTP socket bez airtight
// kontroly (ADR-005, Layer 3).
//
// Heuristika:
//   - smtp.SendMail / smtp.Dial / smtp.NewClient
//   - net.Dial / net.DialTCP / net.DialTimeout / tls.Dial / tls.DialWithDialer
//   - vše bez "airtight-allowed:" anotace v komentáři uvnitř funkce
//
// Test je ratchet: existing violations jsou zafrízovány na baseline.
// Nový code path co přidá unguarded dial → test FAIL. Migrace existing
// path do gate (přes labhook nebo přes airtight-allowed komentář) →
// operator může baseline snížit.
//
// Vzor: sender/slog_op_audit_test.go (BF-F2). Stejný AST scan + ratchet
// pattern.
//
// Source: docs/decisions/ADR-005-airtight-dev-env.md §D4.
const airtightAuditBaseline = 0

// dialFunctions je closed set funkcí které potenciálně vytočí real SMTP.
// Klíč = "package.func" (selector chain). Pokud někdo zavádí novou
// dial primitive (e.g. quic.Dial), přidej sem.
var dialFunctions = map[string]map[string]bool{
	"smtp": {"SendMail": true, "Dial": true, "NewClient": true, "DialTLS": true},
	"net":  {"Dial": true, "DialTCP": true, "DialTimeout": true},
	"tls":  {"Dial": true, "DialWithDialer": true},
}

// allowedAnnotation je komentář-marker pro explicit exception per
// ADR-005 §D4. Anotace musí být na řádku těsně před call expression
// (nebo v function-level doc comment) a obsahovat // airtight-allowed:
// následované volnou textovou ospravedlněním.
const allowedAnnotation = "airtight-allowed"

func TestAirtightAudit_NoUnguardedSMTPDial(t *testing.T) {
	violations, err := scanAirtightViolations(".")
	if err != nil {
		t.Fatalf("scanAirtightViolations: %v", err)
	}
	if len(violations) > airtightAuditBaseline {
		t.Errorf("unguarded SMTP-dial calls in services/campaigns/sender: %d (baseline %d)",
			len(violations), airtightAuditBaseline)
		for _, v := range violations {
			t.Logf("  %s", v)
		}
		t.Logf("Fix:")
		t.Logf("  - Wrap call site v if cfg.Sending.TransportMode != \"lab\" { ... } guard, NEBO")
		t.Logf("  - Anotuj `// airtight-allowed: <důvod>` na řádku těsně před voláním.")
		t.Logf("Vzor: docs/decisions/ADR-005-airtight-dev-env.md §D4 (recovery procedury).")
	}
}

// scanAirtightViolations vrací []string ve formátu "file:line: pkg.Fn(...)"
// pro každé volání které matchuje dialFunctions BEZ airtight-allowed
// anotace v okolí.
func scanAirtightViolations(dir string) ([]string, error) {
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

		// Build line → comment-text map for the file. We use this to
		// check whether the line BEFORE a call has an airtight-allowed
		// marker. Map by line number is sufficient — we don't need
		// exact column tracking.
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
			if !ok {
				return true
			}
			pkgFns, ok := dialFunctions[ident.Name]
			if !ok {
				return true
			}
			if !pkgFns[sel.Sel.Name] {
				return true
			}
			// Match found. Check for airtight-allowed annotation on the
			// line directly above (or up to 3 lines above to allow for
			// multi-line statements).
			pos := fset.Position(call.Pos())
			if hasAirtightAnnotation(commentLines, pos.Line) {
				return true
			}
			violations = append(violations,
				strings.TrimPrefix(path, "./")+":"+
					itoa(pos.Line)+": "+ident.Name+"."+sel.Sel.Name+"(...)")
			return true
		})
	}
	return violations, nil
}

func hasAirtightAnnotation(comments map[int]string, callLine int) bool {
	for delta := 1; delta <= 3; delta++ {
		if c, ok := comments[callLine-delta]; ok {
			if strings.Contains(c, allowedAnnotation) {
				return true
			}
		}
	}
	// Also check inline comment on the same line (rare but valid).
	if c, ok := comments[callLine]; ok {
		if strings.Contains(c, allowedAnnotation) {
			return true
		}
	}
	return false
}

// ── Audit logic self-tests ───────────────────────────────────────────
//
// scanAirtightViolations je pure function nad fset+comments. Ověřujeme
// na synthetic Go zdrojích v t.TempDir() že:
//   1. Bez anotace catchne smtp.SendMail / smtp.Dial / net.Dial / tls.Dial
//   2. S anotací ignoruje (1-line, 2-line above, 3-line above, inline)
//   3. Ignoruje neutrální calls (jiný pkg.Fn, package level vars)
//   4. Ignoruje _test.go soubory (ratchet je o produkčním kódu)
//
// Tyto testy chrání před regresí audit logic samotné (ratchet baseline
// stačí jen pokud scan funguje).

func writeTestFile(t *testing.T, dir, name, body string) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("WriteFile %s: %v", path, err)
	}
}

func TestAirtightAudit_CatchesUnguardedSMTPSendMail(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, dir, "x.go", `package x
import "net/smtp"
func send() error {
	return smtp.SendMail("host:25", nil, "from", []string{"to"}, []byte("body"))
}
`)
	v, err := scanAirtightViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 1 {
		t.Fatalf("expected 1 violation, got %d: %v", len(v), v)
	}
	if !strings.Contains(v[0], "smtp.SendMail") {
		t.Errorf("violation should mention smtp.SendMail: %s", v[0])
	}
}

func TestAirtightAudit_CatchesUnguardedNetDial(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, dir, "x.go", `package x
import "net"
func dial() (net.Conn, error) { return net.Dial("tcp", "smtp.seznam.cz:25") }
`)
	v, err := scanAirtightViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 1 {
		t.Fatalf("expected 1 violation, got %d: %v", len(v), v)
	}
	if !strings.Contains(v[0], "net.Dial") {
		t.Errorf("violation should mention net.Dial: %s", v[0])
	}
}

func TestAirtightAudit_CatchesAllDialFamily(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, dir, "x.go", `package x
import (
	"crypto/tls"
	"net"
	"net/smtp"
)
func a() (*tls.Conn, error) { return tls.Dial("tcp", "h:465", nil) }
func b() (net.Conn, error) { return net.DialTimeout("tcp", "h:25", 0) }
func c() (*smtp.Client, error) { return smtp.NewClient(nil, "h") }
func d() error { return smtp.SendMail("h", nil, "f", nil, nil) }
`)
	v, err := scanAirtightViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	// 4 calls expected: tls.Dial, net.DialTimeout, smtp.NewClient,
	// smtp.SendMail.
	if len(v) != 4 {
		t.Fatalf("expected 4 violations, got %d: %v", len(v), v)
	}
}

func TestAirtightAudit_AnnotationOneLineAbove(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, dir, "x.go", `package x
import "net/smtp"
func send() error {
	// airtight-allowed: lab transport injection (mailsim/bouncer parity)
	return smtp.SendMail("h", nil, "f", nil, nil)
}
`)
	v, err := scanAirtightViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 0 {
		t.Errorf("annotated call should pass, got violations: %v", v)
	}
}

func TestAirtightAudit_AnnotationTwoLinesAbove(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, dir, "x.go", `package x
import "net/smtp"
func send() error {
	// airtight-allowed: legitimate lab path
	// (additional context line)
	return smtp.SendMail("h", nil, "f", nil, nil)
}
`)
	v, err := scanAirtightViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 0 {
		t.Errorf("annotated call (2 lines above) should pass, got: %v", v)
	}
}

func TestAirtightAudit_IgnoresUnrelatedCalls(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, dir, "x.go", `package x
import (
	"fmt"
	"strings"
)
func a() string { return fmt.Sprintf("%s", "x") }
func b() bool { return strings.Contains("a", "b") }
`)
	v, err := scanAirtightViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 0 {
		t.Errorf("unrelated calls should pass, got: %v", v)
	}
}

func TestAirtightAudit_IgnoresTestFiles(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, dir, "x_test.go", `package x
import "net/smtp"
func TestSomething(_ interface{}) {
	smtp.SendMail("h", nil, "f", nil, nil)
}
`)
	v, err := scanAirtightViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 0 {
		t.Errorf("test files should be ignored, got: %v", v)
	}
}

func TestAirtightAudit_AnnotationDoesNotLeakAcrossFunctions(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, dir, "x.go", `package x
import "net/smtp"
func annotated() error {
	// airtight-allowed: lab path
	return smtp.SendMail("h", nil, "f", nil, nil)
}
func unannotated() error {
	return smtp.SendMail("h", nil, "f", nil, nil)
}
`)
	v, err := scanAirtightViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 1 {
		t.Fatalf("expected 1 violation (unannotated only), got %d: %v", len(v), v)
	}
}

func TestAirtightAudit_AnnotationFourLinesAboveDoesNotProtect(t *testing.T) {
	// Anotace musí být do 3 řádků nad voláním. Jinak je to "stale"
	// komentář od jiného call site.
	dir := t.TempDir()
	writeTestFile(t, dir, "x.go", `package x
import "net/smtp"
func send() error {
	// airtight-allowed: lab path
	_ = "padding line 1"
	_ = "padding line 2"
	_ = "padding line 3"
	return smtp.SendMail("h", nil, "f", nil, nil)
}
`)
	v, err := scanAirtightViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 1 {
		t.Errorf("annotation 4 lines above should NOT protect, got: %v", v)
	}
}

func TestAirtightAudit_MultipleCallsInSameFunction(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, dir, "x.go", `package x
import "net/smtp"
func send() error {
	if err := smtp.SendMail("a", nil, "f", nil, nil); err != nil {
		return err
	}
	return smtp.SendMail("b", nil, "f", nil, nil)
}
`)
	v, err := scanAirtightViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 2 {
		t.Errorf("expected 2 violations (both unannotated), got %d: %v", len(v), v)
	}
}

// itoa is a local alias for strconv.Itoa to avoid yet-another import on
// a discipline-only file.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
