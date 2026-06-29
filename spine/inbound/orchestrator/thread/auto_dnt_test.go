package thread

import (
	"context"
	"database/sql"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestApplyAutoDNT_NegativeCategory_Applied(t *testing.T) {
	// When category is "negative", auto-DNT should apply.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	contactID := int64(42)
	ctx := context.Background()

	// Expect setContactDNT query
	mock.ExpectExec(`UPDATE outreach_contacts\s+SET dnt = true\s+WHERE id = \$1`).
		WithArgs(contactID).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Expect insertSuppression query
	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WithArgs(contactID, "auto_dnt_classifier").
		WillReturnResult(sqlmock.NewResult(0, 1))

	result, err := ApplyAutoDNT(ctx, db, contactID, "negative")

	if err != nil {
		t.Fatalf("ApplyAutoDNT() error: %v", err)
	}
	if !result.Applied {
		t.Errorf("ApplyAutoDNT() Applied = false, want true")
	}
	if result.Error != nil {
		t.Errorf("ApplyAutoDNT() Error = %v, want nil", result.Error)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("mock expectations not met: %v", err)
	}
}

func TestApplyAutoDNT_NeutralCategory_NoOp(t *testing.T) {
	// When category is "neutral", auto-DNT should NOT apply.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	contactID := int64(43)
	ctx := context.Background()

	// No database calls expected
	result, err := ApplyAutoDNT(ctx, db, contactID, "neutral")

	if err != nil {
		t.Fatalf("ApplyAutoDNT() error: %v", err)
	}
	if result.Applied {
		t.Errorf("ApplyAutoDNT() Applied = true, want false")
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("mock expectations not met: %v", err)
	}
}

func TestApplyAutoDNT_InterestedCategory_NoOp(t *testing.T) {
	// When category is "interested", auto-DNT should NOT apply.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	contactID := int64(44)
	ctx := context.Background()

	result, err := ApplyAutoDNT(ctx, db, contactID, "interested")

	if err != nil {
		t.Fatalf("ApplyAutoDNT() error: %v", err)
	}
	if result.Applied {
		t.Errorf("ApplyAutoDNT() Applied = true, want false")
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("mock expectations not met: %v", err)
	}
}

func TestApplyAutoDNT_QuestionCategory_NoOp(t *testing.T) {
	// When category is "question", auto-DNT should NOT apply.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	contactID := int64(45)
	ctx := context.Background()

	result, err := ApplyAutoDNT(ctx, db, contactID, "question")

	if err != nil {
		t.Fatalf("ApplyAutoDNT() error: %v", err)
	}
	if result.Applied {
		t.Errorf("ApplyAutoDNT() Applied = true, want false")
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("mock expectations not met: %v", err)
	}
}

func TestApplyAutoDNT_SetContactDNT_Error(t *testing.T) {
	// When setContactDNT fails, ApplyAutoDNT should return the error.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	contactID := int64(46)
	ctx := context.Background()

	// Expect setContactDNT to fail
	mock.ExpectExec(`UPDATE outreach_contacts\s+SET dnt = true\s+WHERE id = \$1`).
		WithArgs(contactID).
		WillReturnError(sql.ErrConnDone)

	result, err := ApplyAutoDNT(ctx, db, contactID, "negative")

	if err == nil {
		t.Fatal("ApplyAutoDNT() error = nil, want error")
	}
	if result.Applied {
		t.Errorf("ApplyAutoDNT() Applied = true, want false on error")
	}
	// result.Error is the unwrapped error, but ApplyAutoDNT wraps it
	// so we check that err is non-nil (which indicates the wrapped error)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("mock expectations not met: %v", err)
	}
}

func TestApplyAutoDNT_InsertSuppression_Error(t *testing.T) {
	// When insertSuppression fails, ApplyAutoDNT should return the error.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	contactID := int64(47)
	ctx := context.Background()

	// Expect setContactDNT to succeed
	mock.ExpectExec(`UPDATE outreach_contacts\s+SET dnt = true\s+WHERE id = \$1`).
		WithArgs(contactID).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Expect insertSuppression to fail
	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WithArgs(contactID, "auto_dnt_classifier").
		WillReturnError(sql.ErrNoRows)

	result, err := ApplyAutoDNT(ctx, db, contactID, "negative")

	if err == nil {
		t.Fatal("ApplyAutoDNT() error = nil, want error")
	}
	if result.Applied {
		t.Errorf("ApplyAutoDNT() Applied = true, want false on error")
	}
	// result.Error is the unwrapped error, but ApplyAutoDNT wraps it
	// so we check that err is non-nil (which indicates the wrapped error)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("mock expectations not met: %v", err)
	}
}

