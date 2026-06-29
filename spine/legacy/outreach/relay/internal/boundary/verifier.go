package boundary

import (
	"relay/internal/filestore"
	"relay/internal/model"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
)

var (
	ErrChannelNotFound    = errors.New("exit channel not found")
	ErrChannelNotVerified = errors.New("exit channel not verified")
	ErrInvalidChannel     = errors.New("invalid exit channel configuration")
)

// ExitVerifier enforces the trusted-delivery boundary.
// Messages can only exit the system through pre-registered, verified channels.
type ExitVerifier struct {
	mu       sync.RWMutex
	path     string
	codec    filestore.Codec
	channels []model.ExitChannel
}

// NewExitVerifier creates a verifier backed by an encrypted JSON file.
func NewExitVerifier(path string, codec filestore.Codec) (*ExitVerifier, error) {
	v := &ExitVerifier{
		path:  path,
		codec: codec,
	}
	if err := filestore.ReadJSON(path, codec, &v.channels); err != nil {
		return nil, err
	}
	return v, nil
}

// Verify checks that an envelope is allowed to exit through the given channel.
func (v *ExitVerifier) Verify(ctx context.Context, env model.Envelope, channelID string) error {
	v.mu.RLock()
	defer v.mu.RUnlock()

	for _, ch := range v.channels {
		if ch.ID == channelID && ch.TenantID == env.TenantID {
			if !ch.Verified {
				return ErrChannelNotVerified
			}
			return nil
		}
	}
	return ErrChannelNotFound
}

// RegisterChannel adds a new exit channel.
func (v *ExitVerifier) RegisterChannel(ctx context.Context, ch model.ExitChannel) error {
	if ch.Name == "" || ch.Type == "" || ch.TenantID == "" {
		return ErrInvalidChannel
	}

	id, err := generateChannelID()
	if err != nil {
		return err
	}
	ch.ID = id

	v.mu.Lock()
	defer v.mu.Unlock()

	v.channels = append(v.channels, ch)
	return v.persist()
}

// VerifyChannel marks a channel as verified (trusted for delivery).
func (v *ExitVerifier) VerifyChannel(ctx context.Context, channelID, tenantID string) error {
	v.mu.Lock()
	defer v.mu.Unlock()

	for i := range v.channels {
		if v.channels[i].ID == channelID && v.channels[i].TenantID == tenantID {
			v.channels[i].Verified = true
			return v.persist()
		}
	}
	return ErrChannelNotFound
}

// ListChannels returns all channels for a tenant.
func (v *ExitVerifier) ListChannels(ctx context.Context, tenantID string) ([]model.ExitChannel, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	var result []model.ExitChannel
	for _, ch := range v.channels {
		if ch.TenantID == tenantID {
			safe := ch
			safe.PublicKey = nil // don't expose keys in listings
			result = append(result, safe)
		}
	}
	return result, nil
}

// GetChannel returns a specific channel by ID and tenant.
func (v *ExitVerifier) GetChannel(ctx context.Context, channelID, tenantID string) (model.ExitChannel, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	for _, ch := range v.channels {
		if ch.ID == channelID && ch.TenantID == tenantID {
			return ch, nil
		}
	}
	return model.ExitChannel{}, ErrChannelNotFound
}

func (v *ExitVerifier) persist() error {
	return filestore.WriteJSONAtomic(v.path, v.codec, v.channels)
}

func generateChannelID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "ch_" + hex.EncodeToString(b), nil
}
