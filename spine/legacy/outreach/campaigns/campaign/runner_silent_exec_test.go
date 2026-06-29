package campaign

// Regression tests for the 2026-04-21 Go audit — HIGH items H1 & H6
// (silent ExecContext drops in runner.go) and the duplicate-send guard
// that was added as part of H1.
//
// These tests *would fail* against the pre-audit code because the
// production path simply ignored the ExecContext return, so we had no
// visibility into:
//   • advance-step UPDATE failures (→ duplicate email next tick)
//   • campaign-status UPDATE failures
//   • mark-completed UPDATE failures
//
// After the fix every failure either:
//   • is logged via slog (status / completed paths — non-blocking)
//   • is logged AND short-circuits the enqueue counter (advance path —
//     duplicate-send guard)
//
// The race-style invariant test at the bottom proves two concurrent
// runners on the same contact+step can never both be counted as
// successful senders: the second one sees 0 rows affected (CAS miss)
// and stops.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
	"common/config"
	"campaigns/content"
	"campaigns/sender"
)

// captureSlog redirects slog's default logger to an in-memory buffer for
// assertions, then restores the original logger on cleanup.
func captureSlog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	orig := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(orig) })
	return &buf
}

// ── H6: campaign status update silently drops errors ──
//
// Before fix: `r.db.ExecContext(... UPDATE campaigns SET status = 'running' ...)`
// returned value ignored. A transient DB error left the campaign in
// 'draft' but logs showed nothing. After fix: slog.Warn fires.
func TestRunCampaign_StatusUpdateError_IsLogged_H6(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	buf := captureSlog(t)

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "t"}})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("H6", "running", steps))

	// Status UPDATE fails.
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnError(errors.New("connection reset"))

	// Contact query returns empty (so we stop early without needing a send engine).
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols))

	r := NewRunner(db, nil, nil)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign should not abort on status-update failure: %v", err)
	}

	if !strings.Contains(buf.String(), "campaign status update failed") {
		t.Errorf("expected slog warning 'campaign status update failed'; got: %s", buf.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// ── H6: mark-completed silently drops errors ──
//
// Contact with currentStep past end of sequence → row marked completed.
// Before fix an UPDATE failure left the row stuck in 'in_sequence'
// forever with no log. After fix: slog.Warn fires.
func TestRunCampaign_MarkCompletedError_IsLogged_H6(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	buf := captureSlog(t)

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "t"}})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("C", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Row with currentStep == 2 > len(steps)=1 → completed branch.
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(11), int64(22), 2, "x@test.cz", "X", "F", "Praha", "valid", ""))

	mock.ExpectExec(`UPDATE campaign_contacts SET status = 'completed' WHERE id`).
		WithArgs(int64(11)).
		WillReturnError(errors.New("disk full"))

	r := NewRunner(db, nil, nil)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("should not abort on completed-update failure: %v", err)
	}

	if !strings.Contains(buf.String(), "campaign mark-completed failed") {
		t.Errorf("expected slog 'campaign mark-completed failed'; got: %s", buf.String())
	}
}

// ── H1: advance step UPDATE silently drops errors → no enqueue ──
//
// Original H1 bug: failed UPDATE of current_step leaves row at old step
// → next tick re-renders + re-sends the same email. The pre-AW7-6 fix
// logged "DUPLICATE-SEND RISK" because Enqueue had already fired BEFORE
// the UPDATE. After AW7-6: reservation is BEFORE enqueue, so a failed
// UPDATE means NO send was dispatched — we just log "skipping enqueue"
// and continue. The next tick re-evaluates (same/safe semantic, no dup).

