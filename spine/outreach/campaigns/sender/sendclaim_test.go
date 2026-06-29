// sendclaim_test.go — exactly-once send-claim layer (migration 171).
//
// Per feedback_extreme_testing (security/correctness-critical → 20+ cases):
// this is the mutex that guarantees one email per (campaign,contact,step), so
// it is tested hard — decision mapping, takeover, error fail-safe, confirm /
// release / expire idempotence, the pure helpers, the engine gate (relay NOT
// hit + no rate-limit advance on skip, fail-open on claim error, dry-run never
// claims), and a wiring ratchet that the gate precedes the relay submit.

package sender

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// newClaimDB returns a *sql.DB backed by sqlmock; both satisfy ClaimDB.
func newClaimDB(t *testing.T) (ClaimDB, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db, mock
}

func claimReq() SendRequest {
	return SendRequest{CampaignID: 7, ContactID: 42, Step: 1, ToAddress: "r@example.test"}
}

// ── AcquireClaim: outcome → decision mapping ──────────────────────────────

func TestAcquireClaim_OutcomeMapping(t *testing.T) {
	cases := []struct {
		name    string
		outcome string
		want    ClaimDecision
	}{
		{"fresh insert acquires", "acquired", ClaimProceed},
		{"takeover of failed/expired acquires", "acquired", ClaimProceed},
		{"already sent", "sent", ClaimAlreadySent},
		{"in-flight elsewhere", "claiming", ClaimInFlightElsewhere},
		{"unexpected status fails safe to in-flight", "weird_future_status", ClaimInFlightElsewhere},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db, mock := newClaimDB(t)
			mock.ExpectQuery("INSERT INTO send_claims").
				WillReturnRows(sqlmock.NewRows([]string{"outcome"}).AddRow(tc.outcome))
			got, err := AcquireClaim(context.Background(), db, claimReq(), ClaimedByGoEngine)
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if got != tc.want {
				t.Errorf("outcome %q → %v, want %v", tc.outcome, got, tc.want)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Error(err)
			}
		})
	}
}

func TestAcquireClaim_DBError_FailsSafeToInFlight(t *testing.T) {
	db, mock := newClaimDB(t)
	mock.ExpectQuery("INSERT INTO send_claims").WillReturnError(errors.New("connection reset"))
	got, err := AcquireClaim(context.Background(), db, claimReq(), ClaimedByGoEngine)
	if err == nil {
		t.Fatal("expected error to propagate")
	}
	// On error the decision must be the safe one (never ClaimProceed).
	if got == ClaimProceed {
		t.Errorf("DB error must NOT yield ClaimProceed; got %v", got)
	}
	if got != ClaimInFlightElsewhere {
		t.Errorf("DB error decision = %v, want ClaimInFlightElsewhere", got)
	}
}

func TestAcquireClaim_PassesClaimedBy(t *testing.T) {
	db, mock := newClaimDB(t)
	mock.ExpectQuery("INSERT INTO send_claims").
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), ClaimedByNodeBatch).
		WillReturnRows(sqlmock.NewRows([]string{"outcome"}).AddRow("acquired"))
	if _, err := AcquireClaim(context.Background(), db, claimReq(), ClaimedByNodeBatch); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ── ConfirmClaim ──────────────────────────────────────────────────────────

func TestConfirmClaim_Success(t *testing.T) {
	db, mock := newClaimDB(t)
	mock.ExpectExec("UPDATE send_claims").WillReturnResult(sqlmock.NewResult(0, 1))
	n, err := ConfirmClaim(context.Background(), db, claimReq(), "env-123")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if n != 1 {
		t.Errorf("rows affected = %d, want 1", n)
	}
}

func TestConfirmClaim_IdempotentNoOp(t *testing.T) {
	db, mock := newClaimDB(t)
	mock.ExpectExec("UPDATE send_claims").WillReturnResult(sqlmock.NewResult(0, 0))
	n, err := ConfirmClaim(context.Background(), db, claimReq(), "env-1")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if n != 0 {
		t.Errorf("double-confirm should match 0 rows, got %d", n)
	}
}

