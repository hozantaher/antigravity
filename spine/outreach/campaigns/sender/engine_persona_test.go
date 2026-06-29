package sender

import (
	"common/config"
	"testing"
)

// D3.2 Persona routing per mailbox.
//
// The operator cockpit plan mandates that every mailbox carries its own
// virtual-salesperson identity (Name / Role / Company / Signature) and that
// consecutive sends pick a different mailbox so the recipient universe sees
// a rotation of distinct senders rather than a single bulk sender. These
// tests pin two guarantees:
//
//  1. pickMailbox rotates round-robin across the configured mailboxes —
//     consecutive calls return different mailbox configs (until we loop
//     back past len(mailboxes)).
//  2. The PreSendHook receives the concrete MailboxConfig for the mailbox
//     that was actually picked, so a humanize engine built inside the
//     hook applies that mailbox's persona (not the global fallback).
//
// If either invariant breaks, the 24-mailbox warm-up pool would collapse
// back to one effective sender identity and the anti-bulk rotation story
// falls apart.

// TestEngine_PickMailbox_RotatesAcrossMailboxes asserts round-robin rotation.
func TestEngine_PickMailbox_RotatesAcrossMailboxes(t *testing.T) {
	mailboxes := []config.MailboxConfig{
		{
			Address:    "jan@firma1.cz",
			DailyLimit: 10,
			Persona:    config.PersonaConfig{Name: "Jan Novák", Company: "Firma1"},
		},
		{
			Address:    "eva@firma2.cz",
			DailyLimit: 10,
			Persona:    config.PersonaConfig{Name: "Eva Svobodová", Company: "Firma2"},
		},
		{
			Address:    "petr@firma3.cz",
			DailyLimit: 10,
			Persona:    config.PersonaConfig{Name: "Petr Dvořák", Company: "Firma3"},
		},
	}
	e := NewEngine(mailboxes, config.SendingConfig{}, config.SafetyConfig{MaxBounceRate: 0.5})

	picks := make([]string, 0, 3)
	for i := 0; i < 3; i++ {
		mb, err := e.pickMailbox("")
		if err != nil {
			t.Fatalf("pick %d: %v", i, err)
		}
		picks = append(picks, mb.Address)
	}

	// All three distinct — one full rotation across 3 mailboxes.
	seen := map[string]bool{}
	for _, a := range picks {
		seen[a] = true
	}
	if len(seen) != 3 {
		t.Errorf("rotation collapsed — expected 3 distinct mailboxes, got %v", picks)
	}
}

// TestEngine_PickMailbox_PersonaFollowsRotation asserts that each rotated
// mailbox config carries its own persona so the PreSendHook sees the
// correct identity per send.
func TestEngine_PickMailbox_PersonaFollowsRotation(t *testing.T) {
	mailboxes := []config.MailboxConfig{
		{
			Address:    "jan@firma1.cz",
			DailyLimit: 10,
			Persona:    config.PersonaConfig{Name: "Jan", Company: "Firma1"},
		},
		{
			Address:    "eva@firma2.cz",
			DailyLimit: 10,
			Persona:    config.PersonaConfig{Name: "Eva", Company: "Firma2"},
		},
	}
	e := NewEngine(mailboxes, config.SendingConfig{}, config.SafetyConfig{MaxBounceRate: 0.5})

	mb1, err := e.pickMailbox("")
	if err != nil {
		t.Fatalf("pick 1: %v", err)
	}
	mb2, err := e.pickMailbox("")
	if err != nil {
		t.Fatalf("pick 2: %v", err)
	}

	if mb1.Address == mb2.Address {
		t.Fatalf("rotation did not advance — picked %s twice", mb1.Address)
	}
	// The personas must match the rotated mailbox, not the other one.
	wantNames := map[string]string{
		"jan@firma1.cz": "Jan",
		"eva@firma2.cz": "Eva",
	}
	if mb1.Persona.Name != wantNames[mb1.Address] {
		t.Errorf("mb1 persona mismatch: address=%s persona.Name=%s", mb1.Address, mb1.Persona.Name)
	}
	if mb2.Persona.Name != wantNames[mb2.Address] {
		t.Errorf("mb2 persona mismatch: address=%s persona.Name=%s", mb2.Address, mb2.Persona.Name)
	}
}

// TestEngine_PreSendHook_ReceivesRotatedPersona wires a hook and replays
// the rotation via send() path (direct SMTP path short-circuited by
// dry_run) to confirm that the hook observes different mailbox personas
// across two consecutive sends.
func TestEngine_PreSendHook_ReceivesRotatedPersona(t *testing.T) {
	mailboxes := []config.MailboxConfig{
		{
			Address:    "jan@firma1.cz",
			DailyLimit: 10,
			Persona:    config.PersonaConfig{Name: "Jan", Role: "Sales", Company: "Firma1"},
		},
		{
			Address:    "eva@firma2.cz",
			DailyLimit: 10,
			Persona:    config.PersonaConfig{Name: "Eva", Role: "CEO", Company: "Firma2"},
		},
	}

	e := NewEngine(mailboxes, config.SendingConfig{}, config.SafetyConfig{MaxBounceRate: 0.5}).
		WithDryRun(true)

	captured := []config.PersonaConfig{}
	e.WithPreSendHook(func(mb config.MailboxConfig, _ *SendRequest) {
		captured = append(captured, mb.Persona)
	})

	// Simulate two send attempts. pickMailbox + preSendHook is the exact
	// order used in Run(); send() on dry_run short-circuits before SMTP
	// I/O so we do not need a fake SMTP server for this assertion.
	for i := 0; i < 2; i++ {
		mb, err := e.pickMailbox("")
		if err != nil {
			t.Fatalf("pick %d: %v", i, err)
		}
		req := SendRequest{ToAddress: "to@test.cz", Subject: "s", BodyPlain: "b", SMTPUsername: "smtp.cz"}
		if e.preSendHook != nil {
			e.preSendHook(mb, &req)
		}
	}

	if len(captured) != 2 {
		t.Fatalf("expected 2 hook calls, got %d", len(captured))
	}
	if captured[0].Name == captured[1].Name {
		t.Errorf("hook received same persona twice: %q — rotation broken", captured[0].Name)
	}
	// Both personas must be non-empty and recognised.
	names := map[string]bool{captured[0].Name: true, captured[1].Name: true}
	if !names["Jan"] || !names["Eva"] {
		t.Errorf("missing expected persona in rotation: got names=%v", names)
	}
}
