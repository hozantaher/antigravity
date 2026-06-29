package sanitizer

import (
	"testing"

	"privacy-gateway/internal/model"
)

func TestSanitizeOutboundTrimsAndFlagsHTML(t *testing.T) {
	service := NewService()

	result := service.SanitizeOutbound(model.SendMessageInput{
		Subject:  " Hello ",
		TextBody: " Body ",
		HTMLBody: "<p>Body</p>",
	})

	if result.Status != model.SubmissionStatusSanitized {
		t.Fatalf("expected sanitized status, got %s", result.Status)
	}
	if result.NormalizedSubject != "Hello" {
		t.Fatalf("expected normalized subject, got %q", result.NormalizedSubject)
	}
	if result.NormalizedText != "Body" {
		t.Fatalf("expected normalized text, got %q", result.NormalizedText)
	}
	if !result.HasHTML {
		t.Fatal("expected has_html to be true")
	}
}

func TestSanitizeInboundFlagsBlockedAttachments(t *testing.T) {
	service := NewService()

	result := service.SanitizeInbound(model.InboxMessage{
		Subject:         " Hello ",
		TextBody:        " Body ",
		AttachmentCount: 1,
		Attachments: []model.InboxAttachment{{
			Filename:     "run.exe",
			PolicyAction: "blocked",
		}},
	})

	if result.NormalizedSubject != "Hello" {
		t.Fatalf("expected normalized subject, got %q", result.NormalizedSubject)
	}
	if result.NormalizedText != "Body" {
		t.Fatalf("expected normalized text, got %q", result.NormalizedText)
	}
	if !result.HasBlockedContent {
		t.Fatal("expected blocked content to be flagged")
	}
}

func TestSanitizeSubmissionFlagsAttachmentsAndNormalizesText(t *testing.T) {
	service := NewService()

	result := service.SanitizeSubmission(model.CreateSubmissionInput{
		Subject:  " Hello ",
		TextBody: " Body ",
		Attachments: []model.SubmissionAttachmentSummary{{
			Filename: "note.txt",
		}},
	})

	if result.Status != model.SubmissionStatusSanitized {
		t.Fatalf("expected sanitized status, got %s", result.Status)
	}
	if result.NormalizedSubject != "Hello" {
		t.Fatalf("expected normalized subject, got %q", result.NormalizedSubject)
	}
	if result.NormalizedText != "Body" {
		t.Fatalf("expected normalized text, got %q", result.NormalizedText)
	}
	if len(result.Notes) == 0 || result.Notes[0] != "attachments_present" {
		t.Fatalf("expected attachments_present note, got %+v", result.Notes)
	}
}

func TestSanitizeSubmissionStrictBlocksRecipientsAndAttachments(t *testing.T) {
	service := NewService()

	result := service.SanitizeSubmission(model.CreateSubmissionInput{
		SanitizerProfile: ProfileStrict,
		Subject:          " Hello ",
		TextBody:         " Body ",
		To:               []string{"recipient@example.com"},
		Attachments: []model.SubmissionAttachmentSummary{{
			Filename: "note.txt",
		}},
	})

	if result.Status != model.SubmissionStatusBlocked {
		t.Fatalf("expected blocked status, got %s", result.Status)
	}
	if result.NormalizedSubject != "Hello" || result.NormalizedText != "Body" {
		t.Fatalf("expected normalized content, got subject=%q text=%q", result.NormalizedSubject, result.NormalizedText)
	}
	if !containsNote(result.Notes, "strict_profile") || !containsNote(result.Notes, "attachments_blocked_strict") || !containsNote(result.Notes, "recipients_blocked_strict") {
		t.Fatalf("expected strict blocking notes, got %+v", result.Notes)
	}
}

func containsNote(notes []string, wanted string) bool {
	for _, note := range notes {
		if note == wanted {
			return true
		}
	}
	return false
}
