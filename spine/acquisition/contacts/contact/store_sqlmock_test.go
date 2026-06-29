package contact

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── CountByStatus via sqlmock ──

func TestCountByStatus_WithRows(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)

	mock.ExpectQuery(`SELECT status, COUNT\(\*\) FROM contacts GROUP BY status`).
		WillReturnRows(sqlmock.NewRows([]string{"status", "count"}).
			AddRow("new", 100).
			AddRow("valid", 50).
			AddRow("bounced", 10))

	result, err := s.CountByStatus(context.Background())
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result[StatusNew] != 100 { t.Errorf("new = %d, want 100", result[StatusNew]) }
	if result[StatusValid] != 50 { t.Errorf("valid = %d, want 50", result[StatusValid]) }
	if result[StatusBounced] != 10 { t.Errorf("bounced = %d, want 10", result[StatusBounced]) }
}

func TestCountByStatus_EmptyResult(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)

	mock.ExpectQuery(`SELECT status, COUNT\(\*\) FROM contacts GROUP BY status`).
		WillReturnRows(sqlmock.NewRows([]string{"status", "count"}))

	result, err := s.CountByStatus(context.Background())
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(result) != 0 { t.Errorf("expected empty map, got %v", result) }
}

func TestCountByStatus_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)

	mock.ExpectQuery(`SELECT status, COUNT\(\*\) FROM contacts GROUP BY status`).
		WillReturnError(errContact("db error"))

	_, err = s.CountByStatus(context.Background())
	if err == nil { t.Error("expected error") }
}

// ── FindBySegment via sqlmock ──

var contactColumns = []string{
	"id", "email", "email_hash", "first_name", "last_name",
	"company_name", "ico", "region", "industry", "company_size",
	"score", "status", "validation_result",
	"source", "imported_at", "validated_at", "last_contacted",
	"created_at", "updated_at",
}

func addContactRow(rows *sqlmock.Rows, id int, email, status string) *sqlmock.Rows {
	now := time.Now()
	return rows.AddRow(
		id, email, "hash123", "First", "Last",
		"Company", "12345678", "Praha", "machinery", "small",
		75, status, nil,
		"csv", now, nil, nil,
		now, now,
	)
}

func TestFindBySegment_WithRows(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)

	rows := sqlmock.NewRows(contactColumns)
	addContactRow(rows, 1, "a@firma.cz", "new")
	addContactRow(rows, 2, "b@firma.cz", "valid")

	mock.ExpectQuery(`SELECT id, email`).
		WillReturnRows(rows)

	contacts, err := s.FindBySegment(context.Background(), SegmentFilter{}, 10, 0)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(contacts) != 2 { t.Errorf("expected 2, got %d", len(contacts)) }
	if contacts[0].ID != 1 { t.Error("first contact ID") }
	if contacts[0].Email != "a@firma.cz" { t.Error("first contact email") }
}

func TestFindBySegment_EmptyResult(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)

	mock.ExpectQuery(`SELECT id, email`).
		WillReturnRows(sqlmock.NewRows(contactColumns))

	contacts, err := s.FindBySegment(context.Background(), SegmentFilter{}, 10, 0)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(contacts) != 0 { t.Errorf("expected 0, got %d", len(contacts)) }
}

func TestFindBySegment_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)

	mock.ExpectQuery(`SELECT id, email`).
		WillReturnError(errContact("query failed"))

	_, err = s.FindBySegment(context.Background(), SegmentFilter{}, 10, 0)
	if err == nil { t.Error("expected error") }
}

func TestFindBySegment_WithStatuses(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)

	rows := sqlmock.NewRows(contactColumns)
	addContactRow(rows, 5, "c@firma.cz", "valid")

	mock.ExpectQuery(`SELECT id, email`).
		WillReturnRows(rows)

	contacts, err := s.FindBySegment(context.Background(), SegmentFilter{
		Statuses: []Status{StatusValid},
	}, 10, 0)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(contacts) != 1 { t.Errorf("expected 1, got %d", len(contacts)) }
}

func TestFindBySegment_WithMinScore(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)

	rows := sqlmock.NewRows(contactColumns)
	addContactRow(rows, 3, "c@firma.cz", "valid")

	mock.ExpectQuery(`SELECT id, email`).
		WillReturnRows(rows)

	minScore := 70
	contacts, err := s.FindBySegment(context.Background(), SegmentFilter{
		MinScore: &minScore,
	}, 5, 0)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(contacts) != 1 { t.Errorf("expected 1 contact (above min score), got %d", len(contacts)) }
	if err := mock.ExpectationsWereMet(); err != nil { t.Errorf("unmet expectations: %v", err) }
}

