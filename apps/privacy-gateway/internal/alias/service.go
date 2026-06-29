package alias

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"privacy-gateway/internal/model"
)

var (
	ErrAliasNotFound  = errors.New("alias not found")
	ErrAliasForbidden = errors.New("alias does not belong to actor")
)

type Repository interface {
	Save(ctx context.Context, alias model.Alias) error
	GetByID(ctx context.Context, id string) (model.Alias, error)
	ListByOwner(ctx context.Context, tenantID, userID string) ([]model.Alias, error)
	PruneBefore(ctx context.Context, cutoff time.Time) error
}

type Service struct {
	repo      Repository
	domain    string
	now       func() time.Time
	retention time.Duration
}

func NewService(repo Repository, domain string) *Service {
	return &Service{
		repo:   repo,
		domain: strings.ToLower(strings.TrimSpace(domain)),
		now:    time.Now,
	}
}

func NewServiceWithRetention(repo Repository, domain string, retention time.Duration) *Service {
	return &Service{
		repo:      repo,
		domain:    strings.ToLower(strings.TrimSpace(domain)),
		now:       time.Now,
		retention: retention,
	}
}

func (s *Service) Create(ctx context.Context, actor model.Actor, input model.CreateAliasInput) (model.Alias, error) {
	s.pruneExpired(ctx)

	label := sanitizeLabel(input.Label)
	suffix, err := randomHex(4)
	if err != nil {
		return model.Alias{}, err
	}

	if label == "" {
		label = "alias"
	}

	id := fmt.Sprintf("al_%s", suffix)
	email := fmt.Sprintf("%s-%s@%s", label, suffix, s.domain)
	alias := model.Alias{
		ID:        id,
		UserID:    actor.ID,
		TenantID:  actor.TenantID,
		Email:     email,
		Label:     label,
		CreatedAt: s.now().UTC(),
	}

	if err := s.repo.Save(ctx, alias); err != nil {
		return model.Alias{}, err
	}

	return alias, nil
}

func (s *Service) ListForActor(ctx context.Context, actor model.Actor) ([]model.Alias, error) {
	return s.repo.ListByOwner(ctx, actor.TenantID, actor.ID)
}

func (s *Service) GetOwned(ctx context.Context, actor model.Actor, aliasID string) (model.Alias, error) {
	alias, err := s.repo.GetByID(ctx, aliasID)
	if err != nil {
		return model.Alias{}, err
	}
	if alias.UserID != actor.ID || alias.TenantID != actor.TenantID {
		return model.Alias{}, ErrAliasForbidden
	}
	return alias, nil
}

type MemoryRepository struct {
	mu      sync.RWMutex
	byID    map[string]model.Alias
	byOwner map[string][]string
}

func NewMemoryRepository() *MemoryRepository {
	return &MemoryRepository{
		byID:    make(map[string]model.Alias),
		byOwner: make(map[string][]string),
	}
}

func (r *MemoryRepository) Save(_ context.Context, alias model.Alias) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.byID[alias.ID]; !exists {
		key := ownerKey(alias.TenantID, alias.UserID)
		r.byOwner[key] = append(r.byOwner[key], alias.ID)
	}
	r.byID[alias.ID] = alias
	return nil
}

func (r *MemoryRepository) GetByID(_ context.Context, id string) (model.Alias, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	alias, ok := r.byID[id]
	if !ok {
		return model.Alias{}, ErrAliasNotFound
	}
	return alias, nil
}

func (r *MemoryRepository) ListByOwner(_ context.Context, tenantID, userID string) ([]model.Alias, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	ids := r.byOwner[ownerKey(tenantID, userID)]
	out := make([]model.Alias, 0, len(ids))
	for _, id := range ids {
		out = append(out, r.byID[id])
	}
	return out, nil
}

func (s *Service) pruneExpired(ctx context.Context) {
	if s.retention <= 0 {
		return
	}
	_ = s.repo.PruneBefore(ctx, s.now().UTC().Add(-s.retention))
}

func (r *MemoryRepository) PruneBefore(_ context.Context, cutoff time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	for id, a := range r.byID {
		if a.CreatedAt.Before(cutoff) {
			delete(r.byID, id)
			key := ownerKey(a.TenantID, a.UserID)
			ids := r.byOwner[key]
			for i, oid := range ids {
				if oid == id {
					r.byOwner[key] = append(ids[:i], ids[i+1:]...)
					break
				}
			}
		}
	}
	return nil
}

func sanitizeLabel(label string) string {
	value := strings.ToLower(strings.TrimSpace(label))
	value = strings.ReplaceAll(value, " ", "-")
	value = nonSlugChars.ReplaceAllString(value, "")
	value = strings.Trim(value, "-")
	if len(value) > 20 {
		value = value[:20]
	}
	return value
}

var nonSlugChars = regexp.MustCompile(`[^a-z0-9-]`)

func randomHex(numBytes int) (string, error) {
	buf := make([]byte, numBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func ownerKey(tenantID, userID string) string {
	return tenantID + ":" + userID
}
