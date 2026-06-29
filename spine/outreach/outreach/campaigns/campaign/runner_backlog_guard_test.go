package campaign

import "testing"

// Backlog guard (incident 2026-06-23): RunCampaign caps how many contacts it
// reserves into status='in_flight' per campaign so the runner never outpaces the
// per-mailbox-spacing-throttled send engine. The cap is read from
// CAMPAIGN_MAX_INFLIGHT_BACKLOG with a safe default. These tests pin the env
// parsing contract; the SQL-level cap (LIMIT GREATEST(0, cap - in_flight)) is
// verified operationally (in_flight stops ballooning) since sqlmock does not
// evaluate the subquery.

func TestDefaultMaxInflightBacklogValue(t *testing.T) {
	if defaultMaxInflightBacklog != 50 {
		t.Fatalf("defaultMaxInflightBacklog = %d, want 50 (changing it shifts campaign throughput backpressure)", defaultMaxInflightBacklog)
	}
}

func TestMaxInflightBacklog(t *testing.T) {
	cases := []struct {
		name string
		set  bool   // whether to set the env var at all
		val  string // value when set
		want int
	}{
		{"unset_uses_default", false, "", defaultMaxInflightBacklog},
		{"empty_uses_default", true, "", defaultMaxInflightBacklog},
		{"valid_override_100", true, "100", 100},
		{"valid_override_1", true, "1", 1},
		{"valid_large", true, "10000", 10000},
		{"valid_exact_default", true, "50", 50},
		{"zero_falls_back", true, "0", defaultMaxInflightBacklog},
		{"negative_falls_back", true, "-5", defaultMaxInflightBacklog},
		{"garbage_falls_back", true, "abc", defaultMaxInflightBacklog},
		{"float_falls_back", true, "12.5", defaultMaxInflightBacklog},
		{"trailing_junk_falls_back", true, "100x", defaultMaxInflightBacklog},
		{"whitespace_falls_back", true, "  ", defaultMaxInflightBacklog},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.set {
				t.Setenv("CAMPAIGN_MAX_INFLIGHT_BACKLOG", c.val)
			} else {
				// Ensure no ambient value leaks in from the runner env.
				t.Setenv("CAMPAIGN_MAX_INFLIGHT_BACKLOG", "")
			}
			if got := maxInflightBacklog(); got != c.want {
				t.Fatalf("maxInflightBacklog() with %q = %d, want %d", c.val, got, c.want)
			}
		})
	}
}

// The guard must never reserve when the cap is non-positive after the fallback,
// i.e. the effective cap is always >= 1 so a healthy campaign cannot be wedged
// to zero throughput by config alone.
func TestMaxInflightBacklogAlwaysPositive(t *testing.T) {
	for _, v := range []string{"", "0", "-1", "-999", "nan", "0x10"} {
		t.Setenv("CAMPAIGN_MAX_INFLIGHT_BACKLOG", v)
		if got := maxInflightBacklog(); got < 1 {
			t.Fatalf("maxInflightBacklog() with %q = %d, must be >= 1", v, got)
		}
	}
}
