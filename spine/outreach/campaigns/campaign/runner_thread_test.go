package campaign

// Tests for fetchThreadChain and the runner's In-Reply-To / References plumbing.
//
// Per memory feedback_extreme_testing: ≥10 test cases, boundary + error +
// integration paths covered.

import (
	"context"
	"errors"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── fetchThreadChain unit tests ───────────────────────────────────────────────

// 1. Step 0 is never called (gate in runner); verify fetchThreadChain with no rows.
//    Simulates data integrity gap: step > 0 but no prior send_events.
func TestFetchThreadChain_NoRows_ReturnsEmpty(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT message_id`).
		WithArgs(int64(1), int64(10), 1).
		WillReturnRows(sqlmock.NewRows([]string{"message_id"}))

	irt, chain := fetchThreadChain(context.Background(), db, 1, 10, 1)
	if irt != "" {
		t.Errorf("inReplyTo = %q, want empty", irt)
	}
	if len(chain) != 0 {
		t.Errorf("chain len = %d, want 0", len(chain))
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// 2. Single prior step → inReplyTo set, chain of length 1.
func TestFetchThreadChain_SinglePriorStep_InReplyToSet(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	const msgID = "<step0.nanos@firma.cz>"
	mock.ExpectQuery(`SELECT message_id`).
		WithArgs(int64(5), int64(20), 1).
		WillReturnRows(sqlmock.NewRows([]string{"message_id"}).AddRow(msgID))

	irt, chain := fetchThreadChain(context.Background(), db, 5, 20, 1)
	if irt != msgID {
		t.Errorf("inReplyTo = %q, want %q", irt, msgID)
	}
	if len(chain) != 1 || chain[0] != msgID {
		t.Errorf("chain = %v, want [%q]", chain, msgID)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// 3. Three prior steps → inReplyTo is latest, chain has 3 entries (oldest first).
func TestFetchThreadChain_ThreePriorSteps_CorrectOrder(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	ids := []string{
		"<step0.nanos@firma.cz>",
		"<step1.nanos@firma.cz>",
		"<step2.nanos@firma.cz>",
	}
	rows := sqlmock.NewRows([]string{"message_id"})
	for _, id := range ids {
		rows.AddRow(id)
	}

	mock.ExpectQuery(`SELECT message_id`).
		WithArgs(int64(7), int64(30), 3).
		WillReturnRows(rows)

	irt, chain := fetchThreadChain(context.Background(), db, 7, 30, 3)

	if irt != ids[2] {
		t.Errorf("inReplyTo = %q, want %q (last step)", irt, ids[2])
	}
	if len(chain) != 3 {
		t.Fatalf("chain len = %d, want 3", len(chain))
	}
	for i, want := range ids {
		if chain[i] != want {
			t.Errorf("chain[%d] = %q, want %q", i, chain[i], want)
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// 4. DB query error → graceful fallback, returns ("", nil).
func TestFetchThreadChain_DBError_GracefulFallback(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT message_id`).
		WithArgs(int64(1), int64(1), 2).
		WillReturnError(errors.New("connection reset"))

	irt, chain := fetchThreadChain(context.Background(), db, 1, 1, 2)
	if irt != "" || len(chain) != 0 {
		t.Errorf("expected empty result on DB error, got inReplyTo=%q chain=%v", irt, chain)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// 5. Chain contains empty-string message_id rows → empty IDs excluded from chain.
func TestFetchThreadChain_EmptyMessageIDs_Excluded(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	const realID = "<step0.nanos@firma.cz>"
	mock.ExpectQuery(`SELECT message_id`).
		WithArgs(int64(2), int64(5), 1).
		WillReturnRows(sqlmock.NewRows([]string{"message_id"}).
			AddRow("").
			AddRow(realID).
			AddRow(""))

	irt, chain := fetchThreadChain(context.Background(), db, 2, 5, 1)
	if irt != realID {
		t.Errorf("inReplyTo = %q, want %q", irt, realID)
	}
	if len(chain) != 1 {
		t.Errorf("chain len = %d, want 1 (empty IDs excluded)", len(chain))
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// 6. 15-row chain (exceeds maxReferencesChainDepth) → all 15 returned by
//
//	fetchThreadChain (engine enforces the cap, not the runner).
func TestFetchThreadChain_LongChain_AllRowsReturned(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	rows := sqlmock.NewRows([]string{"message_id"})
	var ids []string
	for i := 0; i < 15; i++ {
		id := "<stepXX" + string(rune('a'+i)) + "@firma.cz>"
		ids = append(ids, id)
		rows.AddRow(id)
	}

	mock.ExpectQuery(`SELECT message_id`).
		WithArgs(int64(3), int64(8), 15).
		WillReturnRows(rows)

	irt, chain := fetchThreadChain(context.Background(), db, 3, 8, 15)
	if len(chain) != 15 {
		t.Errorf("chain len = %d, want 15 (runner returns all; engine truncates)", len(chain))
	}
	if irt != ids[14] {
		t.Errorf("inReplyTo = %q, want %q", irt, ids[14])
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// 7. currentStep=0 is guarded by runner (step.Step > 0 check) — verify
//
//	fetchThreadChain itself still works when called with step=1 (the
//	minimum follow-up step).
func TestFetchThreadChain_Step1_LooksUpStep0(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	const parentMsgID = "<initial.step@firma.cz>"
	mock.ExpectQuery(`SELECT message_id`).
		WithArgs(int64(10), int64(50), 1).
		WillReturnRows(sqlmock.NewRows([]string{"message_id"}).AddRow(parentMsgID))

	irt, chain := fetchThreadChain(context.Background(), db, 10, 50, 1)
	if irt != parentMsgID {
		t.Errorf("inReplyTo = %q, want %q", irt, parentMsgID)
	}
	if len(chain) != 1 {
		t.Errorf("chain len = %d, want 1", len(chain))
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// 8. All rows have empty message_id → inReplyTo empty, chain empty (graceful).
func TestFetchThreadChain_AllEmptyIDs_ReturnEmpty(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT message_id`).
		WithArgs(int64(4), int64(9), 2).
		WillReturnRows(sqlmock.NewRows([]string{"message_id"}).
			AddRow("").AddRow(""))

	irt, chain := fetchThreadChain(context.Background(), db, 4, 9, 2)
	if irt != "" {
		t.Errorf("inReplyTo = %q, want empty", irt)
	}
	if len(chain) != 0 {
		t.Errorf("chain len = %d, want 0", len(chain))
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// 9. Two prior steps → inReplyTo = second (most recent), chain = [first, second].
func TestFetchThreadChain_TwoPriorSteps_InReplyToIsLatest(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	const (
		step0 = "<initial@firma.cz>"
		step1 = "<followup1@firma.cz>"
	)
	mock.ExpectQuery(`SELECT message_id`).
		WithArgs(int64(6), int64(15), 2).
		WillReturnRows(sqlmock.NewRows([]string{"message_id"}).
			AddRow(step0).
			AddRow(step1))

	irt, chain := fetchThreadChain(context.Background(), db, 6, 15, 2)
	if irt != step1 {
		t.Errorf("inReplyTo = %q, want %q (latest step)", irt, step1)
	}
	if len(chain) != 2 || chain[0] != step0 || chain[1] != step1 {
		t.Errorf("chain = %v, want [%q, %q]", chain, step0, step1)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// 10. Cancelled context → fetchThreadChain returns empty regardless of whether
//
//	the DB query fires or is short-circuited by the driver.
//
// database/sql may return ctx.Err() without touching the mock when ctx is
// already cancelled, so we do NOT register an ExpectQuery. The test only
// verifies the return values are empty — no unmet-expectation error.
func TestFetchThreadChain_CancelledContext_ReturnsEmpty(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Allow the query to fire and return context.Canceled if the driver
	// does not short-circuit — sqlmock's optional matcher means this
	// expectation is satisfied if it fires, but not required.
	mock.ExpectQuery(`SELECT message_id`).
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnError(context.Canceled)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before the call

	irt, chain := fetchThreadChain(ctx, db, 1, 1, 1)
	if irt != "" || len(chain) != 0 {
		t.Errorf("expected empty on cancelled ctx, got irt=%q chain=%v", irt, chain)
	}
	// Ignore unmet expectations: pre-cancelled ctx may short-circuit before
	// the mock sees the query. The important assertion is the empty return above.
	_ = mock.ExpectationsWereMet()
}
