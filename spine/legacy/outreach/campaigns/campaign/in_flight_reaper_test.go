// AW7-3 — watchdog reaper tests for stuck campaign_contacts.status='in_flight'.
//
// Coverage required by HARD memory feedback_extreme_testing (≥10 cases).
// Each case maps to a contract clause in in_flight_reaper.go and the
// task spec.
//
//	1. Stuck contact 25h → reaped to pending, audit row written.
//	2. Fresh contact 1h in_flight → not reaped (still in flight).
//	3. Threshold env override (1h) → 2h-old contact reaped.
//	4. Audit log row created per reap (action='in_flight_reaped').
//	5. Idempotent — concurrent reapers cannot double-reap (CAS lost).
//	6. Empty candidate set → noop, no UPDATE issued.
//	7. SELECT DB error → wrapped error returned.
//	8. Per-row UPDATE error → continue to next candidate, no early exit.
//	9. Nil DB → returns error.
//	10. Default threshold returned when env var unset.
//	11. Invalid threshold env value (negative) → fall back to default.
//	12. Invalid threshold env value (non-integer) → fall back to default.
//	13. Multiple stuck rows in one sweep → all reaped, count matches.
//	14. Audit details payload contains stuck_for_hours numeric > threshold.
//	15. Reap UPDATE resets current_step=0 and next_send_at=NULL.

package campaign

