package sanitizer

import (
	"strings"

	"privacy-gateway/internal/model"
)

const (
	ProfileStandard = "standard"
	ProfileStrict   = "strict"
)

type Service struct{}

func NewService() *Service {
	return &Service{}
}

func (s *Service) SanitizeOutbound(input model.SendMessageInput) model.SanitizationResult {
	result := model.SanitizationResult{
		Status:            model.SubmissionStatusSanitized,
		NormalizedSubject: strings.TrimSpace(input.Subject),
		NormalizedText:    strings.TrimSpace(input.TextBody),
		HasHTML:           strings.TrimSpace(input.HTMLBody) != "",
	}

	if result.HasHTML {
		result.Notes = append(result.Notes, "html_present")
	}
	if result.NormalizedSubject == "" {
		result.Notes = append(result.Notes, "empty_subject")
	}
	if result.NormalizedText == "" {
		result.Notes = append(result.Notes, "empty_text_body")
	}

	return result
}

func (s *Service) SanitizeSubmission(input model.CreateSubmissionInput) model.SanitizationResult {
	profile := NormalizeSubmissionProfile(input.SanitizerProfile)
	result := model.SanitizationResult{
		Status:            model.SubmissionStatusSanitized,
		NormalizedSubject: strings.TrimSpace(input.Subject),
		NormalizedText:    strings.TrimSpace(input.TextBody),
		HasHTML:           strings.TrimSpace(input.HTMLBody) != "",
	}

	if result.HasHTML {
		result.Status = model.SubmissionStatusBlocked
		result.Notes = append(result.Notes, "html_present")
	}
	if result.NormalizedSubject == "" {
		result.Notes = append(result.Notes, "empty_subject")
	}
	if result.NormalizedText == "" {
		result.Status = model.SubmissionStatusBlocked
		result.Notes = append(result.Notes, "empty_text_body")
	}
	if len(input.Attachments) > 0 {
		result.Notes = append(result.Notes, "attachments_present")
	}
	if profile == ProfileStrict {
		result.Notes = append(result.Notes, "strict_profile")
		if len(input.Attachments) > 0 {
			result.Status = model.SubmissionStatusBlocked
			result.Notes = append(result.Notes, "attachments_blocked_strict")
		}
		if len(input.To) > 0 {
			result.Status = model.SubmissionStatusBlocked
			result.Notes = append(result.Notes, "recipients_blocked_strict")
		}
	}

	return result
}

func NormalizeSubmissionProfile(profile string) string {
	switch strings.ToLower(strings.TrimSpace(profile)) {
	case "", ProfileStandard:
		return ProfileStandard
	case ProfileStrict:
		return ProfileStrict
	default:
		return ""
	}
}

func (s *Service) SanitizeInbound(message model.InboxMessage) model.SanitizationResult {
	result := model.SanitizationResult{
		Status:            model.SubmissionStatusSanitized,
		NormalizedSubject: strings.TrimSpace(message.Subject),
		NormalizedText:    strings.TrimSpace(message.TextBody),
	}

	for _, attachment := range message.Attachments {
		if attachment.PolicyAction == "blocked" {
			result.HasBlockedContent = true
			result.Notes = append(result.Notes, "blocked_attachment_present")
			break
		}
	}
	if message.AttachmentCount > 0 {
		result.Notes = append(result.Notes, "attachments_present")
	}

	return result
}
