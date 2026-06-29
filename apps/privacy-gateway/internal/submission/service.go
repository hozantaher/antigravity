package submission

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	netmail "net/mail"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"privacy-gateway/internal/audit"
	"privacy-gateway/internal/model"
	"privacy-gateway/internal/sanitizer"
)

var (
	ErrChannelRequired         = errors.New("channel_id is required")
	ErrInvalidChannelID        = errors.New("channel_id is invalid")
	ErrEmptyBody               = errors.New("text_body is required")
	ErrHTMLNotSupported        = errors.New("html body is not supported in submissions MVP")
	ErrInvalidRecipient        = errors.New("recipient address is invalid")
	ErrTooManyRecipients       = errors.New("recipient count exceeds submission policy")
	ErrInvalidSubject          = errors.New("subject contains invalid UTF-8")
	ErrTooManyAttachments      = errors.New("attachment count exceeds submission policy")
	ErrInvalidAttachment       = errors.New("attachment metadata is invalid")
	ErrInvalidSanitizerProfile = errors.New("sanitizer_profile must be one of standard or strict")
	ErrCannotQueue             = errors.New("submission cannot be queued from its current state")
	ErrCannotRelease           = errors.New("submission cannot be released from its current state")
)

type Service struct {
	repo           Repository
	now            func() time.Time
	retention      time.Duration
	maxRecipients  int
	maxAttachments int
	sanitizer      *sanitizer.Service
	audit          *audit.Service
}

func NewService(repo Repository) *Service {
	return &Service{
		repo:           repo,
		now:            time.Now,
		maxRecipients:  10,
		maxAttachments: 10,
	}
}

func NewWorkflowService(repo Repository, sanitizerService *sanitizer.Service, auditService *audit.Service) *Service {
	service := NewService(repo)
	service.sanitizer = sanitizerService
	service.audit = auditService
	return service
}

func NewWorkflowServiceWithRetention(repo Repository, sanitizerService *sanitizer.Service, auditService *audit.Service, retention time.Duration) *Service {
	service := NewWorkflowService(repo, sanitizerService, auditService)
	service.retention = retention
	return service
}

func (s *Service) Create(ctx context.Context, actor model.Actor, input model.CreateSubmissionInput) (model.Submission, error) {
	if err := s.pruneExpired(ctx); err != nil {
		return model.Submission{}, err
	}
	return s.create(ctx, actor, input, model.SubmissionStatusAccepted)
}

func (s *Service) CreateFromPublicAPI(ctx context.Context, actor model.Actor, input model.CreateSubmissionInput) (model.Submission, error) {
	if err := s.pruneExpired(ctx); err != nil {
		return model.Submission{}, err
	}
	profile := sanitizer.NormalizeSubmissionProfile(input.SanitizerProfile)
	if profile == "" {
		return model.Submission{}, ErrInvalidSanitizerProfile
	}
	input.SanitizerProfile = profile

	result := model.SanitizationResult{
		Status:            model.SubmissionStatusAccepted,
		NormalizedSubject: strings.TrimSpace(input.Subject),
		NormalizedText:    strings.TrimSpace(input.TextBody),
	}
	if s.sanitizer != nil {
		result = s.sanitizer.SanitizeSubmission(input)
	}

	created, err := s.create(ctx, actor, input, result.Status)
	if err != nil {
		return model.Submission{}, err
	}
	created.IntakeChannel = "secure_web_intake"
	created.MetadataProfile = metadataProfileForSanitizerProfile(profile)
	created.ContentProtection = "encrypted_at_rest"
	created.DeliveryBoundary = "internal_store_and_forward"
	created.SourcePath = "secure_web_intake"
	if err := s.repo.Save(ctx, created); err != nil {
		return model.Submission{}, err
	}

	if s.audit != nil {
		metadata := map[string]string{
			"channel_id":        created.ChannelID,
			"submission_status": string(created.Status),
			"recipient_count":   strconv.Itoa(len(created.To)),
			"attachment_count":  strconv.Itoa(len(created.AttachmentsSummary)),
			"intake_channel":    created.IntakeChannel,
			"delivery_boundary": created.DeliveryBoundary,
			"metadata_profile":  created.MetadataProfile,
			"sanitizer_profile": profile,
		}
		if len(result.Notes) > 0 {
			metadata["sanitizer_notes"] = strings.Join(result.Notes, ",")
		}

		if _, err := s.audit.Record(ctx, actor.TenantID, actor.ID, "submission_created", created.ID, metadata); err != nil {
			return model.Submission{}, err
		}
	}

	return created, nil
}

