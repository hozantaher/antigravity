package sender

import (
	"errors"
	"common/config"
	"testing"
	"time"
)

// Per-mailbox circuit breaker tests. The breaker complements the DB-backed
// registry auto-hold: registry tracks bounce-rate over longer windows, while
// this in-process breaker trips fast on SMTPUnknown outcomes (dial/TLS/auth
// failures) so pickMailbox stops burning cycles on a sick mailbox.
//
// Contract recap (see engine.go: recordSendResult SMTPUnknown branch):
//   - mailboxFailThreshold (3) consecutive SMTPUnknown results → cooldown set
//   - mailboxCooldown      (30m) is the minimum skip window
//   - any SMTPOK result resets both the counter and the cooldown
//   - pickMailbox skips a mailbox while cooldown is active, unskips once elapsed

func newBreakerEngine(addrs ...string) *Engine {
	mbs := make([]config.MailboxConfig, len(addrs))
	for i, a := range addrs {
		mbs[i] = config.MailboxConfig{Address: a, DailyLimit: 1000}
	}
	return NewEngine(mbs,
		config.SendingConfig{MaxPerDomainHour: 100, Timezone: "UTC", WindowStart: 0, WindowEnd: 24},
		config.SafetyConfig{MaxBounceRate: 0.99}, // keep global breaker out of the way
	)
}

func TestMailboxCircuitBreaker_TripsAfterThresholdFailures(t *testing.T) {
	e := newBreakerEngine("a@s.test")
	// A plain error (not a textproto.Error with 4xx/5xx, not a transient hint,
	// not a permanent hint) classifies as SMTPUnknown.
	unknown := errors.New("connection refused")

	// First two failures must not trip the breaker.
	for i := 0; i < mailboxFailThreshold-1; i++ {
		e.recordSendResult("a@s.test", "rcpt.test", unknown)
		if _, tripped := e.mailboxCooldownUntil["a@s.test"]; tripped {
			t.Fatalf("cooldown tripped prematurely after %d failures", i+1)
		}
	}
	if got := e.mailboxConsecutiveFails["a@s.test"]; got != mailboxFailThreshold-1 {
		t.Errorf("consecutive_fails=%d, want %d", got, mailboxFailThreshold-1)
	}

	// Third failure must trip.
	e.recordSendResult("a@s.test", "rcpt.test", unknown)
	until, tripped := e.mailboxCooldownUntil["a@s.test"]
	if !tripped {
		t.Fatal("cooldown not tripped after threshold failures")
	}
	if d := time.Until(until); d < mailboxCooldown-time.Minute || d > mailboxCooldown+time.Minute {
		t.Errorf("cooldown window ~%s, want ~%s", d, mailboxCooldown)
	}
}

func TestMailboxCircuitBreaker_SMTPOKResetsCounter(t *testing.T) {
	e := newBreakerEngine("a@s.test")
	unknown := errors.New("tls handshake failure")

	// Accumulate failures below threshold.
	for i := 0; i < mailboxFailThreshold-1; i++ {
		e.recordSendResult("a@s.test", "rcpt.test", unknown)
	}
	// One success clears the counter.
	e.recordSendResult("a@s.test", "rcpt.test", nil)
	if got := e.mailboxConsecutiveFails["a@s.test"]; got != 0 {
		t.Errorf("consecutive_fails after SMTPOK=%d, want 0", got)
	}
	if _, stillCooldown := e.mailboxCooldownUntil["a@s.test"]; stillCooldown {
		t.Error("SMTPOK must clear any pending cooldown")
	}

	// Post-reset, we need the full threshold of failures again to trip.
	for i := 0; i < mailboxFailThreshold-1; i++ {
		e.recordSendResult("a@s.test", "rcpt.test", unknown)
		if _, tripped := e.mailboxCooldownUntil["a@s.test"]; tripped {
			t.Fatalf("breaker tripped early after reset; failure %d", i+1)
		}
	}
}

func TestMailboxCircuitBreaker_SMTPOKClearsActiveCooldown(t *testing.T) {
	e := newBreakerEngine("a@s.test")
	// Simulate an already-tripped cooldown (e.g. from a prior outage).
	e.mailboxCooldownUntil["a@s.test"] = time.Now().Add(20 * time.Minute)
	e.mailboxConsecutiveFails["a@s.test"] = mailboxFailThreshold

	// A successful send recovers the mailbox immediately.
	e.recordSendResult("a@s.test", "rcpt.test", nil)

	if _, still := e.mailboxCooldownUntil["a@s.test"]; still {
		t.Error("SMTPOK must clear active cooldown window")
	}
	if got := e.mailboxConsecutiveFails["a@s.test"]; got != 0 {
		t.Errorf("consecutive_fails not cleared: %d", got)
	}
}

