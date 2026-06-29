package sender

import (
	"common/config"
	"testing"
	"time"
)

// Helper: engine with short state for prune tests
func newPruneEngine() *Engine {
	return NewEngine(
		[]config.MailboxConfig{{Address: "from@x.test"}},
		config.SendingConfig{MaxPerDomainHour: 100, Timezone: "UTC", WindowStart: 0, WindowEnd: 24},
		config.SafetyConfig{MaxBounceRate: 0.3},
	)
}

// ── Hourly reset includes domainSent + domainBounces ─────────

func TestReset_HourlyResetsdomainSentAndBounces(t *testing.T) {
	e := newPruneEngine()
	e.domainSent["a.test"] = 50
	e.domainBounces["a.test"] = 10
	e.domainCounts["a.test"] = 5

	// Force reset by backdating lastReset
	e.lastReset = time.Now().Add(-2 * time.Hour)
	e.resetCountersIfNeeded()

	if e.domainSent["a.test"] != 0 {
		t.Errorf("domainSent not reset on hourly tick: %d", e.domainSent["a.test"])
	}
	if e.domainBounces["a.test"] != 0 {
		t.Errorf("domainBounces not reset on hourly tick: %d", e.domainBounces["a.test"])
	}
	if e.domainCounts["a.test"] != 0 {
		t.Errorf("domainCounts not reset on hourly tick: %d", e.domainCounts["a.test"])
	}
}

func TestReset_HourlyDoesNotResetSentCounts(t *testing.T) {
	e := newPruneEngine()
	e.sentCounts["from@x.test"] = 42
	e.lastReset = time.Now().Add(-2 * time.Hour)
	e.resetCountersIfNeeded()

	if e.sentCounts["from@x.test"] != 42 {
		t.Errorf("sentCounts should NOT be reset on hourly tick, got %d", e.sentCounts["from@x.test"])
	}
}

// ── Prune: expired domainDeferredUntil entries ────────────────

func TestPrune_ExpiredDomainDeferral_Removed(t *testing.T) {
	e := newPruneEngine()
	e.domainDeferredUntil["old.test"] = time.Now().Add(-time.Minute) // expired
	e.domainBackoffAttempt["old.test"] = 3
	e.domainDeferredUntil["fresh.test"] = time.Now().Add(time.Hour) // still active

	e.lastReset = time.Now().Add(-2 * time.Hour)
	e.resetCountersIfNeeded()

	if _, ok := e.domainDeferredUntil["old.test"]; ok {
		t.Error("expired domainDeferredUntil entry should be pruned")
	}
	// The attempt counter MUST survive the deferral expiry so the greylisting
	// escalation ladder (15m→1h→4h→24h→permanent) keeps climbing on the next
	// retry. It is cleared only on a successful send, never by the prune pass.
	if got := e.domainBackoffAttempt["old.test"]; got != 3 {
		t.Errorf("domainBackoffAttempt must survive deferral prune to preserve escalation, got %d, want 3", got)
	}
	if _, ok := e.domainDeferredUntil["fresh.test"]; !ok {
		t.Error("active domainDeferredUntil entry must NOT be pruned")
	}
}

// ── Prune: expired domainCircuitOpen entries ──────────────────

func TestPrune_ExpiredDomainCircuit_Removed(t *testing.T) {
	e := newPruneEngine()
	e.domainCircuitOpen["stale.test"] = time.Now().Add(-2 * time.Hour) // >1h old → auto-expire
	e.domainCircuitOpen["live.test"] = time.Now().Add(-30 * time.Minute) // <1h → still open

	e.lastReset = time.Now().Add(-2 * time.Hour)
	e.resetCountersIfNeeded()

	if _, ok := e.domainCircuitOpen["stale.test"]; ok {
		t.Error("stale domainCircuitOpen (>1h) should be pruned")
	}
	if _, ok := e.domainCircuitOpen["live.test"]; !ok {
		t.Error("recent domainCircuitOpen (<1h) must NOT be pruned")
	}
}

// ── Prune: expired mailboxCooldownUntil entries ───────────────

func TestPrune_ExpiredMailboxCooldown_Removed(t *testing.T) {
	e := newPruneEngine()
	e.mailboxCooldownUntil["mb@cold.test"] = time.Now().Add(-time.Minute) // expired
	e.mailboxConsecutiveFails["mb@cold.test"] = 5
	e.mailboxCooldownUntil["mb@warm.test"] = time.Now().Add(time.Hour) // still active

	e.lastReset = time.Now().Add(-2 * time.Hour)
	e.resetCountersIfNeeded()

	if _, ok := e.mailboxCooldownUntil["mb@cold.test"]; ok {
		t.Error("expired mailboxCooldownUntil should be pruned")
	}
	if _, ok := e.mailboxConsecutiveFails["mb@cold.test"]; ok {
		t.Error("mailboxConsecutiveFails for expired mailbox should be pruned")
	}
	if _, ok := e.mailboxCooldownUntil["mb@warm.test"]; !ok {
		t.Error("active mailboxCooldownUntil must NOT be pruned")
	}
}

// ── Prune: runs even when last reset < 1 hour ago ────────────
// Prune is call-frequency independent — expired entries removed immediately,
// not gated behind the hourly reset window. This prevents 1h+ stale accumulation.

func TestPrune_FiresEvenWithinHour(t *testing.T) {
	e := newPruneEngine()
	e.domainDeferredUntil["x.test"] = time.Now().Add(-time.Minute) // expired
	e.domainBackoffAttempt["x.test"] = 2

	e.lastReset = time.Now().Add(-30 * time.Minute) // <1h: no hourly reset
	e.resetCountersIfNeeded()

	// Expired entry must still be pruned even without hourly reset
	if _, ok := e.domainDeferredUntil["x.test"]; ok {
		t.Error("expired domainDeferredUntil must be pruned regardless of hourly gate")
	}
}

// ── Maps stay bounded across many domains ────────────────────

func TestMaps_BoundedAfterHourlyReset(t *testing.T) {
	e := newPruneEngine()

	// Simulate 1000 unique domains seen in hour 1
	for i := 0; i < 1000; i++ {
		domain := config.MailboxConfig{Address: "x"}.Address // just to reference cfg
		_ = domain
		key := "domain" + string(rune('a'+i%26)) + ".test"
		e.domainSent[key]++
		e.domainBounces[key]++
		e.domainCounts[key]++
	}

	before := len(e.domainSent)
	if before == 0 {
		t.Fatal("setup: expected non-zero domainSent")
	}

	// Hourly reset should clear them all
	e.lastReset = time.Now().Add(-2 * time.Hour)
	e.resetCountersIfNeeded()

	if len(e.domainSent) != 0 {
		t.Errorf("after hourly reset, domainSent should be empty, got %d entries", len(e.domainSent))
	}
	if len(e.domainBounces) != 0 {
		t.Errorf("after hourly reset, domainBounces should be empty, got %d entries", len(e.domainBounces))
	}
}
