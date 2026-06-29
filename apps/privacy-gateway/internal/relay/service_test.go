package relay

import (
	"context"
	"errors"
	"testing"
	"time"

	"privacy-gateway/internal/mail"
	"privacy-gateway/internal/model"
)

func TestRelaySendsMessageAndReturnsAttempt(t *testing.T) {
	gateway := mail.NewRecordedGateway()
	service := NewServiceWithRepository(gateway, "smtp", NewMemoryRepository())
	service.now = func() time.Time {
		return time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC)
	}

	attempt, record, err := service.Relay(context.Background(), "sub_1", model.SanitizedMessage{
		Actor:    model.Actor{ID: "user-1", TenantID: "tenant-1"},
		Alias:    model.Alias{ID: "alias-1", Email: "support@relay.example"},
		To:       []string{"recipient@example.com"},
		Subject:  "Hello",
		TextBody: "Body",
	})
	if err != nil {
		t.Fatalf("Relay() error = %v", err)
	}

	if attempt.ID == "" {
		t.Fatal("expected attempt id")
	}
	if attempt.SubmissionID != "sub_1" {
		t.Fatalf("expected submission id sub_1, got %s", attempt.SubmissionID)
	}
	if attempt.TenantID != "tenant-1" {
		t.Fatalf("expected tenant-1, got %s", attempt.TenantID)
	}
	if attempt.Status != "sent" {
		t.Fatalf("expected sent status, got %s", attempt.Status)
	}
	if record.Subject != "Hello" {
		t.Fatalf("expected relay record subject Hello, got %s", record.Subject)
	}
}

