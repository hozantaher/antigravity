package submission

import (
	"context"
	"errors"
	"testing"
	"time"

	"privacy-gateway/internal/audit"
	"privacy-gateway/internal/model"
	"privacy-gateway/internal/sanitizer"
)

func TestServiceCreateStoresSubmission(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)
	service.now = func() time.Time {
		return time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC)
	}

	submission, err := service.Create(context.Background(), model.Actor{
		ID:       "user-1",
		TenantID: "tenant-1",
	}, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		To:        []string{"recipient@example.com"},
		Subject:   "  Hello  ",
		TextBody:  "  Body  ",
		Attachments: []model.SubmissionAttachmentSummary{{
			Filename:    "note.txt",
			ContentType: "text/plain",
			SizeBytes:   4,
		}},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if submission.ID == "" {
		t.Fatal("expected submission id")
	}
	if submission.Status != model.SubmissionStatusAccepted {
		t.Fatalf("expected accepted status, got %s", submission.Status)
	}
	if submission.Subject != "Hello" {
		t.Fatalf("expected normalized subject, got %q", submission.Subject)
	}
	if submission.TextBody != "Body" {
		t.Fatalf("expected normalized body, got %q", submission.TextBody)
	}
	if submission.CreatedAt != time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC) {
		t.Fatalf("unexpected created_at %v", submission.CreatedAt)
	}
}

func TestServiceCreateRejectsMissingChannelID(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)

	_, err := service.Create(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}, model.CreateSubmissionInput{
		Subject:  "Hello",
		TextBody: "Body",
	})
	if !errors.Is(err, ErrChannelRequired) {
		t.Fatalf("expected ErrChannelRequired, got %v", err)
	}
}

func TestServiceCreateRejectsInvalidChannelID(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)

	_, err := service.Create(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}, model.CreateSubmissionInput{
		ChannelID: "channel-1\r\nx",
		Subject:   "Hello",
		TextBody:  "Body",
	})
	if !errors.Is(err, ErrInvalidChannelID) {
		t.Fatalf("expected ErrInvalidChannelID, got %v", err)
	}
}

func TestServiceCreateRejectsEmptyBody(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)

	_, err := service.Create(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		Subject:   "Hello",
		TextBody:  "   ",
	})
	if !errors.Is(err, ErrEmptyBody) {
		t.Fatalf("expected ErrEmptyBody, got %v", err)
	}
}

func TestServiceCreateRejectsHTMLBody(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)

	_, err := service.Create(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		Subject:   "Hello",
		TextBody:  "Body",
		HTMLBody:  "<p>Body</p>",
	})
	if !errors.Is(err, ErrHTMLNotSupported) {
		t.Fatalf("expected ErrHTMLNotSupported, got %v", err)
	}
}

func TestServiceCreateRejectsInvalidRecipient(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)

	_, err := service.Create(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		Subject:   "Hello",
		TextBody:  "Body",
		To:        []string{"not-an-email"},
	})
	if !errors.Is(err, ErrInvalidRecipient) {
		t.Fatalf("expected ErrInvalidRecipient, got %v", err)
	}
}

func TestServiceCreateNormalizesAndDeduplicatesRecipients(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)

	created, err := service.Create(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		Subject:   "Hello",
		TextBody:  "Body",
		To:        []string{"User@example.com", "user@example.com"},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if len(created.To) != 1 || created.To[0] != "user@example.com" {
		t.Fatalf("expected normalized deduplicated recipients, got %+v", created.To)
	}
}

func TestServiceCreateRejectsInvalidSubject(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)

	_, err := service.Create(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		Subject:   "hello\r\nBCC: victim@example.com",
		TextBody:  "Body",
	})
	if !errors.Is(err, ErrInvalidSubject) {
		t.Fatalf("expected ErrInvalidSubject, got %v", err)
	}
}

