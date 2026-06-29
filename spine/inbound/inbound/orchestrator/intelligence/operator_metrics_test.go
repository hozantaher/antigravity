package intelligence

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// expectCampaignQuery sets up the campaign aggregate query expectation.
func expectCampaignQuery(mock sqlmock.Sqlmock, rows *sqlmock.Rows) {
	mock.ExpectQuery(`SELECT\s+c\.id`).WillReturnRows(rows)
}

// expectStepDistrib sets up the step distribution sub-query expectation.
func expectStepDistrib(mock sqlmock.Sqlmock, rows *sqlmock.Rows) {
	mock.ExpectQuery(`SELECT COALESCE\(current_step`).WillReturnRows(rows)
}

// expectMailboxQuery sets up the mailbox aggregate query expectation.
func expectMailboxQuery(mock sqlmock.Sqlmock, rows *sqlmock.Rows) {
	mock.ExpectQuery(`SELECT\s+m\.from_address`).WillReturnRows(rows)
}

// expectOverridesQuery sets up the classifier overrides query.
func expectOverridesQuery(mock sqlmock.Sqlmock, n int) {
	mock.ExpectQuery(`SELECT COUNT\(\*\).*interval '24h'`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(n))
}

// expectTrainingSetQuery sets up the training set size query.
func expectTrainingSetQuery(mock sqlmock.Sqlmock, n int) {
	mock.ExpectQuery(`SELECT COUNT\(\*\).*reply_classify_override`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(n))
}

// expectAccuracyQuery sets up the rolling 7d accuracy query.
func expectAccuracyQuery(mock sqlmock.Sqlmock, classified, overridden int) {
	mock.ExpectQuery(`SELECT\s+COUNT\(\*\) FILTER.*7 days`).
		WillReturnRows(sqlmock.NewRows([]string{"classified", "overridden"}).
			AddRow(classified, overridden))
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

// T1. Snapshot schema is stable — required fields never disappear from JSON.
func TestOperatorMetricsSnapshot_JSONSchema(t *testing.T) {
	snap := &OperatorMetricsSnapshot{
		GeneratedAt:              time.Now().UTC().Format(time.RFC3339),
		Campaigns:                []CampaignMetrics{},
		Mailboxes:                []MailboxMetricsRow{},
		ClassifierOverridesToday: 0,
		TrainingSetSize:          0,
		AccuracyRolling7d:        0.0,
	}

	b, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}

	required := []string{
		"generated_at",
		"campaigns",
		"mailboxes",
		"classifier_overrides_today",
		"training_set_size",
		"accuracy_rolling_7d",
	}
	for _, key := range required {
		if _, ok := m[key]; !ok {
			t.Errorf("snapshot JSON missing required key: %q", key)
		}
	}
}

// T2. Collect returns a non-nil snapshot and sets generated_at.
func TestCollect_ReturnsSnapshot(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	expectCampaignQuery(mock, sqlmock.NewRows([]string{
		"id", "name", "status", "sent_24h", "bounced_24h", "replied_24h",
	}))
	expectMailboxQuery(mock, sqlmock.NewRows([]string{
		"from_address", "last_score", "send_count_today", "status",
	}))
	expectOverridesQuery(mock, 0)
	expectTrainingSetQuery(mock, 0)
	expectAccuracyQuery(mock, 0, 0)

	snap := Collect(context.Background(), db)
	if snap == nil {
		t.Fatal("Collect returned nil snapshot")
	}
	if snap.GeneratedAt == "" {
		t.Error("GeneratedAt is empty")
	}
	if snap.Campaigns == nil {
		t.Error("Campaigns must be non-nil slice (empty is ok)")
	}
	if snap.Mailboxes == nil {
		t.Error("Mailboxes must be non-nil slice (empty is ok)")
	}
}

// T3. BounceRate: 0 sends → no division-by-zero, BounceRate24h = 0.
func TestCampaignMetrics_ZeroSends_NoDivisionByZero(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	expectCampaignQuery(mock, sqlmock.NewRows([]string{
		"id", "name", "status", "sent_24h", "bounced_24h", "replied_24h",
	}).AddRow(1, "test-campaign", "running", 0, 0, 0))
	expectStepDistrib(mock, sqlmock.NewRows([]string{"step", "count"}))
	expectMailboxQuery(mock, sqlmock.NewRows([]string{
		"from_address", "last_score", "send_count_today", "status",
	}))
	expectOverridesQuery(mock, 0)
	expectTrainingSetQuery(mock, 0)
	expectAccuracyQuery(mock, 0, 0)

	snap := Collect(context.Background(), db)
	if len(snap.Campaigns) != 1 {
		t.Fatalf("expected 1 campaign, got %d", len(snap.Campaigns))
	}
	c := snap.Campaigns[0]
	if c.BounceRate24h != 0.0 {
		t.Errorf("BounceRate24h should be 0 for zero sends, got %v", c.BounceRate24h)
	}
	if c.ReplyRate24h != 0.0 {
		t.Errorf("ReplyRate24h should be 0 for zero sends, got %v", c.ReplyRate24h)
	}
}

