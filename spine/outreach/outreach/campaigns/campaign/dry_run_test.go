package campaign

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"campaigns/content"

	"github.com/DATA-DOG/go-sqlmock"
)

// KT-A5 — dry-run tests.
//
// Coverage targets (memory: feedback_extreme_testing — ≥ 10 cases):
//   - happy path (one contact rendered into a record)
//   - record-count matches contacts returned
//   - subject + body preview captured
//   - body preview truncated when body is long
//   - skipped reason when render fails (bad template name)
//   - skipped reason when contact past sequence end
//   - audit row written via audit.Log
//   - nil DB and nil engine guards
//   - load error surfaces
//   - sequence parse error surfaces
//   - IsDryRunStatus helper
//
// HARD RULE (memory feedback_campaign_send): NONE of these tests open
// the SMTP path. Dry-run renders only.

// ── helpers ─────────────────────────────────────────────────────────

func writeDryRunTemplate(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name+".tmpl"), []byte(body), 0o600); err != nil {
		t.Fatalf("write template: %v", err)
	}
}

func newDryRunEngine(t *testing.T) (*content.Engine, string) {
	t.Helper()
	dir := t.TempDir()
	writeDryRunTemplate(t, dir, "initial",
		"{{/* subject: Pozdrav */}}\nDobrý den {{jmeno}}, ohledně firmy {{firma}}.\n{{unsub_url}}")
	writeDryRunTemplate(t, dir, "longbody",
		"{{/* subject: Long */}}\n"+strings.Repeat("X", dryRunBodyPreviewLen+200))
	return content.NewEngine(dir, nil), dir
}

func expectDryRunCampaignLoad(mock sqlmock.Sqlmock, name, status string, steps []SequenceStep) {
	seq, _ := json.Marshal(steps)
	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow(name, status, seq))
}

// expectDryRunAudit is a permissive matcher for audit.Log INSERT.
func expectDryRunAudit(mock sqlmock.Sqlmock) {
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(0, 1))
}

// ── happy path ──────────────────────────────────────────────────────

func TestRunDryRun_HappyPath(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	expectDryRunCampaignLoad(mock, "Soft Launch", "dry_run",
		[]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "initial"}})

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "contact_id", "current_step", "email", "first_name", "company_name", "region",
		}).AddRow(10, 100, 0, "tester@example.com", "Jan", "Acme s.r.o.", "Praha"))

	expectDryRunAudit(mock)

	eng, _ := newDryRunEngine(t)
	rep, err := RunDryRun(context.Background(), db, eng, 1)
	if err != nil {
		t.Fatalf("dry_run: %v", err)
	}
	if rep.RecordCount != 1 {
		t.Errorf("record_count = %d, want 1", rep.RecordCount)
	}
	rec := rep.Records[0]
	if rec.ToAddress != "tester@example.com" {
		t.Errorf("to = %q", rec.ToAddress)
	}
	if rec.Subject != "Pozdrav" {
		t.Errorf("subject = %q, want 'Pozdrav'", rec.Subject)
	}
	if !strings.Contains(rec.BodyPreview, "Jan") || !strings.Contains(rec.BodyPreview, "Acme") {
		t.Errorf("body preview missing personalization: %q", rec.BodyPreview)
	}
}

func TestRunDryRun_BodyPreviewTruncated(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	expectDryRunCampaignLoad(mock, "Truncate", "dry_run",
		[]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "longbody"}})

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "contact_id", "current_step", "email", "first_name", "company_name", "region",
		}).AddRow(1, 1, 0, "x@y.test", "", "", ""))

	expectDryRunAudit(mock)

	eng, _ := newDryRunEngine(t)
	rep, err := RunDryRun(context.Background(), db, eng, 1)
	if err != nil {
		t.Fatalf("dry_run: %v", err)
	}
	rec := rep.Records[0]
	if !strings.HasSuffix(rec.BodyPreview, "…") {
		t.Errorf("body preview not truncated: %q", rec.BodyPreview)
	}
	if rec.BodyLength <= dryRunBodyPreviewLen {
		t.Errorf("body_length = %d, expected > preview cap %d", rec.BodyLength, dryRunBodyPreviewLen)
	}
}

// ── render failure path ─────────────────────────────────────────────

