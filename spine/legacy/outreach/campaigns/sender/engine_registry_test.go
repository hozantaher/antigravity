package sender

import (
	"context"
	"errors"
	"common/config"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeBackpressure is a scriptable mailbox.Backpressure used to validate
// that Engine gates pickMailbox and records outcomes per D2.3.
//
// Note: this fake intentionally does NOT implement mailbox.MailboxLister
// so existing tests exercise the legacy (config-only) pickMailbox path.
// Tests that want to drive the 2026-05-13 self-heal logic use
// fakeListerBackpressure (below) which embeds fakeBackpressure and adds
// an ActiveMailboxes method returning a scripted slice.
type fakeBackpressure struct {
	mu             sync.Mutex
	active         map[string]struct{}
	activeErr      error
	activeCalls    int32
	successCalls   []string
	bounceCalls    []bounceCall
	bounceWillHold bool
}

type bounceCall struct {
	Address string
	Reason  string
}

func (f *fakeBackpressure) RecordSuccess(_ context.Context, addr string, _ time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.successCalls = append(f.successCalls, addr)
}
func (f *fakeBackpressure) RecordBounce(_ context.Context, addr, reason string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bounceCalls = append(f.bounceCalls, bounceCall{addr, reason})
	return f.bounceWillHold
}
func (f *fakeBackpressure) ActiveAddresses(_ context.Context) (map[string]struct{}, error) {
	atomic.AddInt32(&f.activeCalls, 1)
	if f.activeErr != nil {
		return nil, f.activeErr
	}
	return f.active, nil
}

// fakeListerBackpressure embeds fakeBackpressure and additionally satisfies
// mailbox.MailboxLister. Used by 2026-05-13 self-heal tests so the engine
// can refresh its in-memory mailbox list from the registry mid-run.
type fakeListerBackpressure struct {
	fakeBackpressure
	activeMbs       []config.MailboxConfig
	activeMbsErr    error
	activeMbsCalls  int32
}

func (f *fakeListerBackpressure) ActiveMailboxes(_ context.Context) ([]config.MailboxConfig, error) {
	atomic.AddInt32(&f.activeMbsCalls, 1)
	if f.activeMbsErr != nil {
		return nil, f.activeMbsErr
	}
	return f.activeMbs, nil
}

// waitFor polls a condition for up to 1s — RecordSuccess / RecordBounce are
// dispatched on goroutines in recordSendResult so we can't synchronously
// observe them without a small wait.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Error("timed out waiting for async registry call")
}

func TestEngine_PickMailbox_RegistrySkipsInactive(t *testing.T) {
	// A mailbox present in config but absent from the registry's active set
	// (paused / bounce_hold / retired in the cockpit) must be skipped by
	// pickMailbox.
	mbs := []config.MailboxConfig{
		{Address: "paused@sender.test", DailyLimit: 100},
		{Address: "active@sender.test", DailyLimit: 100},
	}
	bp := &fakeBackpressure{
		active: map[string]struct{}{
			"active@sender.test": {},
			// "paused@sender.test" deliberately missing
		},
	}

	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	mb, err := e.pickMailbox("")
	if err != nil {
		t.Fatalf("pickMailbox: %v", err)
	}
	if mb.Address != "active@sender.test" {
		t.Errorf("expected active@sender.test, got %s", mb.Address)
	}

	// A second call must also skip the paused mailbox — round-robin must not
	// hand out the inactive one just because its index came up.
	mb2, err := e.pickMailbox("")
	if err != nil {
		t.Fatalf("second pickMailbox: %v", err)
	}
	if mb2.Address != "active@sender.test" {
		t.Errorf("second: expected active@sender.test, got %s", mb2.Address)
	}
}

func TestEngine_PickMailbox_RegistryNormalisesAddresses(t *testing.T) {
	// Registry returns NormaliseAddress-keyed set (lowercase trimmed).
	// pickMailbox must match config addresses through the same normalisation
	// so YAML casing variance does not silently skip everyone.
	mbs := []config.MailboxConfig{
		{Address: "  JAN@Sender.Test  ", DailyLimit: 100},
	}
	bp := &fakeBackpressure{
		active: map[string]struct{}{"jan@sender.test": {}},
	}

	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	mb, err := e.pickMailbox("")
	if err != nil {
		t.Fatalf("pickMailbox: %v", err)
	}
	if mb.Address != "  JAN@Sender.Test  " {
		t.Errorf("unexpected mailbox: %s", mb.Address)
	}
}

func TestEngine_PickMailbox_RegistryOutageFailsClosed_StrictDefault(t *testing.T) {
	// INCIDENT 2026-05-13: registry outage under strict mode (the default
	// after WithMailboxRegistry) must REFUSE to send, returning
	// ErrRegistryUnavailable. The Run loop re-queues + retries on the
	// next tick. A transient DB hiccup is acceptable for one tick;
	// silently sending from possibly-deleted env-var mailboxes is not.
	mbs := []config.MailboxConfig{
		{Address: "only@sender.test", DailyLimit: 100},
	}
	bp := &fakeBackpressure{activeErr: errors.New("db down")}

	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	_, err := e.pickMailbox("")
	if err == nil {
		t.Fatal("strict mode must refuse send on registry outage")
	}
	if !errors.Is(err, ErrRegistryUnavailable) {
		t.Errorf("expected ErrRegistryUnavailable, got %v", err)
	}
}

