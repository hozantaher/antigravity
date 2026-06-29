package sender

import (
	"common/config"
	"errors"
	"strings"
	"testing"
)

// TestEngine_PickMailbox_EnvVarFallbackBlocked_Incident20260513 reproduces the
// incident: a mailbox lives in cfg.Mailboxes (via MAILBOX_N_* env-var
// fallback in config.LoadFromEnv) but its row was hard-deleted from
// outreach_mailboxes. Pre-fix, pickMailbox happily selected it because the
// registry's ActiveAddresses set was non-nil and the unknown mailbox was
// silently skipped UNLESS the engine fell through (registry not wired /
// registry errored). Post-fix, strict mode (default) refuses the request
// with ErrMailboxNotProvisioned when ALL config mailboxes are absent from
// the allow-set, instead of returning "all mailboxes at daily limit".
func TestEngine_PickMailbox_EnvVarFallbackBlocked_Incident20260513(t *testing.T) {
	mbs := []config.MailboxConfig{
		// nowak.goran + goran.nowak survive in cfg.Mailboxes via LoadFromEnv
		// (MAILBOX_3_ADDRESS / MAILBOX_4_ADDRESS) but the operator hard-
		// deleted their outreach_mailboxes rows.
		{Address: "nowak.goran@example.cz", DailyLimit: 100},
		{Address: "goran.nowak@example.cz", DailyLimit: 100},
	}
	bp := &fakeBackpressure{
		// Registry only knows about the surviving mailboxes — neither nowak.
		active: map[string]struct{}{
			"surviving@example.cz": {},
		},
	}

	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	_, err := e.pickMailbox("recipient@target.cz")
	if err == nil {
		t.Fatal("expected pickMailbox to refuse deleted env-var mailboxes")
	}
	if !errors.Is(err, ErrMailboxNotProvisioned) {
		t.Errorf("expected ErrMailboxNotProvisioned, got %v", err)
	}
}

// TestEngine_PickMailbox_StrictModeDefaultOnAfterWithRegistry asserts the
// contract change: WithMailboxRegistry now defaults to strict=true.
func TestEngine_PickMailbox_StrictModeDefaultOnAfterWithRegistry(t *testing.T) {
	bp := &fakeBackpressure{}
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	if !e.registryStrict {
		t.Error("WithMailboxRegistry must default to strict mode (INCIDENT 2026-05-13)")
	}
}

// TestEngine_PickMailbox_StrictModeCanBeDisabledForTests asserts the opt-out.
func TestEngine_PickMailbox_StrictModeCanBeDisabledForTests(t *testing.T) {
	bp := &fakeBackpressure{}
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp).
		WithStrictRegistryEnforcement(false)

	if e.registryStrict {
		t.Error("WithStrictRegistryEnforcement(false) must disable strict mode")
	}
}

// TestEngine_PickMailbox_NoRegistry_NoStrictEnforcement asserts that engines
// without a wired registry behave as before (unit-test friendly). Strict
// mode is a no-op when e.registry == nil, since there's no allow-set to
// check against.
func TestEngine_PickMailbox_NoRegistry_NoStrictEnforcement(t *testing.T) {
	mbs := []config.MailboxConfig{
		{Address: "lonely@sender.test", DailyLimit: 100},
	}
	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{})

	mb, err := e.pickMailbox("")
	if err != nil {
		t.Fatalf("no-registry engine must keep legacy behaviour: %v", err)
	}
	if mb.Address != "lonely@sender.test" {
		t.Errorf("unexpected mailbox: %s", mb.Address)
	}
}

// TestEngine_PickMailbox_RegistryAllowsSurvivor_SkipsDeleted asserts that
// when one env-var mailbox is in the registry's allow-set and one is not,
// pickMailbox returns the surviving one (without falling through to the
// deleted one even on round-robin).
func TestEngine_PickMailbox_RegistryAllowsSurvivor_SkipsDeleted(t *testing.T) {
	mbs := []config.MailboxConfig{
		{Address: "deleted@example.cz", DailyLimit: 100},
		{Address: "surviving@example.cz", DailyLimit: 100},
	}
	bp := &fakeBackpressure{
		active: map[string]struct{}{
			"surviving@example.cz": {},
		},
	}

	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	for i := 0; i < 4; i++ {
		mb, err := e.pickMailbox("recipient@target.cz")
		if err != nil {
			t.Fatalf("pick %d: %v", i, err)
		}
		if mb.Address != "surviving@example.cz" {
			t.Errorf("pick %d: must never select deleted mailbox, got %s", i, mb.Address)
		}
	}
}

// TestEngine_PickMailbox_RegistryUnavailableErrorIsWrapped asserts errors.Is
// support so callers can distinguish registry-unavailable from
// not-provisioned vs daily-cap-exceeded paths.
func TestEngine_PickMailbox_RegistryUnavailableErrorIsWrapped(t *testing.T) {
	mbs := []config.MailboxConfig{
		{Address: "any@sender.test", DailyLimit: 100},
	}
	registryErr := errors.New("connection refused")
	bp := &fakeBackpressure{activeErr: registryErr}

	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	_, err := e.pickMailbox("")
	if err == nil {
		t.Fatal("strict mode must refuse on registry outage")
	}
	if !errors.Is(err, ErrRegistryUnavailable) {
		t.Errorf("error not wrapping ErrRegistryUnavailable: %v", err)
	}
	// The underlying registry error message should be in the wrapped chain
	// (via %v in the fmt.Errorf format string we used in pickMailbox).
	if !strings.Contains(err.Error(), "connection refused") {
		t.Errorf("underlying registry error not surfaced: %v", err)
	}
}