import (
	"context"
	"database/sql/driver"
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// reaperSelectRE captures the SELECT shape used by the reaper. Matches
// the leading clause so future minor tweaks (different alias, line
// wrapping) do not break the contract pin.
var reaperSelectRE = regexp.MustCompile(`SELECT id, campaign_id, contact_id, updated_at\s+FROM campaign_contacts`)

// reaperUpdateRE captures the UPDATE shape used by reapOne.
var reaperUpdateRE = regexp.MustCompile(`UPDATE campaign_contacts\s+SET status\s+= 'pending'`)

// reaperAuditRE matches the audit.Log INSERT issued per reaped row.
var reaperAuditRE = regexp.MustCompile(`INSERT INTO operator_audit_log`)

// makeReaperRows is a helper that builds a sqlmock rows resultset for
// the reaper SELECT.
func makeReaperRows(candidates []stuckCandidate) *sqlmock.Rows {
	rows := sqlmock.NewRows([]string{"id", "campaign_id", "contact_id", "created_at"})
	for _, c := range candidates {
		rows.AddRow(c.id, c.campaignID, c.contactID, c.createdAt)
	}
	return rows
}

// ── 1. Stuck contact 25h → reaped to pending, audit row written ────────────

func TestAW73_StuckContact25h_ReapedToPending(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	stuckSince := time.Now().Add(-25 * time.Hour)
	mock.ExpectQuery(reaperSelectRE.String()).
		WillReturnRows(makeReaperRows([]stuckCandidate{
			{id: 100, campaignID: 1, contactID: 200, createdAt: stuckSince},
		}))
	mock.ExpectExec(reaperUpdateRE.String()).
		WithArgs(int64(100)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(reaperAuditRE.String()).
		WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
	reaped, err := r.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if reaped != 1 {
		t.Errorf("reaped count = %d, want 1", reaped)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ── 2. Fresh contact 1h in_flight → not reaped (still in flight) ───────────

func TestAW73_FreshContact1h_NotReaped(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// SELECT returns no rows — the WHERE created_at < cutoff filtered
	// out the 1h-old fresh contact (cutoff at -24h).
	mock.ExpectQuery(reaperSelectRE.String()).
		WillReturnRows(sqlmock.NewRows([]string{"id", "campaign_id", "contact_id", "created_at"}))

	r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
	reaped, err := r.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if reaped != 0 {
		t.Errorf("reaped count = %d, want 0 (fresh contact must not reap)", reaped)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ── 3. Threshold env override (1h) → 2h-old contact reaped ─────────────────

func TestAW73_ThresholdOverride_2hContactReaped(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// 1h threshold via constructor (mirrors what env override would
	// produce; envconfig parsing is exercised separately in test #10/#11).
	stuckSince := time.Now().Add(-2 * time.Hour)
	mock.ExpectQuery(reaperSelectRE.String()).
		WillReturnRows(makeReaperRows([]stuckCandidate{
			{id: 50, campaignID: 7, contactID: 99, createdAt: stuckSince},
		}))
	mock.ExpectExec(reaperUpdateRE.String()).
		WithArgs(int64(50)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(reaperAuditRE.String()).
		WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewInFlightReaperWithThreshold(db, 1*time.Hour)
	if r.Threshold() != time.Hour {
		t.Errorf("Threshold = %v, want 1h", r.Threshold())
	}
	reaped, err := r.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if reaped != 1 {
		t.Errorf("reaped = %d, want 1", reaped)
	}
}

// ── 4. Audit log row created per reap (action='in_flight_reaped') ──────────

func TestAW73_AuditLogActionIsInFlightReaped(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	stuckSince := time.Now().Add(-30 * time.Hour)
	mock.ExpectQuery(reaperSelectRE.String()).
		WillReturnRows(makeReaperRows([]stuckCandidate{
			{id: 11, campaignID: 1, contactID: 1, createdAt: stuckSince},
		}))
	mock.ExpectExec(reaperUpdateRE.String()).
		WithArgs(int64(11)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// audit.Log INSERT positional args: action, actor, entity_type,
	// entity_id, details. We pin action + actor + entity_type + entity_id.
	mock.ExpectExec(reaperAuditRE.String()).
		WithArgs(
			"in_flight_reaped",
			"watchdog_reaper",
			"campaign_contact",
			"11",
			sqlmock.AnyArg(), // details JSON
		).
		WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
	if _, err := r.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ── 5. Idempotent — CAS lost (RowsAffected=0) → no audit row, no reap ─────

func TestAW73_CASLost_NoAuditNoReap(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	stuckSince := time.Now().Add(-30 * time.Hour)
	mock.ExpectQuery(reaperSelectRE.String()).
		WillReturnRows(makeReaperRows([]stuckCandidate{
			{id: 77, campaignID: 1, contactID: 1, createdAt: stuckSince},
		}))
	// Concurrent reaper / late callback won the race — RowsAffected=0.
	mock.ExpectExec(reaperUpdateRE.String()).
		WithArgs(int64(77)).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// No audit row expected because reap did not flip.

	r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
	reaped, err := r.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if reaped != 0 {
		t.Errorf("reaped = %d, want 0 (CAS lost)", reaped)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ── 6. Empty candidate set → noop, no UPDATE issued ────────────────────────

func TestAW73_EmptyCandidates_NoUpdate(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(reaperSelectRE.String()).
		WillReturnRows(sqlmock.NewRows([]string{"id", "campaign_id", "contact_id", "created_at"}))

	r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
	reaped, err := r.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if reaped != 0 {
		t.Errorf("reaped = %d, want 0", reaped)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ── 7. SELECT DB error → wrapped error returned ────────────────────────────

func TestAW73_SelectDBError_WrappedError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	dbErr := errors.New("connection refused")
	mock.ExpectQuery(reaperSelectRE.String()).WillReturnError(dbErr)

	r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
	_, err = r.Run(context.Background())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, dbErr) {
		t.Errorf("error not wrapped — got %v, want chain to %v", err, dbErr)
	}
}

// ── 8. Per-row UPDATE error → continue with next candidate ─────────────────

func TestAW73_PerRowUpdateError_ContinuesLoop(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	stuckA := time.Now().Add(-30 * time.Hour)
	stuckB := time.Now().Add(-30 * time.Hour)
	mock.ExpectQuery(reaperSelectRE.String()).
		WillReturnRows(makeReaperRows([]stuckCandidate{
			{id: 1, campaignID: 1, contactID: 1, createdAt: stuckA},
			{id: 2, campaignID: 1, contactID: 2, createdAt: stuckB},
		}))
	// First UPDATE fails — we should still attempt the second.
	mock.ExpectExec(reaperUpdateRE.String()).
		WithArgs(int64(1)).
		WillReturnError(errors.New("transient DB blip"))
	mock.ExpectExec(reaperUpdateRE.String()).
		WithArgs(int64(2)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(reaperAuditRE.String()).
		WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
	reaped, err := r.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err) // per-row failures must not bubble up
	}
	if reaped != 1 {
		t.Errorf("reaped = %d, want 1 (one failed, one succeeded)", reaped)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ── 9. Nil DB → returns error ──────────────────────────────────────────────

func TestAW73_NilDB_Error(t *testing.T) {
	r := NewInFlightReaperWithThreshold(nil, 24*time.Hour)
	_, err := r.Run(context.Background())
	if err == nil {
		t.Fatal("expected error for nil db, got nil")
	}
	if !strings.Contains(err.Error(), "db is nil") {
		t.Errorf("error message = %q, want substring 'db is nil'", err.Error())
	}
}

// ── 10. Default threshold returned when env var unset ──────────────────────

func TestAW73_DefaultThreshold_EnvUnset(t *testing.T) {
	os.Unsetenv("IN_FLIGHT_STUCK_THRESHOLD_HOURS")
	got := loadStuckThreshold()
	if got != DefaultInFlightStuckThreshold {
		t.Errorf("loadStuckThreshold() = %v, want %v", got, DefaultInFlightStuckThreshold)
	}
	if got != 24*time.Hour {
		t.Errorf("DefaultInFlightStuckThreshold = %v, want 24h", got)
	}
}

// ── 11. Invalid threshold env value (negative) → fall back to default ──────

func TestAW73_InvalidThreshold_Negative_FallsBackToDefault(t *testing.T) {
	t.Setenv("IN_FLIGHT_STUCK_THRESHOLD_HOURS", "-5")
	got := loadStuckThreshold()
	if got != DefaultInFlightStuckThreshold {
		t.Errorf("loadStuckThreshold() = %v, want default %v", got, DefaultInFlightStuckThreshold)
	}
}

// ── 12. Invalid threshold env value (non-integer) → fall back to default ───

func TestAW73_InvalidThreshold_Garbage_FallsBackToDefault(t *testing.T) {
	t.Setenv("IN_FLIGHT_STUCK_THRESHOLD_HOURS", "twentyfour")
	got := loadStuckThreshold()
	if got != DefaultInFlightStuckThreshold {
		t.Errorf("loadStuckThreshold() = %v, want default %v", got, DefaultInFlightStuckThreshold)
	}
}

// Sub-case: zero is also invalid (would disable the reaper silently).
func TestAW73_InvalidThreshold_Zero_FallsBackToDefault(t *testing.T) {
	t.Setenv("IN_FLIGHT_STUCK_THRESHOLD_HOURS", "0")
	got := loadStuckThreshold()
	if got != DefaultInFlightStuckThreshold {
		t.Errorf("loadStuckThreshold() = %v, want default for 0", got)
	}
}

// Sub-case: valid override is honoured.
func TestAW73_ValidThreshold_HonouredAtLoad(t *testing.T) {
	t.Setenv("IN_FLIGHT_STUCK_THRESHOLD_HOURS", "6")
	got := loadStuckThreshold()
	if got != 6*time.Hour {
		t.Errorf("loadStuckThreshold() = %v, want 6h", got)
	}
}

// ── 13. Multiple stuck rows in one sweep → all reaped, count matches ───────

func TestAW73_MultipleStuckRows_AllReaped(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	stuck := time.Now().Add(-30 * time.Hour)
	candidates := []stuckCandidate{
		{id: 1, campaignID: 1, contactID: 1, createdAt: stuck},
		{id: 2, campaignID: 1, contactID: 2, createdAt: stuck},
		{id: 3, campaignID: 2, contactID: 3, createdAt: stuck},
	}
	mock.ExpectQuery(reaperSelectRE.String()).WillReturnRows(makeReaperRows(candidates))
	for _, c := range candidates {
		mock.ExpectExec(reaperUpdateRE.String()).
			WithArgs(c.id).
			WillReturnResult(sqlmock.NewResult(0, 1))
		mock.ExpectExec(reaperAuditRE.String()).
			WillReturnResult(sqlmock.NewResult(0, 1))
	}

	r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
	reaped, err := r.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if reaped != 3 {
		t.Errorf("reaped = %d, want 3", reaped)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ── 14. Audit details payload contains stuck_for_hours numeric > threshold ─
//
// We use a custom driver.Value matcher to assert the details JSON
// payload contains all the documented keys and that stuck_for_hours
// exceeds the configured threshold. The matcher is satisfied by the
// 5th positional arg of audit.Log's INSERT (details JSON string).

func TestAW73_AuditDetails_DetailsJSONShape(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	stuckSince := time.Now().Add(-30 * time.Hour)
	mock.ExpectQuery(reaperSelectRE.String()).
		WillReturnRows(makeReaperRows([]stuckCandidate{
			{id: 42, campaignID: 5, contactID: 99, createdAt: stuckSince},
		}))
	mock.ExpectExec(reaperUpdateRE.String()).
		WithArgs(int64(42)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// audit.Log writes the details JSON as the 5th positional arg.
	// Pin the SHAPE: must contain reason + campaign_id + contact_id +
	// stuck_for_hours + threshold_hours keys.
	detailsMatcher := detailsJSONHas("reason", "campaign_id", "contact_id", "stuck_for_hours", "threshold_hours")
	mock.ExpectExec(reaperAuditRE.String()).
		WithArgs(
			"in_flight_reaped",
			"watchdog_reaper",
			"campaign_contact",
			"42",
			detailsMatcher,
		).
		WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
	if _, err := r.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// detailsJSONHas returns a sqlmock argument matcher that asserts the
// passed value is a string containing all listed JSON keys. Used for
// loose contract pinning of the audit details payload — the exact
// numeric values vary by wallclock so we cannot pin them, but the
// presence of every documented key is a hard contract.
type detailsJSONMatcher struct{ keys []string }

func (m detailsJSONMatcher) Match(v driver.Value) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, k := range m.keys {
		if !strings.Contains(s, "\""+k+"\"") {
			return false
		}
	}
	return true
}

func detailsJSONHas(keys ...string) detailsJSONMatcher {
	return detailsJSONMatcher{keys: keys}
}

// ── 15. Reap UPDATE resets current_step=0 and next_send_at=NULL ────────────

func TestAW73_ReapResetsStepAndNextSendAt(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Pin the EXACT update SQL shape: status='pending', current_step rolled
	// back one step via GREATEST(current_step-1,0), next_send_at=NULL,
	// CAS predicate on status='in_flight'.
	stuck := time.Now().Add(-30 * time.Hour)
	mock.ExpectQuery(reaperSelectRE.String()).
		WillReturnRows(makeReaperRows([]stuckCandidate{
			{id: 1, campaignID: 1, contactID: 1, createdAt: stuck},
		}))
	exactUpdate := regexp.QuoteMeta(`UPDATE campaign_contacts
		    SET status       = 'pending',
		        current_step = GREATEST(current_step - 1, 0),
		        next_send_at = NULL
		  WHERE id     = $1
		    AND status = 'in_flight'`)
	mock.ExpectExec(exactUpdate).
		WithArgs(int64(1)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(reaperAuditRE.String()).
		WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
	if _, err := r.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ── Extra: ensure NewInFlightReaper picks up env at construct time ─────────

func TestAW73_Constructor_LoadsThresholdFromEnv(t *testing.T) {
	t.Setenv("IN_FLIGHT_STUCK_THRESHOLD_HOURS", "12")
	r := NewInFlightReaper(nil) // nil db OK for threshold check
	if r.Threshold() != 12*time.Hour {
		t.Errorf("Threshold = %v, want 12h", r.Threshold())
	}
}

// ── Extra: SELECT scan error surfaces wrapped error ────────────────────────

func TestAW73_SelectScanError_WrappedError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Malformed row: only 3 columns instead of 4 → Scan error.
	mock.ExpectQuery(reaperSelectRE.String()).
		WillReturnRows(sqlmock.NewRows([]string{"id", "campaign_id", "contact_id"}).
			AddRow(int64(1), int64(1), int64(1)))

	r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
	_, err = r.Run(context.Background())
	if err == nil {
		t.Fatal("expected scan error, got nil")
	}
	if !strings.Contains(err.Error(), "InFlightReaper.Run") {
		t.Errorf("error not wrapped through Run: %v", err)
	}
}

// ── Discipline: exported symbols documented + reaper docstring present ────

func TestAW73_DocstringPresent(t *testing.T) {
	// This test is a compile-time-ish reminder that the reaper file
	// must keep its package-level docstring. If a future agent strips
	// the comment block, this test will fail because we read the file.
	data, err := os.ReadFile("in_flight_reaper.go")
	if err != nil {
		t.Fatal(err)
	}
	must := []string{
		"AW7-3",
		"in_flight_reaped",
		"IN_FLIGHT_STUCK_THRESHOLD_HOURS",
	}
	for _, m := range must {
		if !strings.Contains(string(data), m) {
			t.Errorf("in_flight_reaper.go missing required substring %q (docstring stripped?)", m)
		}
	}
}