func TestApplyAutoDNT_AlreadyDNT_Idempotent(t *testing.T) {
	// When a contact is already DNT, re-applying should succeed (idempotent).
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	contactID := int64(48)
	ctx := context.Background()

	// Expect setContactDNT to succeed (even if already true)
	mock.ExpectExec(`UPDATE outreach_contacts\s+SET dnt = true\s+WHERE id = \$1`).
		WithArgs(contactID).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Expect insertSuppression to succeed (ON CONFLICT DO NOTHING)
	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WithArgs(contactID, "auto_dnt_classifier").
		WillReturnResult(sqlmock.NewResult(0, 0))

	result, err := ApplyAutoDNT(ctx, db, contactID, "negative")

	if err != nil {
		t.Fatalf("ApplyAutoDNT() error: %v", err)
	}
	if !result.Applied {
		t.Errorf("ApplyAutoDNT() Applied = false, want true (idempotent)")
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("mock expectations not met: %v", err)
	}
}

func TestIsAutoDNTCategory_NegativeOnly(t *testing.T) {
	tests := []struct {
		name     string
		category string
		want     bool
	}{
		{"negative", "negative", true},
		{"Negative uppercase", "NEGATIVE", false}, // case-sensitive
		{"positive", "positive", false},
		{"neutral", "neutral", false},
		{"question", "question", false},
		{"interested", "interested", false},
		{"meeting", "meeting", false},
		{"later", "later", false},
		{"objection", "objection", false},
		{"ooo", "ooo", false},
		{"empty string", "", false},
		{"unsubscribe placeholder", "unsubscribe", false}, // future feature
		{"legal_threat placeholder", "legal_threat", false},
		{"do_not_contact placeholder", "do_not_contact", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isAutoDNTCategory(tt.category)
			if got != tt.want {
				t.Errorf("isAutoDNTCategory(%q) = %v, want %v", tt.category, got, tt.want)
			}
		})
	}
}

func TestSetContactDNT_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	contactID := int64(49)
	ctx := context.Background()

	mock.ExpectExec(`UPDATE outreach_contacts\s+SET dnt = true\s+WHERE id = \$1`).
		WithArgs(contactID).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err = setContactDNT(ctx, db, contactID)

	if err != nil {
		t.Fatalf("setContactDNT() error: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("mock expectations not met: %v", err)
	}
}

func TestSetContactDNT_Error(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	contactID := int64(50)
	ctx := context.Background()

	mock.ExpectExec(`UPDATE outreach_contacts\s+SET dnt = true\s+WHERE id = \$1`).
		WithArgs(contactID).
		WillReturnError(sql.ErrConnDone)

	err = setContactDNT(ctx, db, contactID)

	if err == nil {
		t.Fatal("setContactDNT() error = nil, want error")
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("mock expectations not met: %v", err)
	}
}

func TestInsertSuppression_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	contactID := int64(51)
	reason := "auto_dnt_classifier"
	ctx := context.Background()

	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WithArgs(contactID, reason).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err = insertSuppression(ctx, db, contactID, reason)

	if err != nil {
		t.Fatalf("insertSuppression() error: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("mock expectations not met: %v", err)
	}
}

func TestInsertSuppression_ConflictIgnored(t *testing.T) {
	// ON CONFLICT DO NOTHING returns success even if no row was inserted.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	contactID := int64(52)
	reason := "auto_dnt_classifier"
	ctx := context.Background()

	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WithArgs(contactID, reason).
		WillReturnResult(sqlmock.NewResult(0, 0))

	err = insertSuppression(ctx, db, contactID, reason)

	if err != nil {
		t.Fatalf("insertSuppression() error: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("mock expectations not met: %v", err)
	}
}