func TestServiceCreateNormalizesAttachmentMetadata(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)

	created, err := service.Create(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		Subject:   "Hello",
		TextBody:  "Body",
		Attachments: []model.SubmissionAttachmentSummary{{
			Filename:    " note.txt ",
			ContentType: " text/plain ",
			SizeBytes:   4,
		}},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if len(created.AttachmentsSummary) != 1 {
		t.Fatalf("expected 1 attachment summary, got %d", len(created.AttachmentsSummary))
	}
	if created.AttachmentsSummary[0].Filename != "note.txt" {
		t.Fatalf("expected trimmed filename, got %q", created.AttachmentsSummary[0].Filename)
	}
	if created.AttachmentsSummary[0].ContentType != "text/plain" {
		t.Fatalf("expected trimmed content type, got %q", created.AttachmentsSummary[0].ContentType)
	}
}

func TestServiceCreateRejectsInvalidAttachment(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)

	_, err := service.Create(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		Subject:   "Hello",
		TextBody:  "Body",
		Attachments: []model.SubmissionAttachmentSummary{{
			Filename:    "payload.exe",
			ContentType: "application/octet-stream",
			SizeBytes:   -1,
		}},
	})
	if !errors.Is(err, ErrInvalidAttachment) {
		t.Fatalf("expected ErrInvalidAttachment, got %v", err)
	}
}

func TestServiceCreateRejectsTooManyAttachments(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)

	attachments := make([]model.SubmissionAttachmentSummary, 11)
	for i := range attachments {
		attachments[i] = model.SubmissionAttachmentSummary{
			Filename:    "note.txt",
			ContentType: "text/plain",
			SizeBytes:   1,
		}
	}

	_, err := service.Create(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}, model.CreateSubmissionInput{
		ChannelID:   "channel-1",
		Subject:     "Hello",
		TextBody:    "Body",
		Attachments: attachments,
	})
	if !errors.Is(err, ErrTooManyAttachments) {
		t.Fatalf("expected ErrTooManyAttachments, got %v", err)
	}
}

func TestServiceCreateFromPublicAPIStoresSanitizedSubmissionAndAudit(t *testing.T) {
	repo := NewMemoryRepository()
	auditStore := audit.NewMemoryStore()
	service := NewWorkflowService(repo, sanitizer.NewService(), audit.NewService(auditStore))
	service.now = func() time.Time {
		return time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC)
	}

	created, err := service.CreateFromPublicAPI(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		Subject:   " Hello ",
		TextBody:  " Body ",
		Attachments: []model.SubmissionAttachmentSummary{{
			Filename:    "note.txt",
			ContentType: "text/plain",
			SizeBytes:   4,
		}},
	})
	if err != nil {
		t.Fatalf("CreateFromPublicAPI() error = %v", err)
	}

	if created.Status != model.SubmissionStatusSanitized {
		t.Fatalf("expected sanitized status, got %s", created.Status)
	}

	events, err := service.audit.ListByTenant(context.Background(), "tenant-1")
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 audit event, got %d", len(events))
	}
	if events[0].EventType != "submission_created" {
		t.Fatalf("expected submission_created event, got %s", events[0].EventType)
	}
	if events[0].Metadata["submission_status"] != string(model.SubmissionStatusSanitized) {
		t.Fatalf("expected sanitized metadata, got %+v", events[0].Metadata)
	}
	if events[0].Metadata["sanitizer_profile"] != "standard" {
		t.Fatalf("expected standard sanitizer profile metadata, got %+v", events[0].Metadata)
	}
}

