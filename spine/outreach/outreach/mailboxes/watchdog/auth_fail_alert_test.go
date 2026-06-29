package watchdog

import (
	"testing"
	"time"
)

// TestShouldAlertOnAuthFail is a table-driven test covering every branch of
// the SEND-S6.3 alert decision: empty/nil inputs, below-threshold counts,
// window boundaries, per-mailbox scoping (caller concern — we test the
// primitive stays pure), and cooldown behaviour.
func TestShouldAlertOnAuthFail(t *testing.T) {
	now := time.Date(2026, 4, 22, 12, 0, 0, 0, time.UTC)
	// helper: N events ending at `end`, each spaced `step` apart going
	// backwards. Index 0 = oldest, last = newest.
	series := func(count int, end time.Time, step time.Duration) []AuthFailEvent {
		out := make([]AuthFailEvent, count)
		for i := 0; i < count; i++ {
			out[i] = AuthFailEvent{FailedAt: end.Add(-time.Duration(count-1-i) * step)}
		}
		return out
	}

	tests := []struct {
		name          string
		events        []AuthFailEvent
		lastAlertedAt *time.Time
		want          bool
	}{
		// ─── No-alert baselines ─────────────────────────────────────────
		{
			name:   "empty slice → no alert",
			events: []AuthFailEvent{},
			want:   false,
		},
		{
			name:   "nil events → no alert",
			events: nil,
			want:   false,
		},
		{
			name:   "1 fail in window → no alert",
			events: series(1, now, time.Minute),
			want:   false,
		},
		{
			name:   "2 fails in window → no alert (below threshold 3)",
			events: series(2, now, time.Minute),
			want:   false,
		},

		// ─── Threshold + window firing ──────────────────────────────────
		{
			name:   "3 fails within 15min → alert",
			events: series(3, now, 2*time.Minute),
			want:   true,
		},
		{
			name:   "5 fails all within 5min → alert",
			events: series(5, now, time.Minute),
			want:   true,
		},

		// ─── Window expiry ──────────────────────────────────────────────
		{
			name: "3 fails but last was 16min ago → no alert",
			events: []AuthFailEvent{
				{FailedAt: now.Add(-30 * time.Minute)},
				{FailedAt: now.Add(-25 * time.Minute)},
				{FailedAt: now.Add(-16 * time.Minute)},
			},
			want: false,
		},
		{
			name:   "10 fails spread over 90min with 10min spacing → no alert (only 2 in last 15min)",
			events: series(10, now, 10*time.Minute),
			want:   false,
		},

		// ─── Exact-boundary cases ───────────────────────────────────────
		{
			name: "3 fails exactly at 15min boundary → no alert (open interval)",
			events: []AuthFailEvent{
				{FailedAt: now.Add(-15 * time.Minute)},
				{FailedAt: now.Add(-14 * time.Minute)},
				{FailedAt: now.Add(-13 * time.Minute)},
			},
			want: false,
		},
		{
			name: "3 fails just inside 15min (14m59s) → alert",
			events: []AuthFailEvent{
				{FailedAt: now.Add(-14*time.Minute - 59*time.Second)},
				{FailedAt: now.Add(-10 * time.Minute)},
				{FailedAt: now.Add(-1 * time.Minute)},
			},
			want: true,
		},

		// ─── Nil timestamps ─────────────────────────────────────────────
		{
			name: "events with zero timestamps → no alert",
			events: []AuthFailEvent{
				{}, {}, {},
			},
			want: false,
		},

		// ─── Cooldown ───────────────────────────────────────────────────
		{
			name:          "3 fresh fails, alerted 30min ago → suppressed (within 1h cooldown)",
			events:        series(3, now, 2*time.Minute),
			lastAlertedAt: ptrTime(now.Add(-30 * time.Minute)),
			want:          false,
		},
		{
			name:          "3 fresh fails, alerted 61min ago → alert (cooldown elapsed)",
			events:        series(3, now, 2*time.Minute),
			lastAlertedAt: ptrTime(now.Add(-61 * time.Minute)),
			want:          true,
		},
		{
			name:          "3 fresh fails, nil lastAlertedAt → alert (first-time)",
			events:        series(3, now, 2*time.Minute),
			lastAlertedAt: nil,
			want:          true,
		},
		{
			name:          "3 fresh fails, alerted exactly 1h ago → alert (boundary inclusive)",
			events:        series(3, now, 2*time.Minute),
			lastAlertedAt: ptrTime(now.Add(-1 * time.Hour)),
			want:          true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ShouldAlertOnAuthFail(tc.events, now, tc.lastAlertedAt)
			if got != tc.want {
				t.Fatalf("ShouldAlertOnAuthFail = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestShouldAlertOnAuthFail_PerMailboxScope documents that the primitive is
// caller-scoped: the caller filters events by mailbox before calling. We
// prove this by feeding two disjoint event sets through the same primitive
// and asserting each is evaluated independently.
func TestShouldAlertOnAuthFail_PerMailboxScope(t *testing.T) {
	now := time.Date(2026, 4, 22, 12, 0, 0, 0, time.UTC)
	mailboxA := []AuthFailEvent{
		{FailedAt: now.Add(-5 * time.Minute)},
		{FailedAt: now.Add(-3 * time.Minute)},
		{FailedAt: now.Add(-1 * time.Minute)},
	}
	mailboxB := []AuthFailEvent{
		{FailedAt: now.Add(-5 * time.Minute)},
	}
	if !ShouldAlertOnAuthFail(mailboxA, now, nil) {
		t.Error("mailbox A should alert (3 in window)")
	}
	if ShouldAlertOnAuthFail(mailboxB, now, nil) {
		t.Error("mailbox B should NOT alert (only 1 fail)")
	}
}

func ptrTime(t time.Time) *time.Time { return &t }