func metadataProfileForSanitizerProfile(profile string) string {
	if profile == sanitizer.ProfileStrict {
		return "minimized_strict"
	}
	return "minimized"
}

func (s *Service) create(ctx context.Context, actor model.Actor, input model.CreateSubmissionInput, status model.SubmissionStatus) (model.Submission, error) {
	channelID := strings.TrimSpace(input.ChannelID)
	if channelID == "" {
		return model.Submission{}, ErrChannelRequired
	}
	if !utf8.ValidString(channelID) || strings.ContainsAny(channelID, "\r\n") {
		return model.Submission{}, ErrInvalidChannelID
	}
	if strings.TrimSpace(input.HTMLBody) != "" {
		return model.Submission{}, ErrHTMLNotSupported
	}

	subject := strings.TrimSpace(input.Subject)
	if !utf8.ValidString(subject) || strings.ContainsAny(subject, "\r\n") {
		return model.Submission{}, ErrInvalidSubject
	}

	textBody := strings.TrimSpace(input.TextBody)
	if textBody == "" {
		return model.Submission{}, ErrEmptyBody
	}

	recipients, err := normalizeRecipients(input.To, s.maxRecipients)
	if err != nil {
		return model.Submission{}, err
	}
	attachments, err := normalizeAttachments(input.Attachments, s.maxAttachments)
	if err != nil {
		return model.Submission{}, err
	}

	id, err := submissionID()
	if err != nil {
		return model.Submission{}, err
	}

	submission := model.Submission{
		ID:                 id,
		TenantID:           actor.TenantID,
		ChannelID:          channelID,
		SubmittedBy:        actor.ID,
		To:                 recipients,
		Subject:            subject,
		TextBody:           textBody,
		AttachmentsSummary: attachments,
		Status:             status,
		CreatedAt:          s.now().UTC(),
	}

	if err := s.repo.Save(ctx, submission); err != nil {
		return model.Submission{}, err
	}
	return submission, nil
}

func (s *Service) MarkRelayed(ctx context.Context, id, provider, attemptID, sourcePath string, relayedAt time.Time) (model.Submission, error) {
	if err := s.pruneExpired(ctx); err != nil {
		return model.Submission{}, err
	}

	submission, err := s.repo.GetByID(ctx, strings.TrimSpace(id))
	if err != nil {
		return model.Submission{}, err
	}

	submission.Status = model.SubmissionStatusRelayed
	submission.RelayProvider = strings.TrimSpace(provider)
	submission.RelayAttemptID = strings.TrimSpace(attemptID)
	submission.RelayFailureClass = ""
	submission.RelayFailureDisposition = ""
	submission.RelayFailureReason = ""
	submission.SourcePath = strings.TrimSpace(sourcePath)
	submission.DeliveryBoundary = "trusted_delivery_boundary"
	submission.RelayedAt = relayedAt.UTC()
	submission.FailedAt = time.Time{}

	if err := s.repo.Save(ctx, submission); err != nil {
		return model.Submission{}, err
	}
	if s.audit != nil {
		_, err := s.audit.Record(ctx, submission.TenantID, submission.SubmittedBy, "submission_relayed", submission.ID, map[string]string{
			"submission_status": string(submission.Status),
			"relay_provider":    submission.RelayProvider,
			"relay_attempt_id":  submission.RelayAttemptID,
			"source_path":       submission.SourcePath,
			"delivery_boundary": submission.DeliveryBoundary,
		})
		if err != nil {
			return model.Submission{}, err
		}
	}
	return submission, nil
}

