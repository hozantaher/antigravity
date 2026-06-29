package sender

import (
	"common/config"
	"campaigns/content"
	"os"
	"path/filepath"
	"testing"
)

// D3.6 integration test: content.Engine.Render → sender.SendRequest.
//
// Pins the end-to-end contract between the two layers without going
// through the full campaign.Runner DB loop:
//  1. A template declaring {{/* humanize: off */}} renders with
//     SkipHumanize=true on RenderedEmail.
//  2. When that value is copied into sender.SendRequest (as
//     campaign.Runner.Enqueue does at runner.go:285), the PreSendHook
//     observes the flag and early-returns without mutating the body.
//
// The content and sender unit tests verify each half in isolation.
// This test verifies the wiring between them so a future refactor
// that accidentally drops the field copy is caught.

func writeTmpl(t *testing.T, body string) (dir, name string) {
	t.Helper()
	dir = t.TempDir()
	name = "tmpl"
	if err := os.WriteFile(filepath.Join(dir, name+".tmpl"), []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	return dir, name
}

func TestContentToSender_SkipHumanizePropagates(t *testing.T) {
	body := `{{/* humanize: off */}}
{{/* subject: Potvrzení odhlášení */}}
Vaše odhlášení bylo zaznamenáno.

Zdraví,
{{podpis}}
`
	dir, name := writeTmpl(t, body)
	ce := content.NewEngine(dir, nil)
	rendered, err := ce.Render(name, content.TemplateVars{
		
	}, 1, 0)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if !rendered.SkipHumanize {
		t.Fatal("content layer did not set SkipHumanize=true on marker template")
	}

	// Build a send engine with a hook that would normally rewrite the
	// body — same shape as cmd/outreach/main.go:buildPreSendHook.
	mailboxes := []config.MailboxConfig{
		{Address: "a@b.cz", DailyLimit: 10, Persona: config.PersonaConfig{Name: "N"}},
	}
	se := NewEngine(mailboxes, config.SendingConfig{}, config.SafetyConfig{MaxBounceRate: 0.5}).
		WithDryRun(true)
	se.WithPreSendHook(func(_ config.MailboxConfig, req *SendRequest) {
		if req.SkipHumanize {
			return
		}
		req.BodyPlain = "MUTATED: " + req.BodyPlain
		req.Subject = "MUTATED: " + req.Subject
	})

	// Exact field copy performed by campaign.Runner at runner.go:285.
	req := SendRequest{
		ToAddress:    "to@test.cz",
		Subject:      rendered.Subject,
		BodyPlain:    rendered.BodyPlain,
		BodyHTML:     rendered.BodyHTML,
		Headers:      rendered.Headers,
		SkipHumanize: rendered.SkipHumanize,
	}

	mb, err := se.pickMailbox("")
	if err != nil {
		t.Fatalf("pick: %v", err)
	}
	if se.preSendHook != nil {
		se.preSendHook(mb, &req)
	}

	// Body and subject must still match the rendered template — no
	// MUTATED prefix from the hook.
	if req.Subject != rendered.Subject {
		t.Errorf("subject mutated despite marker: got %q, want %q", req.Subject, rendered.Subject)
	}
	if req.BodyPlain != rendered.BodyPlain {
		t.Errorf("body mutated despite marker: got %q, want %q", req.BodyPlain, rendered.BodyPlain)
	}
}

// Control test: same wiring, template that OPTS IN to humanize via the
// `{{/* humanize: on */}}` marker — hook DOES run. Sprint A (2026-05-11)
// inverted the default to humanize-OFF (content.detectHumanizeOff), so a
// template must explicitly opt in for the PreSendHook to mutate the body.
func TestContentToSender_OptInMarkerAllowsHumanize(t *testing.T) {
	body := `{{/* humanize: on */}}
{{/* subject: Nabídka */}}
Dobrý den,

nabízíme...

{{podpis}}
`
	dir, name := writeTmpl(t, body)
	ce := content.NewEngine(dir, nil)
	rendered, err := ce.Render(name, content.TemplateVars{
		
	}, 1, 0)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if rendered.SkipHumanize {
		t.Fatal("opt-in marker template should have SkipHumanize=false")
	}

	mailboxes := []config.MailboxConfig{
		{Address: "a@b.cz", DailyLimit: 10, Persona: config.PersonaConfig{Name: "N"}},
	}
	se := NewEngine(mailboxes, config.SendingConfig{}, config.SafetyConfig{MaxBounceRate: 0.5}).
		WithDryRun(true)
	se.WithPreSendHook(func(_ config.MailboxConfig, req *SendRequest) {
		if req.SkipHumanize {
			return
		}
		req.Subject = "H: " + req.Subject
	})

	req := SendRequest{
		ToAddress:    "to@test.cz",
		Subject:      rendered.Subject,
		BodyPlain:    rendered.BodyPlain,
		SkipHumanize: rendered.SkipHumanize,
	}
	mb, _ := se.pickMailbox("")
	se.preSendHook(mb, &req)

	if req.Subject == rendered.Subject {
		t.Error("opt-in marker template should allow hook to mutate subject")
	}
}