func TestRelayListByActorDelegatesToGateway(t *testing.T) {
	gateway := mail.NewRecordedGateway()
	service := NewServiceWithRepository(gateway, "smtp", NewMemoryRepository())
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	if _, _, err := service.Relay(context.Background(), "sub_1", model.SanitizedMessage{
		Actor:    actor,
		Alias:    model.Alias{ID: "alias-1", Email: "support@relay.example"},
		To:       []string{"recipient@example.com"},
		Subject:  "Hello",
		TextBody: "Body",
	}); err != nil {
		t.Fatalf("Relay() error = %v", err)
	}

	records, err := service.ListByActor(context.Background(), actor)
	if err != nil {
		t.Fatalf("ListByActor() error = %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("expected 1 record, got %d", len(records))
	}
}

func TestNewServiceCreatesServiceWithNilRepo(t *testing.T) {
	gateway := mail.NewRecordedGateway()
	svc := NewService(gateway, "smtp")
	if svc == nil {
		t.Fatal("expected non-nil service")
	}
	if svc.Provider() != "smtp" {
		t.Fatalf("expected provider smtp, got %s", svc.Provider())
	}
	if svc.repo != nil {
		t.Fatal("expected nil repo")
	}
}

func TestNewServiceWithRetentionSetsRetention(t *testing.T) {
	gateway := mail.NewRecordedGateway()
	repo := NewMemoryRepository()
	retention := 48 * time.Hour
	svc := NewServiceWithRetention(gateway, "smtp", repo, retention)
	if svc == nil {
		t.Fatal("expected non-nil service")
	}
	if svc.retention != retention {
		t.Fatalf("expected retention %v, got %v", retention, svc.retention)
	}
	if svc.provider != "smtp" {
		t.Fatalf("expected provider smtp, got %s", svc.provider)
	}
}

func TestProviderReturnsConfiguredProvider(t *testing.T) {
	svc := NewService(mail.NewRecordedGateway(), "sendgrid")
	if svc.Provider() != "sendgrid" {
		t.Fatalf("expected sendgrid, got %s", svc.Provider())
	}
}

func TestRelayWithNilRepoSkipsSave(t *testing.T) {
	gateway := mail.NewRecordedGateway()
	// NewService creates a service with nil repo — relay must still succeed.
	svc := NewService(gateway, "smtp")

	attempt, record, err := svc.Relay(context.Background(), "sub_1", model.SanitizedMessage{
		Actor:    model.Actor{ID: "user-1", TenantID: "tenant-1"},
		Alias:    model.Alias{ID: "alias-1", Email: "support@relay.example"},
		To:       []string{"recipient@example.com"},
		Subject:  "Hello",
		TextBody: "Body",
	})
	if err != nil {
		t.Fatalf("Relay() error = %v", err)
	}
	if attempt.Status != "sent" {
		t.Fatalf("expected sent, got %s", attempt.Status)
	}
	if record.Subject != "Hello" {
		t.Fatalf("expected Hello, got %s", record.Subject)
	}
}

func TestRecordFailureWithNilRepoSkipsSave(t *testing.T) {
	svc := NewService(mail.NewRecordedGateway(), "smtp")

	attempt, err := svc.RecordFailure(context.Background(), "sub_1", model.SanitizedMessage{
		Actor: model.Actor{ID: "user-1", TenantID: "tenant-1"},
		Alias: model.Alias{ID: "alias-1"},
	}, "timeout", "retryable", "dial timeout")
	if err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	if attempt.Status != "failed" {
		t.Fatalf("expected failed, got %s", attempt.Status)
	}
	if attempt.FailureClass != "timeout" {
		t.Fatalf("expected timeout, got %s", attempt.FailureClass)
	}
}

func TestListAttemptsByActorNilRepoReturnsNil(t *testing.T) {
	svc := NewService(mail.NewRecordedGateway(), "smtp")

	attempts, err := svc.ListAttemptsByActor(context.Background(), model.Actor{TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("ListAttemptsByActor() error = %v", err)
	}
	if attempts != nil {
		t.Fatalf("expected nil slice from nil repo, got %v", attempts)
	}
}

func TestListAttemptsByActorWithRepoReturnsTenantAttempts(t *testing.T) {
	repo := NewMemoryRepository()
	svc := NewServiceWithRepository(mail.NewRecordedGateway(), "smtp", repo)
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	if _, _, err := svc.Relay(context.Background(), "sub_1", model.SanitizedMessage{
		Actor:    actor,
		Alias:    model.Alias{ID: "alias-1", Email: "support@relay.example"},
		To:       []string{"r@example.com"},
		Subject:  "Hi",
		TextBody: "Body",
	}); err != nil {
		t.Fatalf("Relay() error = %v", err)
	}

	attempts, err := svc.ListAttemptsByActor(context.Background(), actor)
	if err != nil {
		t.Fatalf("ListAttemptsByActor() error = %v", err)
	}
	if len(attempts) != 1 {
		t.Fatalf("expected 1 attempt, got %d", len(attempts))
	}
	if attempts[0].TenantID != "tenant-1" {
		t.Fatalf("expected tenant-1, got %s", attempts[0].TenantID)
	}
}

func TestGetAttemptByIDNilRepoReturnsNotFound(t *testing.T) {
	svc := NewService(mail.NewRecordedGateway(), "smtp")

	_, err := svc.GetAttemptByID(context.Background(), model.Actor{TenantID: "tenant-1"}, "rly_123")
	if !errors.Is(err, ErrRelayAttemptNotFound) {
		t.Fatalf("expected ErrRelayAttemptNotFound, got %v", err)
	}
}

func TestGetAttemptByIDWrongTenantReturnsNotFound(t *testing.T) {
	repo := NewMemoryRepository()
	svc := NewServiceWithRepository(mail.NewRecordedGateway(), "smtp", repo)

	attempt, err := svc.RecordFailure(context.Background(), "sub_1", model.SanitizedMessage{
		Actor: model.Actor{ID: "user-1", TenantID: "tenant-1"},
		Alias: model.Alias{ID: "alias-1"},
	}, "timeout", "retryable", "dial timeout")
	if err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}

	// Different tenant should not see the attempt.
	_, err = svc.GetAttemptByID(context.Background(), model.Actor{TenantID: "tenant-other"}, attempt.ID)
	if !errors.Is(err, ErrRelayAttemptNotFound) {
		t.Fatalf("expected ErrRelayAttemptNotFound for wrong tenant, got %v", err)
	}
}

func TestPruneExpiredSkipsWhenRetentionZero(t *testing.T) {
	repo := NewMemoryRepository()
	// NewServiceWithRepository has zero retention — pruneExpired is a no-op.
	svc := NewServiceWithRepository(mail.NewRecordedGateway(), "smtp", repo)

	// Seed an old attempt directly in the repo.
	old := model.RelayAttempt{
		ID:        "rly_old",
		TenantID:  "tenant-1",
		ActorID:   "user-1",
		CreatedAt: time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC),
		Status:    "sent",
	}
	if err := repo.Save(context.Background(), old); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	// Relay triggers pruneExpired; with zero retention the old record must survive.
	svc.now = func() time.Time { return time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC) }
	_, _, err := svc.Relay(context.Background(), "sub_new", model.SanitizedMessage{
		Actor:    model.Actor{ID: "user-1", TenantID: "tenant-1"},
		Alias:    model.Alias{ID: "alias-1", Email: "support@relay.example"},
		To:       []string{"r@example.com"},
		Subject:  "Hi",
		TextBody: "Body",
	})
	if err != nil {
		t.Fatalf("Relay() error = %v", err)
	}

	// old attempt must still be present.
	if _, err := repo.GetByID(context.Background(), "rly_old"); err != nil {
		t.Fatalf("expected old attempt to survive zero-retention prune, got %v", err)
	}
}

