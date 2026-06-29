// Z3 Bundle C — tests for the mailbox-healing cron.
//
// Two surfaces:
//   - EvaluateAutoResume — pure function, exhaustive boundary cases.
//   - RunMailboxHealingOnce — sqlmock-backed integration of the
//     SELECT + decision + UPDATE + audit-log flow.
package main

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ---- EvaluateAutoResume (pure) ----

func TestEvaluateAutoResume_NotPaused_Skipped(t *testing.T) {
	now := time.Now()
	mb := PausedMailbox{Status: "active"}
	dec := EvaluateAutoResume(mb, MailboxHealingConfig{}, now)
	if dec.ShouldResume {
		t.Fatalf("expected skip when not paused, got resume: %s", dec.Reason)
	}
}

func TestEvaluateAutoResume_ManualPause_Preserved(t *testing.T) {
	now := time.Now()
	mb := PausedMailbox{
		Status:       "paused",
		StatusReason: sql.NullString{String: "operator manual review", Valid: true},
		LastScore:    sql.NullFloat64{Float64: 95, Valid: true},
		LastScoreAt:  sql.NullTime{Time: now, Valid: true},
	}
	dec := EvaluateAutoResume(mb, MailboxHealingConfig{}, now)
	if dec.ShouldResume {
		t.Fatalf("manual pause should never auto-resume, got: %s", dec.Reason)
	}
}

func TestEvaluateAutoResume_NoStatusReason_Skipped(t *testing.T) {
	now := time.Now()
	mb := PausedMailbox{Status: "paused"} // StatusReason zero-value invalid
	dec := EvaluateAutoResume(mb, MailboxHealingConfig{}, now)
	if dec.ShouldResume {
		t.Fatalf("missing status_reason must skip, got: %s", dec.Reason)
	}
}

func TestEvaluateAutoResume_NoScore_Skipped(t *testing.T) {
	now := time.Now()
	mb := PausedMailbox{
		Status:       "paused",
		StatusReason: sql.NullString{String: "auto:bounce_spike", Valid: true},
	}
	dec := EvaluateAutoResume(mb, MailboxHealingConfig{}, now)
	if dec.ShouldResume {
		t.Fatalf("missing last_score must skip, got: %s", dec.Reason)
	}
}

func TestEvaluateAutoResume_ScoreBelowFloor_Skipped(t *testing.T) {
	now := time.Now()
	mb := PausedMailbox{
		Status:       "paused",
		StatusReason: sql.NullString{String: "auto:smtp_auth_fail", Valid: true},
		LastScore:    sql.NullFloat64{Float64: 50, Valid: true},
		LastScoreAt:  sql.NullTime{Time: now, Valid: true},
	}
	dec := EvaluateAutoResume(mb, MailboxHealingConfig{}, now)
	if dec.ShouldResume {
		t.Fatalf("score 50 < floor 80 must skip, got: %s", dec.Reason)
	}
}

func TestEvaluateAutoResume_NoScoreAt_Skipped(t *testing.T) {
	now := time.Now()
	mb := PausedMailbox{
		Status:       "paused",
		StatusReason: sql.NullString{String: "auto:bounce_spike", Valid: true},
		LastScore:    sql.NullFloat64{Float64: 95, Valid: true},
	}
	dec := EvaluateAutoResume(mb, MailboxHealingConfig{}, now)
	if dec.ShouldResume {
		t.Fatalf("missing last_score_at must skip, got: %s", dec.Reason)
	}
}

func TestEvaluateAutoResume_StaleScore_Skipped(t *testing.T) {
	now := time.Now()
	mb := PausedMailbox{
		Status:       "paused",
		StatusReason: sql.NullString{String: "auto:bounce_spike", Valid: true},
		LastScore:    sql.NullFloat64{Float64: 95, Valid: true},
		LastScoreAt:  sql.NullTime{Time: now.Add(-30 * time.Minute), Valid: true},
	}
	dec := EvaluateAutoResume(mb, MailboxHealingConfig{}, now)
	if dec.ShouldResume {
		t.Fatalf("stale score (30 min > 10 min freshness) must skip, got: %s", dec.Reason)
	}
}

func TestEvaluateAutoResume_HealthyAutoPause_Resumes(t *testing.T) {
	now := time.Now()
	mb := PausedMailbox{
		Status:       "paused",
		StatusReason: sql.NullString{String: "auto:bounce_spike", Valid: true},
		LastScore:    sql.NullFloat64{Float64: 95, Valid: true},
		LastScoreAt:  sql.NullTime{Time: now.Add(-2 * time.Minute), Valid: true},
	}
	dec := EvaluateAutoResume(mb, MailboxHealingConfig{}, now)
	if !dec.ShouldResume {
		t.Fatalf("score 95 fresh must resume, got skip: %s", dec.Reason)
	}
}

