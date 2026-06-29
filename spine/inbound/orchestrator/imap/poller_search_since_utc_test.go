package imap

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// F4-3 — locks the rule that SEARCH UNSEEN SINCE formats lastPoll in
// UTC, NOT local TZ. Pre-fix on a non-UTC deployment, lastPoll would
// be Format()'d in local time; the IMAP server interprets the date in
// its own (typically UTC) frame, causing skipped 22:00–23:59 UTC
// windows of the previous day.
//
// Source-level audit: the SEARCH SINCE command MUST contain
// `lastPoll.UTC().Format(...)`, NOT plain `lastPoll.Format(...)`.

func TestSearchSince_FormatsInUTC(t *testing.T) {
	// Build a poller with a known lastPoll, capture the search command
	// that doFetch would produce by re-executing the format inline.
	// (We test the format string directly because doFetch requires a
	// real net.Conn; the bug surface is just the Format(...) call.)
	cases := []struct {
		name      string
		localTZ   *time.Location
		ts        string
		wantDate  string // expected SINCE date in UTC
	}{
		{
			name:     "ahead_of_utc_at_local_late_night",
			localTZ:  loadLoc(t, "Europe/Prague"),
			ts:       "2026-03-15T00:30:00",
			wantDate: "14-Mar-2026", // 00:30 CET = 23:30 UTC of 14-Mar
		},
		{
			name:     "behind_utc_late_evening",
			localTZ:  loadLoc(t, "America/New_York"),
			ts:       "2026-03-15T22:30:00",
			wantDate: "16-Mar-2026", // 22:30 EDT = 02:30 UTC next day
		},
		{
			name:     "utc_unchanged",
			localTZ:  time.UTC,
			ts:       "2026-03-15T00:30:00",
			wantDate: "15-Mar-2026",
		},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			lastPoll, err := time.ParseInLocation("2006-01-02T15:04:05", c.ts, c.localTZ)
			if err != nil {
				t.Fatal(err)
			}
			// The fix: format in UTC.
			got := fmt.Sprintf("SEARCH UNSEEN SINCE %s", lastPoll.UTC().Format("02-Jan-2006"))
			want := "SEARCH UNSEEN SINCE " + c.wantDate
			if got != want {
				t.Errorf("got %q, want %q", got, want)
			}
		})
	}
}

// Source-level audit: poller.go MUST call lastPoll.UTC().Format(...),
// not lastPoll.Format(...) directly.
func TestSearchSince_SourceAudit_UTCFormat(t *testing.T) {
	src, err := os.ReadFile("poller.go")
	if err != nil {
		t.Fatalf("read poller.go: %v", err)
	}
	s := string(src)

	// Find the SEARCH SINCE Sprintf line and verify it goes through .UTC().
	idx := strings.Index(s, "SEARCH UNSEEN SINCE")
	if idx < 0 {
		t.Fatal("could not find SEARCH UNSEEN SINCE in poller.go")
	}
	// Look at the next ~120 chars after that string for the Format call.
	end := idx + 200
	if end > len(s) {
		end = len(s)
	}
	region := s[idx:end]
	if !strings.Contains(region, "lastPoll.UTC().Format") {
		t.Errorf("SEARCH SINCE must use lastPoll.UTC().Format(...) (RFC 3501 §6.4.4 server-frame TZ); region:\n%s", region)
	}
	if strings.Contains(region, "p.lastPoll.Format(") &&
		!strings.Contains(region, "p.lastPoll.UTC().Format(") {
		t.Error("SEARCH SINCE still uses lastPoll.Format(...) without .UTC()")
	}
}

// Property: the buggy lastPoll.Format(...) in a non-UTC location can
// disagree with lastPoll.UTC().Format(...) at midnight boundaries —
// which is exactly the bug F4-3 fixes. Verify there exist hours where
// they diverge in non-UTC zones.
func TestSearchSince_Property_LocalAndUTCDisagreeAtMidnight(t *testing.T) {
	for _, locName := range []string{"Europe/Prague", "America/New_York", "Asia/Tokyo"} {
		loc := loadLoc(t, locName)
		divergences := 0
		for hour := 0; hour < 24; hour++ {
			ts := time.Date(2026, 3, 15, hour, 30, 0, 0, loc)
			localDate := ts.Format("02-Jan-2006")
			utcDate := ts.UTC().Format("02-Jan-2006")
			if localDate != utcDate {
				divergences++
			}
		}
		if divergences == 0 {
			t.Errorf("loc=%s: expected at least one hour where local and UTC date disagree (proves the bug surface)", locName)
		}
	}
}

func loadLoc(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Skipf("tz %q unavailable: %v", name, err)
	}
	return loc
}