func TestMailboxCircuitBreaker_PickMailboxSkipsCooldown(t *testing.T) {
	// Two mailboxes: the first is cooling down, so pickMailbox must return
	// the second even though round-robin would otherwise hand out the first.
	e := newBreakerEngine("cold@s.test", "warm@s.test")
	e.mailboxCooldownUntil["cold@s.test"] = time.Now().Add(10 * time.Minute)
	e.mailboxConsecutiveFails["cold@s.test"] = mailboxFailThreshold

	for i := 0; i < 5; i++ {
		mb, err := e.pickMailbox("")
		if err != nil {
			t.Fatalf("pickMailbox returned err: %v", err)
		}
		if mb.Address == "cold@s.test" {
			t.Fatalf("pickMailbox handed out cooled-down mailbox on iter %d", i)
		}
	}
}

func TestMailboxCircuitBreaker_PickMailboxResumesAfterExpiry(t *testing.T) {
	e := newBreakerEngine("a@s.test")
	// Expired cooldown: the stored timestamp is in the past.
	e.mailboxCooldownUntil["a@s.test"] = time.Now().Add(-time.Minute)
	e.mailboxConsecutiveFails["a@s.test"] = mailboxFailThreshold

	mb, err := e.pickMailbox("")
	if err != nil {
		t.Fatalf("pickMailbox: %v", err)
	}
	if mb.Address != "a@s.test" {
		t.Errorf("expected the only mailbox after cooldown expiry, got %q", mb.Address)
	}
	// Expiry path must also purge the stale bookkeeping.
	if _, still := e.mailboxCooldownUntil["a@s.test"]; still {
		t.Error("pickMailbox did not clear expired cooldown entry")
	}
	if got := e.mailboxConsecutiveFails["a@s.test"]; got != 0 {
		t.Errorf("pickMailbox did not reset consecutive_fails on expiry, got %d", got)
	}
}

func TestMailboxCircuitBreaker_OnlyCooledMailboxErrors(t *testing.T) {
	// All mailboxes in cooldown → pickMailbox must surface a "no mailbox"
	// error rather than silently pick one.
	e := newBreakerEngine("a@s.test", "b@s.test")
	until := time.Now().Add(15 * time.Minute)
	e.mailboxCooldownUntil["a@s.test"] = until
	e.mailboxCooldownUntil["b@s.test"] = until

	if _, err := e.pickMailbox(""); err == nil {
		t.Fatal("pickMailbox should return error when every mailbox is cooled down")
	}
}

func TestMailboxCircuitBreaker_TransientDoesNotIncrementFails(t *testing.T) {
	// A 4xx greylisting is SMTPTransient — it goes through the per-domain
	// backoff path, not the per-mailbox cooldown. The breaker must not count
	// it or a noisy Seznam greylist on one recipient would sideline the
	// entire mailbox.
	e := newBreakerEngine("a@s.test")
	transient := errors.New("451 greylisted, try again later")

	for i := 0; i < mailboxFailThreshold*2; i++ {
		e.recordSendResult("a@s.test", "rcpt.test", transient)
		// clear the deferral so subsequent calls record instead of being
		// short-circuited by allowDomain
		e.domainDeferredUntil["rcpt.test"] = time.Now().Add(-time.Second)
	}

	if got := e.mailboxConsecutiveFails["a@s.test"]; got != 0 {
		t.Errorf("transient errors must not increment consecutive_fails, got %d", got)
	}
	if _, tripped := e.mailboxCooldownUntil["a@s.test"]; tripped {
		t.Error("transient errors must not trip mailbox cooldown")
	}
}

func TestMailboxCircuitBreaker_PermanentDoesNotIncrementFails(t *testing.T) {
	// A 5xx is SMTPPermanent — it counts toward domain bounce rate and the
	// registry's bounce counters, but is a recipient-level signal, not a
	// mailbox-health signal. Must not trip the per-mailbox cooldown.
	e := newBreakerEngine("a@s.test")
	permanent := errors.New("550 user unknown")

	for i := 0; i < mailboxFailThreshold*2; i++ {
		e.recordSendResult("a@s.test", "rcpt.test", permanent)
	}

	if got := e.mailboxConsecutiveFails["a@s.test"]; got != 0 {
		t.Errorf("permanent errors must not increment consecutive_fails, got %d", got)
	}
	if _, tripped := e.mailboxCooldownUntil["a@s.test"]; tripped {
		t.Error("permanent errors must not trip mailbox cooldown")
	}
}

