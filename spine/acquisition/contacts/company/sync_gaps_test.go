package company

import (
	"context"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

var errCompanySync = errors.New("company sync test error")

// ── bulkUpsert: Upsert error (line 106-108) ──

func TestBulkUpsert_UpsertError(t *testing.T) {
	// firmyDB returns one company row
	firmyDB, firmyMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer firmyDB.Close()

	firmyMock.ExpectQuery(`SELECT id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "ico", "name", "email", "telephone", "website",
			"street_address", "address_locality", "postal_code", "description",
			"velikost_firmy", "pravni_forma", "category_path", "categories_json",
			"rating_value", "rating_count",
		}).AddRow(1, "12345678", "Test s.r.o.", "test@test.cz", "", "",
			"", "", "", "", "", "", "", "", 0, 0))

	// outreachDB: Upsert → INSERT → fails
	outreachDB, outreachMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer outreachDB.Close()

	outreachMock.ExpectQuery(`INSERT INTO companies`).
		WillReturnError(errCompanySync)

	s := NewSyncer(firmyDB, outreachDB, SyncConfig{BatchSize: 10})
	_, err = s.bulkUpsert(context.Background())
	if err == nil {
		t.Error("expected error from bulkUpsert when Upsert fails")
	}
}

// ── fetchBatch: scan error (line 333-335) ──

func TestFetchBatch_ScanError(t *testing.T) {
	firmyDB, firmyMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer firmyDB.Close()

	// Return wrong column count → scan fails
	firmyMock.ExpectQuery(`SELECT id`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "name"}).AddRow(1, "bad"))

	outreachDB, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer outreachDB.Close()

	s := NewSyncer(firmyDB, outreachDB, SyncConfig{BatchSize: 10})
	_, _, err = s.fetchBatch(context.Background(), 0)
	if err == nil {
		t.Error("expected scan error from fetchBatch")
	}
}
