package sender

import (
	"errors"
	"fmt"
	"testing"
)

// TestClassifySMTPError_AntiTraceRateLimitedIsTransient locks the contract
// that 429 from the relay flips into the greylisting backoff path rather
// than being recorded as a permanent bounce. The relay sits between us and
// the actual MTA — its rate-limit response is about our throughput, not
// the recipient.
func TestClassifySMTPError_AntiTraceRateLimitedIsTransient(t *testing.T) {
	if got := ClassifySMTPError(ErrAntiTraceRateLimited); got != SMTPTransient {
		t.Errorf("ErrAntiTraceRateLimited: got %v, want SMTPTransient", got)
	}
	// Wrapped via fmt.Errorf("%w: …") still classifies correctly.
	wrapped := fmt.Errorf("%w: throttled by relay", ErrAntiTraceRateLimited)
	if got := ClassifySMTPError(wrapped); got != SMTPTransient {
		t.Errorf("wrapped ErrAntiTraceRateLimited: got %v, want SMTPTransient", got)
	}
}

// TestClassifySMTPError_AntiTraceTransportIsTransient — DNS/network/timeout
// errors reaching the relay must be retried, not counted as bounces.
func TestClassifySMTPError_AntiTraceTransportIsTransient(t *testing.T) {
	wrapped := fmt.Errorf("%w: dial tcp: i/o timeout", ErrAntiTraceTransport)
	if got := ClassifySMTPError(wrapped); got != SMTPTransient {
		t.Errorf("ErrAntiTraceTransport (wrapped): got %v, want SMTPTransient", got)
	}
}

// TestClassifySMTPError_AntiTraceHTTPStatusIsTransient — relay-side non-2xx,
// non-429 (4xx bad payload or 5xx outage). Conservative: retry rather than
// burn the contact, since the failure is in our relay layer.
func TestClassifySMTPError_AntiTraceHTTPStatusIsTransient(t *testing.T) {
	for _, code := range []int{400, 500, 502, 503, 504} {
		wrapped := fmt.Errorf("%w: %d: relay error", ErrAntiTraceHTTPStatus, code)
		if got := ClassifySMTPError(wrapped); got != SMTPTransient {
			t.Errorf("ErrAntiTraceHTTPStatus code %d: got %v, want SMTPTransient", code, got)
		}
	}
}

// TestClassifySMTPError_AntiTraceMarshalIsUnknown — programmer-side errors
// (request build, JSON marshal). Don't penalize the contact or mailbox.
func TestClassifySMTPError_AntiTraceMarshalIsUnknown(t *testing.T) {
	cases := []error{
		fmt.Errorf("%w: cannot marshal payload", ErrAntiTraceMarshal),
		fmt.Errorf("%w: invalid URL", ErrAntiTraceRequest),
	}
	for _, err := range cases {
		if got := ClassifySMTPError(err); got != SMTPUnknown {
			t.Errorf("err %v: got %v, want SMTPUnknown", err, got)
		}
	}
}

// TestClassifySMTPError_AntiTracePrecedenceOverGenericText — a wrapped
// anti-trace error whose message happens to contain a string that the
// generic transient/permanent hint matcher would catch must still be
// classified by its sentinel, not by string-matching. Otherwise a relay
// rate-limit body containing "550 ..." text would flip to SMTPPermanent.
func TestClassifySMTPError_AntiTracePrecedenceOverGenericText(t *testing.T) {
	// HTTPStatus carries the body — body might contain a permanent-looking
	// 550 substring from a downstream MTA, but the relay-status sentinel
	// must win to avoid marking the contact as bounced because the relay
	// stuttered.
	body := "550 mailbox unavailable from inner MTA report"
	wrapped := fmt.Errorf("%w: 502: %s", ErrAntiTraceHTTPStatus, body)
	if got := ClassifySMTPError(wrapped); got != SMTPTransient {
		t.Errorf("HTTPStatus with permanent-looking body: got %v, want SMTPTransient (sentinel must win)", got)
	}
}

// TestClassifySMTPError_AntiTraceErrorsAreDistinguishable — every sentinel
// must remain identifiable via errors.Is. Catches accidental flattening of
// a sentinel into a plain fmt.Errorf("...").
func TestClassifySMTPError_AntiTraceErrorsAreDistinguishable(t *testing.T) {
	sentinels := []error{
		ErrAntiTraceMarshal,
		ErrAntiTraceRequest,
		ErrAntiTraceTransport,
		ErrAntiTraceRateLimited,
		ErrAntiTraceHTTPStatus,
	}
	for i, a := range sentinels {
		for j, b := range sentinels {
			if i == j {
				if !errors.Is(a, b) {
					t.Errorf("sentinel %v not equal to itself", a)
				}
				continue
			}
			if errors.Is(a, b) {
				t.Errorf("sentinel %v aliases %v — must be distinct", a, b)
			}
		}
	}
}
