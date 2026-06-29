package warmup

import (
	"os"
	"path/filepath"
	"testing"
)

// ── LoadPlansFromYAML error paths ──

func TestLoadPlansFromYAML_FileNotFound(t *testing.T) {
	_, err := LoadPlansFromYAML("/nonexistent/path/warmup.yaml")
	if err == nil {
		t.Error("expected error for missing file")
	}
}

func TestLoadPlansFromYAML_EmptyFile(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "warmup*.yaml")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()

	_, err = LoadPlansFromYAML(f.Name())
	if err == nil {
		t.Error("expected error for empty file (no plans)")
	}
}

func TestLoadPlansFromYAML_NoPlansBlock(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "warmup.yaml")
	// Valid YAML but no "plans:" key → no plans found
	os.WriteFile(p, []byte("version: 1\nconfig:\n  foo: bar\n"), 0o644)
	_, err := LoadPlansFromYAML(p)
	if err == nil {
		t.Error("expected error when plans block is absent")
	}
}

func TestLoadPlansFromYAML_LeavesPlansBlock(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "warmup.yaml")
	// indent=0 line after plans block ends the block
	content := `plans:
  test_plan:
    schedule:
      - { day: 1, daily_limit: 10 }
other_section:
  key: value
`
	os.WriteFile(p, []byte(content), 0o644)
	plans, err := LoadPlansFromYAML(p)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := plans["test_plan"]; !ok {
		t.Error("expected test_plan in plans")
	}
}

func TestLoadPlansFromYAML_NilCurrentPlan(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "warmup.yaml")
	// Content at indent 4+ without a plan name → currentPlan is nil → continue
	content := `plans:
    description: orphan line before any plan name
  real_plan:
    schedule:
      - { day: 1, daily_limit: 5 }
`
	os.WriteFile(p, []byte(content), 0o644)
	// Should not panic even with orphan content
	plans, err := LoadPlansFromYAML(p)
	if err != nil && plans == nil {
		// Either a parse error or success with real_plan is acceptable
		return
	}
}

func TestLoadPlansFromYAML_ParseScheduleError(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "warmup.yaml")
	// Non-integer value in schedule entry
	content := `plans:
  bad_plan:
    schedule:
      - { day: one, daily_limit: 10 }
`
	os.WriteFile(p, []byte(content), 0o644)
	_, err := LoadPlansFromYAML(p)
	if err == nil {
		t.Error("expected error for non-integer day value")
	}
}

// ── parseScheduleEntry error paths ──

func TestParseScheduleEntry_NonIntegerValue(t *testing.T) {
	_, err := parseScheduleEntry("{ day: abc, daily_limit: 10 }")
	if err == nil {
		t.Error("expected error for non-integer day")
	}
}

func TestParseScheduleEntry_ZeroDay(t *testing.T) {
	_, err := parseScheduleEntry("{ day: 0, daily_limit: 10 }")
	if err == nil {
		t.Error("expected error for day=0 (must be positive)")
	}
}

func TestParseScheduleEntry_ZeroLimit(t *testing.T) {
	_, err := parseScheduleEntry("{ day: 1, daily_limit: 0 }")
	if err == nil {
		t.Error("expected error for daily_limit=0 (must be positive)")
	}
}

func TestParseScheduleEntry_NegativeDay(t *testing.T) {
	_, err := parseScheduleEntry("{ day: -1, daily_limit: 10 }")
	if err == nil {
		t.Error("expected error for negative day")
	}
}

func TestParseScheduleEntry_Valid(t *testing.T) {
	e, err := parseScheduleEntry("{ day: 3, daily_limit: 40 }")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if e.Day != 3 || e.DailyLimit != 40 {
		t.Errorf("got day=%d limit=%d, want 3/40", e.Day, e.DailyLimit)
	}
}

// TestParseScheduleEntry_MissingColon covers the len(kv) != 2 continue branch.
// A part without ":" is silently skipped; if remaining parts still provide
// valid day+daily_limit, no error is returned.
func TestParseScheduleEntry_MissingColonPart(t *testing.T) {
	// "nocolon" part has no ":" → len(kv)=1 → continue
	// day and daily_limit parts are valid so the whole entry succeeds.
	e, err := parseScheduleEntry("{ nocolon, day: 2, daily_limit: 20 }")
	if err != nil {
		t.Fatalf("unexpected error for entry with missing-colon part: %v", err)
	}
	if e.Day != 2 || e.DailyLimit != 20 {
		t.Errorf("got day=%d limit=%d, want 2/20", e.Day, e.DailyLimit)
	}
}

// TestLoadPlansFromYAML_ScannerError covers sc.Err() path using a 1MB+ line.
func TestLoadPlansFromYAML_ScannerError(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "warmup.yaml")
	// Line longer than bufio scanner buffer (64KB) → sc.Err() fires
	hugeLine := "plans:\n  plan1:\n    schedule:\n      - " +
		string(make([]byte, 2*1024*1024)) + "x\n"
	os.WriteFile(p, []byte(hugeLine), 0o644)
	_, err := LoadPlansFromYAML(p)
	// May return scanner error or "no plans found" — either is a non-nil error.
	if err == nil {
		t.Error("expected error for oversized line")
	}
}
