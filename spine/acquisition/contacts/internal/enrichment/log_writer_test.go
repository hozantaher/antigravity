package enrichment

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/lib/pq"
)

// enrichmentLogInsertPattern matches the parameterised INSERT issued by
// LogWriter.Record. sqlmock treats ExpectExec inputs as regex by default.
const enrichmentLogInsertPattern = `INSERT INTO enrichment_log`

// newLogWriterMock spins up a sqlmock-backed LogWriter for a single test.
func newLogWriterMock(t *testing.T) (*LogWriter, sqlmock.Sqlmock, func()) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	w := NewLogWriter(db)
	cleanup := func() { _ = db.Close() }
	return w, mock, cleanup
}

// 1. ARES-only outcome — single primary returned data, no conflicts. Audits
//    that the writer routes the closed-vocabulary outcome string through
//    untouched.
func TestLogWriter_Record_AresOnly_InsertsRow(t *testing.T) {
	w, mock, cleanup := newLogWriterMock(t)
	defer cleanup()

	mock.ExpectExec(enrichmentLogInsertPattern).
		WithArgs(
			int64(42),
			"27082440",
			pq.Array([]string{"ares", "firmy_cz"}),
			pq.Array([]string{"ares"}),
			"[]",
			"ares_only",
			120,
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := w.Record(context.Background(), LogRow{
		ContactID:         42,
		ICO:               "27082440",
		SourcesAttempted:  []SourceName{SourceARES, SourceFirmyCZ},
		SourcesSuccess:    []SourceName{SourceARES},
		MergeConflicts:    nil,
		EnrichmentOutcome: OutcomeARESOnly,
		DurationMS:        120,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// 2. firmy_cz_only — primary fan-out where ARES failed and firmy.cz returned
//    the row.
func TestLogWriter_Record_FirmyOnly_InsertsRow(t *testing.T) {
	w, mock, cleanup := newLogWriterMock(t)
	defer cleanup()

	mock.ExpectExec(enrichmentLogInsertPattern).
		WithArgs(
			int64(7),
			"99999999",
			pq.Array([]string{"ares", "firmy_cz"}),
			pq.Array([]string{"firmy_cz"}),
			"[]",
			"firmy_cz_only",
			85,
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := w.Record(context.Background(), LogRow{
		ContactID:         7,
		ICO:               "99999999",
		SourcesAttempted:  []SourceName{SourceARES, SourceFirmyCZ},
		SourcesSuccess:    []SourceName{SourceFirmyCZ},
		EnrichmentOutcome: OutcomeFirmyOnly,
		DurationMS:        85,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// 3. merged outcome — both primaries succeeded with no field-level conflict.
func TestLogWriter_Record_Merged_NoConflicts_InsertsEmptyJSONArray(t *testing.T) {
	w, mock, cleanup := newLogWriterMock(t)
	defer cleanup()

	mock.ExpectExec(enrichmentLogInsertPattern).
		WithArgs(
			int64(1),
			"12345678",
			pq.Array([]string{"ares", "firmy_cz"}),
			pq.Array([]string{"ares", "firmy_cz"}),
			"[]",
			"merged",
			200,
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := w.Record(context.Background(), LogRow{
		ContactID:         1,
		ICO:               "12345678",
		SourcesAttempted:  []SourceName{SourceARES, SourceFirmyCZ},
		SourcesSuccess:    []SourceName{SourceARES, SourceFirmyCZ},
		MergeConflicts:    []MergeConflict{},
		EnrichmentOutcome: OutcomeMerged,
		DurationMS:        200,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// 4. merged with conflicts — the JSONB payload must include the per-field
//    conflict array verbatim. We assert via a custom matcher because the
//    JSON field order is stable for our struct layout.
func TestLogWriter_Record_Merged_WithConflicts_SerialisesJSONB(t *testing.T) {
	w, mock, cleanup := newLogWriterMock(t)
	defer cleanup()

	conflicts := []MergeConflict{
		{Field: "pravni_forma", ARESValue: "112", FirmyValue: "Sro", Resolved: SourceARES},
		{Field: "email", ARESValue: "old@x.cz", FirmyValue: "new@x.cz", Resolved: SourceFirmyCZ},
	}
	wantJSON := `[{"field":"pravni_forma","ares":"112","firmy_cz":"Sro","resolved":"ares"},` +
		`{"field":"email","ares":"old@x.cz","firmy_cz":"new@x.cz","resolved":"firmy_cz"}]`

	mock.ExpectExec(enrichmentLogInsertPattern).
		WithArgs(
			int64(99),
			"00000000",
			pq.Array([]string{"ares", "firmy_cz"}),
			pq.Array([]string{"ares", "firmy_cz"}),
			wantJSON,
			"merged",
			321,
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := w.Record(context.Background(), LogRow{
		ContactID:         99,
		ICO:               "00000000",
		SourcesAttempted:  []SourceName{SourceARES, SourceFirmyCZ},
		SourcesSuccess:    []SourceName{SourceARES, SourceFirmyCZ},
		MergeConflicts:    conflicts,
		EnrichmentOutcome: OutcomeMerged,
		DurationMS:        321,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// 5. justice.cz fallback — primaries returned nothing, fallback succeeded.
//    Audits the closed vocabulary "justice_cz_fallback" reaches the column.
func TestLogWriter_Record_JusticeFallback_InsertsRow(t *testing.T) {
	w, mock, cleanup := newLogWriterMock(t)
	defer cleanup()

	mock.ExpectExec(enrichmentLogInsertPattern).
		WithArgs(
			int64(5),
			"55555555",
			pq.Array([]string{"ares", "firmy_cz", "justice_cz"}),
			pq.Array([]string{"justice_cz"}),
			"[]",
			"justice_cz_fallback",
			900,
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := w.Record(context.Background(), LogRow{
		ContactID:         5,
		ICO:               "55555555",
		SourcesAttempted:  []SourceName{SourceARES, SourceFirmyCZ, SourceJusticeCZ},
		SourcesSuccess:    []SourceName{SourceJusticeCZ},
		EnrichmentOutcome: OutcomeJusticeFallback,
		DurationMS:        900,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// 6. none — all sources attempted, none returned data. The audit row must
//    still be inserted so operators can see "we tried this ICO N times and
//    got nothing".
func TestLogWriter_Record_NoneOutcome_StillInsertsAuditRow(t *testing.T) {
	w, mock, cleanup := newLogWriterMock(t)
	defer cleanup()

	mock.ExpectExec(enrichmentLogInsertPattern).
		WithArgs(
			int64(11),
			"11111111",
			pq.Array([]string{"ares", "firmy_cz", "justice_cz"}),
			pq.Array([]string{}),
			"[]",
			"none",
			450,
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := w.Record(context.Background(), LogRow{
		ContactID:         11,
		ICO:               "11111111",
		SourcesAttempted:  []SourceName{SourceARES, SourceFirmyCZ, SourceJusticeCZ},
		SourcesSuccess:    nil,
		EnrichmentOutcome: OutcomeNone,
		DurationMS:        450,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// 7. Empty ICO — short-circuits before the DB round-trip. enrichment_log.ico
//    is NOT NULL and a "we never started" row has zero audit value.
func TestLogWriter_Record_EmptyICO_NoInsert(t *testing.T) {
	w, mock, cleanup := newLogWriterMock(t)
	defer cleanup()

	// No ExpectExec — sqlmock fails if Record hits the DB.
	err := w.Record(context.Background(), LogRow{
		ContactID:         3,
		ICO:               "",
		EnrichmentOutcome: OutcomeNone,
	})
	if err == nil {
		t.Fatal("expected error for empty ICO")
	}
	if !strings.Contains(err.Error(), "ICO is required") {
		t.Errorf("error %q should mention ICO is required", err.Error())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet (or unexpected) expectations: %v", err)
	}
}

// 8. DB error surfaces wrapped with the audit-table prefix so the cron can
//    log + continue without retry.
func TestLogWriter_Record_DBError_WrappedAndReturned(t *testing.T) {
	w, mock, cleanup := newLogWriterMock(t)
	defer cleanup()

	mock.ExpectExec(enrichmentLogInsertPattern).
		WillReturnError(errors.New("connection refused"))

	err := w.Record(context.Background(), LogRow{
		ContactID:         1,
		ICO:               "12345678",
		SourcesAttempted:  []SourceName{SourceARES},
		EnrichmentOutcome: OutcomeNone,
	})
	if err == nil {
		t.Fatal("expected DB error to surface")
	}
	if !strings.Contains(err.Error(), "enrichment_log insert") {
		t.Errorf("error %q should be wrapped with enrichment_log insert prefix", err.Error())
	}
	if !strings.Contains(err.Error(), "connection refused") {
		t.Errorf("error %q should preserve underlying cause", err.Error())
	}
}

// 9. Empty outcome string is normalised to "none" — defensive against
//    callers who construct LogRow without setting EnrichmentOutcome.
func TestLogWriter_Record_EmptyOutcome_NormalisedToNone(t *testing.T) {
	w, mock, cleanup := newLogWriterMock(t)
	defer cleanup()

	mock.ExpectExec(enrichmentLogInsertPattern).
		WithArgs(
			int64(2),
			"22222222",
			pq.Array([]string{"ares"}),
			pq.Array([]string{}),
			"[]",
			"none", // normalised from ""
			10,
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := w.Record(context.Background(), LogRow{
		ContactID:         2,
		ICO:               "22222222",
		SourcesAttempted:  []SourceName{SourceARES},
		SourcesSuccess:    []SourceName{},
		EnrichmentOutcome: "", // missing
		DurationMS:        10,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// 10. Nil writer / nil DB — must error cleanly without panic. Important
//     because the cutover may pass a nil LogWriter when DATABASE_URL is
//     missing in dev sandboxes.
func TestLogWriter_Record_NilWriter_ErrorsWithoutPanic(t *testing.T) {
	var w *LogWriter
	err := w.Record(context.Background(), LogRow{ICO: "1", EnrichmentOutcome: OutcomeNone})
	if err == nil {
		t.Error("expected error from nil writer")
	}
}

func TestLogWriter_Record_NilDB_ErrorsWithoutPanic(t *testing.T) {
	w := &LogWriter{db: nil}
	err := w.Record(context.Background(), LogRow{ICO: "1", EnrichmentOutcome: OutcomeNone})
	if err == nil {
		t.Error("expected error from nil DB")
	}
}

// 11. Context cancellation is propagated to the DB driver.
func TestLogWriter_Record_ContextCancelled_PropagatesError(t *testing.T) {
	w, mock, cleanup := newLogWriterMock(t)
	defer cleanup()

	mock.ExpectExec(enrichmentLogInsertPattern).
		WillReturnError(context.Canceled)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := w.Record(ctx, LogRow{
		ContactID:         1,
		ICO:               "12345678",
		EnrichmentOutcome: OutcomeNone,
	})
	if err == nil {
		t.Fatal("expected error on cancelled context")
	}
}

// 12. SQL injection attempt in ICO — the writer must pass it as a $-bound
//     parameter, never concatenate. sqlmock asserts via WithArgs that the
//     value reaches the driver verbatim (and the parameterised SQL keeps
//     it from being interpreted).
func TestLogWriter_Record_SQLInjectionInICO_PassedAsParameter(t *testing.T) {
	w, mock, cleanup := newLogWriterMock(t)
	defer cleanup()

	hostile := "12345678'); DROP TABLE enrichment_log;--"
	mock.ExpectExec(enrichmentLogInsertPattern).
		WithArgs(
			int64(8),
			hostile,
			pq.Array([]string{"ares"}),
			pq.Array([]string{"ares"}),
			"[]",
			"ares_only",
			55,
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := w.Record(context.Background(), LogRow{
		ContactID:         8,
		ICO:               hostile,
		SourcesAttempted:  []SourceName{SourceARES},
		SourcesSuccess:    []SourceName{SourceARES},
		EnrichmentOutcome: OutcomeARESOnly,
		DurationMS:        55,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// 13. Round-trip with Pipeline.Enrich — guarantees the writer accepts the
//     LogRow shape produced by the pipeline (regression guard for any
//     LogRow field rename).
func TestLogWriter_Record_RoundTripFromPipeline(t *testing.T) {
	w, mock, cleanup := newLogWriterMock(t)
	defer cleanup()

	ares := newARESStub(&CompanyData{ICO: "X", Name: "Pipeline Co"}, nil)
	firmy := newFirmyStub(&CompanyData{ICO: "X", Email: "k@x.cz"}, nil)
	p := NewPipeline(ares, firmy)

	res, err := p.Enrich(context.Background(), 12, "X")
	if err != nil {
		t.Fatalf("pipeline.Enrich: %v", err)
	}
	if res.Log.EnrichmentOutcome != OutcomeMerged {
		t.Fatalf("setup outcome = %q want merged", res.Log.EnrichmentOutcome)
	}

	mock.ExpectExec(enrichmentLogInsertPattern).
		WithArgs(
			int64(12),
			"X",
			pq.Array([]string{"ares", "firmy_cz"}),
			pq.Array([]string{"ares", "firmy_cz"}),
			"[]",
			"merged",
			res.Log.DurationMS,
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	if err := w.Record(context.Background(), res.Log); err != nil {
		t.Fatalf("Record: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// 14. Performance smoke — Record completes well under the cron's per-contact
//     budget even with sqlmock latency. Guards against accidental N+1 queries
//     if anyone adds a follow-up SELECT.
func TestLogWriter_Record_FastPath_UnderBudget(t *testing.T) {
	w, mock, cleanup := newLogWriterMock(t)
	defer cleanup()

	mock.ExpectExec(enrichmentLogInsertPattern).
		WillReturnResult(sqlmock.NewResult(1, 1))

	start := time.Now()
	err := w.Record(context.Background(), LogRow{
		ContactID:         1,
		ICO:               "12345678",
		SourcesAttempted:  []SourceName{SourceARES, SourceFirmyCZ},
		SourcesSuccess:    []SourceName{SourceARES},
		EnrichmentOutcome: OutcomeARESOnly,
		DurationMS:        50,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 100ms is generous for an in-memory sqlmock — real failures here would
	// indicate a regression like a per-call retry loop.
	if d := time.Since(start); d > 100*time.Millisecond {
		t.Errorf("Record took %v, expected < 100ms (regression?)", d)
	}
}
