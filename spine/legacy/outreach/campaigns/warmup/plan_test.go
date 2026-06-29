package warmup

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestLoadPlansFromYAML(t *testing.T) {
	path := filepath.Join("..", "configs", "warmup.yaml")
	plans, err := LoadPlansFromYAML(path)
	if err != nil {
		t.Fatalf("LoadPlansFromYAML: %v", err)
	}
	wantPlans := []string{"default_30d", "aggressive_14d", "cs_seznam_friendly", "fresh_ip_r8c"}
	for _, n := range wantPlans {
		p, ok := plans[n]
		if !ok {
			t.Errorf("missing plan %q", n)
			continue
		}
		if len(p.Schedule) == 0 {
			t.Errorf("plan %q has empty schedule", n)
		}
		// Schedule must be ascending by Day.
		for i := 1; i < len(p.Schedule); i++ {
			if p.Schedule[i].Day < p.Schedule[i-1].Day {
				t.Errorf("plan %q: schedule not ascending at idx %d", n, i)
			}
		}
	}
}

func TestFreshIPR8C_Shape(t *testing.T) {
	path := filepath.Join("..", "configs", "warmup.yaml")
	plans, err := LoadPlansFromYAML(path)
	if err != nil {
		t.Fatalf("LoadPlansFromYAML: %v", err)
	}
	p, ok := plans["fresh_ip_r8c"]
	if !ok {
		t.Fatal("fresh_ip_r8c plan missing after R8c cutover")
	}
	// R8c spec: day 1 → 10, day 2-3 → 25, day 4-7 → 50, day 8+ → full cap.
	cases := []struct {
		day  int
		want int
	}{
		{1, 10},
		{2, 25},
		{3, 25},
		{4, 50},
		{7, 50},
		{8, 400},
		{30, 400},
	}
	for _, c := range cases {
		if got := p.LimitForDay(c.day); got != c.want {
			t.Errorf("fresh_ip_r8c day=%d: got %d, want %d", c.day, got, c.want)
		}
	}
}

func TestPlan_LimitForDay(t *testing.T) {
	p := Plan{
		Name: "t",
		Schedule: []ScheduleEntry{
			{Day: 1, DailyLimit: 10},
			{Day: 3, DailyLimit: 30},
			{Day: 7, DailyLimit: 75},
		},
	}
	cases := []struct {
		day  int
		want int
	}{
		{0, 10}, // below first → first
		{1, 10},
		{2, 10}, // stay at day-1 entry until day 3 hits
		{3, 30},
		{5, 30},
		{7, 75},
		{100, 75}, // clamp at last
	}
	for _, c := range cases {
		got := p.LimitForDay(c.day)
		if got != c.want {
			t.Errorf("LimitForDay(%d) = %d, want %d", c.day, got, c.want)
		}
	}

	empty := Plan{}
	if got := empty.LimitForDay(5); got != 0 {
		t.Errorf("empty plan LimitForDay = %d, want 0", got)
	}
}

func TestPlan_IsComplete(t *testing.T) {
	p := Plan{Schedule: []ScheduleEntry{{Day: 1, DailyLimit: 10}, {Day: 30, DailyLimit: 400}}}
	if p.IsComplete(29) {
		t.Error("IsComplete(29) should be false")
	}
	if !p.IsComplete(30) {
		t.Error("IsComplete(30) should be true")
	}
	if !p.IsComplete(31) {
		t.Error("IsComplete(31) should be true")
	}
	empty := Plan{}
	if !empty.IsComplete(0) {
		t.Error("empty plan should be complete by default")
	}
}