func TestFindBySegment_WithRegions(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)

	rows := sqlmock.NewRows(contactColumns)
	addContactRow(rows, 4, "d@firma.cz", "new")
	addContactRow(rows, 5, "e@firma.cz", "valid")

	mock.ExpectQuery(`SELECT id, email`).
		WillReturnRows(rows)

	contacts, err := s.FindBySegment(context.Background(), SegmentFilter{
		Regions: []string{"Praha", "Brno"},
	}, 10, 0)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(contacts) != 2 { t.Errorf("expected 2 contacts for Praha+Brno filter, got %d", len(contacts)) }
	if err := mock.ExpectationsWereMet(); err != nil { t.Errorf("unmet expectations: %v", err) }
}

// ── Create via sqlmock ──

func TestCreate_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)

	mock.ExpectExec(`INSERT INTO contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	c := &Contact{
		Email:       "new@firma.cz",
		FirstName:   "Jan",
		LastName:    "Novák",
		CompanyName: "Firma s.r.o.",
		Status:      StatusNew,
		Source:      "csv",
	}
	if err := s.Create(context.Background(), c); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestCreate_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)

	mock.ExpectExec(`INSERT INTO contacts`).
		WillReturnError(errContact("insert failed"))

	c := &Contact{Email: "x@firma.cz", Status: StatusNew}
	if err := s.Create(context.Background(), c); err == nil {
		t.Error("expected error")
	}
}

type errContact string
func (e errContact) Error() string { return string(e) }

// ── UpdateValidation status logic via sqlmock (verifies actual status argument) ──

func TestUpdateValidation_StatusLogic_ValidEmail(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)

	// SyntaxValid=true, MXExists=true, IsDisposable=false → status = "valid"
	mock.ExpectExec(`UPDATE contacts SET`).
		WithArgs(sqlmock.AnyArg(), "valid", int64(1)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	vr := &ValidationResult{SyntaxValid: true, MXExists: true, IsDisposable: false}
	if err := s.UpdateValidation(context.Background(), 1, vr); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations (wrong status passed): %v", err)
	}
}

func TestUpdateValidation_StatusLogic_InvalidNoSyntax(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)

	// SyntaxValid=false → status must be "invalid"
	mock.ExpectExec(`UPDATE contacts SET`).
		WithArgs(sqlmock.AnyArg(), "invalid", int64(2)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	vr := &ValidationResult{SyntaxValid: false, MXExists: true, IsDisposable: false}
	if err := s.UpdateValidation(context.Background(), 2, vr); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations (wrong status passed): %v", err)
	}
}

func TestUpdateValidation_StatusLogic_InvalidNoMX(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)

	// MXExists=false → status must be "invalid"
	mock.ExpectExec(`UPDATE contacts SET`).
		WithArgs(sqlmock.AnyArg(), "invalid", int64(3)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	vr := &ValidationResult{SyntaxValid: true, MXExists: false, IsDisposable: false}
	if err := s.UpdateValidation(context.Background(), 3, vr); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations (wrong status passed): %v", err)
	}
}

func TestUpdateValidation_StatusLogic_InvalidDisposable(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)

	// IsDisposable=true → status must be "invalid" even if syntax+MX are valid
	mock.ExpectExec(`UPDATE contacts SET`).
		WithArgs(sqlmock.AnyArg(), "invalid", int64(4)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	vr := &ValidationResult{SyntaxValid: true, MXExists: true, IsDisposable: true}
	if err := s.UpdateValidation(context.Background(), 4, vr); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations (disposable email should produce invalid): %v", err)
	}
}

// ── FindByID via sqlmock ──

func TestFindByID_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)
	mock.ExpectQuery(`SELECT id, email`).
		WillReturnRows(sqlmock.NewRows(contactColumns))

	_, err = s.FindByID(context.Background(), 999)
	if err == nil { t.Error("expected error for not found") }
}

func TestFindByID_Found(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)
	now := time.Now()
	rows := sqlmock.NewRows(contactColumns).AddRow(
		42, "jan@firma.cz", "abc123hash", "Jan", "Novák",
		"Firma s.r.o.", "12345678", "Praha", "machinery", "small",
		80, "new", nil,
		"csv", now, nil, nil,
		now, now,
	)
	mock.ExpectQuery(`SELECT id, email`).WillReturnRows(rows)

	c, err := s.FindByID(context.Background(), 42)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if c.ID != 42 { t.Errorf("ID = %d, want 42", c.ID) }
	if c.Email != "jan@firma.cz" { t.Errorf("Email = %s", c.Email) }
}

func TestFindByID_WithAllNullableFields(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)
	now := time.Now()
	validationJSON := `{"syntax_valid":true,"risk_level":"low"}`
	rows := sqlmock.NewRows(contactColumns).AddRow(
		7, "test@firma.cz", "hash7", "Karel", "Novák",
		"Strojírna", "98765432", "Brno", "metalwork", "medium",
		65, "valid", validationJSON,
		"api", now, now, now,
		now, now,
	)
	mock.ExpectQuery(`SELECT id, email`).WillReturnRows(rows)

	c, err := s.FindByID(context.Background(), 7)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if c.ValidationResult == nil { t.Error("ValidationResult should be parsed") }
	if c.ValidatedAt == nil { t.Error("ValidatedAt should be set") }
	if c.LastContacted == nil { t.Error("LastContacted should be set") }
}

// ── FindByEmail via sqlmock ──

func TestFindByEmail_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)
	mock.ExpectQuery(`SELECT id, email`).
		WillReturnRows(sqlmock.NewRows(contactColumns))

	_, err = s.FindByEmail(context.Background(), "nobody@firma.cz")
	if err == nil { t.Error("expected error for not found") }
}

func TestFindByEmail_Found(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)
	now := time.Now()
	rows := sqlmock.NewRows(contactColumns).AddRow(
		5, "found@firma.cz", "hashfound", "Eva", "Nová",
		"Firma", "11111111", "Ostrava", "construction", "large",
		90, "valid", nil,
		"web", now, nil, nil,
		now, now,
	)
	mock.ExpectQuery(`SELECT id, email`).WillReturnRows(rows)

	c, err := s.FindByEmail(context.Background(), "found@firma.cz")
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if c.Email != "found@firma.cz" { t.Errorf("Email = %s", c.Email) }
}

// ── scanContactRows nullable branches via FindBySegment ──

func TestFindBySegment_WithNullableFields(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)
	now := time.Now()
	validationJSON := `{"syntax_valid":true,"mx_exists":true,"risk_level":"low"}`
	rows := sqlmock.NewRows(contactColumns).AddRow(
		10, "scan@firma.cz", "scanhash", "Petr", "Jícha",
		"Strojírna", "12340001", "Plzeň", "machinery", "medium",
		80, "valid", validationJSON,
		"api", now, now, now,
		now, now,
	)
	mock.ExpectQuery(`SELECT id, email`).WillReturnRows(rows)

	contacts, err := s.FindBySegment(context.Background(), SegmentFilter{}, 10, 0)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(contacts) != 1 { t.Fatalf("expected 1 contact, got %d", len(contacts)) }
	c := contacts[0]
	if c.ValidationResult == nil { t.Error("ValidationResult should be parsed from JSON") }
	if c.ValidatedAt == nil { t.Error("ValidatedAt should be set") }
	if c.LastContacted == nil { t.Error("LastContacted should be set") }
}

// ── BulkImport via sqlmock ──

func TestBulkImport_BeginError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)
	mock.ExpectBegin().WillReturnError(errContact("begin failed"))

	_, err = s.BulkImport(context.Background(), []Contact{{Email: "a@firma.cz"}})
	if err == nil { t.Error("expected begin error") }
}

func TestBulkImport_PrepareError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)
	mock.ExpectBegin()
	mock.ExpectPrepare(`INSERT INTO contacts`).WillReturnError(errContact("prepare failed"))
	mock.ExpectRollback()

	_, err = s.BulkImport(context.Background(), []Contact{{Email: "a@firma.cz"}})
	if err == nil { t.Error("expected prepare error") }
}

func TestBulkImport_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)
	mock.ExpectBegin()
	prep := mock.ExpectPrepare(`INSERT INTO contacts`)
	// first contact inserted (1 row affected)
	prep.ExpectExec().WillReturnResult(sqlmock.NewResult(1, 1))
	// second contact duplicate (0 rows affected)
	prep.ExpectExec().WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()

	contacts := []Contact{
		{Email: "new@firma.cz", Source: "csv"},
		{Email: "dup@firma.cz", Source: "csv"},
	}
	result, err := s.BulkImport(context.Background(), contacts)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Imported != 1 { t.Errorf("Imported = %d, want 1", result.Imported) }
	if len(result.Skipped) != 1 { t.Errorf("Skipped = %d, want 1", len(result.Skipped)) }
}

func TestBulkImport_ExecError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)
	mock.ExpectBegin()
	prep := mock.ExpectPrepare(`INSERT INTO contacts`)
	prep.ExpectExec().WillReturnError(errContact("exec failed"))
	mock.ExpectRollback()

	contacts := []Contact{{Email: "bad@firma.cz", Source: "csv"}}
	_, err = s.BulkImport(context.Background(), contacts)
	if err == nil { t.Error("expected exec error") }
}

func TestBulkImport_EmptyInput(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewStore(db)
	mock.ExpectBegin()
	mock.ExpectPrepare(`INSERT INTO contacts`)
	mock.ExpectCommit()

	result, err := s.BulkImport(context.Background(), []Contact{})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Imported != 0 { t.Errorf("Imported = %d, want 0", result.Imported) }
}