func (s *Service) MarkRelayFailed(ctx context.Context, id, attemptID, provider, sourcePath, failureClass, failureDisposition, failureReason string, failedAt time.Time) (model.Submission, error) {
	if err := s.pruneExpired(ctx); err != nil {
		return model.Submission{}, err
	}

	submission, err := s.repo.GetByID(ctx, strings.TrimSpace(id))
	if err != nil {
		return model.Submission{}, err
	}

	submission.Status = model.SubmissionStatusFailed
	submission.RelayProvider = strings.TrimSpace(provider)
	submission.RelayAttemptID = strings.TrimSpace(attemptID)
	submission.RelayFailureClass = normalizeFailureField(failureClass)
	submission.RelayFailureDisposition = normalizeFailureDisposition(failureDisposition)
	submission.RelayFailureReason = normalizeFailureField(failureReason)
	submission.SourcePath = strings.TrimSpace(sourcePath)
	if submission.DeliveryBoundary == "" {
		submission.DeliveryBoundary = "internal_store_and_forward"
	}
	submission.RelayedAt = time.Time{}
	submission.FailedAt = failedAt.UTC()

	if err := s.repo.Save(ctx, submission); err != nil {
		return model.Submission{}, err
	}
	if s.audit != nil {
		metadata := map[string]string{
			"submission_status":         string(submission.Status),
			"relay_provider":            submission.RelayProvider,
			"relay_failure_class":       submission.RelayFailureClass,
			"relay_failure_disposition": submission.RelayFailureDisposition,
			"source_path":               submission.SourcePath,
			"delivery_boundary":         submission.DeliveryBoundary,
		}
		if submission.RelayFailureReason != "" {
			metadata["relay_failure_reason"] = submission.RelayFailureReason
		}
		_, err := s.audit.Record(ctx, submission.TenantID, submission.SubmittedBy, "submission_relay_failed", submission.ID, metadata)
		if err != nil {
			return model.Submission{}, err
		}
	}
	return submission, nil
}

func (s *Service) GetByID(ctx context.Context, id string) (model.Submission, error) {
	if err := s.pruneExpired(ctx); err != nil {
		return model.Submission{}, err
	}
	return s.repo.GetByID(ctx, strings.TrimSpace(id))
}

func (s *Service) QueueForRelay(ctx context.Context, id, sourcePath string) (model.Submission, error) {
	if err := s.pruneExpired(ctx); err != nil {
		return model.Submission{}, err
	}

	record, err := s.repo.GetByID(ctx, strings.TrimSpace(id))
	if err != nil {
		return model.Submission{}, err
	}
	if !canQueueSubmission(record) {
		return model.Submission{}, ErrCannotQueue
	}

	record.Status = model.SubmissionStatusQueued
	record.SourcePath = strings.TrimSpace(sourcePath)
	record.DeliveryBoundary = "internal_store_and_forward"
	if err := s.repo.Save(ctx, record); err != nil {
		return model.Submission{}, err
	}
	if s.audit != nil {
		_, err := s.audit.Record(ctx, record.TenantID, record.SubmittedBy, "submission_queued", record.ID, map[string]string{
			"submission_status": string(record.Status),
			"source_path":       record.SourcePath,
			"delivery_boundary": record.DeliveryBoundary,
		})
		if err != nil {
			return model.Submission{}, err
		}
	}
	return record, nil
}

