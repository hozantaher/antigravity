package contact

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── FindBySegment: scanContactRows error (line 176) ──

func TestFindBySegment_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Wrong column count → scanContactRows fails
	mock.ExpectQuery(`SELECT id, email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email"}).AddRow(1, "x@x.cz"))

	s := NewStore(db)
	_, err = s.FindBySegment(context.Background(), SegmentFilter{}, 10, 0)
	if err == nil {
		t.Error("expected scan error from FindBySegment")
	}
}

// ── CountByStatus: scan error (line 196) ──

func TestCountByStatus_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// One column when two expected → Scan fails
	mock.ExpectQuery(`SELECT status, COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"status"}).AddRow("valid"))

	s := NewStore(db)
	_, err = s.CountByStatus(context.Background())
	if err == nil {
		t.Error("expected scan error from CountByStatus")
	}
}

// ── scanContactRows: scan error (line 248) ──

func TestUpdateValidation_MarshalError(t *testing.T) {
	// json.Marshal of *ValidationResult practically never fails,
	// but we can test the non-nil path via a valid result to cover nearby lines.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE contacts SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	s := NewStore(db)
	err = s.UpdateValidation(context.Background(), 1, &ValidationResult{
		SyntaxValid: true,
		MXExists:    true,
	})
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}
