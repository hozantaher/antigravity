package identity

import (
	"relay/internal/vault"
	"context"
)

// Service provides identity separation -- the facade that intake uses.
// It ensures real identities are only stored in the vault and never
// leak into the transport pipeline.
type Service struct {
	vault vault.Vault
}

func NewService(v vault.Vault) *Service {
	return &Service{vault: v}
}

// IssueAlias creates an opaque alias token for a submitter identity.
// The real identity is encrypted and stored only in the vault.
// Returns an opaque alias token that the pipeline uses going forward.
func (s *Service) IssueAlias(ctx context.Context, tenantID, realIdentity, purpose string) (aliasToken string, err error) {
	return s.vault.Register(ctx, tenantID, realIdentity, purpose)
}

// RevokeAlias revokes an alias token, making future resolution impossible.
func (s *Service) RevokeAlias(ctx context.Context, aliasToken string) error {
	return s.vault.Revoke(ctx, aliasToken)
}
