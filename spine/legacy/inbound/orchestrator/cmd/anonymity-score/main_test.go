package main

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"

	"campaigns/content"
	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

func ptrS(s string) *string { return &s }

// ──────────────────────────────────────────────────────────────────────────────
// Test 1: SELECT returns 0 rows → exits cleanly with empty report (not error).
// ──────────────────────────────────────────────────────────────────────────────

func TestRun_ZeroRows_NoError(t *testing.T) {
	mockDB, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer mockDB.Close()

	cols := []string{
		"id", "test_run_id", "sender_mailbox_id", "receiver_mailbox_id",
		"template_name", "raw_headers", "received_chain",
		"message_id", "from_addr", "return_path",
		"dkim_result", "spf_result", "dmarc_result",
	}
	mock.ExpectQuery(`SELECT`).
		WithArgs("run-abc").
		WillReturnRows(sqlmock.NewRows(cols))

	tmpDir := t.TempDir()
	cfg := config{runID: "run-abc", outputDir: tmpDir, llmJudge: false}

	if err := run(context.Background(), mockDB, cfg); err != nil {
		t.Errorf("expected no error for 0 rows, got: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}

	// Verify JSON exists and has count=0.
	jsonPath := filepath.Join(tmpDir, "run-abc", "scores.json")
	data, err := os.ReadFile(jsonPath)
	if err != nil {
		t.Fatalf("scores.json not written: %v", err)
	}
	var report Report
	if err := json.Unmarshal(data, &report); err != nil {
		t.Fatalf("parse scores.json: %v", err)
	}
	if report.MessageCount != 0 {
		t.Errorf("expected MessageCount=0, got %d", report.MessageCount)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 2: Aggregator avg + stddev computed correctly over 12 rows.
// ──────────────────────────────────────────────────────────────────────────────

func TestAggRow_AvgStddev_12Rows(t *testing.T) {
	scores := make([]int, 12)
	for i := range scores {
		scores[i] = 70 + i // 70..81
	}
	row := aggRow("sender:1 template:intro_machinery", scores, 5)

	if row.Count != 12 {
		t.Errorf("expected count=12, got %d", row.Count)
	}
	// avg = (70+71+...+81)/12 = (70+81)*12/2/12 = 75.5
	if math.Abs(row.AvgScore-75.5) > 0.01 {
		t.Errorf("expected avg=75.5, got %.4f", row.AvgScore)
	}
	// variance of {70..81}: we know each value is i*1 from mean; symmetric.
	// E[(x-75.5)^2] for x in {70..81} = mean of {30.25,20.25,12.25,6.25,2.25,0.25,0.25,2.25,6.25,12.25,20.25,30.25}=11.917
	// stddev ≈ 3.45
	if row.StdDev <= 0 {
		t.Errorf("expected positive stddev, got %v", row.StdDev)
	}
	if row.MinScore != 70 {
		t.Errorf("expected min=70, got %d", row.MinScore)
	}
	if row.MaxScore != 81 {
		t.Errorf("expected max=81, got %d", row.MaxScore)
	}
	if row.LeakCnt != 5 {
		t.Errorf("expected leakCnt=5, got %d", row.LeakCnt)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 3: JSON output structure matches Report schema.
// ──────────────────────────────────────────────────────────────────────────────

func TestWriteJSON_Structure(t *testing.T) {
	tmpDir := t.TempDir()
	report := Report{
		RunID:        "test-run-1",
		MessageCount: 2,
		Messages: []MessageScore{
			{ID: 1, SenderMailboxID: 1, ReceiverMailboxID: 3, TemplateName: "intro_machinery", Score: 90, LLMJudge: -1},
			{ID: 2, SenderMailboxID: 3, ReceiverMailboxID: 1, TemplateName: "followup_1", Score: 80, LLMJudge: -1},
		},
	}
	path := filepath.Join(tmpDir, "scores.json")
	if err := writeJSON(path, report); err != nil {
		t.Fatalf("writeJSON: %v", err)
	}

	data, _ := os.ReadFile(path)
	var decoded Report
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("decode JSON: %v", err)
	}

	if decoded.RunID != "test-run-1" {
		t.Errorf("run_id mismatch: %q", decoded.RunID)
	}
	if decoded.MessageCount != 2 {
		t.Errorf("message_count mismatch: %d", decoded.MessageCount)
	}
	if len(decoded.Messages) != 2 {
		t.Errorf("messages length mismatch: %d", len(decoded.Messages))
	}
	if decoded.Messages[0].Score != 90 {
		t.Errorf("first message score mismatch: %d", decoded.Messages[0].Score)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 4: Markdown summary contains a table with one row per template.
// ──────────────────────────────────────────────────────────────────────────────

func TestWriteMarkdown_ContainsTemplateTable(t *testing.T) {
	tmpDir := t.TempDir()
	report := Report{
		RunID:        "test-run-2",
		MessageCount: 2,
		Messages: []MessageScore{
			{ID: 1, TemplateName: "intro_machinery", Score: 85},
			{ID: 2, TemplateName: "followup_1", Score: 75},
		},
		ByTemplate: []AggRow{
			{Key: "template:intro_machinery", Count: 1, AvgScore: 85, StdDev: 0, MinScore: 85, MaxScore: 85},
			{Key: "template:followup_1", Count: 1, AvgScore: 75, StdDev: 0, MinScore: 75, MaxScore: 75},
		},
	}

	path := filepath.Join(tmpDir, "summary.md")
	if err := writeMarkdown(path, report); err != nil {
		t.Fatalf("writeMarkdown: %v", err)
	}

	data, _ := os.ReadFile(path)
	content := string(data)

	if !containsAll(content, []string{
		"## By Template",
		"intro_machinery",
		"followup_1",
		"| Template",
	}) {
		t.Errorf("markdown missing expected sections. got:\n%s", content)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 5: parsePGTextArray — {} returns nil/empty.
// ──────────────────────────────────────────────────────────────────────────────

func TestParsePGTextArray_Empty(t *testing.T) {
	result := parsePGTextArray("{}")
	if len(result) != 0 {
		t.Errorf("expected empty for {}, got %v", result)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 6: parsePGTextArray — multi-element including quotes.
// ──────────────────────────────────────────────────────────────────────────────

func TestParsePGTextArray_MultiElement(t *testing.T) {
	lit := `{"from smtp.seznam.cz ([185.146.213.10])","from mx.email.cz ([185.146.213.5])"}`
	result := parsePGTextArray(lit)
	if len(result) != 2 {
		t.Errorf("expected 2 elements, got %d: %v", len(result), result)
	}
	if result[0] != "from smtp.seznam.cz ([185.146.213.10])" {
		t.Errorf("element 0 mismatch: %q", result[0])
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 7: scoreRow returns expected fields for a clean message.
// ──────────────────────────────────────────────────────────────────────────────

func TestScoreRow_CleanMessage(t *testing.T) {
	row := messageRow{
		id:                1,
		senderMailboxID:   1,
		receiverMailboxID: 3,
		templateName:      "intro_machinery",
		rawHeaders:        map[string][]string{},
		receivedChain:     []string{"from smtp.seznam.cz ([185.146.213.10]) by mx.email.cz"},
		messageID:         "<abc@email.cz>",
		fromAddr:          "sender@email.cz",
		returnPath:        "sender@email.cz",
		dkimResult:        ptrS("pass"),
		spfResult:         ptrS("pass"),
		dmarcResult:       ptrS("pass"),
	}
	ms := scoreRow(row, false)

	if ms.Score != 100 {
		t.Errorf("expected score=100, got %d (L1=%d L2=%d L3=%d L4=%d)", ms.Score, ms.L1IPLeak, ms.L2HeaderFP, ms.L3Envelope, ms.L4Auth)
	}
	if ms.LLMJudge != -1 {
		t.Errorf("expected llm_judge=-1 when llmJudge=false, got %d", ms.LLMJudge)
	}
	if len(ms.Leaks) != 0 {
		t.Errorf("expected 0 leaks for clean message, got %d: %+v", len(ms.Leaks), ms.Leaks)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 8: buildReport groups correctly by template.
// ──────────────────────────────────────────────────────────────────────────────

func TestBuildReport_TemplateGrouping(t *testing.T) {
	messages := []MessageScore{
		{ID: 1, SenderMailboxID: 1, TemplateName: "intro_machinery", Score: 80},
		{ID: 2, SenderMailboxID: 2, TemplateName: "intro_machinery", Score: 90},
		{ID: 3, SenderMailboxID: 1, TemplateName: "followup_1", Score: 70},
	}
	report := buildReport("run-xyz", messages)

	if report.MessageCount != 3 {
		t.Errorf("expected MessageCount=3, got %d", report.MessageCount)
	}

	// Find intro_machinery aggregate.
	var introRow *AggRow
	for i := range report.ByTemplate {
		if report.ByTemplate[i].Key == "template:intro_machinery" {
			introRow = &report.ByTemplate[i]
		}
	}
	if introRow == nil {
		t.Fatal("intro_machinery not found in ByTemplate")
	}
	if introRow.Count != 2 {
		t.Errorf("expected intro_machinery count=2, got %d", introRow.Count)
	}
	if math.Abs(introRow.AvgScore-85.0) > 0.01 {
		t.Errorf("expected intro_machinery avg=85.0, got %.2f", introRow.AvgScore)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 9: aggRow handles a single-element slice (stddev=0).
// ──────────────────────────────────────────────────────────────────────────────

func TestAggRow_SingleElement(t *testing.T) {
	row := aggRow("template:followup_2", []int{60}, 0)
	if row.AvgScore != 60.0 {
		t.Errorf("expected avg=60, got %v", row.AvgScore)
	}
	if row.StdDev != 0 {
		t.Errorf("expected stddev=0 for single element, got %v", row.StdDev)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 10: LLMJudge stub always returns -1.
// ──────────────────────────────────────────────────────────────────────────────

func TestLLMJudge_Stub(t *testing.T) {
	if got := LLMJudge(content.AnonymityMessage{}); got != -1 {
		t.Errorf("expected -1 from LLM stub, got %d", got)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

func containsAll(s string, needles []string) bool {
	for _, n := range needles {
		if !stringContains(s, n) {
			return false
		}
	}
	return true
}

func stringContains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle ||
		func() bool {
			for i := 0; i+len(needle) <= len(haystack); i++ {
				if haystack[i:i+len(needle)] == needle {
					return true
				}
			}
			return false
		}())
}
