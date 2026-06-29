package delivery

import (
	"errors"
	"fmt"
	"net/textproto"
	"reflect"
	"testing"
	"time"
)

// -----------------------------------------------------------------------------
// IsTransientSMTPError — RFC 5321 reply code classifier
// -----------------------------------------------------------------------------

func TestIsTransientSMTPError(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name      string
		err       error
		wantOK    bool
		wantCode  int
	}{
		// Sprint AW7-5 incident: LUMIT/auto-mt.com greylisted on first hop.
		// 421 is RFC 5321 §4.2.1 "Service not available, closing transmission
		// channel" — universally treated as a transient retry signal.
		{"421_service_not_available_closing", smtpErr(421, "Service not available"), true, 421},
		// 450 mailbox unavailable; classic greylist response from postgrey-style
		// rate limiters used by autostonis.cz.
		{"450_mailbox_unavailable_greylist", smtpErr(450, "<bob@autostonis.cz> 4.7.1 greylisted"), true, 450},
		{"451_local_error", smtpErr(451, "local error in processing"), true, 451},
		{"452_insufficient_storage", smtpErr(452, "insufficient system storage"), true, 452},
		{"454_temporary_auth_failure", smtpErr(454, "temporary authentication failure"), true, 454},
		// 5xx codes must NOT trigger a retry under any circumstance.
		{"550_recipient_rejected", smtpErr(550, "5.1.1 user unknown"), false, 550},
		{"535_auth_failed", smtpErr(535, "5.7.8 authentication failed"), false, 535},
		{"552_message_too_large", smtpErr(552, "5.3.4 message too large"), false, 552},
		// 4xx code outside the catalog: defensive default = no retry.
		{"4xx_uncatalogued_499", smtpErr(499, "unknown transient"), false, 499},
		// Wrapped errors (production path: fmt.Errorf("%w: <stage>: %v", …))
		{"wrapped_421", fmt.Errorf("delivery failed: rcpt to: %w", smtpErr(421, "greylisted")), true, 421},
		{"wrapped_550", fmt.Errorf("delivery failed: rcpt to: %w", smtpErr(550, "rejected")), false, 550},
		// Codeless transport errors (connect refused, context cancel, pool
		// quarantine/exhaustion): no SMTP reply, so code 0 and transient. The
		// message never reached the recipient MTA, so a retry cannot duplicate
		// it; MaxAttempts bounds the loop.
		{"connection_refused", errors.New("connect: connection refused"), true, 0},
		{"context_deadline", errors.New("context deadline exceeded"), true, 0},
		{"wgpool_all_quarantined", errors.New("wgpool: all endpoints quarantined"), true, 0},
		// nil is not a failure: never retry.
		{"nil_err", nil, false, 0},
		// Edge: a long number must not be misread as a 3-digit code (code stays
		// 0). With no code, the error is a codeless transport failure: transient.
		{"long_number_no_match", errors.New("packet 12345 dropped"), true, 0},
		// Edge: 3xx is not in the catalog (pre-completion).
		{"3xx_not_transient", smtpErr(354, "go ahead"), false, 354},
		// Edge: code with 5xx-prefix code (e.g. 5.7.1 enhanced) must be parsed
		// as 3-digit numeric code at the start.
		{"5xx_with_enhanced_code", errors.New("550 5.7.1 spam rejected"), false, 550},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, code := IsTransientSMTPError(tt.err)
			if got != tt.wantOK || code != tt.wantCode {
				t.Errorf("IsTransientSMTPError(%v) = (%v, %d), want (%v, %d)",
					tt.err, got, code, tt.wantOK, tt.wantCode)
			}
		})
	}
}

// TestIsTransientSMTPError_RecipientDigitsNotMisread is the regression guard for
// the extractor grabbing digits inside the recipient address. net/smtp returns
// a *textproto.Error for a 450 greylist; the relay used to wrap it as
// "rcpt to <addr>: <err>", so a recipient like nakup@stavebniny365.cz put "365"
// ahead of the real code in the scanned string and the 450 was misclassified as
// a permanent 3xx. The code must now be read from the textproto.Error itself,
// regardless of any address digits in an outer wrap.
func TestIsTransientSMTPError_RecipientDigitsNotMisread(t *testing.T) {
	t.Parallel()
	// Underlying protocol reply exactly as net/smtp surfaces it.
	reply := &textproto.Error{Code: 450, Msg: "4.7.1 greylisted, try again later"}
	// Outer wrap that still contains a digit-bearing recipient (worst case).
	wrapped := fmt.Errorf("%w: rcpt to nakup@stavebniny365.cz: %w", ErrDeliveryFailed, reply)

	ok, code := IsTransientSMTPError(wrapped)
	if !ok || code != 450 {
		t.Errorf("IsTransientSMTPError(wrapped 450 w/ digit recipient) = (%v, %d); want (true, 450) — "+
			"address digits must not be read as the reply code", ok, code)
	}
}

// -----------------------------------------------------------------------------
// ParseBackoffSpec — comma-separated duration list
// -----------------------------------------------------------------------------

