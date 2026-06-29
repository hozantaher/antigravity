package mailbox

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// TestMailboxColumns_CoalescesNullableTextFields is a regression guard for the
// 2026-05-13 incident where ActiveAddresses() failed with
//
//	sql: Scan error on column index 11, name "locale":
//	converting NULL to string is unsupported
//
// because the SELECT projection emitted bare `tz, locale` and a row with NULL
// locale (or tz) blew up Scan into the plain-string struct fields. The fix
// wraps both columns in COALESCE on the SQL side; this test will fail if a
// future refactor drops either wrap.
func TestMailboxColumns_CoalescesNullableTextFields(t *testing.T) {
	cases := []string{
		"COALESCE(tz, '')",
		"COALESCE(locale, '')",
		// Defense for the other text columns that also live in the scan
		// target as plain strings — keep them belt-and-suspenders.
		"COALESCE(smtp_username, '')",
		"COALESCE(imap_host, '')",
		"COALESCE(imap_username, '')",
		"COALESCE(status_reason, '')",
		"COALESCE(password, '')",
		"COALESCE(proxy_url, '')",
		"COALESCE(environment, 'production')",
		"COALESCE(preferred_country, '')",
		"COALESCE(lifecycle_phase, 'warmup_d0')",
		// Integer counters — added after the 2026-05-13 incident where a
		// NULL consecutive_bounces (column index 15) crashed Scan with
		// `converting NULL to int is unsupported`, poisoning both
		// ActiveAddresses AND OverlayRegistry at boot. With cfg.Mailboxes
		// left empty, strict-mode pickMailbox refused every send.
		"COALESCE(consecutive_bounces, 0)",
		"COALESCE(total_sent, 0)",
		"COALESCE(total_bounced, 0)",
	}
	for _, want := range cases {
		if !strings.Contains(mailboxColumns, want) {
			t.Errorf("mailboxColumns is missing %q — would re-introduce NULL Scan crash", want)
		}
	}
}

