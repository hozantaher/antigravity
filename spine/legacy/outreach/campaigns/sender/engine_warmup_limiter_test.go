package sender

import (
	"errors"
	"common/config"
	"testing"
)

// WithWarmupLimiter test coverage. Contract recap (see engine.go:178-186 and
// engine.go:515-522):
//   - When a limiter is wired, pickMailbox calls LimitForMailbox(addr, static)
//     and uses the DB value *only* when err == nil.
//   - Any error path leaves the static MailboxConfig.DailyLimit in place —
//     fail-safe: never ramp *up* on oracle error.
//   - A nil limiter is the no-op default; the legacy config.MailboxConfig
//     path (DailyLimit / warmupLimit(WarmupDay)) is authoritative.

type fakeWarmupLimiter struct {
	// limitByAddr is the DB-backed value the oracle returns when err == nil.
	limitByAddr map[string]int
	// errByAddr forces an error for specific addresses.
	errByAddr map[string]error
	// calls records every invocation for assertion.
	calls []warmupCall
}

type warmupCall struct {
	address  string
	fallback int
}

func (f *fakeWarmupLimiter) LimitForMailbox(address string, fallback int) (int, error) {
	f.calls = append(f.calls, warmupCall{address, fallback})
	if err, ok := f.errByAddr[address]; ok {
		return 0, err
	}
	if n, ok := f.limitByAddr[address]; ok {
		return n, nil
	}
	// Default behaviour mirrors "no DB row" — oracle has no opinion, but the
	// interface only returns (int, error). Existing production impl returns
	// fallback in that case so tests should treat missing-map as fallback.
	return fallback, nil
}

func newWarmupEngine(addrs ...string) *Engine {
	mbs := make([]config.MailboxConfig, len(addrs))
	for i, a := range addrs {
		// Static limit 100; WarmupDay=0 so warmupLimit() isn't engaged.
		mbs[i] = config.MailboxConfig{Address: a, DailyLimit: 100}
	}
	return NewEngine(mbs,
		config.SendingConfig{MaxPerDomainHour: 10000, Timezone: "UTC", WindowStart: 0, WindowEnd: 24},
		config.SafetyConfig{MaxBounceRate: 0.99},
	)
}

func TestWithWarmupLimiter_WiresLimiter(t *testing.T) {
	e := newWarmupEngine("a@s.test")
	if e.warmupLimiter != nil {
		t.Fatal("default engine must have nil warmupLimiter")
	}
	l := &fakeWarmupLimiter{}
	returned := e.WithWarmupLimiter(l)
	if returned != e {
		t.Error("WithWarmupLimiter must return same Engine for chaining")
	}
	if e.warmupLimiter != l {
		t.Error("WithWarmupLimiter did not store the provided limiter")
	}
}

func TestWithWarmupLimiter_NilIsNoOpDefault(t *testing.T) {
	// pickMailbox with no limiter wired → purely config-driven path.
	e := newWarmupEngine("a@s.test")
	e.sentCounts["a@s.test"] = 99 // one below config limit

	mb, err := e.pickMailbox("")
	if err != nil {
		t.Fatalf("pickMailbox: %v", err)
	}
	if mb.Address != "a@s.test" {
		t.Errorf("expected a@s.test, got %q", mb.Address)
	}

	// At limit → pickMailbox must refuse, proving the static limit is
	// authoritative when no limiter is wired.
	e.sentCounts["a@s.test"] = 100
	if _, err := e.pickMailbox(""); err == nil {
		t.Error("pickMailbox must refuse when static limit reached and no limiter is wired")
	}
}

func TestWithWarmupLimiter_DBValueRampsDownBelowStatic(t *testing.T) {
	// Warmup plans typically ramp *up* from e.g. 10 → 1000 over days. During
	// the early ramp the DB limit is BELOW the static config limit and must
	// win. This is the whole reason the limiter exists.
	e := newWarmupEngine("a@s.test")
	e.WithWarmupLimiter(&fakeWarmupLimiter{
		limitByAddr: map[string]int{"a@s.test": 5},
	})

	// Sent 4 so far. Static limit would allow (100), DB limit says 5.
	// pickMailbox must hand out the mailbox.
	e.sentCounts["a@s.test"] = 4
	if _, err := e.pickMailbox(""); err != nil {
		t.Fatalf("pickMailbox under DB limit: %v", err)
	}

	// Sent 5 = at DB limit. pickMailbox must refuse, proving the DB value
	// overrode the static 100.
	e.sentCounts["a@s.test"] = 5
	if _, err := e.pickMailbox(""); err == nil {
		t.Error("pickMailbox must refuse at DB-backed limit even though static limit (100) would allow it")
	}
}

func TestWithWarmupLimiter_ErrorKeepsStaticLimit_FailSafe(t *testing.T) {
	// Fail-safe contract: on oracle error we must NOT ramp *up* beyond the
	// static limit. The static 100 stays authoritative.
	e := newWarmupEngine("a@s.test")
	e.WithWarmupLimiter(&fakeWarmupLimiter{
		errByAddr: map[string]error{"a@s.test": errors.New("db connection refused")},
	})

	// At static limit → must refuse. Proves the oracle error did not somehow
	// raise the ceiling.
	e.sentCounts["a@s.test"] = 100
	if _, err := e.pickMailbox(""); err == nil {
		t.Error("pickMailbox must refuse at static limit when oracle errors; got success (fail-open detected)")
	}

	// One below static limit → must succeed, proving the oracle error didn't
	// collapse us to 0 either.
	e.sentCounts["a@s.test"] = 99
	if _, err := e.pickMailbox(""); err != nil {
		t.Errorf("pickMailbox must accept at 99 when oracle errors; got %v (too conservative)", err)
	}
}

func TestWithWarmupLimiter_CallsOraclePerPickAttempt(t *testing.T) {
	// Sanity-check the oracle is actually consulted on each pick — a silent
	// short-circuit would defeat the whole DB-override feature.
	l := &fakeWarmupLimiter{
		limitByAddr: map[string]int{"a@s.test": 50},
	}
	e := newWarmupEngine("a@s.test")
	e.WithWarmupLimiter(l)

	for i := 0; i < 3; i++ {
		if _, err := e.pickMailbox(""); err != nil {
			t.Fatalf("pickMailbox iter %d: %v", i, err)
		}
		e.sentCounts["a@s.test"]++
	}

	if len(l.calls) != 3 {
		t.Errorf("oracle called %d times across 3 picks, want 3", len(l.calls))
	}
	for _, c := range l.calls {
		if c.address != "a@s.test" {
			t.Errorf("oracle called with wrong address: %q", c.address)
		}
		if c.fallback != 100 {
			t.Errorf("oracle fallback arg = %d, want 100 (the static config limit)", c.fallback)
		}
	}
}

func TestWithWarmupLimiter_MissingMapRowUsesFallback(t *testing.T) {
	// An oracle that returns (fallback, nil) for unknown mailboxes — the
	// common "no warmup row" production shape — must leave the static limit
	// untouched.
	e := newWarmupEngine("a@s.test")
	e.WithWarmupLimiter(&fakeWarmupLimiter{
		// limitByAddr is empty; fakeWarmupLimiter returns fallback on miss.
	})

	e.sentCounts["a@s.test"] = 99
	if _, err := e.pickMailbox(""); err != nil {
		t.Fatalf("pickMailbox at 99 under no-opinion oracle: %v", err)
	}
	e.sentCounts["a@s.test"] = 100
	if _, err := e.pickMailbox(""); err == nil {
		t.Error("pickMailbox at static limit must refuse when oracle returns (fallback, nil)")
	}
}
