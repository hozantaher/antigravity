package relay

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"privacy-gateway/internal/mail"
	"privacy-gateway/internal/model"
)

type Service struct {
	gateway   mail.Gateway
	repo      Repository
	now       func() time.Time
	provider  string
	retention time.Duration
}

func NewService(gateway mail.Gateway, provider string) *Service {
	return NewServiceWithRepository(gateway, provider, nil)
}

func NewServiceWithRepository(gateway mail.Gateway, provider string, repo Repository) *Service {
	return &Service{
		gateway:  gateway,
		repo:     repo,
		now:      time.Now,
		provider: provider,
	}
}

func NewServiceWithRetention(gateway mail.Gateway, provider string, repo Repository, retention time.Duration) *Service {
	return &Service{
		gateway:   gateway,
		repo:      repo,
		now:       time.Now,
		provider:  provider,
		retention: retention,
	}
}

func (s *Service) Relay(ctx context.Context, submissionID string, msg model.SanitizedMessage) (model.RelayAttempt, model.MessageRecord, error) {
	s.pruneExpired(ctx)

	record, err := s.gateway.Send(ctx, msg)
	if err != nil {
		return model.RelayAttempt{}, model.MessageRecord{}, err
	}

	id, err := relayAttemptID()
	if err != nil {
		return model.RelayAttempt{}, model.MessageRecord{}, err
	}

	attempt := model.RelayAttempt{
		TenantID:     msg.Actor.TenantID,
		ActorID:      msg.Actor.ID,
		ID:           id,
		SubmissionID: submissionID,
		AliasID:      msg.Alias.ID,
		Provider:     s.provider,
		DeliveryBoundary: "trusted_delivery_boundary",
		Status:       "sent",
		CreatedAt:    s.now().UTC(),
	}
	if s.repo != nil {
		if err := s.repo.Save(ctx, attempt); err != nil {
			return model.RelayAttempt{}, model.MessageRecord{}, err
		}
	}

	return attempt, record, nil
}

func (s *Service) RecordFailure(ctx context.Context, submissionID string, msg model.SanitizedMessage, failureClass, failureDisposition, failureReason string) (model.RelayAttempt, error) {
	id, err := relayAttemptID()
	if err != nil {
		return model.RelayAttempt{}, err
	}

	attempt := model.RelayAttempt{
		TenantID:            msg.Actor.TenantID,
		ActorID:             msg.Actor.ID,
		ID:                  id,
		SubmissionID:        submissionID,
		AliasID:             msg.Alias.ID,
		Provider:            s.provider,
		DeliveryBoundary:    "internal_store_and_forward",
		Status:              "failed",
		FailureClass:        failureClass,
		FailureDisposition:  failureDisposition,
		FailureReason:       failureReason,
		CreatedAt:           s.now().UTC(),
	}
	if s.repo != nil {
		if err := s.repo.Save(ctx, attempt); err != nil {
			return model.RelayAttempt{}, err
		}
	}
	return attempt, nil
}

func (s *Service) ListByActor(ctx context.Context, actor model.Actor) ([]model.MessageRecord, error) {
	return s.gateway.ListByActor(ctx, actor)
}

func (s *Service) ListAttemptsByActor(ctx context.Context, actor model.Actor) ([]model.RelayAttempt, error) {
	if s.repo == nil {
		return nil, nil
	}
	return s.repo.ListByTenant(ctx, actor.TenantID)
}

func (s *Service) GetAttemptByID(ctx context.Context, actor model.Actor, id string) (model.RelayAttempt, error) {
	if s.repo == nil {
		return model.RelayAttempt{}, ErrRelayAttemptNotFound
	}
	attempt, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return model.RelayAttempt{}, err
	}
	if attempt.TenantID != actor.TenantID {
		return model.RelayAttempt{}, ErrRelayAttemptNotFound
	}
	return attempt, nil
}

func (s *Service) Provider() string {
	return s.provider
}

func (s *Service) pruneExpired(ctx context.Context) {
	if s.retention <= 0 || s.repo == nil {
		return
	}
	_ = s.repo.PruneBefore(ctx, s.now().UTC().Add(-s.retention))
}

func relayAttemptID() (string, error) {
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "rly_" + hex.EncodeToString(buf), nil
}