func TestConfirmClaim_EmptyEnvelopeStoresNull(t *testing.T) {
	db, mock := newClaimDB(t)
	mock.ExpectExec("UPDATE send_claims").
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), nil).
		WillReturnResult(sqlmock.NewResult(0, 1))
	if _, err := ConfirmClaim(context.Background(), db, claimReq(), ""); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestConfirmClaim_NonEmptyEnvelopePassedThrough(t *testing.T) {
	db, mock := newClaimDB(t)
	mock.ExpectExec("UPDATE send_claims").
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), "env-xyz").
		WillReturnResult(sqlmock.NewResult(0, 1))
	if _, err := ConfirmClaim(context.Background(), db, claimReq(), "env-xyz"); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestConfirmClaim_DBError(t *testing.T) {
	db, mock := newClaimDB(t)
	mock.ExpectExec("UPDATE send_claims").WillReturnError(errors.New("boom"))
	if _, err := ConfirmClaim(context.Background(), db, claimReq(), "e"); err == nil {
		t.Fatal("expected error")
	}
}

// ── ReleaseClaim ──────────────────────────────────────────────────────────

func TestReleaseClaim_Success(t *testing.T) {
	db, mock := newClaimDB(t)
	mock.ExpectExec("UPDATE send_claims").WillReturnResult(sqlmock.NewResult(0, 1))
	n, err := ReleaseClaim(context.Background(), db, claimReq())
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if n != 1 {
		t.Errorf("rows affected = %d, want 1", n)
	}
}

func TestReleaseClaim_DBError(t *testing.T) {
	db, mock := newClaimDB(t)
	mock.ExpectExec("UPDATE send_claims").WillReturnError(errors.New("boom"))
	if _, err := ReleaseClaim(context.Background(), db, claimReq()); err == nil {
		t.Fatal("expected error")
	}
}

// ── ExpireClaimForContact ─────────────────────────────────────────────────

func TestExpireClaimForContact_Success(t *testing.T) {
	db, mock := newClaimDB(t)
	mock.ExpectExec("UPDATE send_claims").WillReturnResult(sqlmock.NewResult(0, 3))
	n, err := ExpireClaimForContact(context.Background(), db, 7, 42)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if n != 3 {
		t.Errorf("rows affected = %d, want 3", n)
	}
}

func TestExpireClaimForContact_DBError(t *testing.T) {
	db, mock := newClaimDB(t)
	mock.ExpectExec("UPDATE send_claims").WillReturnError(errors.New("boom"))
	if _, err := ExpireClaimForContact(context.Background(), db, 7, 42); err == nil {
		t.Fatal("expected error")
	}
}

// ── ExpireStaleClaims ─────────────────────────────────────────────────────