func TestMailboxCircuitBreaker_IsolatesMailboxes(t *testing.T) {
	// Failures on mailbox A must not trip mailbox B's breaker — per-mailbox
	// isolation is the whole point.
	e := newBreakerEngine("a@s.test", "b@s.test")
	unknown := errors.New("dial tcp: no route to host")

	for i := 0; i < mailboxFailThreshold; i++ {
		e.recordSendResult("a@s.test", "rcpt.test", unknown)
	}

	if _, tripped := e.mailboxCooldownUntil["a@s.test"]; !tripped {
		t.Fatal("mailbox A should be in cooldown")
	}
	if _, tripped := e.mailboxCooldownUntil["b@s.test"]; tripped {
		t.Error("mailbox B must not be affected by A's failures")
	}
	if got := e.mailboxConsecutiveFails["b@s.test"]; got != 0 {
		t.Errorf("mailbox B consecutive_fails leaked, got %d", got)
	}
}

// BF-E2 — explicit half-open: ResetMailboxBreaker clears cooldown so the
// engine immediately resumes sending after the watchdog signals healing
// (manual app-password rotation, proxy refresh, etc.).
func TestMailboxCircuitBreaker_ResetMailboxBreaker_ClearsCooldown(t *testing.T) {
	e := newBreakerEngine("a@s.test")
	unknown := errors.New("auth: 535 bad credentials")

	for i := 0; i < mailboxFailThreshold; i++ {
		e.recordSendResult("a@s.test", "rcpt.test", unknown)
	}
	if _, tripped := e.mailboxCooldownUntil["a@s.test"]; !tripped {
		t.Fatal("setup: cooldown should be active before reset")
	}
	if got := e.mailboxConsecutiveFails["a@s.test"]; got != mailboxFailThreshold {
		t.Fatalf("setup: consecutive_fails=%d, want %d", got, mailboxFailThreshold)
	}

	e.ResetMailboxBreaker("a@s.test")

	if _, tripped := e.mailboxCooldownUntil["a@s.test"]; tripped {
		t.Error("ResetMailboxBreaker did not clear cooldown")
	}
	if got := e.mailboxConsecutiveFails["a@s.test"]; got != 0 {
		t.Errorf("ResetMailboxBreaker did not clear consecutive_fails, got %d", got)
	}
}

// ResetMailboxBreaker on an unknown / never-failed mailbox must be a no-op,
// not a panic. The watchdog may fire reset speculatively after every
// healing event, even when the engine never opened a breaker for that mailbox.
func TestMailboxCircuitBreaker_ResetMailboxBreaker_UnknownMailboxIsNoop(t *testing.T) {
	e := newBreakerEngine("a@s.test")
	// Different mailbox name — never tracked by the engine.
	e.ResetMailboxBreaker("never-failed@s.test")
	// Sanity: nothing got created as a side effect.
	if _, ok := e.mailboxCooldownUntil["never-failed@s.test"]; ok {
		t.Error("ResetMailboxBreaker created phantom cooldown entry")
	}
}

// Reset isolation: clearing breaker for mailbox A must not touch mailbox B.
func TestMailboxCircuitBreaker_ResetMailboxBreaker_DoesNotAffectOthers(t *testing.T) {
	e := newBreakerEngine("a@s.test", "b@s.test")
	unknown := errors.New("tls handshake error")
	for i := 0; i < mailboxFailThreshold; i++ {
		e.recordSendResult("a@s.test", "rcpt.test", unknown)
		e.recordSendResult("b@s.test", "rcpt.test", unknown)
	}

	e.ResetMailboxBreaker("a@s.test")

	if _, tripped := e.mailboxCooldownUntil["b@s.test"]; !tripped {
		t.Error("reset of mailbox A wrongly cleared mailbox B's cooldown")
	}
	if got := e.mailboxConsecutiveFails["b@s.test"]; got != mailboxFailThreshold {
		t.Errorf("reset of mailbox A leaked into mailbox B counter: %d", got)
	}
}
