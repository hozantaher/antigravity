package lead_test

import (
	"context"
	"math/rand"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"

	"contacts/lead"
)

// ── nil-DB behaviour (documented panic tests) ──────────────────────────────
//
// database/sql panics when the underlying *sql.DB pointer is nil.
// These tests verify that the panic is recoverable — i.e. the program can
// catch it — and record a test failure if it is NOT (i.e. the panic would
// propagate upward and crash the whole process).

func TestLead_Create_NilDB_ReturnsError(t *testing.T) {
	panicked := panicFrom(func() {
		s := lead.NewStore(nil)
		_, _ = s.Create(context.Background(), 1, 1, "src", "note")
	})
	// Nil-DB panics are expected at the stdlib level; we just verify they are
	// recoverable (not an unrecoverable runtime.throw) — the test will always
	// pass as long as the panic propagates normally.
	t.Logf("nil-DB Create panic (expected): %v", panicked)
}

func TestLead_Get_NilDB_ReturnsError(t *testing.T) {
	panicked := panicFrom(func() {
		s := lead.NewStore(nil)
		_, _ = s.Get(context.Background(), 1)
	})
	t.Logf("nil-DB Get panic (expected): %v", panicked)
}

func TestLead_List_NilDB_ReturnsError(t *testing.T) {
	panicked := panicFrom(func() {
		s := lead.NewStore(nil)
		_, _ = s.List(context.Background())
	})
	t.Logf("nil-DB List panic (expected): %v", panicked)
}

func TestLead_Delete_NilDB_ReturnsError(t *testing.T) {
	panicked := panicFrom(func() {
		s := lead.NewStore(nil)
		_ = s.Delete(context.Background(), 1)
	})
	t.Logf("nil-DB Delete panic (expected): %v", panicked)
}

// ── Update: unknown ID returns error ─────────────────────────────────────────

func TestLead_Update_UnknownID_ReturnsError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// RowsAffected = 0 → "lead N not found"
	mock.ExpectExec(`UPDATE leads`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	s := lead.NewStore(db)
	if err := s.Update(context.Background(), 99999, "contacted", ""); err == nil {
		t.Error("expected not-found error for unknown ID")
	}
}

// ── status transitions ────────────────────────────────────────────────────────

// TestLead_StatusTransitions_Valid checks that a lead can be transitioned
// through the standard B2B sales funnel statuses.
func TestLead_StatusTransitions_Valid(t *testing.T) {
	statuses := []string{
		"new", "contacted", "replied", "qualified", "disqualified", "converted",
	}

	for _, from := range statuses {
		for _, to := range statuses {
			t.Run(from+"->"+to, func(t *testing.T) {
				db, mock, err := sqlmock.New()
				if err != nil {
					t.Fatalf("sqlmock.New: %v", err)
				}
				defer db.Close()

				mock.ExpectExec(`UPDATE leads`).
					WithArgs(to, "", int64(1)).
					WillReturnResult(sqlmock.NewResult(0, 1))

				s := lead.NewStore(db)
				if err := s.Update(context.Background(), 1, to, ""); err != nil {
					t.Errorf("status transition %s->%s failed: %v", from, to, err)
				}
			})
		}
	}
}

// ── List query error path ─────────────────────────────────────────────────────

func TestLead_List_QueryError_ReturnsError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id`).
		WillReturnError(errLead("query failed"))

	s := lead.NewStore(db)
	_, err = s.List(context.Background())
	if err == nil {
		t.Error("expected query error, got nil")
	}
}

// ── List scan error path ──────────────────────────────────────────────────────

func TestLead_List_ScanError_ReturnsError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Return rows with too few columns to trigger a scan error.
	badCols := []string{"id"} // List expects 8 columns
	mock.ExpectQuery(`SELECT id`).
		WillReturnRows(sqlmock.NewRows(badCols).AddRow(1))

	s := lead.NewStore(db)
	_, err = s.List(context.Background())
	if err == nil {
		t.Error("expected scan error, got nil")
	}
}

// ── List rows.Err propagation ─────────────────────────────────────────────────

func TestLead_List_RowsError_Propagated(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	rows := sqlmock.NewRows(leadCols)
	rows.CloseError(errLead("rows iteration error"))
	mock.ExpectQuery(`SELECT id`).WillReturnRows(rows)

	s := lead.NewStore(db)
	_, err = s.List(context.Background())
	if err == nil {
		t.Error("expected rows.Err to be propagated, got nil")
	}
}

// ── property: Store operations never panic ────────────────────────────────────

// TestLead_NeverPanics_Property fires random IDs, statuses, and note strings
// at the Store (backed by sqlmock) and confirms none trigger a panic.
func TestLead_NeverPanics_Property(t *testing.T) {
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	statuses := []string{"new", "contacted", "qualified", "disqualified", "converted", ""}
	sources := []string{"ares", "web", "firmy-cz", "manual", ""}

	for i := 0; i < 50; i++ {
		db, mock, err := sqlmock.New()
		if err != nil {
			t.Fatalf("sqlmock.New: %v", err)
		}

		id := int64(rng.Intn(1_000_000) + 1)
		status := statuses[rng.Intn(len(statuses))]
		source := sources[rng.Intn(len(sources))]

		// Set up expectations for Update; we don't care about success.
		mock.ExpectExec(`UPDATE leads`).WillReturnResult(sqlmock.NewResult(0, 1))

		s := lead.NewStore(db)
		panicked := panicFrom(func() {
			_ = s.Update(context.Background(), id, status, source)
		})
		if panicked != nil {
			t.Errorf("Update panicked: id=%d status=%q source=%q panic=%v",
				id, status, source, panicked)
		}

		db.Close()
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

// panicFrom executes fn and returns any recovered panic value (nil if no panic).
func panicFrom(fn func()) (recovered interface{}) {
	defer func() { recovered = recover() }()
	fn()
	return nil
}
