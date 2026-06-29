package probe

// Additional coverage for WatchdogMetaL3.Run and SpfDmarcL3/WatchdogMetaL3
// Interval() positive-cadence branches.

import (
	"context"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// --------------------------------------------------------------------
// Interval() positive-cadence branches
// --------------------------------------------------------------------

func TestSpfDmarcL3_IntervalCustom(t *testing.T) {
	p := NewSpfDmarcL3(nil, 4*time.Minute)
	if p.Interval() != 4*time.Minute {
		t.Fatalf("want 4m, got %v", p.Interval())
	}
}

func TestWatchdogMetaL3_IntervalCustom(t *testing.T) {
	p := NewWatchdogMetaL3(nil, 12*time.Minute)
	if p.Interval() != 12*time.Minute {
		t.Fatalf("want 12m, got %v", p.Interval())
	}
}

// --------------------------------------------------------------------
// WatchdogMetaL3.Run — query error
// --------------------------------------------------------------------

func TestWatchdogMetaL3_QueryFails_Err(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT`).
		WillReturnError(context.DeadlineExceeded)

	p := NewWatchdogMetaL3(db, 30*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err on query fail, got %s: %s", r.Status, r.Detail)
	}
}

// --------------------------------------------------------------------
// WatchdogMetaL3.Run — windows = 0 → err (watchdog down)
// --------------------------------------------------------------------

func TestWatchdogMetaL3_ZeroWindows_Err(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{"count", "earliest_age_s"}).AddRow(0, nil))

	p := NewWatchdogMetaL3(db, 30*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err (no windows), got %s: %s", r.Status, r.Detail)
	}
}

// --------------------------------------------------------------------
// WatchdogMetaL3.Run — windows < expected → warn
// --------------------------------------------------------------------

func TestWatchdogMetaL3_PartialWindows_Warn(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// 2 windows returned but default expected is 4 → warn.
	// earliest event is 30h ago so elapsed windows stays at default (4).
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{"count", "earliest_age_s"}).AddRow(2, 30*3600))

	p := NewWatchdogMetaL3(db, 30*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusWarn {
		t.Fatalf("want warn (partial windows), got %s: %s", r.Status, r.Detail)
	}
}

// --------------------------------------------------------------------
// WatchdogMetaL3.Run — all expected windows present → ok
// --------------------------------------------------------------------

func TestWatchdogMetaL3_AllWindows_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// 4 windows returned, expected is 4, earliest 30h ago → ok
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{"count", "earliest_age_s"}).AddRow(4, 30*3600))

	p := NewWatchdogMetaL3(db, 30*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusOK {
		t.Fatalf("want ok, got %s: %s", r.Status, r.Detail)
	}
}

// --------------------------------------------------------------------
// WatchdogMetaL3.Run — custom Windows=0 falls back to 4
// --------------------------------------------------------------------

func TestWatchdogMetaL3_ZeroWindowsDefault_FallsBackTo4(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// With Windows=0 the probe should use default=4 and return warn for 2.
	// earliest event 30h ago → elapsed windows stays at default (4).
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{"count", "earliest_age_s"}).AddRow(2, 30*3600))

	p := &WatchdogMetaL3{DB: db, Windows: 0, Cadence: 30 * time.Minute}
	r := p.Run(context.Background())
	if r.Status != StatusWarn {
		t.Fatalf("want warn (zero windows fallback), got %s: %s", r.Status, r.Detail)
	}
}

// --------------------------------------------------------------------
// checkDMARC — "unrecognised policy" warn branch
// --------------------------------------------------------------------

func TestSpfDmarcL3_DMARC_UnknownPolicy_Warn(t *testing.T) {
	res := &fakeResolver{records: map[string][]string{
		"example.com":        {"v=spf1 include:foo ~all"},
		"_dmarc.example.com": {"v=DMARC1; p=experimental"},
	}}
	p := &SpfDmarcL3{Domains: []string{"example.com"}, Resolver: res}
	r := p.Run(context.Background())
	if r.Status != StatusWarn {
		t.Fatalf("want warn for unknown DMARC policy, got %s: %s", r.Status, r.Detail)
	}
}

// --------------------------------------------------------------------
// SpfDmarcL3.Run — DMARC lookup error branch
// --------------------------------------------------------------------

func TestSpfDmarcL3_DMARCLookupError_Err(t *testing.T) {
	res := &fakeResolver{
		records: map[string][]string{
			"example.com": {"v=spf1 ~all"},
		},
		err: map[string]error{
			"_dmarc.example.com": context.DeadlineExceeded,
		},
	}
	p := &SpfDmarcL3{Domains: []string{"example.com"}, Resolver: res}
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err on DMARC lookup fail, got %s: %s", r.Status, r.Detail)
	}
}
