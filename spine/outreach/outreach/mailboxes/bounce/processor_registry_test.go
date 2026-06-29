package bounce

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// fakeRegistry is a minimal mailbox.Backpressure for wiring tests.
// It only records the calls — the real adapter is exercised in
// internal/mailbox/backpressure_test.go.
type fakeRegistry struct {
	mu           sync.Mutex
	bounces      []fakeBounceCall
	successCalls []string
}

type fakeBounceCall struct {
	Address string
	Reason  string
}

func (f *fakeRegistry) RecordSuccess(_ context.Context, addr string, _ time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.successCalls = append(f.successCalls, addr)
}
func (f *fakeRegistry) RecordBounce(_ context.Context, addr, reason string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bounces = append(f.bounces, fakeBounceCall{addr, reason})
	return false
}
func (f *fakeRegistry) ActiveAddresses(_ context.Context) (map[string]struct{}, error) {
	return nil, nil
}

func TestProcess_HardBounce_RecordsOnMailboxRegistry(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	reg := &fakeRegistry{}
	p := NewProcessor(bdb).WithMailboxRegistry(reg)

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(100, 42, "user@firma.cz", "jan@sender.test"))
	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE send_events SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE contacts SET status = 'bounced'`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO blacklist`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	err := p.Process(Event{
		OriginalMessageID: "msg@id",
		Type:              BounceHard,
		Code:              "550",
		Reason:            "user unknown",
	})
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}

	reg.mu.Lock()
	defer reg.mu.Unlock()
	if len(reg.bounces) != 1 {
		t.Fatalf("expected 1 RecordBounce call, got %d (%+v)", len(reg.bounces), reg.bounces)
	}
	if reg.bounces[0].Address != "jan@sender.test" {
		t.Errorf("expected RecordBounce(jan@sender.test), got %q", reg.bounces[0].Address)
	}
	if reg.bounces[0].Reason == "" {
		t.Error("expected non-empty reason")
	}
}

func TestProcess_Complaint_RecordsOnMailboxRegistry(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	reg := &fakeRegistry{}
	p := NewProcessor(bdb).WithMailboxRegistry(reg)

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(300, 77, "spam@firma.cz", "ops@sender.test"))
	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE send_events SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE contacts SET status = 'blacklisted'`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO blacklist`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	err := p.Process(Event{
		OriginalMessageID: "complaint@id",
		Type:              BounceComplaint,
		Code:              "550",
		Reason:            "spam complaint received",
	})
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}

	reg.mu.Lock()
	defer reg.mu.Unlock()
	if len(reg.bounces) != 1 {
		t.Fatalf("expected 1 RecordBounce call (complaint), got %d", len(reg.bounces))
	}
	if reg.bounces[0].Address != "ops@sender.test" {
		t.Errorf("expected RecordBounce(ops@sender.test), got %q", reg.bounces[0].Address)
	}
	if reg.bounces[0].Reason != "complaint" {
		t.Errorf("expected reason=complaint, got %q", reg.bounces[0].Reason)
	}
}

func TestProcess_SoftBounce_DoesNotTouchRegistry(t *testing.T) {
	// Soft bounces are transient — they must NOT tick the consecutive-bounce
	// counter. Only hard bounces and complaints do.
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	reg := &fakeRegistry{}
	p := NewProcessor(bdb).WithMailboxRegistry(reg)

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(200, 55, "temp@firma.cz", "jan@sender.test"))
	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE send_events SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM bounce_events`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))

	err := p.Process(Event{
		OriginalMessageID: "soft@id",
		Type:              BounceSoft,
		Code:              "421",
		Reason:            "try later",
	})
	if err != nil {
		t.Fatalf("Process: %v", err)
	}

	reg.mu.Lock()
	defer reg.mu.Unlock()
	if len(reg.bounces) != 0 {
		t.Errorf("soft bounce must not touch registry, got %+v", reg.bounces)
	}
}

func TestProcess_NoRegistryIsNoOp(t *testing.T) {
	// Processor without WithMailboxRegistry must still process bounces
	// (legacy path) — no panic, no error.
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	p := NewProcessor(bdb) // no registry

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(100, 42, "user@firma.cz", "jan@sender.test"))
	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE send_events SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE contacts SET status = 'bounced'`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO blacklist`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	if err := p.Process(Event{
		OriginalMessageID: "msg@id",
		Type:              BounceHard,
		Code:              "550",
	}); err != nil {
		t.Fatalf("Process without registry: %v", err)
	}
}