func TestRunDryRun_BadTemplateNameSkipped(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	expectDryRunCampaignLoad(mock, "Bad", "dry_run",
		[]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "../escape"}})

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "contact_id", "current_step", "email", "first_name", "company_name", "region",
		}).AddRow(1, 1, 0, "x@y.test", "", "", ""))

	expectDryRunAudit(mock)

	eng, _ := newDryRunEngine(t)
	rep, err := RunDryRun(context.Background(), db, eng, 1)
	if err != nil {
		t.Fatalf("dry_run: %v", err)
	}
	if rep.RecordCount != 0 {
		t.Errorf("record_count = %d, want 0 (template invalid)", rep.RecordCount)
	}
	if len(rep.SkippedReason) != 1 {
		t.Errorf("skipped len = %d, want 1", len(rep.SkippedReason))
	}
}

func TestRunDryRun_PastSequenceEndSkipped(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	expectDryRunCampaignLoad(mock, "Past", "dry_run",
		[]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "initial"}})

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "contact_id", "current_step", "email", "first_name", "company_name", "region",
		}).AddRow(1, 1, 99, "x@y.test", "", "", "")) // current_step beyond seq

	expectDryRunAudit(mock)

	eng, _ := newDryRunEngine(t)
	rep, err := RunDryRun(context.Background(), db, eng, 1)
	if err != nil {
		t.Fatalf("dry_run: %v", err)
	}
	if rep.RecordCount != 0 {
		t.Errorf("record_count = %d, want 0", rep.RecordCount)
	}
	if len(rep.SkippedReason) != 1 {
		t.Errorf("skipped len = %d, want 1", len(rep.SkippedReason))
	}
}

// ── error surfaces ──────────────────────────────────────────────────

func TestRunDryRun_LoadError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnError(errors.New("no rows"))

	eng, _ := newDryRunEngine(t)
	_, err := RunDryRun(context.Background(), db, eng, 1)
	if err == nil {
		t.Error("expected error from missing campaign")
	}
}

func TestRunDryRun_SequenceParseError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Bad", "dry_run", []byte(`{"not":"array"}`)))

	eng, _ := newDryRunEngine(t)
	_, err := RunDryRun(context.Background(), db, eng, 1)
	if err == nil {
		t.Error("expected error from sequence parse")
	}
}

func TestRunDryRun_NilDB(t *testing.T) {
	eng, _ := newDryRunEngine(t)
	_, err := RunDryRun(context.Background(), nil, eng, 1)
	if err == nil {
		t.Error("expected error from nil DB")
	}
}

func TestRunDryRun_NilEngine(t *testing.T) {
	db, _, _ := sqlmock.New()
	defer db.Close()
	_, err := RunDryRun(context.Background(), db, nil, 1)
	if err == nil {
		t.Error("expected error from nil engine")
	}
}

// ── multiple records aggregate ──────────────────────────────────────

func TestRunDryRun_MultipleRecords(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	expectDryRunCampaignLoad(mock, "Multi", "dry_run",
		[]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "initial"}})

	rows := sqlmock.NewRows([]string{
		"id", "contact_id", "current_step", "email", "first_name", "company_name", "region",
	})
	for i := 1; i <= 3; i++ {
		rows.AddRow(i, i+100, 0, "addr"+string(rune('a'+i-1))+"@y.test", "Jméno", "Firma", "")
	}
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).WillReturnRows(rows)

	expectDryRunAudit(mock)

	eng, _ := newDryRunEngine(t)
	rep, err := RunDryRun(context.Background(), db, eng, 1)
	if err != nil {
		t.Fatalf("dry_run: %v", err)
	}
	if rep.RecordCount != 3 {
		t.Errorf("record_count = %d, want 3", rep.RecordCount)
	}
}

// ── helpers ─────────────────────────────────────────────────────────

func TestIsDryRunStatus(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"dry_run", true},
		{"draft", false},
		{"running", false},
		{"DRY_RUN", false}, // case-sensitive
		{"", false},
	}
	for _, c := range cases {
		if got := IsDryRunStatus(c.in); got != c.want {
			t.Errorf("IsDryRunStatus(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestFirstNRecords_Truncates(t *testing.T) {
	in := []DryRunRecord{
		{ContactID: 1}, {ContactID: 2}, {ContactID: 3}, {ContactID: 4},
	}
	got := firstNRecords(in, 2)
	if len(got) != 2 {
		t.Errorf("len = %d, want 2", len(got))
	}
	got[0].ContactID = 999
	if in[0].ContactID == 999 {
		t.Error("firstNRecords aliased original slice")
	}
}

func TestFirstNRecords_NoTruncationWhenSmaller(t *testing.T) {
	in := []DryRunRecord{{ContactID: 1}}
	got := firstNRecords(in, 10)
	if len(got) != 1 {
		t.Errorf("len = %d, want 1", len(got))
	}
}
