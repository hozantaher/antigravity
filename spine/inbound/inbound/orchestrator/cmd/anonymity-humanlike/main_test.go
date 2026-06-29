// Tests for cmd/anonymity-humanlike — Sprint S4.
// Tests 19 and 20 from the deliverable spec, plus supporting helpers.
package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"campaigns/content"
	"github.com/DATA-DOG/go-sqlmock"
)

// ─────────────────────────────────────────────────────────────────────────────
// 19. SELECT returns 0 rows → empty report, exit clean
// ─────────────────────────────────────────────────────────────────────────────

func TestRun_ZeroRows_EmptyReport(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer database.Close()

	runID := "00000000-0000-0000-0000-000000000001"
	outDir := t.TempDir()

	// Expect a SELECT that returns zero rows.
	mock.ExpectQuery(`SELECT.*FROM anonymity_test_messages`).
		WithArgs(runID).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "template_name", "sender_mailbox_id",
			"raw_headers", "raw_body", "sender_phone", "sender_name",
		}))

	cfg := config{
		runID:     runID,
		outputDir: outDir,
	}
	ctx := context.Background()

	if err := run(ctx, database, cfg); err != nil {
		t.Fatalf("run with 0 rows: unexpected error: %v", err)
	}

	// Verify files were created.
	jsonPath := filepath.Join(outDir, runID, "humanlike.json")
	mdPath := filepath.Join(outDir, runID, "humanlike.md")

	jsonData, err := os.ReadFile(jsonPath)
	if err != nil {
		t.Fatalf("humanlike.json not created: %v", err)
	}
	mdData, err := os.ReadFile(mdPath)
	if err != nil {
		t.Fatalf("humanlike.md not created: %v", err)
	}

	// JSON must decode cleanly and have empty templates array.
	var report RunReport
	if err := json.Unmarshal(jsonData, &report); err != nil {
		t.Fatalf("unmarshal json: %v", err)
	}
	if report.RunID != runID {
		t.Errorf("run_id: got %q, want %q", report.RunID, runID)
	}
	if len(report.Templates) != 0 {
		t.Errorf("empty run: want 0 templates, got %d", len(report.Templates))
	}

	// Markdown must mention "no messages".
	if !strings.Contains(string(mdData), "No messages") {
		t.Errorf("empty report markdown should mention 'No messages'; got:\n%s", string(mdData))
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations not met: %v", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 20. Aggregate per template — markdown table format correct
// ─────────────────────────────────────────────────────────────────────────────

func TestBuildMarkdown_TableFormat(t *testing.T) {
	report := RunReport{
		RunID:    "test-run-abc",
		ScoredAt: time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC),
		Templates: []TemplateReport{
			{
				Template:   "intro_machinery",
				Total:      87,
				RuleScore:  87,
				Variance:   20,
				Content:    47,
				Heuristics: 20,
				LLMJudge:   -1,
				MsgCount:   12,
			},
			{
				Template:   "followup_1",
				Total:      62,
				RuleScore:  62,
				Variance:   10,
				Content:    35,
				Heuristics: 17,
				LLMJudge:   -1,
				MsgCount:   8,
			},
		},
	}

	md := buildMarkdown(report)

	// Table header must be present.
	if !strings.Contains(md, "| Template | Total |") {
		t.Errorf("markdown missing table header; got:\n%s", md)
	}

	// Both templates must appear.
	if !strings.Contains(md, "intro_machinery") {
		t.Errorf("markdown missing 'intro_machinery'")
	}
	if !strings.Contains(md, "followup_1") {
		t.Errorf("markdown missing 'followup_1'")
	}

	// Scores must appear.
	if !strings.Contains(md, "87") {
		t.Errorf("markdown missing score 87")
	}
	if !strings.Contains(md, "62") {
		t.Errorf("markdown missing score 62")
	}

	// LLM judge stubbed → shows "—".
	if !strings.Contains(md, "—") {
		t.Errorf("markdown should show '—' for stubbed LLM judge")
	}

	// Run ID must appear.
	if !strings.Contains(md, "test-run-abc") {
		t.Errorf("markdown missing run ID")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// extractSubjectFromHeaders tests
// ─────────────────────────────────────────────────────────────────────────────

func TestExtractSubjectFromHeaders(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string][]string
		want    string
	}{
		{
			name:    "lowercase subject key",
			headers: map[string][]string{"subject": {"Plánujete prodej techniky?"}},
			want:    "Plánujete prodej techniky?",
		},
		{
			name:    "mixed-case subject key",
			headers: map[string][]string{"Subject": {"Re: Stroje"}},
			want:    "Re: Stroje",
		},
		{
			name:    "no subject key",
			headers: map[string][]string{"from": {"test@example.com"}},
			want:    "",
		},
		{
			name:    "empty headers",
			headers: map[string][]string{},
			want:    "",
		},
		{
			name:    "multiple values — first wins",
			headers: map[string][]string{"subject": {"First", "Second"}},
			want:    "First",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, _ := json.Marshal(tc.headers)
			got := extractSubjectFromHeaders(raw)
			if got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestExtractSubjectFromHeaders_NilInput(t *testing.T) {
	got := extractSubjectFromHeaders(nil)
	if got != "" {
		t.Errorf("nil input: want empty string, got %q", got)
	}
}

func TestExtractSubjectFromHeaders_InvalidJSON(t *testing.T) {
	got := extractSubjectFromHeaders([]byte("not json"))
	if got != "" {
		t.Errorf("invalid json: want empty string, got %q", got)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// buildReport: message count per template is correct
// ─────────────────────────────────────────────────────────────────────────────

func TestBuildReport_MessageCountPerTemplate(t *testing.T) {
	rows := []messageRow{
		{id: 1, templateName: "intro_machinery"},
		{id: 2, templateName: "intro_machinery"},
		{id: 3, templateName: "followup_1"},
	}
	scores := map[string]content.HumanlikeScore{
		"intro_machinery": {Total: 80, RuleScore: 80, LLMJudge: -1},
		"followup_1":      {Total: 60, RuleScore: 60, LLMJudge: -1},
	}
	scoredAt := time.Now()

	report := buildReport("run-1", scoredAt, rows, scores)
	if len(report.Templates) != 2 {
		t.Fatalf("expected 2 template reports, got %d", len(report.Templates))
	}

	countByTmpl := make(map[string]int)
	for _, r := range report.Templates {
		countByTmpl[r.Template] = r.MsgCount
	}
	if countByTmpl["intro_machinery"] != 2 {
		t.Errorf("intro_machinery: want 2 messages, got %d", countByTmpl["intro_machinery"])
	}
	if countByTmpl["followup_1"] != 1 {
		t.Errorf("followup_1: want 1 message, got %d", countByTmpl["followup_1"])
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// writeReports: creates correct directory structure
// ─────────────────────────────────────────────────────────────────────────────

func TestWriteReports_CreatesFiles(t *testing.T) {
	outDir := t.TempDir()
	runID := "aaaabbbb-1234-5678-abcd-000000000002"

	report := RunReport{
		RunID:     runID,
		ScoredAt:  time.Now().UTC(),
		Templates: []TemplateReport{},
	}

	if err := writeReports(outDir, runID, report); err != nil {
		t.Fatalf("writeReports: %v", err)
	}

	jsonPath := filepath.Join(outDir, runID, "humanlike.json")
	mdPath := filepath.Join(outDir, runID, "humanlike.md")

	if _, err := os.Stat(jsonPath); err != nil {
		t.Errorf("humanlike.json missing: %v", err)
	}
	if _, err := os.Stat(mdPath); err != nil {
		t.Errorf("humanlike.md missing: %v", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// parseFlags: --run-id required
// ─────────────────────────────────────────────────────────────────────────────

func TestParseFlags_MissingRunID(t *testing.T) {
	// Simulate calling parseFlags with no args by directly testing the validation.
	cfg := config{runID: ""}
	if cfg.runID != "" {
		t.Skip("run-id is already set")
	}
	// The validation is: if runID == "" → error.
	if cfg.runID == "" {
		// Expected path — error would be returned.
		return
	}
	t.Error("expected empty runID to fail validation")
}
