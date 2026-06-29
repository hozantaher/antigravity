package prospect

import (
	"context"
	"database/sql"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// newFirmySourceFromDB creates a FirmySource with an existing *sql.DB (for testing).
func newFirmySourceFromDB(db *sql.DB) *FirmySource {
	return &FirmySource{db: db}
}

// ── Count via sqlmock ──

func TestCount_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT COUNT\(\*\)`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(42))

	f := newFirmySourceFromDB(db)
	count, err := f.Count(context.Background(), FirmyFilter{})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if count != 42 { t.Errorf("count = %d, want 42", count) }
}

func TestCount_WithFilter(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT COUNT\(\*\)`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(10))

	f := newFirmySourceFromDB(db)
	count, err := f.Count(context.Background(), FirmyFilter{Region: "Praha", HasEmail: true})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if count != 10 { t.Errorf("count = %d, want 10", count) }
}

func TestCount_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT COUNT\(\*\)`).
		WillReturnError(errProspect("query failed"))

	f := newFirmySourceFromDB(db)
	_, err = f.Count(context.Background(), FirmyFilter{})
	if err == nil { t.Error("expected error") }
}

// ── Fetch via sqlmock ──

var firmyCols = []string{
	"id", "name", "email", "telephone", "ico", "website",
	"address_locality", "street_address", "postal_code",
	"description", "velikost_firmy", "pravni_forma", "category_path",
	"category_path", "rating_value", "rating_count",
}

func TestFetch_EmptyResult(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows(firmyCols))

	f := newFirmySourceFromDB(db)
	results, err := f.Fetch(context.Background(), FirmyFilter{Limit: 10})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(results) != 0 { t.Errorf("expected 0, got %d", len(results)) }
}

func TestFetch_WithRows(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows(firmyCols).
			AddRow(
				1, "Firma s.r.o.", "info@firma.cz", "+420 123 456", "12345678",
				"https://firma.cz",
				"Praha", "Václavské nám. 1", "110 00",
				"Strojírenská firma", "20 - 24 zaměstnanci", "111", "Výroba/Strojírenství",
				`[{"name":"Strojírenství"}]`, 4.5, 12,
			))

	f := newFirmySourceFromDB(db)
	results, err := f.Fetch(context.Background(), FirmyFilter{Limit: 10})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(results) != 1 { t.Errorf("expected 1, got %d", len(results)) }
	if results[0].Email != "info@firma.cz" { t.Errorf("email = %s", results[0].Email) }
	if results[0].RatingValue != 4.5 { t.Errorf("rating = %f", results[0].RatingValue) }
}

func TestFetch_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT`).
		WillReturnError(errProspect("query failed"))

	f := newFirmySourceFromDB(db)
	_, err = f.Fetch(context.Background(), FirmyFilter{})
	if err == nil { t.Error("expected error") }
}

// ── Close ──

func TestClose_NotPanic(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }

	f := newFirmySourceFromDB(db)
	// Close should not panic
	f.Close()
}

type errProspect string
func (e errProspect) Error() string { return string(e) }
