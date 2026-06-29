package prodlike

import (
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// TestSyncSchemaAExecsSingleStatement verifies the sync function runs
// exactly one bulk UPSERT statement rather than looping row-by-row.
// Row-by-row syncing against 500k+ rows on prod would be catastrophic.
func TestSyncSchemaAExecsSingleStatement(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1000))

	n, err := SyncSchemaA(t.Context(), db)
	if err != nil {
		t.Fatalf("SyncSchemaA: %v", err)
	}
	if n != 1000 {
		t.Errorf("expected 1000 rows affected, got %d", n)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("mock expectations: %v", err)
	}
}

// TestVerifySchemaParityReturnsCounts confirms the diagnostic helper
// executes two distinct counts and sets parity true only when they
// match.
func TestVerifySchemaParityReturnsCounts(t *testing.T) {
	cases := []struct {
		name                   string
		outreach, contacts     int
		wantParity             bool
	}{
		{"equal", 500, 500, true},
		{"schemaA behind", 500, 450, false},
		{"schemaA ahead", 500, 520, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatalf("sqlmock: %v", err)
			}
			defer db.Close()

			mock.ExpectQuery(`SELECT COUNT\(\*\) FROM outreach_contacts`).
				WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(tc.outreach))
			mock.ExpectQuery(`SELECT COUNT\(\*\) FROM contacts c`).
				WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(tc.contacts))

			oc, cc, parity, err := VerifySchemaParity(t.Context(), db)
			if err != nil {
				t.Fatalf("VerifySchemaParity: %v", err)
			}
			if oc != tc.outreach || cc != tc.contacts {
				t.Errorf("got counts %d/%d, want %d/%d", oc, cc, tc.outreach, tc.contacts)
			}
			if parity != tc.wantParity {
				t.Errorf("parity = %v, want %v", parity, tc.wantParity)
			}
		})
	}
}
