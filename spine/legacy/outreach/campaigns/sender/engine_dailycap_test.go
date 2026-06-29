package sender

import (
	"errors"
	"common/config"
	"sync/atomic"
	"testing"
)

// D3.1: persistent daily-cap hook.
//
// The sender.Engine keeps an in-memory sentCounts map that resets on process
// restart. Without a persistent oracle, an operator restart mid-day would
// allow the next restart's count to climb back from zero and exceed the
// real daily cap — catastrophic for deliverability and compliance (Gmail /
// Microsoft see sudden bursts above the advertised cap and throttle).
//
// These tests wire a fake oracle via Engine.WithDailyCapFunc so production
// can plug a Postgres-backed counter without the engine caring how it works.

// fakeDailyCap is a scripted DailyCapFunc.
type fakeDailyCap struct {
	exhausted map[string]bool
	calls     atomic.Int32
	err       error
}

func (f *fakeDailyCap) Call(address string) (bool, error) {
	f.calls.Add(1)
	if f.err != nil {
		return false, f.err
	}
	return f.exhausted[address], nil
}

func TestEngine_PickMailbox_DailyCapFunc_SkipsExhausted(t *testing.T) {
	// Persistent oracle reports "maxed@sender.test" has hit its daily cap
	// even though the in-memory counter is 0. pickMailbox MUST respect the
	// oracle — the in-memory count lies after restart.
	mbs := []config.MailboxConfig{
		{Address: "maxed@sender.test", DailyLimit: 100},
		{Address: "fresh@sender.test", DailyLimit: 100},
	}
	cap := &fakeDailyCap{exhausted: map[string]bool{
		"maxed@sender.test": true,
	}}

	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithDailyCapFunc(cap.Call)

	mb, err := e.pickMailbox("")
	if err != nil {
		t.Fatalf("pickMailbox: %v", err)
	}
	if mb.Address != "fresh@sender.test" {
		t.Errorf("picked %q, expected fresh@sender.test", mb.Address)
	}
}

func TestEngine_PickMailbox_DailyCapFunc_AllExhaustedReturnsError(t *testing.T) {
	// When every mailbox is oracle-exhausted, pickMailbox must fail with
	// the canonical daily-limit error so the caller backs off instead of
	// spinning.
	mbs := []config.MailboxConfig{
		{Address: "a@sender.test", DailyLimit: 100},
		{Address: "b@sender.test", DailyLimit: 100},
	}
	cap := &fakeDailyCap{exhausted: map[string]bool{
		"a@sender.test": true,
		"b@sender.test": true,
	}}

	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithDailyCapFunc(cap.Call)

	if _, err := e.pickMailbox(""); err == nil {
		t.Errorf("expected daily-limit error when oracle reports all exhausted")
	}
}

func TestEngine_PickMailbox_DailyCapFunc_ErrorFailsOpen(t *testing.T) {
	// Oracle outage must NOT block sending — fall through to in-memory
	// behaviour (same fail-open contract as registry outage in D2.3).
	mbs := []config.MailboxConfig{
		{Address: "only@sender.test", DailyLimit: 100},
	}
	cap := &fakeDailyCap{err: errors.New("postgres down")}

	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithDailyCapFunc(cap.Call)

	mb, err := e.pickMailbox("")
	if err != nil {
		t.Fatalf("oracle outage must not block pickMailbox: %v", err)
	}
	if mb.Address != "only@sender.test" {
		t.Errorf("unexpected pick: %s", mb.Address)
	}
}

func TestEngine_PickMailbox_DailyCapFunc_NilIsNoOp(t *testing.T) {
	// No oracle wired — existing in-memory-only behaviour survives.
	mbs := []config.MailboxConfig{
		{Address: "only@sender.test", DailyLimit: 100},
	}
	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{})
	if _, err := e.pickMailbox(""); err != nil {
		t.Fatalf("pickMailbox without oracle: %v", err)
	}
}