func TestServiceCreateFromPublicAPIStrictProfileBlocksRecipientsAndAttachments(t *testing.T) {
	repo := NewMemoryRepository()
	auditStore := audit.NewMemoryStore()
	service := NewWorkflowService(repo, sanitizer.NewService(), audit.NewService(auditStore))

	created, err := service.CreateFromPublicAPI(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}, model.CreateSubmissionInput{
		ChannelID:        "channel-1",
		SanitizerProfile: "strict",
		Subject:          "Hello",
		TextBody:         "Body",
		To:               []string{"recipient@example.com"},
		Attachments: []model.SubmissionAttachmentSummary{{
			Filename:    "note.txt",
			ContentType: "text/plain",
			SizeBytes:   4,
		}},
	})
	if err != nil {
		t.Fatalf("CreateFromPublicAPI() error = %v", err)
	}
	if created.Status != model.SubmissionStatusBlocked {
		t.Fatalf("expected blocked status, got %s", created.Status)
	}
	if created.MetadataProfile != "minimized_strict" {
		t.Fatalf("expected strict metadata profile, got %s", created.MetadataProfile)
	}

	events, err := service.audit.ListByTenant(context.Background(), "tenant-1")
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 audit event, got %d", len(events))
	}
	if events[0].Metadata["sanitizer_profile"] != "strict" {
		t.Fatalf("expected strict sanitizer profile metadata, got %+v", events[0].Metadata)
	}
}

func TestServiceCreateFromPublicAPIRejectsInvalidSanitizerProfile(t *testing.T) {
	service := NewWorkflowService(NewMemoryRepository(), sanitizer.NewService(), audit.NewService(audit.NewMemoryStore()))

	_, err := service.CreateFromPublicAPI(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}, model.CreateSubmissionInput{
		ChannelID:        "channel-1",
		SanitizerProfile: "paranoid",
		Subject:          "Hello",
		TextBody:         "Body",
	})
	if !errors.Is(err, ErrInvalidSanitizerProfile) {
		t.Fatalf("expected ErrInvalidSanitizerProfile, got %v", err)
	}
}

func TestServiceGetByIDReturnsStoredSubmission(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	created, err := service.Create(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		Subject:   "Hello",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	stored, err := service.GetByID(context.Background(), created.ID)
	if err != nil {
		t.Fatalf("GetByID() error = %v", err)
	}
	if stored.ID != created.ID {
		t.Fatalf("expected submission %s, got %s", created.ID, stored.ID)
	}
}

func TestServiceListForActorReturnsTenantSubmissions(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)

	actorA := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	actorB := model.Actor{ID: "user-2", TenantID: "tenant-2"}

	if _, err := service.Create(context.Background(), actorA, model.CreateSubmissionInput{ChannelID: "channel-1", Subject: "A", TextBody: "A"}); err != nil {
		t.Fatalf("Create() actorA error = %v", err)
	}
	if _, err := service.Create(context.Background(), actorB, model.CreateSubmissionInput{ChannelID: "channel-2", Subject: "B", TextBody: "B"}); err != nil {
		t.Fatalf("Create() actorB error = %v", err)
	}

	list, err := service.ListForActor(context.Background(), actorA)
	if err != nil {
		t.Fatalf("ListForActor() error = %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 submission for tenant-1, got %d", len(list))
	}
	if list[0].TenantID != "tenant-1" {
		t.Fatalf("expected tenant-1 submission, got %s", list[0].TenantID)
	}
}