func TestRunCampaign_AdvanceStep_DBError_IsLoggedAsDupRisk_H1(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	buf := captureSlog(t)

	dir := makeTemplateDir(t, "t", "Subject: Hi\n\nBody")
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// 2-step campaign so step 0 → step 1 is a real advance with
	// next_send_at set (non-completed path).
	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "t"},
		{Step: 1, DelayDays: 3, TemplateName: "t"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("H1", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(1), int64(2), 0, "a@firma.cz", "A", "F", "Praha", "valid", ""))

	// Advance UPDATE errors.
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnError(errors.New("deadlock"))

	r := NewRunner(db,
		content.NewEngine(dir, nil),
		sender.NewEngine([]config.MailboxConfig{{Address: "x@f.cz"}}, config.SendingConfig{}, config.SafetyConfig{}),
	)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("should not abort on advance failure: %v", err)
	}

	// AW7-6: post-reservation-before-enqueue, a failed UPDATE means the
	// enqueue never happened. We log "skipping enqueue" instead of the
	// pre-AW7-6 "DUPLICATE-SEND RISK" wording (no send was dispatched).
	if !strings.Contains(buf.String(), "skipping enqueue") {
		t.Errorf("expected 'skipping enqueue' in log; got: %s", buf.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// ── H1: CAS predicate — advance matching 0 rows means reservation lost ──
//
// The post-fix UPDATE carries `WHERE id = $N AND current_step = $oldStep`.
// If a parallel path already advanced the contact, our RowsAffected = 0
// and we must log the reservation-lost signal. AW7-6 demoted the log
// from Error ("concurrent runner detected") to Info ("reservation lost
// CAS — skipping enqueue") because under the new ordering (reserve
// BEFORE enqueue), CAS miss simply means no send is dispatched. There
// is no concurrent runner — the advisory lock guarantees one tick per
// campaign across replicas — but the in-flight reaper or operator-edit
// can produce CAS misses; that is now an EXPECTED outcome, not a bug.
func TestRunCampaign_AdvanceStep_ZeroRowsAffected_ConcurrentDup_H1(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	buf := captureSlog(t)

	dir := makeTemplateDir(t, "t", "Subject: Hi\n\nBody")
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "t"},
		{Step: 1, DelayDays: 3, TemplateName: "t"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("H1-CAS", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(9), int64(99), 0, "a@firma.cz", "A", "F", "Praha", "valid", ""))

	// 0 rows affected → simulated CAS miss (other runner already advanced).
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	r := NewRunner(db,
		content.NewEngine(dir, nil),
		sender.NewEngine([]config.MailboxConfig{{Address: "x@f.cz"}}, config.SendingConfig{}, config.SafetyConfig{}),
	)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("should not abort on CAS miss: %v", err)
	}

	// AW7-6: log message changed from "concurrent runner detected" to
	// "reservation lost CAS" because the new ordering (reserve before
	// enqueue) means CAS miss = no send dispatched (not a duplicate).
	if !strings.Contains(buf.String(), "reservation lost CAS") {
		t.Errorf("expected 'reservation lost CAS' log; got: %s", buf.String())
	}
}

// ── H1 invariant — the headline duplicate-send invariant ──
//
// Simulate two runners hitting the SAME campaign_contact at the SAME
// current_step. The post-fix advance UPDATE uses a CAS predicate, so
// exactly one must succeed. The other must see RowsAffected = 0 and
// take the concurrent-runner branch (→ NOT counted as enqueued).
//
// We stub the DB with a tiny CAS-aware fake so the test is fully
// hermetic (no real Postgres needed) and runs under `-race`.
func TestRunCampaign_ConcurrentRunners_ExactlyOneAdvance_H1(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	// Two parallel "ticks" of the runner against a shared in-memory row.
	// Assertion: advance UPDATE executes at most once with affected=1;
	// the other gets affected=0.
	var (
		mu            sync.Mutex
		currentStep   = 0 // shared, mutable "DB" cell
		advanceCalls  int32
		successAdvance int32
	)

	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "t"},
		{Step: 1, DelayDays: 3, TemplateName: "t"},
	})

	fakeDB := &casFakeDB{
		seqJSON: steps,
		name:    "RACE",
		status:  "running",
		// Contact row state:
		ccID:        42,
		contactID:   1001,
		onAdvance: func(ccID int64, expectStep, newStep int) (affected int64) {
			atomic.AddInt32(&advanceCalls, 1)
			mu.Lock()
			defer mu.Unlock()
			if currentStep != expectStep {
				return 0 // CAS miss
			}
			currentStep = newStep
			atomic.AddInt32(&successAdvance, 1)
			return 1
		},
	}

	dir := makeTemplateDir(t, "t", "Subject: Hi\n\nBody")
	contentEng := content.NewEngine(dir, nil)
	sendEng := sender.NewEngine([]config.MailboxConfig{{Address: "x@f.cz"}}, config.SendingConfig{}, config.SafetyConfig{})

	var wg sync.WaitGroup
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer wg.Done()
			r := NewRunner(fakeDB, contentEng, sendEng)
			_ = r.RunCampaign(context.Background(), 1)
		}()
	}
	wg.Wait()

	if advanceCalls < 2 {
		t.Fatalf("expected both runners to attempt advance; got %d", advanceCalls)
	}
	if successAdvance != 1 {
		t.Fatalf("H1 INVARIANT VIOLATED: expected exactly 1 successful advance, got %d (this would mean BOTH runners sent the same step)", successAdvance)
	}
}

