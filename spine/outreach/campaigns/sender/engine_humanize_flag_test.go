package sender

import (
	"common/config"
	"testing"
)

// D3.6 — Sender-side wiring for the humanize opt-out flag.
//
// content.RenderedEmail exposes SkipHumanize=true when a template
// declares `{{/* humanize: off */}}`. That flag must flow through to
// sender.SendRequest so the PreSendHook can early-return without
// invoking the humanize engine — preserving the verbatim body of
// legal notices, opt-out confirmations, and consent-tier transition
// emails.
//
// These tests pin the contract at the sender layer. The template-side
// detection is covered by content/humanize_flag_test.go; the E2E
// wiring via campaign.Runner is covered by its own runner test.

// TestSendRequest_CarriesSkipHumanize asserts the field exists and
// defaults to false.
func TestSendRequest_CarriesSkipHumanize(t *testing.T) {
	req := SendRequest{ToAddress: "to@test.cz"}
	if req.SkipHumanize {
		t.Error("SkipHumanize should default to false")
	}
	req.SkipHumanize = true
	if !req.SkipHumanize {
		t.Error("SkipHumanize=true assignment did not stick")
	}
}

// TestPreSendHook_ObservesSkipHumanize asserts a PreSendHook can read
// the flag and decide to skip its humanize pass.
func TestPreSendHook_ObservesSkipHumanize(t *testing.T) {
	mailboxes := []config.MailboxConfig{
		{
			Address:    "jan@firma1.cz",
			DailyLimit: 10,
			Persona:    config.PersonaConfig{Name: "Jan", Company: "Firma1"},
		},
	}
	e := NewEngine(mailboxes, config.SendingConfig{}, config.SafetyConfig{MaxBounceRate: 0.5}).
		WithDryRun(true)

	humanizeCalls := 0
	e.WithPreSendHook(func(_ config.MailboxConfig, req *SendRequest) {
		// Mimics the production hook: early-return on the flag.
		if req.SkipHumanize {
			return
		}
		humanizeCalls++
	})

	mb, err := e.pickMailbox("")
	if err != nil {
		t.Fatalf("pick: %v", err)
	}

	// Request 1: flag set → hook must NOT call humanize path.
	req1 := SendRequest{ToAddress: "to@test.cz", Subject: "Opt-out confirm", BodyPlain: "Verbatim legal text.", SkipHumanize: true}
	if e.preSendHook != nil {
		e.preSendHook(mb, &req1)
	}
	if humanizeCalls != 0 {
		t.Errorf("humanize path ran despite SkipHumanize=true (calls=%d)", humanizeCalls)
	}

	// Request 2: flag clear → hook must call humanize path normally.
	req2 := SendRequest{ToAddress: "to@test.cz", Subject: "Cold outreach", BodyPlain: "Dobrý den, ...", SkipHumanize: false}
	if e.preSendHook != nil {
		e.preSendHook(mb, &req2)
	}
	if humanizeCalls != 1 {
		t.Errorf("humanize path did not run for SkipHumanize=false (calls=%d, want 1)", humanizeCalls)
	}
}

// TestPreSendHook_DoesNotMutateBodyWhenSkipHumanize asserts that a
// production-style hook which would normally mutate BodyPlain leaves
// it untouched when the flag is set.
func TestPreSendHook_DoesNotMutateBodyWhenSkipHumanize(t *testing.T) {
	mailboxes := []config.MailboxConfig{
		{Address: "a@b.cz", DailyLimit: 10, Persona: config.PersonaConfig{Name: "N"}},
	}
	e := NewEngine(mailboxes, config.SendingConfig{}, config.SafetyConfig{MaxBounceRate: 0.5}).
		WithDryRun(true)

	// Hook that would otherwise rewrite the body.
	e.WithPreSendHook(func(_ config.MailboxConfig, req *SendRequest) {
		if req.SkipHumanize {
			return
		}
		req.BodyPlain = "HUMANIZED: " + req.BodyPlain
	})

	mb, _ := e.pickMailbox("")

	original := "Potvrzujeme odhlášení. Zdraví, Jan."
	req := SendRequest{ToAddress: "x@y.cz", Subject: "s", BodyPlain: original, SkipHumanize: true}
	e.preSendHook(mb, &req)

	if req.BodyPlain != original {
		t.Errorf("body mutated despite SkipHumanize=true: got %q", req.BodyPlain)
	}
}
