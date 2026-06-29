package sanitizer_test

import (
	"math/rand"
	"strings"
	"testing"
	"testing/quick"

	"privacy-gateway/internal/model"
	"privacy-gateway/internal/sanitizer"
)

// ── NormalizeSubmissionProfile — property tests ───────────────────────────

func TestNormalizeSubmissionProfile_OutputIdempotent(t *testing.T) {
	// Idempotency holds for OUTPUTS (valid enum values), not arbitrary inputs.
	// Unknown input → "" (first call), then "" → "standard" (second call): by design.
	// But any output, when passed back in, must stabilise on the second call.
	validOutputs := []string{"standard", "strict", ""}
	for _, v := range validOutputs {
		once := sanitizer.NormalizeSubmissionProfile(v)
		twice := sanitizer.NormalizeSubmissionProfile(once)
		if once != twice {
			t.Errorf("output %q not idempotent: once=%q twice=%q", v, once, twice)
		}
	}
}

func TestNormalizeSubmissionProfile_OutputBounded(t *testing.T) {
	valid := map[string]bool{"standard": true, "strict": true, "": true}
	f := func(s string) bool {
		result := sanitizer.NormalizeSubmissionProfile(s)
		return valid[result]
	}
	if err := quick.Check(f, nil); err != nil {
		t.Errorf("NormalizeSubmissionProfile returned invalid value: %v", err)
	}
}

func TestNormalizeSubmissionProfile_CaseInsensitive(t *testing.T) {
	variants := []string{"STANDARD", "Standard", "standard", "STRICT", "Strict", "strict"}
	for _, v := range variants {
		result := sanitizer.NormalizeSubmissionProfile(v)
		lower := strings.ToLower(v)
		if result != lower {
			t.Errorf("case insensitive: NormalizeSubmissionProfile(%q) = %q, want %q", v, result, lower)
		}
	}
}

func TestNormalizeSubmissionProfile_WhitespaceTolerant(t *testing.T) {
	f := func(s string) bool {
		trimmed := sanitizer.NormalizeSubmissionProfile(s)
		padded := sanitizer.NormalizeSubmissionProfile("  " + s + "  ")
		return trimmed == padded
	}
	if err := quick.Check(f, nil); err != nil {
		t.Errorf("NormalizeSubmissionProfile not whitespace-tolerant: %v", err)
	}
}

func TestNormalizeSubmissionProfile_NeverPanics(t *testing.T) {
	edge := []string{"", " ", "\t", "\n", "unknown", "💬", strings.Repeat("x", 10_000)}
	for _, s := range edge {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("NormalizeSubmissionProfile panicked on %q: %v", s, r)
				}
			}()
			_ = sanitizer.NormalizeSubmissionProfile(s)
		}()
	}
}

// ── SanitizeOutbound — property tests ─────────────────────────────────────

func TestSanitizeOutbound_NeverPanics(t *testing.T) {
	svc := sanitizer.NewService()
	f := func(subject, text, html string) bool {
		defer func() { recover() }()
		svc.SanitizeOutbound(model.SendMessageInput{
			Subject:  subject,
			TextBody: text,
			HTMLBody: html,
		})
		return true
	}
	if err := quick.Check(f, nil); err != nil {
		t.Errorf("SanitizeOutbound panicked: %v", err)
	}
}

func TestSanitizeOutbound_SubjectTrimmed(t *testing.T) {
	svc := sanitizer.NewService()
	f := func(subject string) bool {
		result := svc.SanitizeOutbound(model.SendMessageInput{Subject: subject})
		return result.NormalizedSubject == strings.TrimSpace(subject)
	}
	if err := quick.Check(f, nil); err != nil {
		t.Errorf("SanitizeOutbound: subject not trimmed: %v", err)
	}
}

func TestSanitizeOutbound_Idempotent(t *testing.T) {
	svc := sanitizer.NewService()
	f := func(subject, text string) bool {
		first := svc.SanitizeOutbound(model.SendMessageInput{Subject: subject, TextBody: text})
		second := svc.SanitizeOutbound(model.SendMessageInput{
			Subject:  first.NormalizedSubject,
			TextBody: first.NormalizedText,
		})
		return first.NormalizedSubject == second.NormalizedSubject &&
			first.NormalizedText == second.NormalizedText
	}
	if err := quick.Check(f, nil); err != nil {
		t.Errorf("SanitizeOutbound not idempotent on trim: %v", err)
	}
}

