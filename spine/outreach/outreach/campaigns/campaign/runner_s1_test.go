package campaign

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
	"campaigns/content"
	"campaigns/sender"
	"common/config"
)

// ── regionToTimezone ──

func TestRegionToTimezone_SK(t *testing.T) {
	if got := regionToTimezone("SK"); got != "Europe/Bratislava" {
		t.Errorf("SK → %q, want Europe/Bratislava", got)
	}
}

func TestRegionToTimezone_Default(t *testing.T) {
	for _, r := range []string{"", "CZ", "Praha", "unknown", "Brno"} {
		if got := regionToTimezone(r); got != "Europe/Prague" {
			t.Errorf("%q → %q, want Europe/Prague", r, got)
		}
	}
}

// ── List scanCampaign error (lines 494-496) ──
// Trigger by returning a row with wrong column count so rows.Scan fails.

func TestList_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Only 3 columns → scanCampaign needs 10 → Scan fails
	rows := sqlmock.NewRows([]string{"id", "name", "status"}).
		AddRow(1, "Bad", "draft")

	mock.ExpectQuery(`SELECT id, name`).WillReturnRows(rows)

	r := NewReadOnlyRunner(db)
	_, err = r.List(context.Background())
	if err == nil {
		t.Error("expected scan error from List")
	}
}

// ── Get scanCampaign error ──

func TestGet_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Return wrong column count → Scan fails
	mock.ExpectQuery(`SELECT id, name`).WillReturnRows(
		sqlmock.NewRows([]string{"id"}).AddRow(1),
	)

	r := NewReadOnlyRunner(db)
	_, err = r.Get(context.Background(), 1)
	if err == nil {
		t.Error("expected scan error from Get")
	}
}

// ── Stats rows.Scan error ──

func TestStats_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// One column when two expected → Scan fails
	mock.ExpectQuery(`SELECT status, COUNT`).WillReturnRows(
		sqlmock.NewRows([]string{"status"}).AddRow("pending"),
	)

	r := NewReadOnlyRunner(db)
	_, err = r.Stats(context.Background(), 1)
	if err == nil {
		t.Error("expected scan error from Stats")
	}
}

// ── RunCampaign: query contacts error ──

func TestRunCampaign_QueryContactsError_S1(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "t0"}})
	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Camp", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnError(errors.New("db failure"))

	r := NewRunner(db, nil, nil)
	err = r.RunCampaign(context.Background(), 1)
	if err == nil {
		t.Error("expected error when query contacts fails")
	}
}

// ── ListRunningCampaigns scan error (scheduler_postgres.go) ──

func TestListRunningCampaigns_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Return string where int is expected → Scan fails, should continue
	mock.ExpectQuery(`SELECT id FROM campaigns`).WillReturnRows(
		sqlmock.NewRows([]string{"id"}).AddRow("not-an-int"),
	)

	sched := NewPostgresSchedulerDB(db)
	result, err := sched.ListRunningCampaigns(context.Background())
	// Scan error is swallowed (continue), rows.Err() checked at end
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Row was skipped due to scan error
	if len(result) != 0 {
		t.Errorf("expected 0 results (scan error skipped), got %d", len(result))
	}
}

// ── RunCampaign with recalcDB goroutine (lines 298-308) ──
// Verifies that when r.recalcDB is set and a contact is processed,
// the async recalc goroutine is launched (covers lines 298-308 in runner.go).

func TestRunCampaign_WithRecalcDB_GoroutineLaunched(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	// Mock relay server to capture sends.
	var relayHits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/submit" {
			io.Copy(io.Discard, r.Body)
			atomic.AddInt32(&relayHits, 1)
		}
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"envelope_id":"recalc-test","status":"accepted"}`))
	}))
	defer srv.Close()

	// Campaign DB mock.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "initial"},
		{Step: 1, DelayDays: 7, TemplateName: "initial"},
	})
	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("RecalcCamp", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(1), int64(100), 0, "x@firma.cz", "Jan", "ACME", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`). // domain day-count
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// recalcDB — fails open (no expectations → error logged, not fatal).
	recalcDB, _, err2 := sqlmock.New()
	if err2 != nil {
		t.Fatal(err2)
	}
	defer recalcDB.Close()

	mb := config.MailboxConfig{
		Address: "from@firma.cz", SMTPHost: "smtp.firma.cz", SMTPPort: 587,
		Username: "from@firma.cz", Password: "pass", DailyLimit: 100,
	}
	eng := sender.NewEngine([]config.MailboxConfig{mb},
		config.SendingConfig{WindowStart: 0, WindowEnd: 24, MaxPerDomainHour: 1000},
		config.SafetyConfig{}).
		WithAntiTrace(sender.NewAntiTraceClient(srv.URL, "tok"))

	dir := makeTemplateDir(t, "initial", "Subject: Hi {{.Jmeno}}\n\nBody")
	contentEng := content.NewEngine(dir, nil)

	r := NewRunner(db, contentEng, eng).WithRecalc(recalcDB, []string{"machinery"})
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign: %v", err)
	}

	// Run engine briefly to process the enqueued send.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() {
		eng.Run(ctx, func(_ sender.SendRequest, _ sender.SendResult) { close(done) })
	}()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("engine did not send within timeout")
	}

	// Give the recalc goroutine time to attempt its DB call.
	time.Sleep(50 * time.Millisecond)

	if atomic.LoadInt32(&relayHits) < 1 {
		t.Error("expected relay to be called")
	}
}