func TestServiceListForActorPrunesOldTerminalSubmissionsPastRetention(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewWorkflowServiceWithRetention(repo, sanitizer.NewService(), audit.NewService(audit.NewMemoryStore()), 24*time.Hour)
	service.now = func() time.Time {
		return time.Date(2026, time.April, 5, 12, 0, 0, 0, time.UTC)
	}

	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	for _, item := range []model.Submission{
		{
			ID:        "sub_old_relayed",
			TenantID:  actor.TenantID,
			ChannelID: "channel-1",
			Status:    model.SubmissionStatusRelayed,
			CreatedAt: time.Date(2026, time.April, 3, 11, 0, 0, 0, time.UTC),
		},
		{
			ID:        "sub_old_blocked",
			TenantID:  actor.TenantID,
			ChannelID: "channel-1",
			Status:    model.SubmissionStatusBlocked,
			CreatedAt: time.Date(2026, time.April, 3, 10, 0, 0, 0, time.UTC),
		},
		{
			ID:        "sub_old_failed",
			TenantID:  actor.TenantID,
			ChannelID: "channel-1",
			Status:    model.SubmissionStatusFailed,
			CreatedAt: time.Date(2026, time.April, 3, 9, 30, 0, 0, time.UTC),
		},
		{
			ID:        "sub_active_sanitized",
			TenantID:  actor.TenantID,
			ChannelID: "channel-1",
			Status:    model.SubmissionStatusSanitized,
			CreatedAt: time.Date(2026, time.April, 3, 9, 0, 0, 0, time.UTC),
		},
		{
			ID:        "sub_recent_relayed",
			TenantID:  actor.TenantID,
			ChannelID: "channel-1",
			Status:    model.SubmissionStatusRelayed,
			CreatedAt: time.Date(2026, time.April, 5, 11, 0, 0, 0, time.UTC),
		},
	} {
		if err := repo.Save(context.Background(), item); err != nil {
			t.Fatalf("Save() error = %v", err)
		}
	}

	list, err := service.ListForActor(context.Background(), actor)
	if err != nil {
		t.Fatalf("ListForActor() error = %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 retained submissions, got %d", len(list))
	}

	stored, err := repo.ListByTenant(context.Background(), actor.TenantID)
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(stored) != 2 {
		t.Fatalf("expected 2 physically retained submissions, got %d", len(stored))
	}
}

