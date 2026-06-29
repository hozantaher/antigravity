package sender

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

// BF-E1 — Sentinel → SMTPClass → backoff table.
//
// Locks the contract that:
//   1. Every anti-trace sentinel maps to a single defined SMTPClass.
//   2. The retry-class → greylistingBackoff() mapping covers attempts 0,1,2,3,
//      and "way past" (99). The schedule is calibrated for Czech/Seznam
//      greylisting policies; changing it should be deliberate, not accidental.
//
// A regression — e.g. flipping ErrAntiTraceRateLimited to SMTPPermanent —
// would silently mark whole campaigns as bounced and burn contacts. This
// test makes such a change loud.

type sentinelExpectation struct {
	name     string
	sentinel error
	want     SMTPClass
	// backoff is the expected greylistingBackoff() result *if* the class is
	// SMTPTransient. SMTPUnknown / SMTPPermanent / SMTPOK don't drive the
	// greylisting backoff path (engine.go handles them separately).
	driveBackoff bool
}

var antiTraceSentinelTable = []sentinelExpectation{
	{name: "ErrAntiTraceMarshal", sentinel: ErrAntiTraceMarshal, want: SMTPUnknown, driveBackoff: false},
	{name: "ErrAntiTraceRequest", sentinel: ErrAntiTraceRequest, want: SMTPUnknown, driveBackoff: false},
	{name: "ErrAntiTraceTransport", sentinel: ErrAntiTraceTransport, want: SMTPTransient, driveBackoff: true},
	{name: "ErrAntiTraceRateLimited", sentinel: ErrAntiTraceRateLimited, want: SMTPTransient, driveBackoff: true},
	{name: "ErrAntiTraceHTTPStatus", sentinel: ErrAntiTraceHTTPStatus, want: SMTPTransient, driveBackoff: true},
}

// TestSentinelToClassTable — every sentinel and its wrapped form maps to
// the expected SMTPClass. Catches accidental class flips during refactor.
func TestSentinelToClassTable(t *testing.T) {
	for _, c := range antiTraceSentinelTable {
		t.Run(c.name+"/bare", func(t *testing.T) {
			if got := ClassifySMTPError(c.sentinel); got != c.want {
				t.Errorf("bare %s: got %v, want %v", c.name, got, c.want)
			}
		})
		t.Run(c.name+"/wrapped", func(t *testing.T) {
			wrapped := fmt.Errorf("%w: contextual detail here", c.sentinel)
			if got := ClassifySMTPError(wrapped); got != c.want {
				t.Errorf("wrapped %s: got %v, want %v", c.name, got, c.want)
			}
		})
	}
}

// TestSentinelToBackoffTable — for each transient sentinel, walking the
// retry-attempt counter through the schedule must yield the documented
// 15m / 1h / 4h / 24h cadence. SMTPUnknown sentinels are explicitly NOT
// expected to drive this path (engine.go treats them differently); we
// assert that the test author knows so by setting driveBackoff=false.
func TestSentinelToBackoffTable(t *testing.T) {
	expected := []time.Duration{
		15 * time.Minute, // attempt 0
		1 * time.Hour,    // attempt 1
		4 * time.Hour,    // attempt 2
		24 * time.Hour,   // attempt 3
		24 * time.Hour,   // attempt 99 (saturated)
	}
	attempts := []int{0, 1, 2, 3, 99}
	for _, c := range antiTraceSentinelTable {
		if !c.driveBackoff {
			continue
		}
		for i, attempt := range attempts {
			t.Run(fmt.Sprintf("%s/attempt=%d", c.name, attempt), func(t *testing.T) {
				class := ClassifySMTPError(c.sentinel)
				if class != SMTPTransient {
					t.Fatalf("table contract violation: %s expected to drive backoff but classified as %v", c.name, class)
				}
				if got := greylistingBackoff(attempt); got != expected[i] {
					t.Errorf("attempt=%d: got %v, want %v", attempt, got, expected[i])
				}
			})
		}
	}
}

// TestBackoffMonotonicNonDecreasing — across the documented schedule, each
// next attempt's delay must be >= the previous. Property-style guard against
// a typo that would, for example, swap the 1h and 4h entries.
func TestBackoffMonotonicNonDecreasing(t *testing.T) {
	prev := time.Duration(-1)
	for attempt := 0; attempt <= 10; attempt++ {
		got := greylistingBackoff(attempt)
		if got <= 0 {
			t.Errorf("attempt=%d: backoff non-positive %v", attempt, got)
		}
		if got < prev {
			t.Errorf("attempt=%d: backoff %v < previous %v (must be non-decreasing)", attempt, got, prev)
		}
		prev = got
	}
}

// TestBackoffSaturation — at the maxGreylistingAttempts boundary and beyond,
// engine.go stops scheduling retries. The function itself still returns a
// finite duration (24h) so callers don't have to special-case overflow.
func TestBackoffSaturation(t *testing.T) {
	for _, attempt := range []int{maxGreylistingAttempts, maxGreylistingAttempts + 1, 100} {
		got := greylistingBackoff(attempt)
		if got != 24*time.Hour {
			t.Errorf("attempt=%d (saturation): got %v, want 24h", attempt, got)
		}
	}
}

// TestBackoffSentinelComposition — composing multiple sentinels via errors.Join
// must keep classification stable. Any one of the joined errors being a known
// sentinel is enough to drive the class. (errors.Is walks the join tree.)
func TestBackoffSentinelComposition(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want SMTPClass
	}{
		{
			name: "RateLimited joined with Transport — both transient",
			err:  errors.Join(ErrAntiTraceRateLimited, ErrAntiTraceTransport),
			want: SMTPTransient,
		},
		{
			name: "Marshal joined with Transport — Marshal returns Unknown first via switch order",
			err:  errors.Join(ErrAntiTraceMarshal, ErrAntiTraceTransport),
			// Switch in ClassifySMTPError tests RateLimited→Transport→HTTPStatus
			// before Marshal/Request. So Transport wins → SMTPTransient.
			want: SMTPTransient,
		},
		{
			name: "Marshal joined with Request — both Unknown",
			err:  errors.Join(ErrAntiTraceMarshal, ErrAntiTraceRequest),
			want: SMTPUnknown,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ClassifySMTPError(c.err); got != c.want {
				t.Errorf("got %v, want %v", got, c.want)
			}
		})
	}
}