func TestExpireStaleClaims_RejectsNonPositiveDuration(t *testing.T) {
	db, mock := newClaimDB(t)
	// No query should run for a non-positive threshold.
	for _, d := range []time.Duration{0, -time.Hour} {
		if _, err := ExpireStaleClaims(context.Background(), db, d); err == nil {
			t.Errorf("olderThan=%v must be rejected", d)
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestExpireStaleClaims_Success(t *testing.T) {
	db, mock := newClaimDB(t)
	mock.ExpectExec("UPDATE send_claims").WillReturnResult(sqlmock.NewResult(0, 5))
	n, err := ExpireStaleClaims(context.Background(), db, time.Hour)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if n != 5 {
		t.Errorf("rows affected = %d, want 5", n)
	}
}

func TestExpireStaleClaims_DBError(t *testing.T) {
	db, mock := newClaimDB(t)
	mock.ExpectExec("UPDATE send_claims").WillReturnError(errors.New("boom"))
	if _, err := ExpireStaleClaims(context.Background(), db, time.Hour); err == nil {
		t.Fatal("expected error")
	}
}

// ── Pure helpers ──────────────────────────────────────────────────────────

func TestClaimDecision_String(t *testing.T) {
	cases := map[ClaimDecision]string{
		ClaimProceed:           "proceed",
		ClaimAlreadySent:       "already_sent",
		ClaimInFlightElsewhere: "in_flight_elsewhere",
		ClaimDecision(99):      "unknown",
	}
	for d, want := range cases {
		if got := d.String(); got != want {
			t.Errorf("%d.String() = %q, want %q", d, got, want)
		}
	}
}

func TestIsDuplicateSkip(t *testing.T) {
	if !IsDuplicateSkip(ErrDuplicateAlreadySent) {
		t.Error("ErrDuplicateAlreadySent must be a duplicate skip")
	}
	if !IsDuplicateSkip(ErrDuplicateInFlight) {
		t.Error("ErrDuplicateInFlight must be a duplicate skip")
	}
	if IsDuplicateSkip(nil) {
		t.Error("nil is not a duplicate skip")
	}
	if IsDuplicateSkip(errors.New("some other error")) {
		t.Error("unrelated error is not a duplicate skip")
	}
}

func TestDupSkipResult(t *testing.T) {
	a := dupSkipResult("mb@x.test", ClaimAlreadySent)
	if !errors.Is(a.Error, ErrDuplicateAlreadySent) {
		t.Errorf("already-sent result error = %v", a.Error)
	}
	if a.MailboxUsed != "mb@x.test" {
		t.Errorf("mailbox not carried: %q", a.MailboxUsed)
	}
	if !strings.Contains(a.SMTPResponse, "already sent") {
		t.Errorf("SMTPResponse = %q", a.SMTPResponse)
	}

	f := dupSkipResult("mb@x.test", ClaimInFlightElsewhere)
	if !errors.Is(f.Error, ErrDuplicateInFlight) {
		t.Errorf("in-flight result error = %v", f.Error)
	}
	if !strings.Contains(f.SMTPResponse, "in-flight") {
		t.Errorf("SMTPResponse = %q", f.SMTPResponse)
	}
}

// ── Engine gate (reuses newSpyRelay / newLabhookEngine / runOneAndCancel) ─

type fakeClaimGate struct {
	mu       sync.Mutex
	calls    []SendRequest
	decision ClaimDecision
	err      error
}

func (f *fakeClaimGate) fn(_ context.Context, req SendRequest) (ClaimDecision, error) {
	f.mu.Lock()
	f.calls = append(f.calls, req)
	d, e := f.decision, f.err
	f.mu.Unlock()
	return d, e
}

func (f *fakeClaimGate) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeClaimGate) first() (SendRequest, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.calls) == 0 {
		return SendRequest{}, false
	}
	return f.calls[0], true
}

func TestEngine_SendClaim_Proceed_HitsRelay(t *testing.T) {
	relay, hits := newSpyRelay(t)
	e := newLabhookEngine(t, nil, false, relay.URL)
	gate := &fakeClaimGate{decision: ClaimProceed}
	e.WithSendClaim(gate.fn)
	res, fired := runOneAndCancel(t, e, SendRequest{
		CampaignID: 1, ContactID: 2, Step: 0,
		ToAddress: "r@example.test", Subject: "S", BodyPlain: "B",
	}, true)
	if !fired {
		t.Fatal("onSent must fire on ClaimProceed")
	}
	if got := atomic.LoadInt32(hits); got != 1 {
		t.Errorf("relay must be hit once on proceed, got %d", got)
	}
	if res.Error != nil {
		t.Errorf("proceed must not carry a dup error: %v", res.Error)
	}
	if gate.count() != 1 {
		t.Errorf("claim gate must be called exactly once, got %d", gate.count())
	}
}

func TestEngine_SendClaim_AlreadySent_SkipsRelay(t *testing.T) {
	relay, hits := newSpyRelay(t)
	e := newLabhookEngine(t, nil, false, relay.URL)
	gate := &fakeClaimGate{decision: ClaimAlreadySent}
	e.WithSendClaim(gate.fn)
	res, fired := runOneAndCancel(t, e, SendRequest{
		CampaignID: 1, ContactID: 2, Step: 0,
		ToAddress: "r@example.test", Subject: "S", BodyPlain: "B",
	}, true)
	if !fired {
		t.Fatal("onSent must fire on skip so the contact gets finalized")
	}
	if got := atomic.LoadInt32(hits); got != 0 {
		t.Errorf("relay must NOT be hit on already-sent skip, got %d", got)
	}
	if !errors.Is(res.Error, ErrDuplicateAlreadySent) {
		t.Errorf("want ErrDuplicateAlreadySent, got %v", res.Error)
	}
	e.mu.Lock()
	sc := e.sentCounts["operator@firma.test"]
	e.mu.Unlock()
	if sc != 0 {
		t.Errorf("skip must not advance sentCounts, got %d", sc)
	}
}

func TestEngine_SendClaim_InFlight_SkipsRelay(t *testing.T) {
	relay, hits := newSpyRelay(t)
	e := newLabhookEngine(t, nil, false, relay.URL)
	gate := &fakeClaimGate{decision: ClaimInFlightElsewhere}
	e.WithSendClaim(gate.fn)
	res, fired := runOneAndCancel(t, e, SendRequest{
		CampaignID: 1, ContactID: 2, Step: 0,
		ToAddress: "r@example.test", Subject: "S", BodyPlain: "B",
	}, true)
	if !fired {
		t.Fatal("onSent must fire on skip")
	}
	if got := atomic.LoadInt32(hits); got != 0 {
		t.Errorf("relay must NOT be hit on in-flight skip, got %d", got)
	}
	if !errors.Is(res.Error, ErrDuplicateInFlight) {
		t.Errorf("want ErrDuplicateInFlight, got %v", res.Error)
	}
}

func TestEngine_SendClaim_AcquireError_FailsOpen(t *testing.T) {
	relay, hits := newSpyRelay(t)
	e := newLabhookEngine(t, nil, false, relay.URL)
	gate := &fakeClaimGate{decision: ClaimInFlightElsewhere, err: errors.New("claim table down")}
	e.WithSendClaim(gate.fn)
	res, fired := runOneAndCancel(t, e, SendRequest{
		CampaignID: 1, ContactID: 2, Step: 0,
		ToAddress: "r@example.test", Subject: "S", BodyPlain: "B",
	}, true)
	if !fired {
		t.Fatal("onSent must fire on fail-open send")
	}
	if got := atomic.LoadInt32(hits); got != 1 {
		t.Errorf("claim error must fail-OPEN (proceed); relay hits=%d want 1", got)
	}
	if res.Error != nil {
		t.Errorf("fail-open proceed should not carry a dup error: %v", res.Error)
	}
}

func TestEngine_SendClaim_NilGate_LegacyPath(t *testing.T) {
	relay, hits := newSpyRelay(t)
	e := newLabhookEngine(t, nil, false, relay.URL) // no WithSendClaim
	_, fired := runOneAndCancel(t, e, SendRequest{
		CampaignID: 1, ContactID: 2, Step: 0,
		ToAddress: "r@example.test", Subject: "S", BodyPlain: "B",
	}, true)
	if !fired {
		t.Fatal("onSent must fire when no claim gate is wired")
	}
	if got := atomic.LoadInt32(hits); got != 1 {
		t.Errorf("nil gate must behave as before (relay hit once), got %d", got)
	}
}

func TestEngine_SendClaim_DryRun_NeverClaims(t *testing.T) {
	relay, hits := newSpyRelay(t)
	e := newLabhookEngine(t, nil, false, relay.URL)
	e.WithDryRun(true)
	gate := &fakeClaimGate{decision: ClaimProceed}
	e.WithSendClaim(gate.fn)
	_, fired := runOneAndCancel(t, e, SendRequest{
		CampaignID: 1, ContactID: 2, Step: 0,
		ToAddress: "r@example.test", Subject: "S", BodyPlain: "B",
	}, true)
	if !fired {
		t.Fatal("dry-run still fires onSent")
	}
	if gate.count() != 0 {
		t.Errorf("dry-run must NOT acquire a claim (no real send), got %d calls", gate.count())
	}
	if got := atomic.LoadInt32(hits); got != 0 {
		t.Errorf("dry-run must not hit relay, got %d", got)
	}
}

func TestEngine_SendClaim_PassesCorrectKey(t *testing.T) {
	relay, _ := newSpyRelay(t)
	e := newLabhookEngine(t, nil, false, relay.URL)
	gate := &fakeClaimGate{decision: ClaimProceed}
	e.WithSendClaim(gate.fn)
	_, _ = runOneAndCancel(t, e, SendRequest{
		CampaignID: 55, ContactID: 99, Step: 2,
		ToAddress: "r@example.test", Subject: "S", BodyPlain: "B",
	}, true)
	got, ok := gate.first()
	if !ok {
		t.Fatal("claim gate was never called")
	}
	if got.CampaignID != 55 || got.ContactID != 99 || got.Step != 2 {
		t.Errorf("claim key mismatch: campaign=%d contact=%d step=%d (want 55/99/2)",
			got.CampaignID, got.ContactID, got.Step)
	}
}

// ── Wiring ratchet: the gate must precede the relay submit in engine.go ────

func TestSendClaimGate_PrecedesRelaySubmit(t *testing.T) {
	src, err := os.ReadFile("engine.go")
	if err != nil {
		t.Fatalf("read engine.go: %v", err)
	}
	text := string(src)
	gateIdx := strings.Index(text, "e.sendClaim(ctx, req)")
	sendIdx := strings.Index(text, "e.antiTrace.Send(ctx, req)")
	if gateIdx < 0 {
		t.Fatal("send-claim gate (e.sendClaim) missing from engine.go — exactly-once protection removed?")
	}
	if sendIdx < 0 {
		t.Fatal("e.antiTrace.Send call not found in engine.go")
	}
	if gateIdx > sendIdx {
		t.Fatal("send-claim gate must run BEFORE e.antiTrace.Send; ordering regressed")
	}
}