func TestServiceMarkRelayedUpdatesSubmissionProvenance(t *testing.T) {
	repo := NewMemoryRepository()
	auditStore := audit.NewMemoryStore()
	service := NewWorkflowService(repo, sanitizer.NewService(), audit.NewService(auditStore))
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	created, err := service.Create(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		Subject:   "Hello",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	relayedAt := time.Date(2026, time.April, 3, 13, 0, 0, 0, time.UTC)
	updated, err := service.MarkRelayed(context.Background(), created.ID, "smtp", "rly_123", "messages_compat", relayedAt)
	if err != nil {
		t.Fatalf("MarkRelayed() error = %v", err)
	}

	if updated.Status != model.SubmissionStatusRelayed {
		t.Fatalf("expected relayed status, got %s", updated.Status)
	}
	if updated.RelayProvider != "smtp" {
		t.Fatalf("expected smtp relay provider, got %s", updated.RelayProvider)
	}
	if updated.RelayAttemptID != "rly_123" {
		t.Fatalf("expected relay attempt id rly_123, got %s", updated.RelayAttemptID)
	}
	if updated.SourcePath != "messages_compat" {
		t.Fatalf("expected source path messages_compat, got %s", updated.SourcePath)
	}
	if updated.RelayedAt != relayedAt {
		t.Fatalf("expected relayed_at %v, got %v", relayedAt, updated.RelayedAt)
	}

	events, err := service.audit.ListByTenant(context.Background(), actor.TenantID)
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(events) != 1 || events[0].EventType != "submission_relayed" {
		t.Fatalf("expected submission_relayed audit event, got %+v", events)
	}
}

func TestServiceMarkRelayFailedUpdatesSubmissionFailureStateAndAudit(t *testing.T) {
	repo := NewMemoryRepository()
	auditStore := audit.NewMemoryStore()
	service := NewWorkflowService(repo, sanitizer.NewService(), audit.NewService(auditStore))
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	created, err := service.Create(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		Subject:   "Hello",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	failedAt := time.Date(2026, time.April, 3, 13, 5, 0, 0, time.UTC)
	updated, err := service.MarkRelayFailed(context.Background(), created.ID, "rly_failed", "smtp", "messages_compat", "delivery_failed", "terminal", "upstream transport error", failedAt)
	if err != nil {
		t.Fatalf("MarkRelayFailed() error = %v", err)
	}

	if updated.Status != model.SubmissionStatusFailed {
		t.Fatalf("expected failed status, got %s", updated.Status)
	}
	if updated.RelayProvider != "smtp" {
		t.Fatalf("expected smtp relay provider, got %s", updated.RelayProvider)
	}
	if updated.RelayFailureClass != "delivery_failed" {
		t.Fatalf("expected delivery_failed class, got %s", updated.RelayFailureClass)
	}
	if updated.RelayAttemptID != "rly_failed" {
		t.Fatalf("expected relay attempt id rly_failed, got %s", updated.RelayAttemptID)
	}
	if updated.RelayFailureDisposition != "terminal" {
		t.Fatalf("expected terminal failure disposition, got %s", updated.RelayFailureDisposition)
	}
	if updated.RelayFailureReason != "upstream transport error" {
		t.Fatalf("expected relay failure reason, got %q", updated.RelayFailureReason)
	}
	if updated.SourcePath != "messages_compat" {
		t.Fatalf("expected source path messages_compat, got %s", updated.SourcePath)
	}
	if updated.FailedAt != failedAt {
		t.Fatalf("expected failed_at %v, got %v", failedAt, updated.FailedAt)
	}

	events, err := service.audit.ListByTenant(context.Background(), actor.TenantID)
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(events) != 1 || events[0].EventType != "submission_relay_failed" {
		t.Fatalf("expected submission_relay_failed audit event, got %+v", events)
	}
}

func TestCanQueueSubmissionReturnsFalseForRelayedStatus(t *testing.T) {
	record := model.Submission{Status: model.SubmissionStatusRelayed}
	if canQueueSubmission(record) {
		t.Fatal("expected canQueueSubmission to return false for relayed status")
	}
}

func TestCanQueueSubmissionReturnsFalseForBlockedStatus(t *testing.T) {
	record := model.Submission{Status: model.SubmissionStatusBlocked}
	if canQueueSubmission(record) {
		t.Fatal("expected canQueueSubmission to return false for blocked status")
	}
}

func TestCanQueueSubmissionReturnsTrueForRetryableFailure(t *testing.T) {
	record := model.Submission{
		Status:                  model.SubmissionStatusFailed,
		RelayFailureDisposition: "retryable",
	}
	if !canQueueSubmission(record) {
		t.Fatal("expected canQueueSubmission to return true for retryable failed submission")
	}
}

func TestCanQueueSubmissionReturnsFalseForTerminalFailure(t *testing.T) {
	record := model.Submission{
		Status:                  model.SubmissionStatusFailed,
		RelayFailureDisposition: "terminal",
	}
	if canQueueSubmission(record) {
		t.Fatal("expected canQueueSubmission to return false for terminal failed submission")
	}
}

func TestQueueForRelayReturnsErrCannotQueueForNonQueueableStatus(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	created, err := service.Create(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		Subject:   "Hello",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	// Mark as relayed so it's no longer queueable.
	if err := repo.Save(context.Background(), model.Submission{
		ID:       created.ID,
		TenantID: actor.TenantID,
		Status:   model.SubmissionStatusRelayed,
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	_, err = service.QueueForRelay(context.Background(), created.ID, "path")
	if !errors.Is(err, ErrCannotQueue) {
		t.Fatalf("expected ErrCannotQueue, got %v", err)
	}
}

func TestQueueForRelaySucceedsForRetryableFailedSubmission(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	created, err := service.Create(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		Subject:   "Hello",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	// Seed a retryable failed state.
	if err := repo.Save(context.Background(), model.Submission{
		ID:                      created.ID,
		TenantID:                actor.TenantID,
		ChannelID:               "channel-1",
		Status:                  model.SubmissionStatusFailed,
		RelayFailureDisposition: "retryable",
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	queued, err := service.QueueForRelay(context.Background(), created.ID, "retry_path")
	if err != nil {
		t.Fatalf("QueueForRelay() error = %v", err)
	}
	if queued.Status != model.SubmissionStatusQueued {
		t.Fatalf("expected queued status, got %s", queued.Status)
	}
}

func TestQueueForRelayNotFound(t *testing.T) {
	service := NewService(NewMemoryRepository())
	_, err := service.QueueForRelay(context.Background(), "sub_missing", "path")
	if !errors.Is(err, ErrSubmissionNotFound) {
		t.Fatalf("expected ErrSubmissionNotFound, got %v", err)
	}
}

func TestReleaseToRelayReturnsErrCannotReleaseForNonQueuedStatus(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	created, err := service.Create(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		Subject:   "Hello",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	// Status is accepted, not queued — release must fail.
	_, err = service.ReleaseToRelay(context.Background(), created.ID, "path")
	if !errors.Is(err, ErrCannotRelease) {
		t.Fatalf("expected ErrCannotRelease, got %v", err)
	}
}

func TestReleaseToRelayNotFound(t *testing.T) {
	service := NewService(NewMemoryRepository())
	_, err := service.ReleaseToRelay(context.Background(), "sub_missing", "path")
	if !errors.Is(err, ErrSubmissionNotFound) {
		t.Fatalf("expected ErrSubmissionNotFound, got %v", err)
	}
}

func TestCreateReturnsPruneError(t *testing.T) {
	repo := &failingPruneRepo{inner: NewMemoryRepository(), pruneErr: errors.New("prune failed")}
	service := NewWorkflowServiceWithRetention(repo, nil, nil, 24*time.Hour)

	_, err := service.Create(context.Background(), model.Actor{ID: "u", TenantID: "t"}, model.CreateSubmissionInput{
		ChannelID: "c",
		Subject:   "S",
		TextBody:  "B",
	})
	if err == nil || err.Error() != "prune failed" {
		t.Fatalf("expected prune error, got %v", err)
	}
}

func TestGetByIDReturnsPruneError(t *testing.T) {
	repo := &failingPruneRepo{inner: NewMemoryRepository(), pruneErr: errors.New("prune fail")}
	service := NewWorkflowServiceWithRetention(repo, nil, nil, 24*time.Hour)

	_, err := service.GetByID(context.Background(), "sub_x")
	if err == nil || err.Error() != "prune fail" {
		t.Fatalf("expected prune error, got %v", err)
	}
}

func TestListForActorReturnsPruneError(t *testing.T) {
	repo := &failingPruneRepo{inner: NewMemoryRepository(), pruneErr: errors.New("prune fail")}
	service := NewWorkflowServiceWithRetention(repo, nil, nil, 24*time.Hour)

	_, err := service.ListForActor(context.Background(), model.Actor{TenantID: "t"})
	if err == nil || err.Error() != "prune fail" {
		t.Fatalf("expected prune error, got %v", err)
	}
}

func TestNormalizeFailureDispositionRetryable(t *testing.T) {
	if got := normalizeFailureDisposition("retryable"); got != "retryable" {
		t.Fatalf("expected retryable, got %s", got)
	}
}

func TestNormalizeFailureDispositionTerminal(t *testing.T) {
	if got := normalizeFailureDisposition("terminal"); got != "terminal" {
		t.Fatalf("expected terminal, got %s", got)
	}
}

func TestNormalizeFailureDispositionUnknownBecomesTerminal(t *testing.T) {
	if got := normalizeFailureDisposition("unknown"); got != "terminal" {
		t.Fatalf("expected terminal for unknown disposition, got %s", got)
	}
}

func TestNormalizeFailureFieldReplacesNewlines(t *testing.T) {
	input := "error\r\ninjected"
	got := normalizeFailureField(input)
	if got != "error  injected" {
		t.Fatalf("expected newlines replaced, got %q", got)
	}
}

func TestMarkRelayedNotFound(t *testing.T) {
	service := NewService(NewMemoryRepository())
	_, err := service.MarkRelayed(context.Background(), "sub_missing", "smtp", "rly_1", "path", time.Now())
	if !errors.Is(err, ErrSubmissionNotFound) {
		t.Fatalf("expected ErrSubmissionNotFound, got %v", err)
	}
}

func TestMarkRelayFailedNotFound(t *testing.T) {
	service := NewService(NewMemoryRepository())
	_, err := service.MarkRelayFailed(context.Background(), "sub_missing", "rly_1", "smtp", "path", "class", "terminal", "reason", time.Now())
	if !errors.Is(err, ErrSubmissionNotFound) {
		t.Fatalf("expected ErrSubmissionNotFound, got %v", err)
	}
}

func TestMarkRelayFailedSetsDeliveryBoundaryWhenEmpty(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	created, err := service.Create(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		Subject:   "Hello",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	updated, err := service.MarkRelayFailed(context.Background(), created.ID, "rly_1", "smtp", "path", "delivery_failed", "terminal", "upstream error", time.Now())
	if err != nil {
		t.Fatalf("MarkRelayFailed() error = %v", err)
	}
	if updated.DeliveryBoundary != "internal_store_and_forward" {
		t.Fatalf("expected internal_store_and_forward, got %s", updated.DeliveryBoundary)
	}
}

// failingPruneRepo wraps MemoryRepository and returns a fixed error from PruneBefore.
type failingPruneRepo struct {
	inner    *MemoryRepository
	pruneErr error
}

func (r *failingPruneRepo) Save(ctx context.Context, s model.Submission) error {
	return r.inner.Save(ctx, s)
}

func (r *failingPruneRepo) GetByID(ctx context.Context, id string) (model.Submission, error) {
	return r.inner.GetByID(ctx, id)
}

func (r *failingPruneRepo) ListByTenant(ctx context.Context, tenantID string) ([]model.Submission, error) {
	return r.inner.ListByTenant(ctx, tenantID)
}

func (r *failingPruneRepo) PruneBefore(_ context.Context, _ time.Time) error {
	return r.pruneErr
}

func TestServiceQueueAndReleaseSubmissionLifecycle(t *testing.T) {
	repo := NewMemoryRepository()
	auditStore := audit.NewMemoryStore()
	service := NewWorkflowService(repo, sanitizer.NewService(), audit.NewService(auditStore))
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	created, err := service.CreateFromPublicAPI(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: "channel-1",
		Subject:   "Hello",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("CreateFromPublicAPI() error = %v", err)
	}

	queued, err := service.QueueForRelay(context.Background(), created.ID, "manual_queue")
	if err != nil {
		t.Fatalf("QueueForRelay() error = %v", err)
	}
	if queued.Status != model.SubmissionStatusQueued {
		t.Fatalf("expected queued status, got %s", queued.Status)
	}
	if queued.SourcePath != "manual_queue" {
		t.Fatalf("expected source path manual_queue, got %s", queued.SourcePath)
	}
	if queued.DeliveryBoundary != "internal_store_and_forward" {
		t.Fatalf("expected internal store-and-forward boundary, got %s", queued.DeliveryBoundary)
	}

	released, err := service.ReleaseToRelay(context.Background(), created.ID, "manual_release")
	if err != nil {
		t.Fatalf("ReleaseToRelay() error = %v", err)
	}
	if released.Status != model.SubmissionStatusSanitized {
		t.Fatalf("expected sanitized status, got %s", released.Status)
	}
	if released.SourcePath != "manual_release" {
		t.Fatalf("expected source path manual_release, got %s", released.SourcePath)
	}
	if released.DeliveryBoundary != "internal_store_and_forward" {
		t.Fatalf("expected internal store-and-forward boundary, got %s", released.DeliveryBoundary)
	}

	events, err := service.audit.ListByTenant(context.Background(), actor.TenantID)
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("expected 3 audit events, got %+v", events)
	}
	if events[1].EventType != "submission_queued" {
		t.Fatalf("expected submission_queued event, got %+v", events)
	}
	if events[2].EventType != "submission_released" {
		t.Fatalf("expected submission_released event, got %+v", events)
	}
}