func TestEvaluateAutoResume_BoundaryScoreAtFloor_Resumes(t *testing.T) {
	now := time.Now()
	mb := PausedMailbox{
		Status:       "paused",
		StatusReason: sql.NullString{String: "auto:smtp_auth_fail", Valid: true},
		LastScore:    sql.NullFloat64{Float64: 80, Valid: true},
		LastScoreAt:  sql.NullTime{Time: now, Valid: true},
	}
	dec := EvaluateAutoResume(mb, MailboxHealingConfig{}, now)
	if !dec.ShouldResume {
		t.Fatalf("score == floor (80) must resume per >= rule, got skip: %s", dec.Reason)
	}
}

func TestEvaluateAutoResume_CustomConfigOverrides(t *testing.T) {
	now := time.Now()
	mb := PausedMailbox{
		Status:       "paused",
		StatusReason: sql.NullString{String: "auto:bounce_spike", Valid: true},
		LastScore:    sql.NullFloat64{Float64: 90, Valid: true},
		LastScoreAt:  sql.NullTime{Time: now, Valid: true},
	}
	strict := MailboxHealingConfig{ScoreFloor: 95, ScoreFreshness: 5 * time.Minute}
	dec := EvaluateAutoResume(mb, strict, now)
	if dec.ShouldResume {
		t.Fatalf("score 90 < custom floor 95 must skip, got: %s", dec.Reason)
	}
}

// ---- WithDefaults ----

func TestMailboxHealingConfig_WithDefaults_FillsZero(t *testing.T) {
	cfg := MailboxHealingConfig{}.WithDefaults()
	if cfg.Interval != 15*time.Minute {
		t.Errorf("expected default interval 15m, got %s", cfg.Interval)
	}
	if cfg.ScoreFloor != 80 {
		t.Errorf("expected default score floor 80, got %f", cfg.ScoreFloor)
	}
	if cfg.ScoreFreshness != 10*time.Minute {
		t.Errorf("expected default freshness 10m, got %s", cfg.ScoreFreshness)
	}
	if cfg.UpdateTimeout <= 0 || cfg.TickTimeout <= 0 {
		t.Errorf("timeouts must be positive: update=%s tick=%s", cfg.UpdateTimeout, cfg.TickTimeout)
	}
}

func TestMailboxHealingConfig_WithDefaults_PreservesNonZero(t *testing.T) {
	cfg := MailboxHealingConfig{
		Interval:       7 * time.Minute,
		ScoreFloor:     90,
		ScoreFreshness: 3 * time.Minute,
	}.WithDefaults()
	if cfg.Interval != 7*time.Minute || cfg.ScoreFloor != 90 || cfg.ScoreFreshness != 3*time.Minute {
		t.Errorf("WithDefaults overwrote non-zero values: %+v", cfg)
	}
}

// ---- RunMailboxHealingOnce (sqlmock) ----