func (s *Service) ReleaseToRelay(ctx context.Context, id, sourcePath string) (model.Submission, error) {
	if err := s.pruneExpired(ctx); err != nil {
		return model.Submission{}, err
	}

	record, err := s.repo.GetByID(ctx, strings.TrimSpace(id))
	if err != nil {
		return model.Submission{}, err
	}
	if record.Status != model.SubmissionStatusQueued {
		return model.Submission{}, ErrCannotRelease
	}

	record.Status = model.SubmissionStatusSanitized
	record.SourcePath = strings.TrimSpace(sourcePath)
	record.DeliveryBoundary = "internal_store_and_forward"
	if err := s.repo.Save(ctx, record); err != nil {
		return model.Submission{}, err
	}
	if s.audit != nil {
		_, err := s.audit.Record(ctx, record.TenantID, record.SubmittedBy, "submission_released", record.ID, map[string]string{
			"submission_status": string(record.Status),
			"source_path":       record.SourcePath,
			"delivery_boundary": record.DeliveryBoundary,
		})
		if err != nil {
			return model.Submission{}, err
		}
	}
	return record, nil
}

func (s *Service) ListForActor(ctx context.Context, actor model.Actor) ([]model.Submission, error) {
	if err := s.pruneExpired(ctx); err != nil {
		return nil, err
	}
	return s.repo.ListByTenant(ctx, actor.TenantID)
}

func (s *Service) pruneExpired(ctx context.Context) error {
	if s.retention <= 0 {
		return nil
	}
	return s.repo.PruneBefore(ctx, s.now().UTC().Add(-s.retention))
}

func submissionID() (string, error) {
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "sub_" + hex.EncodeToString(buf), nil
}

func normalizeRecipients(values []string, maxRecipients int) ([]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	if len(values) > maxRecipients {
		return nil, ErrTooManyRecipients
	}

	recipients := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, raw := range values {
		addr, err := netmail.ParseAddress(strings.TrimSpace(raw))
		if err != nil {
			return nil, ErrInvalidRecipient
		}
		normalized := strings.ToLower(addr.Address)
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		recipients = append(recipients, normalized)
	}
	return recipients, nil
}

func normalizeAttachments(values []model.SubmissionAttachmentSummary, maxAttachments int) ([]model.SubmissionAttachmentSummary, error) {
	if len(values) == 0 {
		return nil, nil
	}
	if len(values) > maxAttachments {
		return nil, ErrTooManyAttachments
	}

	attachments := make([]model.SubmissionAttachmentSummary, 0, len(values))
	for _, raw := range values {
		filename := strings.TrimSpace(raw.Filename)
		contentType := strings.TrimSpace(raw.ContentType)
		if !utf8.ValidString(filename) || !utf8.ValidString(contentType) {
			return nil, ErrInvalidAttachment
		}
		if strings.ContainsAny(filename, "\r\n") || strings.ContainsAny(contentType, "\r\n") {
			return nil, ErrInvalidAttachment
		}
		if raw.SizeBytes < 0 {
			return nil, ErrInvalidAttachment
		}

		attachments = append(attachments, model.SubmissionAttachmentSummary{
			Filename:    filename,
			ContentType: contentType,
			SizeBytes:   raw.SizeBytes,
		})
	}
	return attachments, nil
}

func normalizeFailureField(value string) string {
	value = strings.TrimSpace(value)
	if !utf8.ValidString(value) {
		return ""
	}
	value = strings.ReplaceAll(value, "\r", " ")
	value = strings.ReplaceAll(value, "\n", " ")
	return strings.TrimSpace(value)
}

func normalizeFailureDisposition(value string) string {
	value = strings.TrimSpace(value)
	switch value {
	case "retryable", "terminal":
		return value
	default:
		return "terminal"
	}
}

func canQueueSubmission(record model.Submission) bool {
	switch record.Status {
	case model.SubmissionStatusAccepted, model.SubmissionStatusSanitized, model.SubmissionStatusQueued:
		return true
	case model.SubmissionStatusFailed:
		return record.RelayFailureDisposition == "retryable"
	default:
		return false
	}
}
