package identityvault

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	netmail "net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"privacy-gateway/internal/model"
)

var (
	ErrAliasIDRequired         = errors.New("alias_id is required")
	ErrRealIdentityRefRequired = errors.New("real_identity_ref is required")
	ErrInvalidRealIdentityRef  = errors.New("real_identity_ref is invalid")
	ErrInvalidPurpose          = errors.New("purpose contains invalid UTF-8")
	ErrExpiresAtInPast         = errors.New("expires_at must be in the future")
	ErrIdentityLinkRevoked     = errors.New("identity link is revoked")
)

type Service struct {
	repo      Repository
	now       func() time.Time
	retention time.Duration
}

func NewService(repo Repository) *Service {
	return &Service{
		repo: repo,
		now:  time.Now,
	}
}

func NewServiceWithRetention(repo Repository, retention time.Duration) *Service {
	service := NewService(repo)
	service.retention = retention
	return service
}

func (s *Service) CreateLink(ctx context.Context, actor model.Actor, aliasID, realIdentityRef, purpose string, expiresAt time.Time) (model.IdentityLink, error) {
	if err := s.pruneInactive(ctx); err != nil {
		return model.IdentityLink{}, err
	}

	aliasID = strings.TrimSpace(aliasID)
	if aliasID == "" {
		return model.IdentityLink{}, ErrAliasIDRequired
	}

	realIdentityRef = strings.TrimSpace(realIdentityRef)
	if realIdentityRef == "" {
		return model.IdentityLink{}, ErrRealIdentityRefRequired
	}
	parsedAddress, err := netmail.ParseAddress(realIdentityRef)
	if err != nil {
		return model.IdentityLink{}, ErrInvalidRealIdentityRef
	}

	purpose = strings.TrimSpace(purpose)
	if !utf8.ValidString(purpose) || strings.ContainsAny(purpose, "\r\n") {
		return model.IdentityLink{}, ErrInvalidPurpose
	}
	if !expiresAt.IsZero() && expiresAt.UTC().Before(s.now().UTC()) {
		return model.IdentityLink{}, ErrExpiresAtInPast
	}

	id, err := identityLinkID()
	if err != nil {
		return model.IdentityLink{}, err
	}

	link := model.IdentityLink{
		ID:              id,
		TenantID:        actor.TenantID,
		AliasID:         aliasID,
		RealIdentityRef: strings.ToLower(parsedAddress.Address),
		Purpose:         purpose,
		CreatedAt:       s.now().UTC(),
		ExpiresAt:       expiresAt.UTC(),
	}

	if err := s.repo.Save(ctx, link); err != nil {
		return model.IdentityLink{}, err
	}
	return link, nil
}

func (s *Service) GetByAliasID(ctx context.Context, actor model.Actor, aliasID string) (model.IdentityLink, error) {
	if err := s.pruneInactive(ctx); err != nil {
		return model.IdentityLink{}, err
	}

	link, err := s.repo.GetByAliasID(ctx, actor.TenantID, strings.TrimSpace(aliasID))
	if err != nil {
		return model.IdentityLink{}, err
	}
	if !s.isActive(link) {
		return model.IdentityLink{}, ErrIdentityLinkNotFound
	}
	return link, nil
}

func (s *Service) ListForActor(ctx context.Context, actor model.Actor) ([]model.IdentityLink, error) {
	if err := s.pruneInactive(ctx); err != nil {
		return nil, err
	}

	links, err := s.repo.ListByTenant(ctx, actor.TenantID)
	if err != nil {
		return nil, err
	}

	filtered := make([]model.IdentityLink, 0, len(links))
	for _, link := range links {
		if !s.isActive(link) {
			continue
		}
		filtered = append(filtered, link)
	}
	return filtered, nil
}

func (s *Service) RevokeByAliasID(ctx context.Context, actor model.Actor, aliasID string) (model.IdentityLink, error) {
	if err := s.pruneInactive(ctx); err != nil {
		return model.IdentityLink{}, err
	}

	link, err := s.repo.GetByAliasID(ctx, actor.TenantID, strings.TrimSpace(aliasID))
	if err != nil {
		return model.IdentityLink{}, err
	}
	if !link.RevokedAt.IsZero() {
		return model.IdentityLink{}, ErrIdentityLinkRevoked
	}
	if s.isExpired(link) {
		return model.IdentityLink{}, ErrIdentityLinkNotFound
	}

	next := cloneIdentityLink(link)
	next.RevokedAt = s.now().UTC()
	if err := s.repo.Save(ctx, next); err != nil {
		return model.IdentityLink{}, err
	}
	return next, nil
}

func (s *Service) isActive(link model.IdentityLink) bool {
	return !s.isExpired(link) && !s.isRevoked(link)
}

func (s *Service) isExpired(link model.IdentityLink) bool {
	return !link.ExpiresAt.IsZero() && link.ExpiresAt.Before(s.now().UTC())
}

func (s *Service) isRevoked(link model.IdentityLink) bool {
	return !link.RevokedAt.IsZero()
}

func (s *Service) pruneInactive(ctx context.Context) error {
	if s.retention <= 0 {
		return nil
	}
	return s.repo.PruneInactiveBefore(ctx, s.now().UTC().Add(-s.retention))
}

func identityLinkID() (string, error) {
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "idl_" + hex.EncodeToString(buf), nil
}