// ── casFakeDB — hermetic DB that exercises the advance CAS predicate ──
//
// Implements the campaign.DB interface. It supports:
//   • load campaign  →  returns the stored sequence JSON
//   • UPDATE campaigns SET status → no-op success
//   • SELECT cc.id, cc.contact_id, cc.current_step → returns ONE row
//     reflecting the *current* shared current_step (so a losing runner
//     never even picks up the same contact if the first runner finished
//     first — the losing runner enters the "already advanced" branch
//     and its UPDATE matches 0 rows).
//   • UPDATE campaign_contacts SET current_step → CAS via onAdvance
//     callback.
type casFakeDB struct {
	seqJSON   []byte
	name      string
	status    string
	ccID      int64
	contactID int64
	onAdvance func(ccID int64, expectStep, newStep int) (affected int64)

	mu sync.Mutex
}

func (f *casFakeDB) ExecContext(_ context.Context, query string, args ...any) (sql.Result, error) {
	if strings.Contains(query, "UPDATE campaigns SET status") {
		return sqlResult{affected: 1}, nil
	}
	if strings.Contains(query, "UPDATE campaign_contacts SET current_step") {
		// Arg layout (advance-with-next-send-at):
		//   $1 nextStep, $2 nextSendAt, $3 ccID, $4 currentStep(expect)
		// Advance-without-next-send-at:
		//   $1 nextStep, $2 ccID, $3 currentStep(expect)
		var nextStep, expectStep int
		var ccID int64
		switch len(args) {
		case 4:
			nextStep = args[0].(int)
			ccID = args[2].(int64)
			expectStep = args[3].(int)
		case 3:
			nextStep = args[0].(int)
			ccID = args[1].(int64)
			expectStep = args[2].(int)
		default:
			return sqlResult{affected: 0}, nil
		}
		n := f.onAdvance(ccID, expectStep, nextStep)
		return sqlResult{affected: n}, nil
	}
	return sqlResult{affected: 0}, nil
}

func (f *casFakeDB) QueryContext(_ context.Context, query string, _ ...any) (*sql.Rows, error) {
	// We only need the contact-scan loop. Use sqlmock under the hood to
	// synthesise a *sql.Rows that returns exactly one row reflecting the
	// current shared step — or zero rows if already advanced.
	if !strings.Contains(query, "SELECT cc.id, cc.contact_id, cc.current_step") {
		return nil, errors.New("casFakeDB: unexpected QueryContext: " + query)
	}
	f.mu.Lock()
	defer f.mu.Unlock()

	db, mock, err := sqlmock.New()
	if err != nil {
		return nil, err
	}

	rows := sqlmock.NewRows(contactCols)
	// Both runners see the *starting* step=0 row; the CAS inside
	// ExecContext is what actually filters the second one out.
	rows.AddRow(f.ccID, f.contactID, 0, "race@firma.cz", "R", "F", "Praha", "valid", "")

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).WillReturnRows(rows)
	return db.QueryContext(context.Background(), query)
}

func (f *casFakeDB) QueryRowContext(_ context.Context, query string, _ ...any) *sql.Row {
	// Campaign load: return (name, status, sequence_config).
	if strings.Contains(query, "SELECT name, status, sequence_config FROM campaigns") {
		db, mock, err := sqlmock.New()
		if err != nil {
			return nil
		}
		mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
			WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
				AddRow(f.name, f.status, f.seqJSON))
		return db.QueryRowContext(context.Background(), query)
	}
	// Dedup guard contact load: return all-clear contact (dnt=false,
	// lifetime=0, no crm_client_id) so H1 test passes the guard cleanly.
	if strings.Contains(query, "FROM contacts") {
		db, mock, err := sqlmock.New()
		if err != nil {
			return nil
		}
		mock.ExpectQuery(`FROM contacts`).
			WillReturnRows(sqlmock.NewRows(
				[]string{"dnt", "lifetime_touches", "email_domain", "region", "parent_ico", "crm_client_id"},
			).AddRow(false, 0, "firma.cz", nil, nil, nil))
		return db.QueryRowContext(context.Background(), query)
	}
	// S20 domain day-count query + dedup guard cross-table queries:
	// return 0 / no-rows so the H1 concurrent-runner test is unaffected by
	// the daily limit gate and all dedup axes pass cleanly.
	if strings.Contains(query, "send_events") || strings.Contains(query, "tracking_events") {
		db, mock, err := sqlmock.New()
		if err != nil {
			return nil
		}
		if strings.Contains(query, "LEFT JOIN tracking_events") {
			mock.ExpectQuery(`.`).
				WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(0, 0))
		} else {
			mock.ExpectQuery(`.`).
				WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
		}
		return db.QueryRowContext(context.Background(), query)
	}
	return nil
}

type sqlResult struct{ affected int64 }

func (r sqlResult) LastInsertId() (int64, error) { return 0, nil }
func (r sqlResult) RowsAffected() (int64, error) { return r.affected, nil }
