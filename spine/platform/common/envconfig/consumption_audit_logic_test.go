package envconfig_test

// Self-tests for the scanner that powers TestEnvconfigConsumption_RatchetBaseline.
//
// scanEnvconfigViolations is a pure function over (root dir → []string).
// We exercise it on synthetic Go source trees in t.TempDir() to lock the
// detection rules:
//
//   1. Bare os.Getenv → counted.
//   2. envconfig-allowed annotation 1, 2, or 3 lines above → ignored.
//   3. envconfig-allowed inline (same line) → ignored.
//   4. envconfig-allowed 4+ lines above → still counted (no leak).
//   5. _test.go files → skipped (production code only).
//   6. Files under common/envconfig/ → skipped (the package itself).
//   7. Unrelated calls (fmt.Sprintf, strings.Contains) → ignored.
//   8. Other os.* calls (os.Stat, os.Setenv) → ignored.
//   9. Multiple calls in one function → all counted.
//  10. Nested directories (services/foo/bar/) → walked recursively.
//  11. vendor/ and node_modules/ → skipped.
//  12. Sorted output → deterministic.
//
// Same shape as services/campaigns/sender/airtight_audit_test.go
// (PR #394) — in particular the AST walk + comment-line lookup +
// allow-list annotation contract.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeGo(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("WriteFile %s: %v", path, err)
	}
}

