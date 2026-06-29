package warmup

import (
	"context"
	"regexp"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

func TestDaemon_Reset_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(regexp.QuoteMeta("UPDATE mailbox_warmup")).
		WithArgs("jan@firma.cz").
		WillReturnResult(sqlmock.NewResult(0, 1))

	d := NewDaemon(db, map[string]Plan{})
	if err := d.Reset(context.Background(), "jan@firma.cz"); err != nil {
		t.Fatalf("Reset: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestDaemon_Reset_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(regexp.QuoteMeta("UPDATE mailbox_warmup")).
		WillReturnError(sqlmock.ErrCancelled)

	d := NewDaemon(db, map[string]Plan{})
	if err := d.Reset(context.Background(), "jan@firma.cz"); err == nil {
		t.Fatal("expected DB error from Reset")
	}
}