// helper: mock the SELECT for paused/auto candidates with the given rows.
func mockSelectPaused(mock sqlmock.Sqlmock, rows *sqlmock.Rows) {
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT id, status, status_reason, last_score, last_score_at`)).
		WillReturnRows(rows)
}

func TestRunMailboxHealingOnce_EmptyCandidates_NoOp(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mockSelectPaused(mock, sqlmock.NewRows([]string{"id", "status", "status_reason", "last_score", "last_score_at"}))

	stats, err := RunMailboxHealingOnce(context.Background(), db, MailboxHealingConfig{}, time.Now())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stats.Candidates != 0 || stats.Resumed != 0 || stats.Skipped != 0 {
		t.Errorf("expected zero stats, got %+v", stats)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestRunMailboxHealingOnce_HealthyMailbox_ResumeAndAudit(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now()
	mockSelectPaused(mock, sqlmock.NewRows([]string{
		"id", "status", "status_reason", "last_score", "last_score_at",
	}).AddRow(int64(42), "paused", "auto:bounce_spike", 95.0, now.Add(-1*time.Minute)))

	mock.ExpectExec(regexp.QuoteMeta(`UPDATE outreach_mailboxes`)).
		WithArgs(int64(42)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(1, 1))

	stats, err := RunMailboxHealingOnce(context.Background(), db, MailboxHealingConfig{}, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stats.Resumed != 1 || stats.Skipped != 0 || stats.Errors != 0 {
		t.Errorf("expected 1 resumed, got %+v", stats)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestRunMailboxHealingOnce_DegradedMailbox_SkipNoUpdate(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now()
	mockSelectPaused(mock, sqlmock.NewRows([]string{
		"id", "status", "status_reason", "last_score", "last_score_at",
	}).AddRow(int64(7), "paused", "auto:smtp_auth_fail", 40.0, now))
	// No UPDATE expected — degraded mailbox stays paused.

	stats, err := RunMailboxHealingOnce(context.Background(), db, MailboxHealingConfig{}, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stats.Resumed != 0 || stats.Skipped != 1 {
		t.Errorf("expected 0 resumed 1 skipped, got %+v", stats)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestRunMailboxHealingOnce_RaceLostToManualPause_CountedAsSkip(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now()
	mockSelectPaused(mock, sqlmock.NewRows([]string{
		"id", "status", "status_reason", "last_score", "last_score_at",
	}).AddRow(int64(11), "paused", "auto:bounce_spike", 95.0, now))
	// Decision says "resume" but UPDATE matches 0 rows — operator
	// flipped status_reason between SELECT and UPDATE.
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE outreach_mailboxes`)).
		WithArgs(int64(11)).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// No audit log INSERT — we only audit successful flips.

	stats, err := RunMailboxHealingOnce(context.Background(), db, MailboxHealingConfig{}, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stats.Resumed != 0 || stats.Skipped != 1 || stats.Errors != 0 {
		t.Errorf("race-lost row should count as skipped, got %+v", stats)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestRunMailboxHealingOnce_UpdateError_ContinuesAndCounts(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now()
	mockSelectPaused(mock, sqlmock.NewRows([]string{
		"id", "status", "status_reason", "last_score", "last_score_at",
	}).
		AddRow(int64(1), "paused", "auto:x", 95.0, now).
		AddRow(int64(2), "paused", "auto:x", 95.0, now))
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE outreach_mailboxes`)).
		WithArgs(int64(1)).
		WillReturnError(errors.New("connection reset"))
	// Second mailbox still tried — partial failure must not abort.
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE outreach_mailboxes`)).
		WithArgs(int64(2)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(1, 1))

	stats, err := RunMailboxHealingOnce(context.Background(), db, MailboxHealingConfig{}, now)
	if err != nil {
		t.Fatalf("partial failure must not return terminal error: %v", err)
	}
	if stats.Errors != 1 || stats.Resumed != 1 {
		t.Errorf("expected errors=1 resumed=1, got %+v", stats)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestRunMailboxHealingOnce_MultipleEligible_AllResumed(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now()
	mockSelectPaused(mock, sqlmock.NewRows([]string{
		"id", "status", "status_reason", "last_score", "last_score_at",
	}).
		AddRow(int64(1), "paused", "auto:bounce_spike", 90.0, now).
		AddRow(int64(2), "paused", "auto:auth_fail", 85.0, now.Add(-1*time.Minute)).
		AddRow(int64(3), "paused", "auto:proxy_dead", 100.0, now))
	for _, id := range []int64{1, 2, 3} {
		mock.ExpectExec(regexp.QuoteMeta(`UPDATE outreach_mailboxes`)).
			WithArgs(id).
			WillReturnResult(sqlmock.NewResult(0, 1))
		mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
			WillReturnResult(sqlmock.NewResult(1, 1))
	}

	stats, err := RunMailboxHealingOnce(context.Background(), db, MailboxHealingConfig{}, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stats.Resumed != 3 || stats.Skipped != 0 || stats.Errors != 0 {
		t.Errorf("expected 3 resumed, got %+v", stats)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestRunMailboxHealingOnce_MixedEligibility(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now()
	mockSelectPaused(mock, sqlmock.NewRows([]string{
		"id", "status", "status_reason", "last_score", "last_score_at",
	}).
		AddRow(int64(1), "paused", "auto:bounce", 95.0, now).        // resume
		AddRow(int64(2), "paused", "auto:bounce", 40.0, now).        // skip: score
		AddRow(int64(3), "paused", "auto:bounce", 95.0, now.Add(-30*time.Minute))) // skip: stale
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE outreach_mailboxes`)).
		WithArgs(int64(1)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(1, 1))

	stats, err := RunMailboxHealingOnce(context.Background(), db, MailboxHealingConfig{}, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stats.Resumed != 1 || stats.Skipped != 2 {
		t.Errorf("expected 1 resumed, 2 skipped, got %+v", stats)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestRunMailboxHealingOnce_SelectError_TerminalReturn(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT id, status, status_reason`)).
		WillReturnError(errors.New("db dead"))

	_, err = RunMailboxHealingOnce(context.Background(), db, MailboxHealingConfig{}, time.Now())
	if err == nil {
		t.Fatal("expected terminal error from SELECT failure")
	}
}

func TestRunMailboxHealingOnce_NilDB_TerminalError(t *testing.T) {
	_, err := RunMailboxHealingOnce(context.Background(), nil, MailboxHealingConfig{}, time.Now())
	if err == nil {
		t.Fatal("expected error with nil DB")
	}
}