// TestPGStore_List_RowWithEmptyLocaleAndTZ exercises the post-COALESCE Scan
// path: a DB row whose tz/locale columns are NULL gets converted to '' by the
// SQL projection, and Scan must succeed. This is the production behaviour we
// want; sqlmock can't run COALESCE itself, so the post-projection values are
// what the test feeds.
func TestPGStore_List_RowWithEmptyLocaleAndTZ(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()

	now := time.Now()
	rows := sqlmock.NewRows(mailboxCols()).AddRow(
		int64(1001), "edge.case@seznam.cz", "Edge Case",
		"smtp.seznam.cz", 587, "", // smtp creds
		"", int64(0), "", // imap creds (post-COALESCE empties)
		nil, "", "", // daily_cap_override NULL, tz '', locale '' (post-COALESCE)
		"active", "", // status, status_reason
		nil, 0, int64(0), int64(0), // last_send_at + counters
		now, now, "", "", "production",
		"",          // preferred_country
		"warmup_d0", // lifecycle_phase
	)
	mock.ExpectQuery(`SELECT .*FROM outreach_mailboxes`).
		WillReturnRows(rows)

	out, err := s.List(context.Background(), Filter{Status: []Status{StatusActive}, Limit: 10})
	if err != nil {
		t.Fatalf("List with empty tz/locale must succeed, got: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("expected 1 mailbox, got %d", len(out))
	}
	if got, want := out[0].FromAddress, "edge.case@seznam.cz"; got != want {
		t.Errorf("FromAddress = %q, want %q", got, want)
	}
	if got := out[0].Locale; got != "" {
		t.Errorf("Locale = %q, want empty string (post-COALESCE)", got)
	}
	if got := out[0].TZ; got != "" {
		t.Errorf("TZ = %q, want empty string (post-COALESCE)", got)
	}
}

// TestStoreBackpressure_ActiveAddresses_SurvivesNullableTextColumns ensures
// the path that originally crashed in production (sender registry call)
// resolves to a non-nil set without error when the DB returns rows whose
// nullable text fields are NULL. With COALESCE in place, sqlmock returns
// empties and ActiveAddresses succeeds.
func TestStoreBackpressure_ActiveAddresses_SurvivesNullableTextColumns(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()

	now := time.Now()
	rows := sqlmock.NewRows(mailboxCols()).AddRow(
		int64(2001), "Two@Seznam.CZ", "Two",
		"smtp.seznam.cz", 587, "",
		"", int64(0), "",
		nil, "", "",
		"active", "",
		nil, 0, int64(0), int64(0),
		now, now, "", "", "production",
		"",
		"warmup_d0",
	).AddRow(
		int64(2002), "three@seznam.cz", "Three",
		"smtp.seznam.cz", 587, "",
		"", int64(0), "",
		nil, "Europe/Prague", "cs",
		"active", "",
		nil, 0, int64(0), int64(0),
		now, now, "", "", "production",
		"",
		"warmup_d0",
	)
	mock.ExpectQuery(`SELECT .*FROM outreach_mailboxes`).
		WillReturnRows(rows)

	bp := NewBackpressure(s)
	set, err := bp.ActiveAddresses(context.Background())
	if err != nil {
		t.Fatalf("ActiveAddresses must not error on NULL-locale rows, got: %v", err)
	}
	if len(set) != 2 {
		t.Fatalf("expected 2 active addresses, got %d", len(set))
	}
	// Keys must be NormaliseAddress'd (lower-cased).
	if _, ok := set["two@seznam.cz"]; !ok {
		t.Errorf("missing normalised key two@seznam.cz, set=%v", set)
	}
	if _, ok := set["three@seznam.cz"]; !ok {
		t.Errorf("missing normalised key three@seznam.cz, set=%v", set)
	}
}

// TestStoreBackpressure_ActiveMailboxes_ReturnsFullConfig covers the
// 2026-05-13 runtime self-heal path: the sender engine type-asserts on
// MailboxLister to refresh its in-memory mailbox list when cfg.Mailboxes
// is empty. ActiveMailboxes must return full MailboxConfig records so the
// engine can dispatch without a separate config lookup. Fields covered:
// Address, DailyLimit (derived from lifecycle_phase fallback when
// daily_cap_override is NULL), SMTP host/port, Username (defaults to
// from_address when smtp_username is empty).
func TestStoreBackpressure_ActiveMailboxes_ReturnsFullConfig(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()

	now := time.Now()
	rows := sqlmock.NewRows(mailboxCols()).AddRow(
		int64(3001), "fresh@seznam.cz", "Fresh",
		"smtp.seznam.cz", 587, "", // smtp creds (Username falls back to from_address)
		"imap.seznam.cz", int64(993), "fresh@seznam.cz",
		int64(170), "Europe/Prague", "cs", // daily_cap_override=170
		"active", "",
		nil, 0, int64(0), int64(0), // counters all 0 (post-COALESCE)
		now, now, "secret-pw", "", "production",
		"",
		"production", // lifecycle_phase
	)
	mock.ExpectQuery(`SELECT .*FROM outreach_mailboxes`).
		WillReturnRows(rows)

	bp := NewBackpressure(s)
	out, err := bp.ActiveMailboxes(context.Background())
	if err != nil {
		t.Fatalf("ActiveMailboxes: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("expected 1 active mailbox, got %d", len(out))
	}
	got := out[0]
	if got.Address != "fresh@seznam.cz" {
		t.Errorf("Address = %q, want fresh@seznam.cz", got.Address)
	}
	if got.DailyLimit != 170 {
		t.Errorf("DailyLimit = %d, want 170 (daily_cap_override)", got.DailyLimit)
	}
	if got.SMTPHost != "smtp.seznam.cz" || got.SMTPPort != 587 {
		t.Errorf("SMTP wiring lost: host=%q port=%d", got.SMTPHost, got.SMTPPort)
	}
	if got.Username != "fresh@seznam.cz" {
		t.Errorf("Username fallback to from_address broken: %q", got.Username)
	}
	if got.Password != "secret-pw" {
		t.Errorf("Password not carried through ToConfig: %q", got.Password)
	}
}

// TestStoreBackpressure_ActiveMailboxes_DerivesDailyLimitFromLifecyclePhase
// guards against the project_tocfg_daily_limit_zero memory: a DB-only
// mailbox with daily_cap_override=NULL must surface a non-zero DailyLimit
// derived from lifecycle_phase, or pickMailbox treats it as
// "all mailboxes at limit" and refuses to dispatch.
func TestStoreBackpressure_ActiveMailboxes_DerivesDailyLimitFromLifecyclePhase(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()

	now := time.Now()
	rows := sqlmock.NewRows(mailboxCols()).AddRow(
		int64(4001), "warmup-d7-only@seznam.cz", "Warmup",
		"smtp.seznam.cz", 587, "",
		"", int64(0), "",
		nil, "Europe/Prague", "cs", // daily_cap_override NULL
		"active", "",
		nil, 0, int64(0), int64(0),
		now, now, "", "", "production",
		"",
		"warmup_d7", // lifecycle_phase=warmup_d7 → DailyLimit 70 (migration 116)
	)
	mock.ExpectQuery(`SELECT .*FROM outreach_mailboxes`).
		WillReturnRows(rows)

	bp := NewBackpressure(s)
	out, err := bp.ActiveMailboxes(context.Background())
	if err != nil {
		t.Fatalf("ActiveMailboxes: %v", err)
	}
	if got := out[0].DailyLimit; got != 70 {
		t.Errorf("DailyLimit = %d, want 70 (warmup_d7 phase cap)", got)
	}
}

// TestStoreBackpressure_ActiveMailboxes_NilStoreErrors mirrors the
// existing ActiveAddresses_NilStoreErrors safety net.
func TestStoreBackpressure_ActiveMailboxes_NilStoreErrors(t *testing.T) {
	bp := &StoreBackpressure{}
	if _, err := bp.ActiveMailboxes(context.Background()); err == nil {
		t.Error("ActiveMailboxes with nil store must error")
	}
}
