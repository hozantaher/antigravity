package prospect

import (
	"context"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
	"contacts/contact"
)

// firmyRow returns a sqlmock.Rows with the same 16 columns as Fetch expects.
func firmyRow(id int, email string) *sqlmock.Rows {
	return sqlmock.NewRows(firmyCols).AddRow(
		id, "Firma s.r.o.", email, "+420111", "12345678", "https://firma.cz",
		"Praha", "Ulice 1", "110 00",
		"Strojírenství", "10-19", "111", "Výroba",
		`[{"name":"Výroba"}]`, 4.0, 5,
	)
}

func TestImportToStore_FetchError(t *testing.T) {
	firmyDB, firmyMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer firmyDB.Close()

	firmyMock.ExpectQuery(`SELECT`).WillReturnError(errProspect("db down"))

	contactDB, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer contactDB.Close()
	store := contact.NewStore(contactDB)

	_, _, err = newFirmySourceFromDB(firmyDB).ImportToStore(context.Background(), store, FirmyFilter{})
	if err == nil {
		t.Fatal("expected error from Fetch")
	}
}

func TestImportToStore_EmptyFetch_ZeroImported(t *testing.T) {
	firmyDB, firmyMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer firmyDB.Close()

	firmyMock.ExpectQuery(`SELECT`).WillReturnRows(sqlmock.NewRows(firmyCols))

	contactDB, contactMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer contactDB.Close()
	contactMock.ExpectBegin()
	contactMock.ExpectPrepare(`INSERT INTO contacts`)
	contactMock.ExpectCommit()
	store := contact.NewStore(contactDB)

	imported, skipped, err := newFirmySourceFromDB(firmyDB).ImportToStore(context.Background(), store, FirmyFilter{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imported != 0 {
		t.Errorf("expected 0 imported, got %d", imported)
	}
	if skipped != 0 {
		t.Errorf("expected 0 skipped, got %d", skipped)
	}
}

func TestImportToStore_NoEmailRow_Skipped(t *testing.T) {
	firmyDB, firmyMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer firmyDB.Close()

	// Row with empty email → skipped
	firmyMock.ExpectQuery(`SELECT`).WillReturnRows(firmyRow(1, ""))

	contactDB, contactMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer contactDB.Close()
	contactMock.ExpectBegin()
	contactMock.ExpectPrepare(`INSERT INTO contacts`)
	contactMock.ExpectCommit()
	store := contact.NewStore(contactDB)

	imported, skipped, err := newFirmySourceFromDB(firmyDB).ImportToStore(context.Background(), store, FirmyFilter{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imported != 0 {
		t.Errorf("expected 0 imported, got %d", imported)
	}
	if skipped != 1 {
		t.Errorf("expected 1 skipped, got %d", skipped)
	}
}

func TestImportToStore_OneRow_Imported(t *testing.T) {
	firmyDB, firmyMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer firmyDB.Close()

	firmyMock.ExpectQuery(`SELECT`).WillReturnRows(firmyRow(2, "info@firma.cz"))

	contactDB, contactMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer contactDB.Close()
	contactMock.ExpectBegin()
	contactMock.ExpectPrepare(`INSERT INTO contacts`)
	contactMock.ExpectExec(`INSERT INTO contacts`).WillReturnResult(sqlmock.NewResult(1, 1))
	contactMock.ExpectCommit()
	store := contact.NewStore(contactDB)

	imported, skipped, err := newFirmySourceFromDB(firmyDB).ImportToStore(context.Background(), store, FirmyFilter{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imported != 1 {
		t.Errorf("expected 1 imported, got %d", imported)
	}
	if skipped != 0 {
		t.Errorf("expected 0 skipped, got %d", skipped)
	}
	if err := contactMock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestImportToStore_DuplicateRow_Skipped(t *testing.T) {
	firmyDB, firmyMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer firmyDB.Close()

	firmyMock.ExpectQuery(`SELECT`).WillReturnRows(firmyRow(3, "dup@firma.cz"))

	contactDB, contactMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer contactDB.Close()
	contactMock.ExpectBegin()
	contactMock.ExpectPrepare(`INSERT INTO contacts`)
	// 0 rows affected = ON CONFLICT DO NOTHING hit → duplicate
	contactMock.ExpectExec(`INSERT INTO contacts`).WillReturnResult(sqlmock.NewResult(0, 0))
	contactMock.ExpectCommit()
	store := contact.NewStore(contactDB)

	imported, skipped, err := newFirmySourceFromDB(firmyDB).ImportToStore(context.Background(), store, FirmyFilter{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imported != 0 {
		t.Errorf("expected 0 imported (duplicate), got %d", imported)
	}
	if skipped != 1 {
		t.Errorf("expected 1 skipped (duplicate), got %d", skipped)
	}
}

func TestImportToStore_BulkImportExecError(t *testing.T) {
	firmyDB, firmyMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer firmyDB.Close()

	firmyMock.ExpectQuery(`SELECT`).WillReturnRows(firmyRow(4, "err@firma.cz"))

	contactDB, contactMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer contactDB.Close()
	contactMock.ExpectBegin()
	contactMock.ExpectPrepare(`INSERT INTO contacts`)
	contactMock.ExpectExec(`INSERT INTO contacts`).WillReturnError(errProspect("exec failed"))
	store := contact.NewStore(contactDB)

	_, _, err = newFirmySourceFromDB(firmyDB).ImportToStore(context.Background(), store, FirmyFilter{})
	if err == nil {
		t.Fatal("expected error from BulkImport exec failure")
	}
}
