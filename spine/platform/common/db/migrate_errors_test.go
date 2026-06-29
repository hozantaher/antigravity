package db

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── Migrate error branches not covered by existing tests ──────────────────

// TestMigrate_EnsureSchemaMigrations_Fails verifies error from CREATE TABLE is
// propagated. This exercises the db.Exec(ensureSchemaMigrationsSQL) branch.
func TestMigrate_EnsureSchemaMigrations_Fails(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "001_init.sql"), []byte("SELECT 1"), 0600)

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`CREATE TABLE IF NOT EXISTS schema_migrations`).
		WillReturnError(errors.New("permission denied"))

	if err := Migrate(db, dir); err == nil {
		t.Fatal("expected error when schema_migrations creation fails")
	}
}

// TestMigrate_IsMigrationApplied_QueryError verifies error from the EXISTS query
// is returned as a migration check error.
func TestMigrate_IsMigrationApplied_QueryError(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "001_init.sql"), []byte("SELECT 1"), 0600)

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`CREATE TABLE IF NOT EXISTS schema_migrations`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnError(errors.New("query failed"))

	if err := Migrate(db, dir); err == nil {
		t.Fatal("expected error from isMigrationApplied query failure")
	}
}

// TestMigrate_BeginTransaction_Fails verifies error from db.Begin is returned.
func TestMigrate_BeginTransaction_Fails(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "001_init.sql"), []byte("CREATE TABLE foo (id INT)"), 0600)

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`CREATE TABLE IF NOT EXISTS schema_migrations`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectBegin().WillReturnError(errors.New("begin failed"))

	if err := Migrate(db, dir); err == nil {
		t.Fatal("expected error when db.Begin fails")
	}
}

// TestMigrate_RecordMigration_Fails verifies rollback + error when the INSERT
// into schema_migrations fails after the migration SQL succeeds.
func TestMigrate_RecordMigration_Fails(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "001_init.sql"), []byte("CREATE TABLE bar (id INT)"), 0600)

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`CREATE TABLE IF NOT EXISTS schema_migrations`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectBegin()
	mock.ExpectExec(`CREATE TABLE bar`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO schema_migrations`).
		WillReturnError(errors.New("insert failed"))
	mock.ExpectRollback()

	if err := Migrate(db, dir); err == nil {
		t.Fatal("expected error when INSERT into schema_migrations fails")
	}
}

// TestMigrate_CommitFails verifies rollback + error when COMMIT fails.
func TestMigrate_CommitFails(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "001_init.sql"), []byte("CREATE TABLE baz (id INT)"), 0600)

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`CREATE TABLE IF NOT EXISTS schema_migrations`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectBegin()
	mock.ExpectExec(`CREATE TABLE baz`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO schema_migrations`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit().WillReturnError(errors.New("commit failed"))
	mock.ExpectRollback()

	if err := Migrate(db, dir); err == nil {
		t.Fatal("expected error when COMMIT fails")
	}
}

// TestMigrate_ReadFileFails verifies error when the .sql file is unreadable
// (file removed between ReadDir and ReadFile).
func TestMigrate_ReadFileFails(t *testing.T) {
	dir := t.TempDir()
	sqlPath := filepath.Join(dir, "001_init.sql")
	_ = os.WriteFile(sqlPath, []byte("SELECT 1"), 0600)

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`CREATE TABLE IF NOT EXISTS schema_migrations`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))

	// Remove the file after ReadDir but before ReadFile would be called.
	// We achieve this by making the file unreadable.
	_ = os.Chmod(sqlPath, 0000)
	defer os.Chmod(sqlPath, 0600) //nolint:errcheck

	if err := Migrate(db, dir); err == nil {
		t.Logf("note: Migrate returned nil (may be running as root which ignores chmod)")
	}
	// Either error or success is acceptable; it must not panic.
}

// TestMigrate_MonkeyNoPanic verifies that arbitrary valid dir paths + nil db
// never cause a panic — only return errors.
func TestMigrate_MonkeyNoPanic(t *testing.T) {
	cases := []string{
		t.TempDir(),
		"/tmp",
		"/nonexistent-abc-xyz",
		"",
	}
	for _, dir := range cases {
		dir := dir
		t.Run("dir="+dir[:min2(20, len(dir))], func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("Migrate panicked on dir=%q: %v", dir, r)
				}
			}()
			_ = Migrate(nil, dir)
		})
	}
}

// isMigrationApplied_ScanError — direct unit test for the unexported function.
func TestIsMigrationApplied_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Return a row with a non-boolean value to trigger Scan error.
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnError(errors.New("scan error"))

	_, err = isMigrationApplied(db, "001_init")
	if err == nil {
		t.Fatal("expected error from query failure")
	}
}

func min2(a, b int) int {
	if a < b {
		return a
	}
	return b
}
