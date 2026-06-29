package prospect

import (
	"context"
	"math/rand"
	"strings"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── nil-DB safety ─────────────────────────────────────────────────────────────

// TestProspect_NilDB_Safe verifies that a nil *sql.DB inside FirmySource
// causes a recoverable panic (not an unrecoverable crash).
// database/sql itself panics on nil-pointer dereference; these tests
// document that behaviour and confirm recovery is possible.
func TestProspect_NilDB_Safe(t *testing.T) {
	t.Run("Count_nilDB_recoverable", func(t *testing.T) {
		panicked := panicFrom(func() {
			f := &FirmySource{db: nil}
			_, _ = f.Count(context.Background(), FirmyFilter{})
		})
		t.Logf("nil-DB Count panic (expected): %v", panicked)
	})

	t.Run("Fetch_nilDB_recoverable", func(t *testing.T) {
		panicked := panicFrom(func() {
			f := &FirmySource{db: nil}
			_, _ = f.Fetch(context.Background(), FirmyFilter{})
		})
		t.Logf("nil-DB Fetch panic (expected): %v", panicked)
	})
}

// panicFrom executes fn and returns any recovered panic value (nil if no panic).
func panicFrom(fn func()) (recovered interface{}) {
	defer func() { recovered = recover() }()
	fn()
	return nil
}

// ── empty list returns nil slice, not error ───────────────────────────────────

func TestProspect_EmptyList_NoResults(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT`).WillReturnRows(sqlmock.NewRows(firmyCols))

	f := newFirmySourceFromDB(db)
	results, err := f.Fetch(context.Background(), FirmyFilter{Limit: 100})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results, got %d", len(results))
	}
}

// ── property: buildQuery/buildCountQuery never panic ─────────────────────────

// TestProspect_NeverPanics_Property runs buildQuery/buildConditions/MaxID
// with random inputs and verifies none of them panic.
func TestProspect_NeverPanics_Property(t *testing.T) {
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))

	regions := []string{"", "Praha", "Brno", "Ostrava", "Plzeň",
		strings.Repeat("x", 200)}
	descriptions := []string{"", "stroje", "výroba", "oprava",
		strings.Repeat("y", 200)}
	categories := []string{"", "Zemědělství", "Strojírenství", "IT"}

	for i := 0; i < 200; i++ {
		filter := FirmyFilter{
			Region:      regions[rng.Intn(len(regions))],
			HasEmail:    rng.Intn(2) == 1,
			HasPhone:    rng.Intn(2) == 1,
			HasICO:      rng.Intn(2) == 1,
			MinRating:   rng.Float64() * 5,
			Categories:  categories[rng.Intn(len(categories))],
			Description: descriptions[rng.Intn(len(descriptions))],
			Limit:       rng.Intn(10000),
			Offset:      rng.Intn(10000),
			AfterID:     rng.Intn(1000000),
		}

		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("buildQuery panicked: filter=%+v panic=%v", filter, r)
				}
			}()
			q, args := buildQuery("SELECT *", filter)
			if q == "" {
				t.Errorf("empty query for filter=%+v", filter)
			}
			_ = args
		}()

		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("buildCountQuery panicked: filter=%+v panic=%v", filter, r)
				}
			}()
			q, args := buildCountQuery(filter)
			if q == "" {
				t.Errorf("empty count query for filter=%+v", filter)
			}
			_ = args
		}()
	}
}

// ── property: MaxID never panics ─────────────────────────────────────────────

func TestProspect_MaxID_Property(t *testing.T) {
	rng := rand.New(rand.NewSource(42))

	// nil slice
	if got := MaxID(nil); got != 0 {
		t.Errorf("MaxID(nil) = %d, want 0", got)
	}

	for i := 0; i < 100; i++ {
		n := rng.Intn(50)
		bs := make([]FirmyBusiness, n)
		maxWant := 0
		for j := range bs {
			id := rng.Intn(1_000_000)
			bs[j] = FirmyBusiness{ID: id}
			if id > maxWant {
				maxWant = id
			}
		}
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("MaxID panicked: %v", r)
				}
			}()
			got := MaxID(bs)
			if got != maxWant {
				t.Errorf("MaxID mismatch: got %d, want %d (n=%d)", got, maxWant, n)
			}
		}()
	}
}

// ── property: extractFirstName never panics ───────────────────────────────────

func TestProspect_ExtractFirstName_NeverPanics_Property(t *testing.T) {
	inputs := []string{
		"", " ", "\t\n", "a",
		"Ing. Jan Novák", "s.r.o.", "ACME CORP",
		"123 456", "   spaces   ", "Ü ber",
		"Bc. bc. Bc.",
	}
	rng := rand.New(rand.NewSource(99))

	for i := 0; i < 100; i++ {
		var name string
		if i < len(inputs) {
			name = inputs[i]
		} else {
			// random printable ASCII string
			length := rng.Intn(80)
			b := make([]byte, length)
			for j := range b {
				b[j] = byte(rng.Intn(95) + 32)
			}
			name = string(b)
		}
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("extractFirstName(%q) panicked: %v", name, r)
				}
			}()
			_ = extractFirstName(name)
		}()
	}
}

// ── Fetch — scan error path ───────────────────────────────────────────────────

func TestFetch_ScanError_ReturnsError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Return rows with wrong column count to trigger a scan error.
	badCols := []string{"id"} // only 1 column; Fetch expects 16
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows(badCols).AddRow(1))

	f := newFirmySourceFromDB(db)
	_, err = f.Fetch(context.Background(), FirmyFilter{Limit: 1})
	if err == nil {
		t.Error("expected scan error, got nil")
	}
}

// ── NewFirmySource — ping failure ─────────────────────────────────────────────

// TestNewFirmySource_PingFail confirms NewFirmySource returns an error
// when the database is unreachable (bad DSN forces Ping to fail).
func TestNewFirmySource_PingFail(t *testing.T) {
	// sql.Open does NOT connect — only Ping does — so a bad host triggers the
	// error path at line 59 of firmy.go.
	badDSN := "postgresql://nobody:wrong@127.0.0.1:1/nodb?sslmode=disable&connect_timeout=1"
	_, err := NewFirmySource(badDSN)
	if err == nil {
		t.Error("expected error when Ping fails, got nil")
	}
}
