package slogop

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeFile is a tiny helper that writes a Go source file inside the
// scratch dir built by t.TempDir().
func writeFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

func TestScan_FlagsErrorWithoutOpKey(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "bad.go", `package x
import "log/slog"
func F() { slog.Error("db fell over", "error", "boom") }
`)
	v, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(v) != 1 {
		t.Fatalf("violations: got %d want 1: %+v", len(v), v)
	}
	if v[0].Method != "Error" {
		t.Errorf("method: got %q want Error", v[0].Method)
	}
	if v[0].Line != 3 {
		t.Errorf("line: got %d want 3", v[0].Line)
	}
}

func TestScan_FlagsWarnWithoutOpKey(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "warn.go", `package x
import "log/slog"
func F() { slog.Warn("retry", "attempt", 3) }
`)
	v, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(v) != 1 || v[0].Method != "Warn" {
		t.Fatalf("expected one Warn violation, got: %+v", v)
	}
}

func TestScan_AcceptsErrorWithOpKey(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "good.go", `package x
import "log/slog"
func F() { slog.Error("db fell over", "op", "x.F/insert", "error", "boom") }
`)
	v, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(v) != 0 {
		t.Fatalf("no violations expected, got: %+v", v)
	}
}

func TestScan_AcceptsWarnWithOpKey(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "good.go", `package x
import "log/slog"
func F() { slog.Warn("greylist", "op", "x.F/greylist", "host", "smtp.example") }
`)
	v, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(v) != 0 {
		t.Fatalf("no violations expected, got: %+v", v)
	}
}

func TestScan_OpKeyDeepInArgListIsAccepted(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "deep.go", `package x
import "log/slog"
func F() {
    slog.Error("multi-keyed", "host", "h1", "port", 25, "op", "x.F/branch", "error", "boom")
}
`)
	v, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(v) != 0 {
		t.Fatalf("op key after other keys is still valid; got: %+v", v)
	}
}

func TestScan_DoesNotFlagSlogInfo(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "info.go", `package x
import "log/slog"
func F() {
    slog.Info("hello", "err", "boom")
    slog.Debug("hi", "err", "boom")
}
`)
	v, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(v) != 0 {
		t.Fatalf("scanner should only flag Error/Warn; got: %+v", v)
	}
}

func TestScan_SkipsTestFiles(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "regular_test.go", `package x
import "log/slog"
import "testing"
func TestX(t *testing.T) { slog.Error("from test", "err", "boom") }
`)
	v, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(v) != 0 {
		t.Fatalf("test files must be ignored; got: %+v", v)
	}
}

func TestScan_DoesNotRecurseIntoSubdirectories(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "child")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// child violation should be ignored — Scan is non-recursive.
	writeFile(t, sub, "deep.go", `package y
import "log/slog"
func G() { slog.Error("child", "err", "boom") }
`)
	// parent file with op — clean.
	writeFile(t, dir, "parent.go", `package x
import "log/slog"
func F() { slog.Error("parent", "op", "x.F/main") }
`)
	v, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(v) != 0 {
		t.Fatalf("subdir should be skipped; got: %+v", v)
	}
}

func TestScan_AggregatesMultipleViolationsAcrossFiles(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.go", `package x
import "log/slog"
func A() {
    slog.Error("e1", "err", "boom")
    slog.Warn("w1", "err", "boom")
}
`)
	writeFile(t, dir, "b.go", `package x
import "log/slog"
func B() { slog.Error("e2", "err", "boom") }
`)
	v, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(v) != 3 {
		t.Fatalf("violations: got %d want 3: %+v", len(v), v)
	}
	// Confirm both methods + both files appear.
	saw := map[string]bool{}
	for _, x := range v {
		saw[x.Method] = true
		base := filepath.Base(x.File)
		if base != "a.go" && base != "b.go" {
			t.Errorf("unexpected file: %q", x.File)
		}
	}
	if !saw["Error"] || !saw["Warn"] {
		t.Errorf("missing method coverage: %+v", saw)
	}
}

func TestScan_StringFormatMatchesLegacyShape(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "legacy.go", `package x
import "log/slog"
func F() { slog.Error("oops", "err", "boom") }
`)
	v, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(v) != 1 {
		t.Fatalf("expected 1 violation, got %d", len(v))
	}
	got := v[0].String()
	if !strings.HasSuffix(got, ": slog.Error missing \"op\" field") {
		t.Errorf("string format drift: %q", got)
	}
	if !strings.Contains(got, "legacy.go:") {
		t.Errorf("expected file:line:col prefix, got: %q", got)
	}
}

func TestScan_ReturnsErrorOnMissingDir(t *testing.T) {
	_, err := Scan(filepath.Join(t.TempDir(), "does-not-exist"))
	if err == nil {
		t.Fatal("expected error for missing dir")
	}
}

func TestScan_ReturnsErrorOnMalformedSource(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "broken.go", `package x
this is not valid go syntax {{ ;
`)
	_, err := Scan(dir)
	if err == nil {
		t.Fatal("expected parse error for malformed source")
	}
}

func TestScan_IgnoresUnrelatedSelectorCalls(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "other.go", `package x
type fakeLogger struct{}
func (fakeLogger) Error(msg string, args ...any) {}
func F() {
    var l fakeLogger
    l.Error("not slog", "err", "boom") // not slog.Error — must be ignored
}
`)
	v, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(v) != 0 {
		t.Fatalf("non-slog .Error calls must not be flagged; got: %+v", v)
	}
}

func TestScan_NonLiteralKeyIsTreatedAsMissing(t *testing.T) {
	// A const or variable key (e.g. `keyOp`) cannot be statically
	// resolved to the literal "op" without a type checker. Documenting
	// the deliberate behavior: such call sites are still flagged so
	// the convention "use the string literal "op"" is enforceable at
	// the AST level.
	dir := t.TempDir()
	writeFile(t, dir, "nonliteral.go", `package x
import "log/slog"
const keyOp = "op"
func F() { slog.Error("hello", keyOp, "x.F/branch") }
`)
	v, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(v) != 1 {
		t.Fatalf("non-literal op key should be flagged; got: %+v", v)
	}
}

// TestScan_KnownLimitation_OpAsValueArgIsAcceptedAsKey documents the
// AST-level shortcut: the scanner treats *any* string literal "op"
// from arg index 1 onward as a match, regardless of whether it sits
// in key or value position. In practice, no production call site
// passes "op" as a value (the convention is `"op", "<package>.<func>"`),
// so this is a known-acceptable limitation. Codified to catch future
// scanner regressions that might tighten or break this behaviour.
func TestScan_KnownLimitation_OpAsValueArgIsAcceptedAsKey(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "valuepos.go", `package x
import "log/slog"
func F() {
    slog.Error("hi", "key", "op") // "op" appears as VALUE; still passes.
}
`)
	v, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(v) != 0 {
		t.Fatalf("known limitation — \"op\" anywhere passes; got: %+v", v)
	}
}

func TestScan_PositionFieldsArePopulated(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "pos.go", `package x
import "log/slog"

func F() {
	slog.Error("at line 5", "err", "boom")
}
`)
	v, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(v) != 1 {
		t.Fatalf("expected 1 violation, got %d", len(v))
	}
	got := v[0]
	if got.Line != 5 {
		t.Errorf("line: got %d want 5", got.Line)
	}
	if got.Column < 1 {
		t.Errorf("column: got %d want >=1", got.Column)
	}
	if filepath.Base(got.File) != "pos.go" {
		t.Errorf("file: got %q want pos.go", got.File)
	}
}
