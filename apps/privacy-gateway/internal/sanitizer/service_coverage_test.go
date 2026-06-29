package sanitizer

import (
	"testing"

	"privacy-gateway/internal/model"
)

// TestNormalizeSubmissionProfileBranches covers all branches of NormalizeSubmissionProfile.
func TestNormalizeSubmissionProfileBranches(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"empty returns standard", "", ProfileStandard},
		{"standard literal", "standard", ProfileStandard},
		{"strict literal", "strict", ProfileStrict},
		{"mixed case strict", "STRICT", ProfileStrict},
		{"whitespace trim", "  standard  ", ProfileStandard},
		{"unknown returns empty", "weird", ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := NormalizeSubmissionProfile(tc.input); got != tc.want {
				t.Fatalf("NormalizeSubmissionProfile(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

// TestSanitizeSubmissionEmptyNotes exercises the empty-subject/empty-text branches.
func TestSanitizeSubmissionEmptyNotes(t *testing.T) {
	service := NewService()

	result := service.SanitizeSubmission(model.CreateSubmissionInput{})

	if result.Status != model.SubmissionStatusBlocked {
		t.Fatalf("expected blocked status for empty text, got %s", result.Status)
	}
	foundEmptySubject := false
	foundEmptyText := false
	for _, note := range result.Notes {
		if note == "empty_subject" {
			foundEmptySubject = true
		}
		if note == "empty_text_body" {
			foundEmptyText = true
		}
	}
	if !foundEmptySubject || !foundEmptyText {
		t.Fatalf("expected empty_subject and empty_text_body notes, got %+v", result.Notes)
	}
}

// TestSanitizeSubmissionHTMLIsBlocked exercises the html-present branch.
func TestSanitizeSubmissionHTMLIsBlocked(t *testing.T) {
	service := NewService()

	result := service.SanitizeSubmission(model.CreateSubmissionInput{
		Subject:  "Hi",
		TextBody: "Body",
		HTMLBody: "<p>Body</p>",
	})

	if result.Status != model.SubmissionStatusBlocked {
		t.Fatalf("expected blocked status for HTML body, got %s", result.Status)
	}
	foundHTML := false
	for _, note := range result.Notes {
		if note == "html_present" {
			foundHTML = true
		}
	}
	if !foundHTML {
		t.Fatalf("expected html_present note, got %+v", result.Notes)
	}
}

// TestSanitizeOutboundEmptyNotes ensures empty subject and text emit notes.
func TestSanitizeOutboundEmptyNotes(t *testing.T) {
	service := NewService()

	result := service.SanitizeOutbound(model.SendMessageInput{})

	if result.Status != model.SubmissionStatusSanitized {
		t.Fatalf("expected sanitized status, got %s", result.Status)
	}
	foundEmptySubject := false
	foundEmptyText := false
	for _, note := range result.Notes {
		if note == "empty_subject" {
			foundEmptySubject = true
		}
		if note == "empty_text_body" {
			foundEmptyText = true
		}
	}
	if !foundEmptySubject || !foundEmptyText {
		t.Fatalf("expected empty notes, got %+v", result.Notes)
	}
}

// TestSanitizeSubmissionStrictProfileCleanInput covers strict profile without
// recipients or attachments so only the strict_profile note is added.
func TestSanitizeSubmissionStrictProfileCleanInput(t *testing.T) {
	service := NewService()

	result := service.SanitizeSubmission(model.CreateSubmissionInput{
		SanitizerProfile: ProfileStrict,
		Subject:          "Hi",
		TextBody:         "Body",
	})

	if result.Status != model.SubmissionStatusSanitized {
		t.Fatalf("expected sanitized status, got %s", result.Status)
	}
	found := false
	for _, note := range result.Notes {
		if note == "strict_profile" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected strict_profile note, got %+v", result.Notes)
	}
}