// T4. BounceRate calculation correct: 10 sent, 2 bounced → 0.2.
func TestCampaignMetrics_BounceRateCalculation(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	expectCampaignQuery(mock, sqlmock.NewRows([]string{
		"id", "name", "status", "sent_24h", "bounced_24h", "replied_24h",
	}).AddRow(2, "bounce-test", "running", 10, 2, 1))
	expectStepDistrib(mock, sqlmock.NewRows([]string{"step", "count"}))
	expectMailboxQuery(mock, sqlmock.NewRows([]string{
		"from_address", "last_score", "send_count_today", "status",
	}))
	expectOverridesQuery(mock, 0)
	expectTrainingSetQuery(mock, 0)
	expectAccuracyQuery(mock, 0, 0)

	snap := Collect(context.Background(), db)
	if len(snap.Campaigns) == 0 {
		t.Fatal("no campaigns in snapshot")
	}
	c := snap.Campaigns[0]
	const wantBounce = 0.2
	if c.BounceRate24h != wantBounce {
		t.Errorf("BounceRate24h: want %v, got %v", wantBounce, c.BounceRate24h)
	}
	const wantReply = 0.1
	if c.ReplyRate24h != wantReply {
		t.Errorf("ReplyRate24h: want %v, got %v", wantReply, c.ReplyRate24h)
	}
}

// T5. Aggregation across 4 mailboxes returns 4 rows.
func TestMailboxMetrics_AggregateFourMailboxes(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	expectCampaignQuery(mock, sqlmock.NewRows([]string{
		"id", "name", "status", "sent_24h", "bounced_24h", "replied_24h",
	}))
	rows := sqlmock.NewRows([]string{"from_address", "last_score", "send_count_today", "status"}).
		AddRow("a@list.cz", 100, 12, "active").
		AddRow("b@list.cz", 80, 8, "active").
		AddRow("c@list.cz", 0, 0, "bounce_hold").
		AddRow("d@list.cz", 60, 5, "paused")
	expectMailboxQuery(mock, rows)
	expectOverridesQuery(mock, 0)
	expectTrainingSetQuery(mock, 0)
	expectAccuracyQuery(mock, 0, 0)

	snap := Collect(context.Background(), db)
	if len(snap.Mailboxes) != 4 {
		t.Fatalf("expected 4 mailboxes, got %d", len(snap.Mailboxes))
	}

	// bounce_hold mailbox must report circuit open.
	var foundBounceHold bool
	for _, m := range snap.Mailboxes {
		if m.Status == "bounce_hold" {
			if m.CircuitState != "open" {
				t.Errorf("bounce_hold mailbox %s should have CircuitState=open, got %q", m.Address, m.CircuitState)
			}
			foundBounceHold = true
		} else {
			if m.CircuitState != "closed" {
				t.Errorf("mailbox %s (status=%s) should have CircuitState=closed, got %q",
					m.Address, m.Status, m.CircuitState)
			}
		}
	}
	if !foundBounceHold {
		t.Error("no bounce_hold mailbox found in test data")
	}
}

// T6. Empty operator overrides still produces a valid row with zero counts.
func TestOperatorStats_EmptyOverrides(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	expectCampaignQuery(mock, sqlmock.NewRows([]string{
		"id", "name", "status", "sent_24h", "bounced_24h", "replied_24h",
	}))
	expectMailboxQuery(mock, sqlmock.NewRows([]string{
		"from_address", "last_score", "send_count_today", "status",
	}))
	expectOverridesQuery(mock, 0)
	expectTrainingSetQuery(mock, 0)
	expectAccuracyQuery(mock, 0, 0)

	snap := Collect(context.Background(), db)
	if snap.ClassifierOverridesToday != 0 {
		t.Errorf("ClassifierOverridesToday: want 0, got %d", snap.ClassifierOverridesToday)
	}
	if snap.TrainingSetSize != 0 {
		t.Errorf("TrainingSetSize: want 0, got %d", snap.TrainingSetSize)
	}
	if snap.AccuracyRolling7d != 0 {
		t.Errorf("AccuracyRolling7d: want 0.0, got %v", snap.AccuracyRolling7d)
	}
}

