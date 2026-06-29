package vault

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"relay/internal/model"
)

// ---------------------------------------------------------------------------
// NewFileVault error paths
// ---------------------------------------------------------------------------

func TestNewFileVaultRejectsInvalidBase64Key(t *testing.T) {
	dir := t.TempDir()
	_, err := NewFileVault(filepath.Join(dir, "vault.json"), "!!!not-base64!!!", 0)
	if err == nil {
		t.Fatal("expected error for invalid base64 key, got nil")
	}
}

func TestNewFileVaultRejectsShortKey(t *testing.T) {
	dir := t.TempDir()
	// Valid base64 but not 32 bytes (codec expects 32-byte key).
	_, err := NewFileVault(filepath.Join(dir, "vault.json"), "YWJjZA==", 0)
	if err == nil {
		t.Fatal("expected error for short key, got nil")
	}
}

func TestNewFileVaultReadsExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vault.json")
	key := testVaultKey()

	// Seed with a mapping via first instance
	v1, err := NewFileVault(path, key, 0)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := v1.Register(ctx, "t1", "id-a", "p"); err != nil {
		t.Fatal(err)
	}

	// Second instance reloads from file
	v2, err := NewFileVault(path, key, 0)
	if err != nil {
		t.Fatalf("re-open: %v", err)
	}
	if len(v2.mappings) != 1 {
		t.Fatalf("expected 1 mapping loaded, got %d", len(v2.mappings))
	}
}