// TestEngine_PickMailbox_EmptyAllowSetRefusesAllInStrictMode asserts that
// when the registry comes back empty (all mailboxes paused/deleted),
// strict mode refuses to fall through to env-var mailboxes.
func TestEngine_PickMailbox_EmptyAllowSetRefusesAllInStrictMode(t *testing.T) {
	mbs := []config.MailboxConfig{
		{Address: "env-only@example.cz", DailyLimit: 100},
	}
	bp := &fakeBackpressure{
		active: map[string]struct{}{}, // every mailbox paused/deleted
	}

	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	_, err := e.pickMailbox("recipient@target.cz")
	if err == nil {
		t.Fatal("empty allow-set must block env-var mailboxes under strict mode")
	}
	if !errors.Is(err, ErrMailboxNotProvisioned) {
		t.Errorf("expected ErrMailboxNotProvisioned, got %v", err)
	}
}

// TestEngine_PickMailbox_NonStrictAllowsDailyLimitFallthrough asserts the
// legacy daily-limit error message still surfaces in non-strict mode (for
// observability — pre-existing callers may grep on it).
func TestEngine_PickMailbox_NonStrictAllowsDailyLimitFallthrough(t *testing.T) {
	mbs := []config.MailboxConfig{
		{Address: "a@sender.test", DailyLimit: 1},
	}
	bp := &fakeBackpressure{
		active: map[string]struct{}{"a@sender.test": {}},
	}

	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp).
		WithStrictRegistryEnforcement(false)

	// First pick succeeds — DailyLimit=1.
	if _, err := e.pickMailbox(""); err != nil {
		t.Fatalf("first pick: %v", err)
	}
	// Bump the sent counter manually (simulating a successful send having
	// touched it via recordSendResult — we don't go through Run here).
	e.mu.Lock()
	e.sentCounts["a@sender.test"] = 1
	e.mu.Unlock()

	_, err := e.pickMailbox("")
	if err == nil {
		t.Fatal("expected daily-limit error after second pick")
	}
	if !strings.Contains(err.Error(), "daily limit") {
		t.Errorf("expected 'daily limit' message, got %v", err)
	}
}

// TestEngine_PickMailbox_SelfHealAfterEmptyCfgMailboxes is the regression
// guard for the 2026-05-13 follow-up incident: machinery-outreach booted
// with cfg.Mailboxes empty because OverlayRegistry crashed on a NULL Scan,
// then strict-mode pickMailbox refused every send even after the DB was
// repaired. The fix wires mailbox.MailboxLister into pickMailbox's
// allow-set refresh path so unknown-but-currently-allowed mailboxes are
// merged into e.mailboxes on the fly. After the merge the engine selects
// the DB-managed mailbox without a redeploy.
func TestEngine_PickMailbox_SelfHealAfterEmptyCfgMailboxes(t *testing.T) {
	// cfg.Mailboxes empty (OverlayRegistry crashed at boot). Registry
	// reports four healthy production mailboxes — engine MUST self-heal.
	bp := &fakeListerBackpressure{
		fakeBackpressure: fakeBackpressure{
			active: map[string]struct{}{
				"hozan.taher.75@post.cz": {},
				"hozan.taher.76@post.cz": {},
				"hozan.taher.77@post.cz": {},
				"hozan.taher.78@post.cz": {},
			},
		},
		activeMbs: []config.MailboxConfig{
			{Address: "hozan.taher.75@post.cz", DailyLimit: 170},
			{Address: "hozan.taher.76@post.cz", DailyLimit: 170},
			{Address: "hozan.taher.77@post.cz", DailyLimit: 170},
			{Address: "hozan.taher.78@post.cz", DailyLimit: 170},
		},
	}

	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	mb, err := e.pickMailbox("recipient@target.cz")
	if err != nil {
		t.Fatalf("self-heal must let strict-mode engine pick a registry-listed mailbox, got: %v", err)
	}
	if !strings.HasPrefix(mb.Address, "hozan.taher.") {
		t.Errorf("unexpected mailbox after self-heal: %s", mb.Address)
	}
	if mb.DailyLimit != 170 {
		t.Errorf("DailyLimit lost during self-heal merge: got %d, want 170", mb.DailyLimit)
	}
}