// T7. Accuracy calculation: 100 classified, 20 overridden → accuracy = 0.80.
func TestOperatorStats_AccuracyCalculation(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	expectCampaignQuery(mock, sqlmock.NewRows([]string{
		"id", "name", "status", "sent_24h", "bounced_24h", "replied_24h",
	}))
	expectMailboxQuery(mock, sqlmock.NewRows([]string{
		"from_address", "last_score", "send_count_today", "status",
	}))
	expectOverridesQuery(mock, 5)
	expectTrainingSetQuery(mock, 42)
	expectAccuracyQuery(mock, 100, 20)

	snap := Collect(context.Background(), db)
	const want = 0.80
	if snap.AccuracyRolling7d != want {
		t.Errorf("AccuracyRolling7d: want %v, got %v", want, snap.AccuracyRolling7d)
	}
	if snap.ClassifierOverridesToday != 5 {
		t.Errorf("ClassifierOverridesToday: want 5, got %d", snap.ClassifierOverridesToday)
	}
	if snap.TrainingSetSize != 42 {
		t.Errorf("TrainingSetSize: want 42, got %d", snap.TrainingSetSize)
	}
}

// T8. Sentry breadcrumb is emitted (no panic).
// The real Sentry hub is nil in tests; Breadcrumb recovers from the nil check.
func TestCollect_SentryBreadcrumb_NoPanic(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	expectCampaignQuery(mock, sqlmock.NewRows([]string{
		"id", "name", "status", "sent_24h", "bounced_24h", "replied_24h",
	}))
	expectMailboxQuery(mock, sqlmock.NewRows([]string{
		"from_address", "last_score", "send_count_today", "status",
	}))
	expectOverridesQuery(mock, 0)
	expectTrainingSetQuery(mock, 0)
	expectAccuracyQuery(mock, 0, 0)

	// Must not panic even though Sentry is not initialised in tests.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Collect panicked: %v", r)
		}
	}()
	Collect(context.Background(), db)
}

// T9. Snapshot() returns nil before first Collect, non-nil after.
func TestSnapshot_InitialNil(t *testing.T) {
	// Reset the package-level snapshot to verify initial state.
	snapshotMu.Lock()
	currentSnapshot = nil
	snapshotMu.Unlock()

	if Snapshot() != nil {
		t.Error("Snapshot should be nil before first Collect")
	}

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	expectCampaignQuery(mock, sqlmock.NewRows([]string{
		"id", "name", "status", "sent_24h", "bounced_24h", "replied_24h",
	}))
	expectMailboxQuery(mock, sqlmock.NewRows([]string{
		"from_address", "last_score", "send_count_today", "status",
	}))
	expectOverridesQuery(mock, 0)
	expectTrainingSetQuery(mock, 0)
	expectAccuracyQuery(mock, 0, 0)

	Collect(context.Background(), db)
	if Snapshot() == nil {
		t.Error("Snapshot should be non-nil after Collect")
	}
}

// T10. RunMetricsDaemon respects ctx cancel: stops without blocking.
func TestRunMetricsDaemon_CtxCancel(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Set up the initial immediate Collect expectation.
	expectCampaignQuery(mock, sqlmock.NewRows([]string{
		"id", "name", "status", "sent_24h", "bounced_24h", "replied_24h",
	}))
	expectMailboxQuery(mock, sqlmock.NewRows([]string{
		"from_address", "last_score", "send_count_today", "status",
	}))
	expectOverridesQuery(mock, 0)
	expectTrainingSetQuery(mock, 0)
	expectAccuracyQuery(mock, 0, 0)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		// Use a 10s interval so the ticker never fires before the cancel.
		done <- RunMetricsDaemon(ctx, db, 10*time.Second)
	}()

	// Cancel immediately after the goroutine starts.
	cancel()

	select {
	case err := <-done:
		if err != context.Canceled {
			t.Errorf("RunMetricsDaemon returned %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Error("RunMetricsDaemon did not stop after ctx cancel within 2s")
	}
}

// T11. MarshalSnapshot produces valid JSON with all top-level keys.
func TestMarshalSnapshot_ValidJSON(t *testing.T) {
	snap := &OperatorMetricsSnapshot{
		GeneratedAt: "2026-05-01T08:00:00Z",
		Campaigns: []CampaignMetrics{
			{
				ID:     1,
				Name:   "machinery-q2",
				Status: "running",
				Sent24h: 48,
				BounceRate24h: 0.02,
				ReplyRate24h:  0.12,
				CurrentStepDistribution: map[string]int{"initial": 40, "followup1": 8},
			},
		},
		Mailboxes: []MailboxMetricsRow{
			{Address: "a@list.cz", LastScore: 100, SendCountToday: 8, CircuitState: "closed", Status: "active"},
		},
		ClassifierOverridesToday: 3,
		TrainingSetSize:          87,
		AccuracyRolling7d:        0.91,
	}

	b, err := MarshalSnapshot(snap)
	if err != nil {
		t.Fatalf("MarshalSnapshot: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("invalid JSON produced: %v", err)
	}
	for _, key := range []string{
		"generated_at", "campaigns", "mailboxes",
		"classifier_overrides_today", "training_set_size", "accuracy_rolling_7d",
	} {
		if _, ok := m[key]; !ok {
			t.Errorf("marshaled snapshot missing key: %q", key)
		}
	}
}