func TestParseBackoffSpec(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		spec    string
		want    []time.Duration
		wantErr bool
	}{
		{"default_three_step", "5m,15m,60m", []time.Duration{
			5 * time.Minute, 15 * time.Minute, 60 * time.Minute,
		}, false},
		{"single", "30s", []time.Duration{30 * time.Second}, false},
		{"with_spaces", "  5m , 15m  ", []time.Duration{
			5 * time.Minute, 15 * time.Minute,
		}, false},
		{"trailing_comma", "5m,", []time.Duration{5 * time.Minute}, false},
		{"empty_string", "", nil, true},
		{"all_whitespace", "  ,  ,", nil, true},
		{"invalid_token", "5m,bogus,60m", nil, true},
		{"negative_duration", "-5m", nil, true},
		{"zero_duration", "0s", nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseBackoffSpec(tt.spec)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, tt.wantErr)
			}
			if !tt.wantErr && !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}

// -----------------------------------------------------------------------------
// RetryConfig — BackoffFor + ShouldRetry
// -----------------------------------------------------------------------------

func TestBackoffFor(t *testing.T) {
	t.Parallel()
	cfg := DefaultRetryConfig() // 5m, 15m, 60m
	if got := cfg.BackoffFor(1); got != 5*time.Minute {
		t.Errorf("attempt 1 backoff = %v, want 5m", got)
	}
	if got := cfg.BackoffFor(2); got != 15*time.Minute {
		t.Errorf("attempt 2 backoff = %v, want 15m", got)
	}
	if got := cfg.BackoffFor(3); got != 60*time.Minute {
		t.Errorf("attempt 3 backoff = %v, want 60m", got)
	}
	// Beyond configured slice → reuse last entry (capped exponential).
	if got := cfg.BackoffFor(99); got != 60*time.Minute {
		t.Errorf("attempt 99 backoff = %v, want 60m (capped)", got)
	}
	// Disabled → 0.
	disabled := DefaultRetryConfig()
	disabled.Enabled = false
	if got := disabled.BackoffFor(1); got != 0 {
		t.Errorf("disabled backoff = %v, want 0", got)
	}
	// Out-of-range attempt → 0.
	if got := cfg.BackoffFor(0); got != 0 {
		t.Errorf("attempt 0 backoff = %v, want 0", got)
	}
}

func TestShouldRetry(t *testing.T) {
	t.Parallel()
	cfg := DefaultRetryConfig() // enabled, max=3
	transient := smtpErr(421, "greylisted")
	perm := smtpErr(550, "rejected")

	tests := []struct {
		name     string
		cfg      RetryConfig
		attempts int
		err      error
		wantOK   bool
	}{
		{"transient_attempt1_of_3_yes", cfg, 1, transient, true},
		{"transient_attempt2_of_3_yes", cfg, 2, transient, true},
		// attempt 3 just failed → no more budget (max=3 means 3 total attempts).
		{"transient_attempt3_of_3_no", cfg, 3, transient, false},
		{"perm_5xx_no", cfg, 1, perm, false},
		{"feature_disabled", RetryConfig{Enabled: false, MaxAttempts: 3, Backoff: cfg.Backoff}, 1, transient, false},
		{"unknown_4xx_no", cfg, 1, smtpErr(499, "unknown"), false},
		{"nil_err_no", cfg, 1, nil, false},
		{"max_attempts_1_first_failure_no_retry",
			RetryConfig{Enabled: true, MaxAttempts: 1, Backoff: cfg.Backoff}, 1, transient, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, _ := tt.cfg.ShouldRetry(tt.attempts, tt.err)
			if got != tt.wantOK {
				t.Errorf("ShouldRetry(attempts=%d, err=%v) = %v, want %v",
					tt.attempts, tt.err, got, tt.wantOK)
			}
		})
	}
}

// TestRetryConfig_AntiTraceContract verifies the retry config does not change
// the delivery transport. Anti-trace path stays intact: only the "when" of
// the next attempt changes, not the "how" (engine.WithAntiTrace + relay
// transport selection are unaffected). This is a contract test enforcing
// HARD memory feedback_anti_trace_full_stack.
func TestRetryConfig_AntiTraceContract(t *testing.T) {
	t.Parallel()
	cfg := DefaultRetryConfig()
	// The retry layer must never expose a transport, deliverer, or sealing
	// hook: it is strictly a "when do we try again" knob. This test fails
	// loudly if a future change adds delivery-affecting fields.
	v := reflect.TypeOf(cfg)
	for i := 0; i < v.NumField(); i++ {
		f := v.Field(i)
		switch f.Name {
		case "Enabled", "MaxAttempts", "Backoff":
			// allowed
		default:
			t.Errorf("RetryConfig has unexpected field %q — retry must not "+
				"affect delivery transport (anti-trace contract)", f.Name)
		}
	}
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// smtpErr builds an error whose message begins with a 3-digit SMTP reply
// code, mimicking how net/smtp reports protocol-level failures. The format
// matches net/smtp.Client.cmd → readResponse: "<code> <text>".
func smtpErr(code int, text string) error {
	return fmt.Errorf("%d %s", code, text)
}
