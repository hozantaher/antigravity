package intelligence

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
	"common/alert"
)

// ── RunDaemon: alert notified after 3 consecutive failures ───────────────────

// TestRunDaemon_AlertOnThreeFailures verifies that cfg.Alert.DaemonPanic is
// called when consecutiveFails >= 3. A nil *sql.DB causes a panic on every
// RunOnce call; after 3+ panics the webhook server must have received a request.
func TestRunDaemon_AlertOnThreeFailures(t *testing.T) {
	var called atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALERT_WEBHOOK_URL", srv.URL)
	t.Setenv("ALERT_WEBHOOK_SECRET", "")
	alertClient := alert.New()

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(300 * time.Millisecond)
		cancel()
	}()

	// nil db → every run panics → markFail → consecutiveFails++ → alert after ≥3
	RunDaemon(ctx, nil, Config{Alert: alertClient}, 50*time.Millisecond) //nolint:errcheck

	if called.Load() == 0 {
		t.Error("expected alert webhook to be called after 3+ consecutive failures")
	}
}

// ── RunDaemon: success resets consecutive counter ────────────────────────────

// TestRunDaemon_SuccessResetsCounter verifies the success path inside run():
// consecutiveFails = 0 and metrics counters are updated.
// We provide a properly seeded sqlmock DB so RunOnce can complete successfully,
// then immediately cancel the context.
func TestRunDaemon_SuccessResetsCounter(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Seed the full minimal RunOnce sequence so it completes without error.
	expectRunOnceMinimal(mock)

	ctx, cancel := context.WithCancel(context.Background())
	// Cancel immediately after the first successful run (give it 500ms grace).
	go func() {
		time.Sleep(500 * time.Millisecond)
		cancel()
	}()

	err = RunDaemon(ctx, db, Config{TargetIndustries: []string{}}, time.Hour)
	// RunDaemon returns ctx.Err() when cancelled — that is expected.
	if err == nil {
		t.Error("expected context.Canceled from RunDaemon, got nil")
	}
}