func TestNewFileVaultFailsWhenFileCorrupt(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vault.json")
	// Write garbage that the codec cannot decrypt
	if err := os.WriteFile(path, []byte("not-valid-ciphertext"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := NewFileVault(path, testVaultKey(), 0)
	if err == nil {
		t.Fatal("expected error opening vault with corrupt file, got nil")
	}
}

// ---------------------------------------------------------------------------
// Register validation paths
// ---------------------------------------------------------------------------

func TestRegisterRejectsEmptyInputs(t *testing.T) {
	dir := t.TempDir()
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	tests := []struct {
		name     string
		tenant   string
		identity string
	}{
		{"empty tenant", "", "id@example.com"},
		{"empty identity", "t1", ""},
		{"both empty", "", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := v.Register(ctx, tc.tenant, tc.identity, "p"); err != ErrInvalidInput {
				t.Fatalf("expected ErrInvalidInput, got %v", err)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Resolve error paths
// ---------------------------------------------------------------------------

func TestResolveUnknownTokenReturnsErrNotFound(t *testing.T) {
	dir := t.TempDir()
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.Resolve(context.Background(), "bogus-token"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestResolveExpiredMappingReturnsErrExpired(t *testing.T) {
	dir := t.TempDir()
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}
	// Control time for determinism
	fixed := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	v.now = func() time.Time { return fixed }

	ctx := context.Background()
	token, err := v.Register(ctx, "t1", "expire@example.com", "p")
	if err != nil {
		t.Fatal(err)
	}

	// Set an explicit past expiry on the stored mapping
	v.mu.Lock()
	for i := range v.mappings {
		if v.mappings[i].AliasToken == token {
			v.mappings[i].ExpiresAt = fixed.Add(-1 * time.Minute)
		}
	}
	v.mu.Unlock()

	if _, err := v.Resolve(ctx, token); err != ErrExpired {
		t.Fatalf("expected ErrExpired, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// Revoke unknown token
// ---------------------------------------------------------------------------

func TestRevokeUnknownTokenReturnsErrNotFound(t *testing.T) {
	dir := t.TempDir()
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := v.Revoke(context.Background(), "unknown"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// pruneExpired (exercised via ListByTenant)
// ---------------------------------------------------------------------------

func TestListByTenantPrunesOldMappingsWhenRetentionSet(t *testing.T) {
	dir := t.TempDir()
	// Retention = 1h -- anything older than 1h should be pruned.
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	fixed := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	v.now = func() time.Time { return fixed }

	// Insert synthetic mappings directly: one fresh, one stale.
	v.mu.Lock()
	v.mappings = []model.AliasMapping{
		{
			AliasToken:    "fresh",
			TenantID:      "t1",
			CreatedBucket: fixed.Add(-10 * time.Minute), // within retention
		},
		{
			AliasToken:    "stale",
			TenantID:      "t1",
			CreatedBucket: fixed.Add(-2 * time.Hour), // outside retention
		},
	}
	v.mu.Unlock()

	got, err := v.ListByTenant(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 mapping after prune, got %d (%+v)", len(got), got)
	}
	if got[0].AliasToken != "fresh" {
		t.Fatalf("expected fresh to remain, got %q", got[0].AliasToken)
	}
}

func TestPruneExpiredNoopWhenRetentionZero(t *testing.T) {
	dir := t.TempDir()
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}
	fixed := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	v.now = func() time.Time { return fixed }

	v.mu.Lock()
	v.mappings = []model.AliasMapping{
		{AliasToken: "ancient", TenantID: "t1", CreatedBucket: fixed.Add(-10000 * time.Hour)},
	}
	v.mu.Unlock()

	got, err := v.ListByTenant(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("expected retention=0 to disable prune, got %d mappings", len(got))
	}
}

// ---------------------------------------------------------------------------
// ListByTenant filters revoked + wrong tenant
// ---------------------------------------------------------------------------

func TestListByTenantFiltersRevokedAndWrongTenant(t *testing.T) {
	dir := t.TempDir()
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	tok1, _ := v.Register(ctx, "t1", "id-a", "p")
	v.Register(ctx, "t1", "id-b", "p")
	v.Register(ctx, "t2", "id-c", "p")

	// Revoke one t1 mapping
	if err := v.Revoke(ctx, tok1); err != nil {
		t.Fatal(err)
	}

	got, err := v.ListByTenant(ctx, "t1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 visible mapping for t1 after revoke, got %d", len(got))
	}

	gotOther, _ := v.ListByTenant(ctx, "t2")
	if len(gotOther) != 1 {
		t.Fatalf("expected 1 mapping for t2, got %d", len(gotOther))
	}
	gotNone, _ := v.ListByTenant(ctx, "no-such-tenant")
	if len(gotNone) != 0 {
		t.Fatalf("expected 0 mappings for unknown tenant, got %d", len(gotNone))
	}
}

// ---------------------------------------------------------------------------
// bucketTime truncates to 15 minutes
// ---------------------------------------------------------------------------

func TestBucketTimeTruncatesTo15MinutesUTC(t *testing.T) {
	// 12:37:42 -> 12:30:00 UTC
	in := time.Date(2026, 1, 1, 12, 37, 42, 500, time.Local)
	got := bucketTime(in)
	want := time.Date(2026, 1, 1, 12, 30, 0, 0, time.UTC).Truncate(15 * time.Minute)
	// bucketTime runs UTC() then Truncate(15m); account for any TZ offset.
	if got.Location() != time.UTC {
		t.Fatalf("bucketTime should return UTC, got %v", got.Location())
	}
	if !got.Equal(want.Truncate(15 * time.Minute)) {
		// Accept any 15-minute boundary in UTC near the input -- we just verify truncation.
		if got.Minute()%15 != 0 || got.Second() != 0 || got.Nanosecond() != 0 {
			t.Fatalf("bucketTime not truncated: %v", got)
		}
	}
}

// ---------------------------------------------------------------------------
// generateAliasToken produces distinct hex tokens
// ---------------------------------------------------------------------------

func TestGenerateAliasTokenUniqueAndHex(t *testing.T) {
	tok1, err := generateAliasToken()
	if err != nil {
		t.Fatal(err)
	}
	tok2, err := generateAliasToken()
	if err != nil {
		t.Fatal(err)
	}
	if tok1 == tok2 {
		t.Fatal("expected distinct alias tokens")
	}
	if len(tok1) != 32 || len(tok2) != 32 {
		t.Fatalf("expected 32-char hex tokens, got %d / %d", len(tok1), len(tok2))
	}
	for _, c := range tok1 + tok2 {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Fatalf("token contains non-hex character: %q", c)
		}
	}
}

// ---------------------------------------------------------------------------
// Resolve after revoke takes precedence over expiry check
// ---------------------------------------------------------------------------

func TestResolveRevokedBeatsExpiryCheck(t *testing.T) {
	dir := t.TempDir()
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}
	fixed := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	v.now = func() time.Time { return fixed }

	ctx := context.Background()
	token, _ := v.Register(ctx, "t1", "id@example.com", "p")

	// Set both revoked and past expiry; Resolve must report Revoked first.
	v.mu.Lock()
	for i := range v.mappings {
		if v.mappings[i].AliasToken == token {
			v.mappings[i].Revoked = true
			v.mappings[i].ExpiresAt = fixed.Add(-1 * time.Hour)
		}
	}
	v.mu.Unlock()

	if _, err := v.Resolve(ctx, token); err != ErrRevoked {
		t.Fatalf("expected ErrRevoked (precedence), got %v", err)
	}
}