func TestParseScheduleEntry(t *testing.T) {
	good := []struct {
		in   string
		want ScheduleEntry
	}{
		{"{ day: 1, daily_limit: 10 }", ScheduleEntry{Day: 1, DailyLimit: 10}},
		{"{day:3,daily_limit:40}", ScheduleEntry{Day: 3, DailyLimit: 40}},
	}
	for _, c := range good {
		got, err := parseScheduleEntry(c.in)
		if err != nil {
			t.Errorf("parseScheduleEntry(%q): %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("parseScheduleEntry(%q) = %+v, want %+v", c.in, got, c.want)
		}
	}

	bad := []string{
		"{ day: 0, daily_limit: 10 }",
		"{ day: 1, daily_limit: 0 }",
		"{ day: abc, daily_limit: 10 }",
	}
	for _, in := range bad {
		if _, err := parseScheduleEntry(in); err == nil {
			t.Errorf("parseScheduleEntry(%q) should have errored", in)
		}
	}
}

func TestDaemon_Tick(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(regexp.QuoteMeta("UPDATE mailbox_warmup")).
		WillReturnResult(sqlmock.NewResult(0, 7))

	d := NewDaemon(db, map[string]Plan{})
	n, err := d.Tick(context.Background())
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if n != 7 {
		t.Errorf("Tick rows = %d, want 7", n)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestDaemon_EnrollMailbox(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	plans := map[string]Plan{"default_30d": {Name: "default_30d"}}
	d := NewDaemon(db, plans)

	// Unknown plan.
	if err := d.EnrollMailbox(context.Background(), "a@x.test", "nope"); err == nil {
		t.Error("expected error for unknown plan")
	}

	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO mailbox_warmup")).
		WithArgs("a@x.test", "default_30d").
		WillReturnResult(sqlmock.NewResult(1, 1))

	if err := d.EnrollMailbox(context.Background(), "a@x.test", "default_30d"); err != nil {
		t.Fatalf("EnrollMailbox: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// M-W2 (2026-04-22): Tick and EnrollMailbox DB-error paths were untested.
// These three tests lock in the error-bubble contract so a future refactor
// that silently swallows errors gets caught here.

func TestDaemon_Tick_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	boom := errors.New("connection refused")
	mock.ExpectExec(regexp.QuoteMeta("UPDATE mailbox_warmup")).
		WillReturnError(boom)

	d := NewDaemon(db, map[string]Plan{})
	_, got := d.Tick(context.Background())
	if got == nil {
		t.Fatal("expected error from Tick when DB fails, got nil")
	}
	if !errors.Is(got, boom) {
		t.Errorf("expected error to wrap boom, got: %v", got)
	}
}

func TestDaemon_EnrollMailbox_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	boom := errors.New("unique violation")
	plans := map[string]Plan{"default_30d": {Name: "default_30d"}}
	d := NewDaemon(db, plans)

	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO mailbox_warmup")).
		WithArgs("a@x.test", "default_30d").
		WillReturnError(boom)

	if err := d.EnrollMailbox(context.Background(), "a@x.test", "default_30d"); err == nil {
		t.Fatal("expected DB error from EnrollMailbox, got nil")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestDaemon_Tick_ZeroRowsAdvanced(t *testing.T) {
	// No mailboxes qualify for advancement (all paused or advanced recently):
	// Tick should return 0, nil — not an error.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(regexp.QuoteMeta("UPDATE mailbox_warmup")).
		WillReturnResult(sqlmock.NewResult(0, 0))

	d := NewDaemon(db, map[string]Plan{})
	n, err := d.Tick(context.Background())
	if err != nil {
		t.Fatalf("Tick with 0 rows: unexpected error: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 rows advanced, got %d", n)
	}
}

func TestDaemon_LimitForMailbox(t *testing.T) {
	plans := map[string]Plan{
		"default_30d": {
			Name: "default_30d",
			Schedule: []ScheduleEntry{
				{Day: 1, DailyLimit: 10},
				{Day: 5, DailyLimit: 50},
			},
		},
	}

	t.Run("no row returns fallback", func(t *testing.T) {
		db, mock, err := sqlmock.New()
		if err != nil {
			t.Fatalf("sqlmock.New: %v", err)
		}
		defer db.Close()

		mock.ExpectQuery(regexp.QuoteMeta("SELECT warmup_day")).
			WithArgs("a@x.test").
			WillReturnError(sql.ErrNoRows)

		d := NewDaemon(db, plans)
		got, err := d.LimitForMailbox(context.Background(),"a@x.test", 200)
		if err != nil {
			t.Fatalf("LimitForMailbox: %v", err)
		}
		if got != 200 {
			t.Errorf("got %d, want fallback 200", got)
		}
	})

	t.Run("returns plan limit for day", func(t *testing.T) {
		db, mock, err := sqlmock.New()
		if err != nil {
			t.Fatalf("sqlmock.New: %v", err)
		}
		defer db.Close()

		rows := sqlmock.NewRows([]string{"warmup_day", "plan_name", "is_paused"}).
			AddRow(3, "default_30d", false)
		mock.ExpectQuery(regexp.QuoteMeta("SELECT warmup_day")).
			WithArgs("a@x.test").
			WillReturnRows(rows)

		d := NewDaemon(db, plans)
		got, err := d.LimitForMailbox(context.Background(),"a@x.test", 200)
		if err != nil {
			t.Fatalf("LimitForMailbox: %v", err)
		}
		// Day 3: only entry 1 applies → 10.
		if got != 10 {
			t.Errorf("got %d, want 10", got)
		}
	})

	t.Run("paused mailbox keeps current limit", func(t *testing.T) {
		db, mock, err := sqlmock.New()
		if err != nil {
			t.Fatalf("sqlmock.New: %v", err)
		}
		defer db.Close()

		rows := sqlmock.NewRows([]string{"warmup_day", "plan_name", "is_paused"}).
			AddRow(5, "default_30d", true)
		mock.ExpectQuery(regexp.QuoteMeta("SELECT warmup_day")).
			WithArgs("paused@x.test").
			WillReturnRows(rows)

		d := NewDaemon(db, plans)
		got, err := d.LimitForMailbox(context.Background(),"paused@x.test", 200)
		if err != nil {
			t.Fatalf("LimitForMailbox: %v", err)
		}
		if got != 50 {
			t.Errorf("paused got %d, want 50", got)
		}
	})

	t.Run("unknown plan falls back", func(t *testing.T) {
		db, mock, err := sqlmock.New()
		if err != nil {
			t.Fatalf("sqlmock.New: %v", err)
		}
		defer db.Close()

		rows := sqlmock.NewRows([]string{"warmup_day", "plan_name", "is_paused"}).
			AddRow(2, "ghost_plan", false)
		mock.ExpectQuery(regexp.QuoteMeta("SELECT warmup_day")).
			WithArgs("ghost@x.test").
			WillReturnRows(rows)

		d := NewDaemon(db, plans)
		got, err := d.LimitForMailbox(context.Background(),"ghost@x.test", 150)
		if err != nil {
			t.Fatalf("LimitForMailbox: %v", err)
		}
		if got != 150 {
			t.Errorf("got %d, want fallback 150", got)
		}
	})

	t.Run("db error bubbles up", func(t *testing.T) {
		db, mock, err := sqlmock.New()
		if err != nil {
			t.Fatalf("sqlmock.New: %v", err)
		}
		defer db.Close()

		boom := errors.New("connection refused")
		mock.ExpectQuery(regexp.QuoteMeta("SELECT warmup_day")).
			WithArgs("err@x.test").
			WillReturnError(boom)

		d := NewDaemon(db, plans)
		if _, err := d.LimitForMailbox(context.Background(),"err@x.test", 100); err == nil {
			t.Error("expected error to bubble up")
		}
	})
}

