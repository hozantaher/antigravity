package db

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ---- Migrate: filesystem-only paths ----

func TestMigrate_NonExistentDir_Error(t *testing.T) {
	db, _, _ := sqlmock.New()
	defer db.Close()
	if err := Migrate(db, "/tmp/no-such-dir-xyz-abc"); err == nil {
		t.Fatal("expected error for missing dir")
	}
}

func TestMigrate_EmptyDir_Noop(t *testing.T) {
	dir := t.TempDir()
	db, _, _ := sqlmock.New()
	defer db.Close()
	if err := Migrate(db, dir); err != nil {
		t.Fatal(err)
	}
}

func TestMigrate_NilDB_Error(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "001_init.sql"), []byte("SELECT 1"), 0600)
	if err := Migrate(nil, dir); err == nil {
		t.Fatal("expected error for nil db")
	}
}

// ---- Migrate: sqlmock paths ----

func TestMigrate_AlreadyApplied_Skip(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "001_init.sql"), []byte("CREATE TABLE t (id INT)"), 0600)

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`CREATE TABLE IF NOT EXISTS schema_migrations`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))

	if err := Migrate(db, dir); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestMigrate_NewMigration_Applied(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "002_new.sql"), []byte("CREATE TABLE new_table (id INT)"), 0600)

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
	mock.ExpectExec(`CREATE TABLE new_table`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO schema_migrations`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	if err := Migrate(db, dir); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestMigrate_TwoFiles_OnlyNewRuns(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "001_old.sql"), []byte("SELECT 1"), 0600)
	_ = os.WriteFile(filepath.Join(dir, "002_new.sql"), []byte("SELECT 2"), 0600)

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`CREATE TABLE IF NOT EXISTS schema_migrations`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectBegin()
	mock.ExpectExec(`SELECT 2`).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO schema_migrations`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	if err := Migrate(db, dir); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestMigrate_ExecFails_RollsBack(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "001_bad.sql"), []byte("BAD SQL HERE"), 0600)

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
	mock.ExpectExec(`BAD SQL HERE`).WillReturnError(errors.New("syntax error"))
	mock.ExpectRollback()

	if err := Migrate(db, dir); err == nil {
		t.Fatal("expected error on bad SQL")
	}
}

// ---- isMigrationApplied ----

func TestIsMigrationApplied_True(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))

	applied, err := isMigrationApplied(db, "001_init")
	if err != nil {
		t.Fatal(err)
	}
	if !applied {
		t.Fatal("expected applied=true")
	}
}

func TestIsMigrationApplied_False(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))

	applied, err := isMigrationApplied(db, "002_new")
	if err != nil {
		t.Fatal(err)
	}
	if applied {
		t.Fatal("expected applied=false")
	}
}

// ---- Connect: error paths via sqlmock and db.Begin/Exec/Commit errors ----

func TestMigrate_CheckMigrationError_PropagatesError(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "001_check.sql"), []byte("SELECT 1"), 0600)

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`CREATE TABLE IF NOT EXISTS schema_migrations`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnError(errors.New("database error"))

	if err := Migrate(db, dir); err == nil {
		t.Fatal("expected error when isMigrationApplied fails")
	}
}

func TestMigrate_BeginError_ReturnsError(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "001_begin_fail.sql"), []byte("SELECT 1"), 0600)

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
		t.Fatal("expected error when Begin fails")
	}
}

func TestMigrate_InsertMigrationRecordError_RollsBack(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "001_insert_fail.sql"), []byte("SELECT 1"), 0600)

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
	mock.ExpectExec(`SELECT 1`).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO schema_migrations`).
		WillReturnError(errors.New("insert failed"))
	mock.ExpectRollback()

	if err := Migrate(db, dir); err == nil {
		t.Fatal("expected error when INSERT into schema_migrations fails")
	}
}

func TestMigrate_CommitError_ReturnsError(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "001_commit_fail.sql"), []byte("SELECT 1"), 0600)

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
	mock.ExpectExec(`SELECT 1`).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO schema_migrations`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit().WillReturnError(errors.New("commit failed"))
	mock.ExpectRollback()

	if err := Migrate(db, dir); err == nil {
		t.Fatal("expected error when Commit fails")
	}
}

func TestIsMigrationApplied_Error(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnError(errors.New("query failed"))

	_, err = isMigrationApplied(db, "001_test")
	if err == nil {
		t.Fatal("expected error from isMigrationApplied")
	}
}
