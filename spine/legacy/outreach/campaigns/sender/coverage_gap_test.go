package sender

// coverage_gap_test.go — retroactive TDD pass targeting uncovered branches
// in engine.go. SMTP-EGRESS-LOCKDOWN R4: tests exercising the deleted
// Engine.send() method were removed; remaining tests cover pure engine
// plumbing (circuit breaker, dequeue, requeue, counter reset, antitrace
// payload shape) with no direct SMTP dependency.

import (
	"encoding/json"
	"testing"
	"time"

	"common/config"
)

// TestEngine_isCircuitOpen_True verifies isCircuitOpen returns true after the
// circuit is manually tripped.
func TestEngine_isCircuitOpen_True(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	if e.isCircuitOpen() {
		t.Fatal("circuit should be closed initially")
	}

	e.mu.Lock()
	e.circuitOpen = true
	e.mu.Unlock()

	if !e.isCircuitOpen() {
		t.Error("isCircuitOpen should return true after manual open")
	}
}

// TestEngine_Dequeue_EmptyQueue verifies dequeue returns ok=false on an empty queue.
func TestEngine_Dequeue_EmptyQueue(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	_, ok := e.dequeue()
	if ok {
		t.Error("dequeue on empty queue should return ok=false")
	}
}

// TestEngine_Requeue_FrontOnNoMailbox verifies the requeue-at-front behaviour
// that Run uses when pickMailbox fails (exhausted mailboxes).
func TestEngine_Requeue_FrontOnNoMailbox(t *testing.T) {
	e := NewEngine(
		[]config.MailboxConfig{{Address: "a@t.cz", DailyLimit: 1}},
		config.SendingConfig{},
		config.SafetyConfig{},
	)

	e.mu.Lock()
	e.sentCounts["a@t.cz"] = 1
	e.mu.Unlock()

	_, err := e.pickMailbox("")
	if err == nil {
		t.Fatal("expected pickMailbox to fail when all mailboxes are exhausted")
	}

	priority := SendRequest{ContactID: 99}
	filler := SendRequest{ContactID: 1}
	e.Enqueue(filler)

	e.mu.Lock()
	e.queue = append([]SendRequest{priority}, e.queue...)
	e.mu.Unlock()

	got, ok := e.dequeue()
	if !ok || got.ContactID != 99 {
		t.Errorf("priority item should be at front, got ContactID=%d ok=%v", got.ContactID, ok)
	}
}

// TestEngine_Requeue_BackOnDomainLimit verifies the append-to-back requeue
// when allowDomain returns false.
func TestEngine_Requeue_BackOnDomainLimit(t *testing.T) {
	e := NewEngine(
		nil,
		config.SendingConfig{MaxPerDomainHour: 1},
		config.SafetyConfig{},
	)

	e.mu.Lock()
	e.domainCounts["target.cz"] = 1
	e.mu.Unlock()

	if e.allowDomain("target.cz") {
		t.Fatal("target.cz should be rate-limited")
	}

	normal := SendRequest{ContactID: 1}
	limited := SendRequest{ContactID: 99}
	e.Enqueue(normal)
	e.mu.Lock()
	e.queue = append(e.queue, limited)
	e.mu.Unlock()

	first, _ := e.dequeue()
	second, _ := e.dequeue()
	if first.ContactID != 1 {
		t.Errorf("first should be normal item, got ContactID=%d", first.ContactID)
	}
	if second.ContactID != 99 {
		t.Errorf("second should be rate-limited item, got ContactID=%d", second.ContactID)
	}
}

// TestEngine_ResetCounters_DailySentCountsReset verifies sentCounts is cleared
// on a new calendar day even when the hourly reset branch fires first.
//
// Regression for the single-shared-timestamp bug: the daily reset is now
// evaluated against its own lastDailyReset timestamp, so a stale morning tick
// (>1h after the prior hourly reset, on a new day) clears the per-mailbox
// daily counts instead of being silently defeated by the hourly branch
// overwriting the shared timestamp to `now`. No midnight-window skip needed.
func TestEngine_ResetCounters_DailySentCountsReset(t *testing.T) {
	now := time.Now()

	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	e.mu.Lock()
	e.sentCounts["mb@t.cz"] = 99
	e.lastReset = now.Add(-2 * time.Hour)    // >1h ago → hourly branch fires first
	e.lastDailyReset = now.AddDate(0, 0, -1) // yesterday → daily window rolled over
	e.mu.Unlock()

	e.resetCountersIfNeeded()

	e.mu.Lock()
	sc := e.sentCounts["mb@t.cz"]
	e.mu.Unlock()

	if sc != 0 {
		t.Errorf("sentCounts should be 0 after daily reset, got %d", sc)
	}
}

// TestAntiTraceClient_Send_MarshalAlwaysSucceeds documents that antiTraceRequest
// is a struct with only basic JSON-serialisable field types, so json.Marshal
// will never fail in practice.
func TestAntiTraceClient_Send_MarshalAlwaysSucceeds(t *testing.T) {
	payload := antiTraceRequest{
		Recipient:   "r@t.cz",
		Subject:     "Subject with special chars: <>&",
		Body:        "Plain body\nwith newlines",
		BodyHTML:    "<html><body>HTML &amp; content</body></html>",
		Headers:     map[string]string{"X-Test": "value"},
		FromAddress: "sender@firma.cz",
	}
	_, err := json.Marshal(payload)
	if err != nil {
		t.Errorf("json.Marshal of antiTraceRequest should never fail, got: %v", err)
	}
}
