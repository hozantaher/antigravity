package main

import (
	"os"
	"testing"

	"common/envconfig"
)

// ── splitLines ──

func TestSplitLines(t *testing.T) {
	cases := []struct {
		input string
		want  []string
	}{
		{"", nil},
		{"a\nb\nc", []string{"a", "b", "c"}},
		{"a\r\nb\r\nc", []string{"a", "b", "c"}}, // Windows line endings
		{"a\n\nb", []string{"a", "b"}},            // blank lines skipped
		{"single", []string{"single"}},
	}
	for _, tc := range cases {
		got := splitLines(tc.input)
		if len(got) != len(tc.want) {
			t.Errorf("splitLines(%q) = %v, want %v", tc.input, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("splitLines(%q)[%d] = %q, want %q", tc.input, i, got[i], tc.want[i])
			}
		}
	}
}

// ── splitOn ──

func TestSplitOn(t *testing.T) {
	parts := splitOn("a,b,c", ',')
	if len(parts) != 3 || parts[0] != "a" || parts[1] != "b" || parts[2] != "c" {
		t.Errorf("splitOn = %v", parts)
	}
	empty := splitOn("", ',')
	if len(empty) != 1 || empty[0] != "" {
		t.Errorf("splitOn empty = %v", empty)
	}
}

// ── splitCSV ──

func TestSplitCSV(t *testing.T) {
	fields := splitCSV("a, b , c")
	if len(fields) != 3 || fields[0] != "a" || fields[1] != "b" || fields[2] != "c" {
		t.Errorf("splitCSV = %v", fields)
	}
}

// ── trimCR ──

func TestTrimCR(t *testing.T) {
	if got := trimCR("hello\r"); got != "hello" {
		t.Errorf("trimCR with CR = %q", got)
	}
	if got := trimCR("hello"); got != "hello" {
		t.Errorf("trimCR without CR = %q", got)
	}
	if got := trimCR(""); got != "" {
		t.Errorf("trimCR empty = %q", got)
	}
}

// ── trimSpace ──

func TestTrimSpace(t *testing.T) {
	cases := []struct{ input, want string }{
		{"  hello  ", "hello"},
		{"\thello\t", "hello"},
		{"hello", "hello"},
		{"", ""},
		{"   ", ""},
	}
	for _, tc := range cases {
		if got := trimSpace(tc.input); got != tc.want {
			t.Errorf("trimSpace(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

// ── envOr — local helper consolidated to envconfig.GetOr ──

func TestEnvOr(t *testing.T) {
	os.Setenv("TEST_ENVOR_KEY", "value")
	defer os.Unsetenv("TEST_ENVOR_KEY")

	if got := envconfig.GetOr("TEST_ENVOR_KEY", "fallback"); got != "value" {
		t.Errorf("envconfig.GetOr with set key = %q, want value", got)
	}
	if got := envconfig.GetOr("TEST_ENVOR_MISSING", "fallback"); got != "fallback" {
		t.Errorf("envconfig.GetOr with missing key = %q, want fallback", got)
	}
}

// ── parseSyncCompaniesOptions ──

func TestParseSyncCompaniesOptions(t *testing.T) {
	opts := parseSyncCompaniesOptions([]string{"--incremental", "--skip-tier-stats"}, "1000")
	if !opts.Incremental {
		t.Error("expected Incremental=true")
	}
	if !opts.SkipTierStats {
		t.Error("expected SkipTierStats=true")
	}
	if opts.BatchSize != 1000 {
		t.Errorf("BatchSize = %d, want 1000", opts.BatchSize)
	}
}

func TestParseSyncCompaniesOptions_MetadataStartID(t *testing.T) {
	opts := parseSyncCompaniesOptions([]string{"--metadata-start-id", "42"}, "")
	if opts.MetadataStartID != 42 {
		t.Errorf("MetadataStartID = %d, want 42", opts.MetadataStartID)
	}
	if opts.BatchSize != 5000 { // default
		t.Errorf("BatchSize = %d, want 5000", opts.BatchSize)
	}
}

func TestParseSyncCompaniesOptions_MetadataMaxBatches(t *testing.T) {
	opts := parseSyncCompaniesOptions([]string{"--metadata-max-batches", "10"}, "")
	if opts.MetadataMaxBatches != 10 {
		t.Errorf("MetadataMaxBatches = %d, want 10", opts.MetadataMaxBatches)
	}
}

func TestParseSyncCompaniesOptions_AllFlags(t *testing.T) {
	opts := parseSyncCompaniesOptions([]string{
		"--incremental", "--backfill-categories-json", "--sync-prod-metadata",
		"--refresh-categories", "--verify-sync", "--metadata-only",
	}, "")
	if !opts.Incremental || !opts.BackfillCategoriesJSON || !opts.SyncProdMetadata ||
		!opts.RefreshCategories || !opts.VerifySync || !opts.MetadataOnly {
		t.Error("not all flags parsed correctly")
	}
}

// ── shouldPrintTierStats ──

func TestShouldPrintTierStats(t *testing.T) {
	if !shouldPrintTierStats(syncCompaniesOptions{}) {
		t.Error("should print tier stats when no flags set")
	}
	if shouldPrintTierStats(syncCompaniesOptions{SkipTierStats: true}) {
		t.Error("should NOT print tier stats when SkipTierStats=true")
	}
	if shouldPrintTierStats(syncCompaniesOptions{MetadataOnly: true}) {
		t.Error("should NOT print tier stats when MetadataOnly=true")
	}
}

// ── buildSyncMVPArgs ──

func TestBuildSyncMVPArgs(t *testing.T) {
	args := buildSyncMVPArgs([]string{"--extra"})
	// Should include all defaults plus the extra
	found := false
	for _, a := range args {
		if a == "--incremental" {
			found = true
		}
	}
	if !found {
		t.Error("expected --incremental in buildSyncMVPArgs result")
	}
	if args[len(args)-1] != "--extra" {
		t.Error("expected --extra at end")
	}
}

// ── parseCSVEnv ──

func TestParseCSVEnv(t *testing.T) {
	os.Setenv("TEST_CSV_ENV", "a, b, c")
	defer os.Unsetenv("TEST_CSV_ENV")

	got := parseCSVEnv("TEST_CSV_ENV", "x")
	if len(got) != 3 || got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Errorf("parseCSVEnv = %v", got)
	}

	// With missing key, use fallback
	got2 := parseCSVEnv("TEST_CSV_MISSING", "fallback,value")
	if len(got2) != 2 {
		t.Errorf("parseCSVEnv fallback = %v", got2)
	}
}

// ── printUsage (just verify no panic) ──

func TestPrintUsage_NoPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("printUsage panicked: %v", r)
		}
	}()
	// printUsage just prints to stdout — verify it doesn't panic
	printUsage()
}
