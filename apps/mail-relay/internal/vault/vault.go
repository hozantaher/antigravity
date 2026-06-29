package vault

import (
	"relay/internal/filestore"
	"relay/internal/model"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"
)

var (
	ErrNotFound      = errors.New("alias mapping not found")
	ErrRevoked       = errors.New("alias mapping revoked")
	ErrExpired       = errors.New("alias mapping expired")
	ErrInvalidInput  = errors.New("invalid input")
)

// Vault manages identity mappings with its own encryption key,
// separate from the main data encryption key.
type Vault interface {
	Register(ctx context.Context, tenantID, realIdentityRef, purpose string) (aliasToken string, err error)
	Resolve(ctx context.Context, aliasToken string) (realIdentityRef string, err error)
	Revoke(ctx context.Context, aliasToken string) error
	ListByTenant(ctx context.Context, tenantID string) ([]model.AliasMapping, error)
}

// FileVault stores identity mappings in an encrypted file using a dedicated vault key.
type FileVault struct {
	mu        sync.RWMutex
	path      string
	codec     filestore.Codec
	vaultKey  filestore.Codec
	mappings  []model.AliasMapping
	retention time.Duration
	now       func() time.Time
}

// NewFileVault creates a vault backed by an encrypted JSON file.
// vaultKeyB64 is the vault-specific encryption key (separate from data key).
func NewFileVault(path, vaultKeyB64 string, retention time.Duration) (*FileVault, error) {
	vaultCodec, err := filestore.NewCodecFromBase64(vaultKeyB64)
	if err != nil {
		return nil, err
	}
	// The file itself is encrypted with the vault codec
	v := &FileVault{
		path:      path,
		codec:     vaultCodec,
		vaultKey:  vaultCodec,
		retention: retention,
		now:       time.Now,
	}
	if err := filestore.ReadJSON(path, vaultCodec, &v.mappings); err != nil {
		return nil, err
	}
	return v, nil
}

func (v *FileVault) Register(ctx context.Context, tenantID, realIdentityRef, purpose string) (string, error) {
	if tenantID == "" || realIdentityRef == "" {
		return "", ErrInvalidInput
	}

	token, err := generateAliasToken()
	if err != nil {
		return "", err
	}

	encRef, err := v.vaultKey.Encrypt([]byte(realIdentityRef))
	if err != nil {
		return "", err
	}

	mapping := model.AliasMapping{
		AliasToken:    token,
		TenantID:      tenantID,
		EncryptedRef:  encRef,
		Purpose:       purpose,
		CreatedBucket: bucketTime(v.now()),
	}

	v.mu.Lock()
	defer v.mu.Unlock()

	v.mappings = append(v.mappings, mapping)
	if err := v.persist(); err != nil {
		return "", err
	}
	return token, nil
}

func (v *FileVault) Resolve(ctx context.Context, aliasToken string) (string, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	for _, m := range v.mappings {
		if m.AliasToken == aliasToken {
			if m.Revoked {
				return "", ErrRevoked
			}
			if !m.ExpiresAt.IsZero() && v.now().After(m.ExpiresAt) {
				return "", ErrExpired
			}
			plain, err := v.vaultKey.Decrypt(m.EncryptedRef)
			if err != nil {
				return "", err
			}
			return string(plain), nil
		}
	}
	return "", ErrNotFound
}

func (v *FileVault) Revoke(ctx context.Context, aliasToken string) error {
	v.mu.Lock()
	defer v.mu.Unlock()

	for i := range v.mappings {
		if v.mappings[i].AliasToken == aliasToken {
			v.mappings[i].Revoked = true
			v.mappings[i].RevokedAt = v.now()
			return v.persist()
		}
	}
	return ErrNotFound
}

func (v *FileVault) ListByTenant(ctx context.Context, tenantID string) ([]model.AliasMapping, error) {
	v.mu.Lock()
	v.pruneExpired()
	v.mu.Unlock()

	v.mu.RLock()
	defer v.mu.RUnlock()

	var result []model.AliasMapping
	for _, m := range v.mappings {
		if m.TenantID == tenantID && !m.Revoked {
			safe := m
			safe.EncryptedRef = nil // never expose encrypted ref in listings
			result = append(result, safe)
		}
	}
	return result, nil
}

func (v *FileVault) pruneExpired() {
	if v.retention <= 0 {
		return
	}
	cutoff := v.now().Add(-v.retention)
	kept := v.mappings[:0]
	for _, m := range v.mappings {
		if m.CreatedBucket.After(cutoff) || m.CreatedBucket.Equal(cutoff) {
			kept = append(kept, m)
		}
	}
	v.mappings = kept
}

func (v *FileVault) persist() error {
	return filestore.WriteJSONAtomic(v.path, v.codec, v.mappings)
}

func generateAliasToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func bucketTime(t time.Time) time.Time {
	return t.UTC().Truncate(15 * time.Minute)
}