func TestPruneExpiredRemovesOldAttemptsWhenRetentionSet(t *testing.T) {
	repo := NewMemoryRepository()
	svc := NewServiceWithRetention(mail.NewRecordedGateway(), "smtp", repo, 24*time.Hour)
	svc.now = func() time.Time { return time.Date(2026, 4, 5, 12, 0, 0, 0, time.UTC) }

	old := model.RelayAttempt{
		ID:        "rly_old",
		TenantID:  "tenant-1",
		ActorID:   "user-1",
		CreatedAt: time.Date(2026, 4, 3, 0, 0, 0, 0, time.UTC), // > 24h ago
		Status:    "sent",
	}
	if err := repo.Save(context.Background(), old); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	// Relay triggers pruneExpired.
	if _, _, err := svc.Relay(context.Background(), "sub_new", model.SanitizedMessage{
		Actor:    model.Actor{ID: "user-1", TenantID: "tenant-1"},
		Alias:    model.Alias{ID: "alias-1", Email: "support@relay.example"},
		To:       []string{"r@example.com"},
		Subject:  "Hi",
		TextBody: "Body",
	}); err != nil {
		t.Fatalf("Relay() error = %v", err)
	}

	// old attempt must have been pruned.
	if _, err := repo.GetByID(context.Background(), "rly_old"); !errors.Is(err, ErrRelayAttemptNotFound) {
		t.Fatalf("expected old attempt to be pruned, got err=%v", err)
	}
}

func TestMemoryRepositoryPruneBeforeRemovesOldAttempts(t *testing.T) {
	repo := NewMemoryRepository()
	cutoff := time.Date(2026, 4, 4, 0, 0, 0, 0, time.UTC)

	old := model.RelayAttempt{
		ID:        "rly_old",
		TenantID:  "t1",
		CreatedAt: time.Date(2026, 4, 3, 0, 0, 0, 0, time.UTC),
	}
	recent := model.RelayAttempt{
		ID:        "rly_new",
		TenantID:  "t1",
		CreatedAt: time.Date(2026, 4, 5, 0, 0, 0, 0, time.UTC),
	}
	if err := repo.Save(context.Background(), old); err != nil {
		t.Fatalf("Save old: %v", err)
	}
	if err := repo.Save(context.Background(), recent); err != nil {
		t.Fatalf("Save recent: %v", err)
	}

	if err := repo.PruneBefore(context.Background(), cutoff); err != nil {
		t.Fatalf("PruneBefore() error = %v", err)
	}

	if _, err := repo.GetByID(context.Background(), "rly_old"); !errors.Is(err, ErrRelayAttemptNotFound) {
		t.Fatalf("expected old attempt pruned, got err=%v", err)
	}
	if _, err := repo.GetByID(context.Background(), "rly_new"); err != nil {
		t.Fatalf("expected recent attempt retained, got err=%v", err)
	}
}

func TestMemoryRepositoryGetByIDNotFound(t *testing.T) {
	repo := NewMemoryRepository()
	_, err := repo.GetByID(context.Background(), "rly_missing")
	if !errors.Is(err, ErrRelayAttemptNotFound) {
		t.Fatalf("expected ErrRelayAttemptNotFound, got %v", err)
	}
}

func TestRelayRecordFailureStoresFailedAttempt(t *testing.T) {
	service := NewServiceWithRepository(mail.NewRecordedGateway(), "smtp", NewMemoryRepository())
	service.now = func() time.Time {
		return time.Date(2026, time.April, 3, 12, 5, 0, 0, time.UTC)
	}

	attempt, err := service.RecordFailure(context.Background(), "sub_1", model.SanitizedMessage{
		Actor:   model.Actor{ID: "user-1", TenantID: "tenant-1"},
		Alias:   model.Alias{ID: "alias-1", Email: "support@relay.example"},
		To:      []string{"recipient@example.com"},
		Subject: "Hello",
	}, "timeout", "retryable", "dial tcp timeout")
	if err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}

	if attempt.Status != "failed" {
		t.Fatalf("expected failed status, got %s", attempt.Status)
	}
	if attempt.FailureDisposition != "retryable" {
		t.Fatalf("expected retryable disposition, got %s", attempt.FailureDisposition)
	}

	stored, err := service.GetAttemptByID(context.Background(), model.Actor{TenantID: "tenant-1"}, attempt.ID)
	if err != nil {
		t.Fatalf("GetAttemptByID() error = %v", err)
	}
	if stored.FailureClass != "timeout" {
		t.Fatalf("expected timeout class, got %s", stored.FailureClass)
	}
}
