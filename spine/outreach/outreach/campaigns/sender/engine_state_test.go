package sender

import (
	"errors"
	"common/config"
	"net/textproto"
	"testing"
	"time"
)

func newTestEngine() *Engine {
	return NewEngine(
		[]config.MailboxConfig{{Address: "from@x.test"}},
		config.SendingConfig{MaxPerDomainHour: 100, Timezone: "UTC", WindowStart: 0, WindowEnd: 24},
		config.SafetyConfig{MaxBounceRate: 0.3},
	)
}

func TestRecordSendResult_TransientDefersNextSend(t *testing.T) {
	e := newTestEngine()
	// Simulate 451 greylisting.
	err := &textproto.Error{Code: 451, Msg: "greylisted"}
	e.recordSendResult("from@x.test", "recipient.test", err)

	if got := e.bounceCount; got != 0 {
		t.Errorf("transient error must not increment bounceCount, got %d", got)
	}
	if got := e.domainBounces["recipient.test"]; got != 0 {
		t.Errorf("transient error must not increment domainBounces, got %d", got)
	}
	if e.domainBackoffAttempt["recipient.test"] != 1 {
		t.Errorf("backoff attempt counter not advanced: %d", e.domainBackoffAttempt["recipient.test"])
	}
	// allowDomain must reject during deferral window.
	if e.allowDomain("recipient.test") {
		t.Error("allowDomain should reject during greylisting deferral")
	}
}

func TestRecordSendResult_OKClearsBackoff(t *testing.T) {
	e := newTestEngine()
	// First attempt deferred.
	e.recordSendResult("from@x.test", "r.test", &textproto.Error{Code: 451})
	if e.domainBackoffAttempt["r.test"] == 0 {
		t.Fatal("setup: expected backoff attempt to be recorded")
	}
	// Force past the deferral window by clearing it, then simulate success.
	e.domainDeferredUntil["r.test"] = time.Now().Add(-time.Minute)
	e.recordSendResult("from@x.test", "r.test", nil)

	if _, still := e.domainDeferredUntil["r.test"]; still {
		t.Error("success must clear deferredUntil")
	}
	if e.domainBackoffAttempt["r.test"] != 0 {
		t.Errorf("success must reset backoff attempt, got %d", e.domainBackoffAttempt["r.test"])
	}
}

func TestRecordSendResult_PermanentIncrementsBounces(t *testing.T) {
	e := newTestEngine()
	e.recordSendResult("from@x.test", "r.test", &textproto.Error{Code: 550, Msg: "no such user"})
	if e.bounceCount != 1 {
		t.Errorf("permanent must increment bounceCount, got %d", e.bounceCount)
	}
	if e.domainBounces["r.test"] != 1 {
		t.Errorf("permanent must increment domainBounces, got %d", e.domainBounces["r.test"])
	}
	if _, deferred := e.domainDeferredUntil["r.test"]; deferred {
		t.Error("permanent must not set deferral")
	}
}

func TestRecordSendResult_GreylistingBudgetExhaustion(t *testing.T) {
	e := newTestEngine()
	// Push past the max attempts. After maxGreylistingAttempts, next 4xx
	// should be counted as permanent bounce.
	for i := 0; i < maxGreylistingAttempts; i++ {
		e.recordSendResult("from@x.test", "r.test", &textproto.Error{Code: 451})
	}
	if e.bounceCount != 0 {
		t.Errorf("pre-exhaustion bounceCount should be 0, got %d", e.bounceCount)
	}
	// Clear deferral to allow next recording.
	e.domainDeferredUntil["r.test"] = time.Now().Add(-time.Minute)
	e.recordSendResult("from@x.test", "r.test", &textproto.Error{Code: 451})
	if e.bounceCount == 0 {
		t.Error("exhausted budget must flip next 4xx into bounce")
	}
}

func TestRecordSendResult_PerDomainCircuitTrips(t *testing.T) {
	e := newTestEngine()
	// 15 attempts, 10 bounces — 66 % bounce rate, above the 30 % threshold.
	for i := 0; i < 10; i++ {
		e.recordSendResult("from@x.test", "bad.test", errors.New("550 user unknown"))
	}
	for i := 0; i < 5; i++ {
		e.recordSendResult("from@x.test", "bad.test", nil)
	}
	if _, open := e.domainCircuitOpen["bad.test"]; !open {
		t.Errorf("per-domain circuit should be open for bad.test; state: sent=%d bounces=%d",
			e.domainSent["bad.test"], e.domainBounces["bad.test"])
	}
	if e.allowDomain("bad.test") {
		t.Error("allowDomain must reject while domain circuit is open")
	}
	// Unrelated domain must still be allowed.
	if !e.allowDomain("good.test") {
		t.Error("unrelated domain must not be affected by bad.test circuit")
	}
}

func TestRecordSendResult_CircuitReclosesAfterCooldown(t *testing.T) {
	e := newTestEngine()
	// Manually open the circuit in the past.
	e.domainCircuitOpen["b.test"] = time.Now().Add(-2 * time.Hour)
	e.domainSent["b.test"] = 50
	e.domainBounces["b.test"] = 40

	if !e.allowDomain("b.test") {
		t.Error("after 1h cooldown allowDomain should permit again")
	}
	// Reclose should have reset per-domain counters.
	if e.domainSent["b.test"] != 0 || e.domainBounces["b.test"] != 0 {
		t.Errorf("reclose should reset counters, sent=%d bounces=%d",
			e.domainSent["b.test"], e.domainBounces["b.test"])
	}
}