func TestScanEnvconfig_BareCallCounted(t *testing.T) {
	dir := t.TempDir()
	writeGo(t, filepath.Join(dir, "x.go"), `package x
import "os"
func a() string { return os.Getenv("FOO") }
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 1 {
		t.Fatalf("expected 1 violation, got %d: %v", len(v), v)
	}
	if !strings.Contains(v[0], "os.Getenv") {
		t.Errorf("violation should mention os.Getenv: %s", v[0])
	}
	if !strings.HasSuffix(strings.Split(v[0], ":")[0], "x.go") {
		t.Errorf("violation file path malformed: %s", v[0])
	}
}

func TestScanEnvconfig_AnnotationOneLineAbove_Ignored(t *testing.T) {
	dir := t.TempDir()
	writeGo(t, filepath.Join(dir, "x.go"), `package x
import "os"
func a() string {
	// envconfig-allowed: legitimate inline lookup with custom semantics
	return os.Getenv("FOO")
}
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 0 {
		t.Errorf("annotated call should be ignored, got: %v", v)
	}
}

func TestScanEnvconfig_AnnotationTwoLinesAbove_Ignored(t *testing.T) {
	dir := t.TempDir()
	writeGo(t, filepath.Join(dir, "x.go"), `package x
import "os"
func a() string {
	// envconfig-allowed: justification
	// continued reasoning here
	return os.Getenv("FOO")
}
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 0 {
		t.Errorf("annotation 2 lines above should still count, got: %v", v)
	}
}

func TestScanEnvconfig_AnnotationThreeLinesAbove_Ignored(t *testing.T) {
	dir := t.TempDir()
	writeGo(t, filepath.Join(dir, "x.go"), `package x
import "os"
func a() string {
	// envconfig-allowed: lab path
	// line two of reasoning
	// line three of reasoning
	return os.Getenv("FOO")
}
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 0 {
		t.Errorf("annotation 3 lines above should still count, got: %v", v)
	}
}

func TestScanEnvconfig_AnnotationFourLinesAbove_Counted(t *testing.T) {
	dir := t.TempDir()
	writeGo(t, filepath.Join(dir, "x.go"), `package x
import "os"
func a() string {
	// envconfig-allowed: stale comment from an old call
	_ = "padding 1"
	_ = "padding 2"
	_ = "padding 3"
	return os.Getenv("FOO")
}
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 1 {
		t.Errorf("annotation 4 lines above should NOT protect, got: %v", v)
	}
}

func TestScanEnvconfig_TestFileSkipped(t *testing.T) {
	dir := t.TempDir()
	writeGo(t, filepath.Join(dir, "x_test.go"), `package x
import "os"
func TestFoo(_ interface{}) { _ = os.Getenv("FOO") }
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 0 {
		t.Errorf("_test.go must be skipped, got: %v", v)
	}
}

func TestScanEnvconfig_EnvconfigPackageSkipped(t *testing.T) {
	dir := t.TempDir()
	// Mirror real path layout: <root>/common/envconfig/foo.go
	pkgPath := filepath.Join(dir, "common", "envconfig", "foo.go")
	writeGo(t, pkgPath, `package envconfig
import "os"
func GetOr(k, fb string) string {
	if v := os.Getenv(k); v != "" { return v }
	return fb
}
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 0 {
		t.Errorf("envconfig package itself must be skipped, got: %v", v)
	}
}

func TestScanEnvconfig_UnrelatedCallsIgnored(t *testing.T) {
	dir := t.TempDir()
	writeGo(t, filepath.Join(dir, "x.go"), `package x
import (
	"fmt"
	"strings"
)
func a() string { return fmt.Sprintf("%s", "x") }
func b() bool { return strings.Contains("a", "b") }
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 0 {
		t.Errorf("unrelated calls should pass, got: %v", v)
	}
}

func TestScanEnvconfig_OtherOsCallsIgnored(t *testing.T) {
	dir := t.TempDir()
	writeGo(t, filepath.Join(dir, "x.go"), `package x
import "os"
func a() { os.Setenv("FOO", "1") }
func b() { os.Unsetenv("BAR") }
func c() { _, _ = os.Stat("/tmp") }
func d() { _ = os.Args }
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 0 {
		t.Errorf("os.* calls other than Getenv should be ignored, got: %v", v)
	}
}

func TestScanEnvconfig_MultipleCallsInSameFunction(t *testing.T) {
	dir := t.TempDir()
	writeGo(t, filepath.Join(dir, "x.go"), `package x
import "os"
func a() (string, string, string) {
	return os.Getenv("A"), os.Getenv("B"), os.Getenv("C")
}
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 3 {
		t.Fatalf("expected 3 violations, got %d: %v", len(v), v)
	}
}

func TestScanEnvconfig_NestedDirectoriesWalked(t *testing.T) {
	dir := t.TempDir()
	writeGo(t, filepath.Join(dir, "svc", "internal", "config", "config.go"), `package config
import "os"
func a() string { return os.Getenv("FOO") }
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 1 {
		t.Fatalf("expected 1 violation in nested dir, got %d: %v", len(v), v)
	}
	if !strings.Contains(v[0], "svc/internal/config/config.go") {
		t.Errorf("violation should report nested path, got: %s", v[0])
	}
}

func TestScanEnvconfig_VendorAndNodeModulesSkipped(t *testing.T) {
	dir := t.TempDir()
	writeGo(t, filepath.Join(dir, "vendor", "thirdparty", "x.go"), `package thirdparty
import "os"
func a() string { return os.Getenv("FOO") }
`)
	writeGo(t, filepath.Join(dir, "node_modules", "x", "x.go"), `package x
import "os"
func a() string { return os.Getenv("FOO") }
`)
	writeGo(t, filepath.Join(dir, "src", "x.go"), `package x
import "os"
func a() string { return os.Getenv("REAL") }
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 1 {
		t.Fatalf("expected 1 violation (vendor + node_modules skipped), got %d: %v", len(v), v)
	}
	if !strings.Contains(v[0], "src/x.go") {
		t.Errorf("only src/x.go should remain, got: %s", v[0])
	}
}

func TestScanEnvconfig_OutputIsSorted(t *testing.T) {
	dir := t.TempDir()
	writeGo(t, filepath.Join(dir, "z.go"), `package z
import "os"
func z() string { return os.Getenv("Z") }
`)
	writeGo(t, filepath.Join(dir, "a.go"), `package a
import "os"
func a() string { return os.Getenv("A") }
`)
	writeGo(t, filepath.Join(dir, "m.go"), `package m
import "os"
func m() string { return os.Getenv("M") }
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 3 {
		t.Fatalf("expected 3 violations, got %d: %v", len(v), v)
	}
	// Lexicographic order on file path: a.go < m.go < z.go.
	if !strings.Contains(v[0], "a.go") || !strings.Contains(v[1], "m.go") || !strings.Contains(v[2], "z.go") {
		t.Errorf("violations not sorted by file path: %v", v)
	}
}

func TestScanEnvconfig_AnnotationDoesNotLeakAcrossFunctions(t *testing.T) {
	dir := t.TempDir()
	writeGo(t, filepath.Join(dir, "x.go"), `package x
import "os"
func annotated() string {
	// envconfig-allowed: justification
	return os.Getenv("FOO")
}
func unannotated() string {
	return os.Getenv("BAR")
}
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 1 {
		t.Fatalf("expected 1 violation (unannotated only), got %d: %v", len(v), v)
	}
	if !strings.Contains(v[0], "8") {
		// Line 8 is the unannotated call in the source above.
		t.Errorf("expected line 8 for unannotated call, got: %s", v[0])
	}
}

func TestScanEnvconfig_NonGoFilesIgnored(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.json"),
		[]byte(`{"hint": "os.Getenv would be parsed"}`), 0o644); err != nil {
		t.Fatalf("WriteFile json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"),
		[]byte("os.Getenv example\n"), 0o644); err != nil {
		t.Fatalf("WriteFile md: %v", err)
	}
	writeGo(t, filepath.Join(dir, "x.go"), `package x
func a() {}
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 0 {
		t.Errorf("non-.go files should be ignored, got: %v", v)
	}
}

func TestScanEnvconfig_AnnotationInlineSameLine_Ignored(t *testing.T) {
	dir := t.TempDir()
	writeGo(t, filepath.Join(dir, "x.go"), `package x
import "os"
func a() string {
	return os.Getenv("FOO") // envconfig-allowed: inline trailing-comment justification
}
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 0 {
		t.Errorf("inline trailing annotation should be ignored, got: %v", v)
	}
}

func TestScanEnvconfig_EmptyDirReturnsNoViolations(t *testing.T) {
	dir := t.TempDir()
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 0 {
		t.Errorf("empty dir should yield no violations, got: %v", v)
	}
}