func TestSanitizeOutbound_HTMLFlagAccurate(t *testing.T) {
	svc := sanitizer.NewService()
	cases := []struct{ html string; want bool }{
		{"", false},
		{"   ", false},
		{"<b>bold</b>", true},
		{"plain text", true},
	}
	for _, tc := range cases {
		result := svc.SanitizeOutbound(model.SendMessageInput{HTMLBody: tc.html})
		if result.HasHTML != tc.want {
			t.Errorf("SanitizeOutbound HTMLBody=%q: HasHTML=%v want %v", tc.html, result.HasHTML, tc.want)
		}
	}
}

// ── SanitizeSubmission — property tests ───────────────────────────────────

func TestSanitizeSubmission_HTMLBodyBlocked(t *testing.T) {
	svc := sanitizer.NewService()
	f := func(html string) bool {
		if strings.TrimSpace(html) == "" {
			return true // empty html → not blocked
		}
		result := svc.SanitizeSubmission(model.CreateSubmissionInput{
			HTMLBody: html,
			TextBody: "some text",
			Subject:  "subject",
		})
		return result.Status == model.SubmissionStatusBlocked
	}
	if err := quick.Check(f, nil); err != nil {
		t.Errorf("SanitizeSubmission: non-empty HTML should block: %v", err)
	}
}

func TestSanitizeSubmission_EmptyTextBodyBlocked(t *testing.T) {
	svc := sanitizer.NewService()
	cases := []struct{ text string; wantBlocked bool }{
		{"", true},
		{"  ", true},
		{"hello", false},
	}
	for _, tc := range cases {
		result := svc.SanitizeSubmission(model.CreateSubmissionInput{
			TextBody: tc.text,
			Subject:  "subject",
		})
		blocked := result.Status == model.SubmissionStatusBlocked
		if blocked != tc.wantBlocked {
			t.Errorf("SanitizeSubmission text=%q: blocked=%v want %v", tc.text, blocked, tc.wantBlocked)
		}
	}
}

func TestSanitizeSubmission_StrictProfileBlocksAttachments(t *testing.T) {
	svc := sanitizer.NewService()
	result := svc.SanitizeSubmission(model.CreateSubmissionInput{
		SanitizerProfile: "strict",
		Subject:          "hello",
		TextBody:         "body",
		Attachments: []model.SubmissionAttachmentSummary{
			{Filename: "file.pdf", ContentType: "application/pdf"},
		},
	})
	if result.Status != model.SubmissionStatusBlocked {
		t.Errorf("strict profile with attachments should be blocked, got %s", result.Status)
	}
}

func TestSanitizeSubmission_NeverPanics(t *testing.T) {
	svc := sanitizer.NewService()
	rng := rand.New(rand.NewSource(42))
	profiles := []string{"", "standard", "strict", "unknown", "STRICT"}
	for i := 0; i < 200; i++ {
		profile := profiles[rng.Intn(len(profiles))]
		attachCount := rng.Intn(5)
		attachments := make([]model.SubmissionAttachmentSummary, attachCount)
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("SanitizeSubmission panicked (iter %d): %v", i, r)
				}
			}()
			svc.SanitizeSubmission(model.CreateSubmissionInput{
				SanitizerProfile: profile,
				Subject:          strings.Repeat("x", rng.Intn(200)),
				TextBody:         strings.Repeat("y", rng.Intn(200)),
				Attachments:      attachments,
			})
		}()
	}
}

// ── SanitizeInbound — property tests ─────────────────────────────────────

func TestSanitizeInbound_NeverPanics(t *testing.T) {
	svc := sanitizer.NewService()
	f := func(subject, text string, attachCount uint8) bool {
		attachments := make([]model.InboxAttachment, attachCount)
		defer func() { recover() }()
		svc.SanitizeInbound(model.InboxMessage{
			Subject:         subject,
			TextBody:        text,
			Attachments:     attachments,
			AttachmentCount: int(attachCount),
		})
		return true
	}
	if err := quick.Check(f, nil); err != nil {
		t.Errorf("SanitizeInbound panicked: %v", err)
	}
}

func TestSanitizeInbound_SubjectTrimmed(t *testing.T) {
	svc := sanitizer.NewService()
	result := svc.SanitizeInbound(model.InboxMessage{Subject: "  hello  "})
	if result.NormalizedSubject != "hello" {
		t.Errorf("SanitizeInbound: subject not trimmed, got %q", result.NormalizedSubject)
	}
}