func TestEngine_PickMailbox_RegistryOutageFailsOpen_LegacyOptIn(t *testing.T) {
	// Legacy fail-open behaviour preserved for callers that opt out of
	// strict mode (tests / dev scripts). WithStrictRegistryEnforcement(false)
	// restores the pre-INCIDENT-2026-05-13 fall-through.
	mbs := []config.MailboxConfig{
		{Address: "only@sender.test", DailyLimit: 100},
	}
	bp := &fakeBackpressure{activeErr: errors.New("db down")}

	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp).
		WithStrictRegistryEnforcement(false)

	mb, err := e.pickMailbox("")
	if err != nil {
		t.Fatalf("legacy mode must fall through on registry outage: %v", err)
	}
	if mb.Address != "only@sender.test" {
		t.Errorf("unexpected mailbox: %s", mb.Address)
	}
}

func TestEngine_PickMailbox_RegistryCachesActiveSet(t *testing.T) {
	// ActiveAddresses must be TTL-cached so the send hot loop does not
	// hammer the registry DB.
	mbs := []config.MailboxConfig{
		{Address: "a@sender.test", DailyLimit: 100},
	}
	bp := &fakeBackpressure{
		active: map[string]struct{}{"a@sender.test": {}},
	}
	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	for i := 0; i < 5; i++ {
		if _, err := e.pickMailbox(""); err != nil {
			t.Fatalf("pick %d: %v", i, err)
		}
	}
	if got := atomic.LoadInt32(&bp.activeCalls); got != 1 {
		t.Errorf("expected 1 ActiveAddresses call (TTL-cached), got %d", got)
	}
}

func TestEngine_RecordSendResult_SuccessUpdatesRegistry(t *testing.T) {
	bp := &fakeBackpressure{}
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	e.recordSendResult("jan@sender.test", "target.cz", nil)

	waitFor(t, func() bool {
		bp.mu.Lock()
		defer bp.mu.Unlock()
		return len(bp.successCalls) == 1
	})

	bp.mu.Lock()
	defer bp.mu.Unlock()
	if bp.successCalls[0] != "jan@sender.test" {
		t.Errorf("expected RecordSuccess(jan@sender.test), got %q", bp.successCalls[0])
	}
	if len(bp.bounceCalls) != 0 {
		t.Errorf("success must not call RecordBounce, got %+v", bp.bounceCalls)
	}
}

func TestEngine_RecordSendResult_PermanentBounceUpdatesRegistry(t *testing.T) {
	bp := &fakeBackpressure{}
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	// SMTP 550 = permanent. ClassifySMTPError will classify this as SMTPPermanent.
	e.recordSendResult("jan@sender.test", "target.cz", &simpleErr{msg: "550 5.1.1 User unknown"})

	waitFor(t, func() bool {
		bp.mu.Lock()
		defer bp.mu.Unlock()
		return len(bp.bounceCalls) == 1
	})

	bp.mu.Lock()
	defer bp.mu.Unlock()
	if bp.bounceCalls[0].Address != "jan@sender.test" {
		t.Errorf("expected RecordBounce(jan@sender.test), got %+v", bp.bounceCalls[0])
	}
	if bp.bounceCalls[0].Reason == "" {
		t.Error("RecordBounce reason must be non-empty")
	}
	if len(bp.successCalls) != 0 {
		t.Errorf("permanent bounce must not call RecordSuccess, got %+v", bp.successCalls)
	}
}

func TestEngine_RecordSendResult_TransientDoesNotTouchRegistry(t *testing.T) {
	// Greylisting (4xx) is not a bounce and must not touch the registry —
	// we'd otherwise auto-hold mailboxes hitting healthy greylist domains.
	bp := &fakeBackpressure{}
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	e.recordSendResult("jan@sender.test", "target.cz", &simpleErr{msg: "451 4.7.1 Please try again later"})

	// Let any spurious goroutine finish.
	time.Sleep(50 * time.Millisecond)

	bp.mu.Lock()
	defer bp.mu.Unlock()
	if len(bp.successCalls) != 0 {
		t.Errorf("transient error must not call RecordSuccess, got %+v", bp.successCalls)
	}
	if len(bp.bounceCalls) != 0 {
		t.Errorf("transient error must not call RecordBounce, got %+v", bp.bounceCalls)
	}
}

func TestEngine_RecordSendResult_NoRegistryIsNoOp(t *testing.T) {
	// No registry wired — the engine must still function and must not panic
	// when recording a success or a bounce.
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	e.recordSendResult("jan@sender.test", "target.cz", nil)
	e.recordSendResult("jan@sender.test", "target.cz", &simpleErr{msg: "550 user unknown"})
	// No panic = pass.
}