// TestEngine_PickMailbox_SelfHealRespectsAllowSet asserts that the
// self-heal path never admits a mailbox that is missing from the
// strict-mode allow-set, even when ActiveMailboxes returns it. Defense
// against a lister that drifts ahead of ActiveAddresses (e.g. a stale
// cache or a buggy adapter).
func TestEngine_PickMailbox_SelfHealRespectsAllowSet(t *testing.T) {
	bp := &fakeListerBackpressure{
		fakeBackpressure: fakeBackpressure{
			// allow-set says only mailbox-a is active right now
			active: map[string]struct{}{"mailbox-a@example.cz": {}},
		},
		// lister returns both — but mailbox-b is NOT in the allow-set
		activeMbs: []config.MailboxConfig{
			{Address: "mailbox-a@example.cz", DailyLimit: 50},
			{Address: "mailbox-b@example.cz", DailyLimit: 50},
		},
	}

	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	for i := 0; i < 3; i++ {
		mb, err := e.pickMailbox("recipient@target.cz")
		if err != nil {
			t.Fatalf("pick %d: %v", i, err)
		}
		if mb.Address != "mailbox-a@example.cz" {
			t.Errorf("pick %d: self-heal admitted out-of-allowset mailbox: %s", i, mb.Address)
		}
	}
}

// TestEngine_PickMailbox_SelfHealDoesNotDuplicateExistingMailboxes ensures
// the merge is idempotent: when cfg.Mailboxes already contains a mailbox
// the lister also reports, the engine keeps the cfg.yaml-tuned overlay
// (WarmupDay, Persona, daily limit chosen by operator) instead of
// clobbering it with the registry default.
func TestEngine_PickMailbox_SelfHealDoesNotDuplicateExistingMailboxes(t *testing.T) {
	// cfg.yaml carries a WarmupDay-7 overlay the operator set manually.
	mbs := []config.MailboxConfig{
		{Address: "tuned@example.cz", DailyLimit: 25, WarmupDay: 7},
	}
	bp := &fakeListerBackpressure{
		fakeBackpressure: fakeBackpressure{
			active: map[string]struct{}{"tuned@example.cz": {}},
		},
		activeMbs: []config.MailboxConfig{
			// Registry default carries DailyLimit=100 without WarmupDay.
			// The cfg overlay must NOT be clobbered.
			{Address: "tuned@example.cz", DailyLimit: 100},
		},
	}

	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	if _, err := e.pickMailbox("recipient@target.cz"); err != nil {
		t.Fatalf("pick: %v", err)
	}
	// e.mailboxes should still have exactly one entry — duplicate suppressed.
	if got := len(e.mailboxes); got != 1 {
		t.Errorf("self-heal duplicated a known mailbox: len(e.mailboxes) = %d, want 1", got)
	}
	// And the original WarmupDay overlay must survive.
	if got := e.mailboxes[0].WarmupDay; got != 7 {
		t.Errorf("self-heal clobbered cfg.yaml WarmupDay overlay: got %d, want 7", got)
	}
}

// TestEngine_PickMailbox_SelfHealListerErrorIsNonFatal asserts that an
// ActiveMailboxes() outage does not break the existing allow-set path.
// The engine keeps whatever cfg.Mailboxes it has; if cfg.Mailboxes is
// empty AND the lister errored, the strict-mode contract returns
// ErrMailboxNotProvisioned (no env-var fallback).
func TestEngine_PickMailbox_SelfHealListerErrorIsNonFatal(t *testing.T) {
	mbs := []config.MailboxConfig{
		{Address: "fallback@example.cz", DailyLimit: 100},
	}
	bp := &fakeListerBackpressure{
		fakeBackpressure: fakeBackpressure{
			active: map[string]struct{}{"fallback@example.cz": {}},
		},
		activeMbsErr: errors.New("lister down"),
	}

	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	mb, err := e.pickMailbox("recipient@target.cz")
	if err != nil {
		t.Fatalf("ActiveMailboxes error must not block pickMailbox when cfg has a valid entry, got: %v", err)
	}
	if mb.Address != "fallback@example.cz" {
		t.Errorf("unexpected mailbox: %s", mb.Address)
	}
}

// TestEngine_PickMailbox_SelfHealDoesNotEnableEnvVarFallback proves the
// PR #1342 strict-mode contract is preserved: when both cfg.Mailboxes
// AND the registry are empty, pickMailbox still refuses with
// ErrMailboxNotProvisioned. The self-heal path cannot resurrect env-var
// mailboxes — only mailboxes the registry currently advertises.
func TestEngine_PickMailbox_SelfHealDoesNotEnableEnvVarFallback(t *testing.T) {
	// cfg.Mailboxes mimics the LoadFromEnv() output: an env-var mailbox
	// whose DB row has been hard-deleted.
	mbs := []config.MailboxConfig{
		{Address: "deleted-env-mailbox@example.cz", DailyLimit: 100},
	}
	bp := &fakeListerBackpressure{
		fakeBackpressure: fakeBackpressure{
			active: map[string]struct{}{}, // empty allow-set
		},
		activeMbs: nil, // lister also reports nothing
	}

	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithMailboxRegistry(bp)

	_, err := e.pickMailbox("recipient@target.cz")
	if err == nil {
		t.Fatal("self-heal must not fall through to env-var mailboxes when registry is empty")
	}
	if !errors.Is(err, ErrMailboxNotProvisioned) {
		t.Errorf("expected ErrMailboxNotProvisioned, got %v", err)
	}
}
