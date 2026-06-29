package intake

import (
	"context"
	"relay/internal/model"
	"relay/internal/msgbus"
	"strings"
	"testing"
	"time"
)

// AW6 edge cases for the intake Process pipeline. Pin behaviours that
// previously relied on intuited contracts:
//
//   - empty Body / Recipient / Subject (degenerate but not invalid)
//   - very long fields (no panic, no truncation surprises)
//   - hostile multipart Headers
//   - PreferredCountry passthrough
//
// Each test exercises a single contract; if the assertion fails it points
// to either a regression or a deliberate behavior change worth a CR note.

// Empty Body: pipeline accepts and seals (sanitizer normalises empty → empty
// without blocking). Documents that "nothing to send" is not a hard error;
// it's the operator's responsibility to gate empty submissions upstream.
func TestProcess_EmptyBody_Accepted(t *testing.T) {
	p, bus := testPipeline(t)
	defer bus.Close()

	actor := model.Actor{ID: "user-eb", TenantID: "tenant-eb"}
	req := model.IntakeRequest{
		Recipient: "person@example.com",
		Subject:   "Heads up",
		Body:      "",
	}

	result, err := p.Process(context.Background(), actor, req, "api")
	if err != nil {
		t.Fatalf("empty body must not error: %v", err)
	}
	if result.Status != model.StatusSealed {
		t.Errorf("expected sealed, got %s", result.Status)
	}
	if result.EnvelopeID == "" {
		t.Error("envelope ID must still be issued for empty-body submissions")
	}
}

// Empty Recipient: not validated at this layer (the campaigns sender enforces
// it before calling intake). Pin that intake does NOT treat empty-recipient
// as a hard error — that responsibility lives upstream.
func TestProcess_EmptyRecipient_Accepted(t *testing.T) {
	p, bus := testPipeline(t)
	defer bus.Close()

	actor := model.Actor{ID: "user-er", TenantID: "tenant-er"}
	req := model.IntakeRequest{
		Recipient: "",
		Subject:   "test",
		Body:      "test body",
	}

	result, err := p.Process(context.Background(), actor, req, "api")
	if err != nil {
		t.Fatalf("intake does not validate Recipient at this layer; got %v", err)
	}
	if result.Status != model.StatusSealed {
		t.Errorf("expected sealed (validation lives upstream), got %s", result.Status)
	}
}

// Very long Body: stress test pad-to-size-class behavior. Submitter ships
// 100 KiB body — pipeline must seal without panic and emit a non-zero size
// class.
// TestProcess_VeryLongBody_OversizeRefused documents the FIX 5 behavior change:
// a body that exceeds the top size class (here ~108 KiB, far over SizeClass32K)
// can no longer be silently truncated into a 32K envelope stamped with an
// unrecoverable length prefix — which the drain used to drop after already
// returning a 202. The size minimizer now refuses oversize content, yielding a
// zero size class instead of corrupt, truncated bytes.
//
// NOTE: the complete fix also has intake reject oversize content up front with a
// 4xx; until that intake-layer change lands, Process still seals a zero-class
// envelope, which fails closed at the drain rather than delivering truncated
// bytes. This test asserts the floor (no silent truncation).
func TestProcess_VeryLongBody_OversizeRefused(t *testing.T) {
	p, bus := testPipeline(t)
	defer bus.Close()

	actor := model.Actor{ID: "user-long", TenantID: "tenant-long"}
	body := strings.Repeat("Lorem ipsum dolor sit amet. ", 4000) // ~108 KiB
	req := model.IntakeRequest{
		Recipient: "long@example.com",
		Subject:   "long body test",
		Body:      body,
	}

	result, err := p.Process(context.Background(), actor, req, "api")
	if err != nil {
		t.Fatalf("oversize body must not panic or hard-error in Process: %v", err)
	}
	if result.SizeClass != 0 {
		t.Errorf("oversize body must be refused by the size minimizer (size class 0, "+
			"no silent truncation), got class %d", result.SizeClass)
	}
}

// PreferredCountry passthrough — pipeline must propagate the field onto the
// emitted envelope so the wgpool picker downstream sees the operator's geo
// preference.
func TestProcess_PreferredCountry_Propagated(t *testing.T) {
	p, bus := testPipeline(t)
	defer bus.Close()

	sealedCh := bus.Subscribe(msgbus.TopicSealed)
	actor := model.Actor{ID: "user-pc", TenantID: "tenant-pc"}

	req := model.IntakeRequest{
		Recipient:        "geo@example.com",
		Subject:          "geo test",
		Body:             "want CZ exit",
		PreferredCountry: "CZ",
	}

	if _, err := p.Process(context.Background(), actor, req, "api"); err != nil {
		t.Fatalf("Process: %v", err)
	}

	select {
	case env := <-sealedCh:
		if env.PreferredCountry != "CZ" {
			t.Errorf("PreferredCountry must be propagated; got %q", env.PreferredCountry)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for sealed envelope")
	}
}

// MailboxID passthrough — pipeline must propagate the numeric mailbox ID
// for downstream egress observation (post-delivery).
func TestProcess_MailboxID_Propagated(t *testing.T) {
	p, bus := testPipeline(t)
	defer bus.Close()

	sealedCh := bus.Subscribe(msgbus.TopicSealed)
	actor := model.Actor{ID: "user-mb", TenantID: "tenant-mb"}

	req := model.IntakeRequest{
		Recipient: "mid@example.com",
		Subject:   "mailbox id test",
		Body:      "tracking",
		MailboxID: "42",
	}

	if _, err := p.Process(context.Background(), actor, req, "api"); err != nil {
		t.Fatalf("Process: %v", err)
	}

	select {
	case env := <-sealedCh:
		if env.MailboxID != "42" {
			t.Errorf("MailboxID must be propagated; got %q", env.MailboxID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for sealed envelope")
	}
}

// Hostile Headers map: keys with control chars or empty strings must NOT
// cause Process to panic. The intake doesn't validate header content
// (sanitization happens at delivery time), so it should accept the map and
// pass it through opaquely.
func TestProcess_HostileHeaders_NoPanicAcceptedAndSealed(t *testing.T) {
	p, bus := testPipeline(t)
	defer bus.Close()

	actor := model.Actor{ID: "user-hh", TenantID: "tenant-hh"}

	req := model.IntakeRequest{
		Recipient: "hh@example.com",
		Subject:   "hostile headers",
		Body:      "body",
		Headers: map[string]string{
			"X-Good":   "ok",
			"":         "empty key",
			"X-Inject": "v\r\nBcc: spy",
		},
	}

	defer func() {
		if r := recover(); r != nil {
			t.Errorf("Process panicked on hostile headers: %v", r)
		}
	}()

	result, err := p.Process(context.Background(), actor, req, "api")
	if err != nil {
		t.Fatalf("hostile headers must not error at intake layer: %v", err)
	}
	if result.Status != model.StatusSealed {
		t.Errorf("expected sealed, got %s", result.Status)
	}
}
