package company

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── FindByID: NullTime fields set (lines 334-348) ──
// Tests lastContacted, lastReplied, aresSyncedAt, classifiedAt all non-null.

func TestFindByID_WithAllTimestamps(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	now := time.Now()
	rows := sqlmock.NewRows(companyCols).AddRow(
		1, 12345, "12345678", "Firma s.r.o.", "info@firma.cz", "+420 123", "https://firma.cz",
		"Václavské nám. 1", "Praha", "110 00", "Strojírenství",
		"20 - 24 zaměstnanci", "111", "Výroba",
		4.5, 10,
		"scored", 2, 1, 5, 1,
		now, now, // lastContacted, lastReplied — both non-null → lines 334-339
		0.7,
		"pending", "{}", false,
		"{}", "",
		false, false, now, // aresSyncedAt non-null → lines 343-345
		"{}", "",
		0.85, "ml",
		75, "ideal",
		"Praha", now, // classifiedAt non-null → lines 346-348
		time.Now(), time.Now(), time.Now(),
	)
	mock.ExpectQuery(`SELECT`).WillReturnRows(rows)

	s := NewStore(db)
	c, err := s.FindByID(context.Background(), 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.LastContacted == nil {
		t.Error("expected LastContacted to be set")
	}
	if c.LastReplied == nil {
		t.Error("expected LastReplied to be set")
	}
	if c.ARESSyncedAt == nil {
		t.Error("expected ARESSyncedAt to be set")
	}
	if c.ClassifiedAt == nil {
		t.Error("expected ClassifiedAt to be set")
	}
}

// ── TierStats: scan error (line 262) ──

func TestTierStats_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Return 1 column when 2 expected → scan fails
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{"tier"}).AddRow("ideal"))

	s := NewStore(db)
	_, err = s.TierStats(context.Background())
	if err == nil {
		t.Error("expected scan error from TierStats")
	}
}

// ── bulkUpsert: UPDATE error in company sync (company/sync.go:106) ──
// Let me also add the sync error test since it's in the same package

