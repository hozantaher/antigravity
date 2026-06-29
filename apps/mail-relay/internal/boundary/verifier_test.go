package boundary

import (
	"relay/internal/filestore"
	"relay/internal/model"
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func testCodec(t *testing.T) filestore.Codec {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 77)
	}
	c, _ := filestore.NewCodecFromBase64(base64.StdEncoding.EncodeToString(key))
	return c
}

func TestRegisterAndListChannels(t *testing.T) {
	dir := t.TempDir()
	v, err := NewExitVerifier(filepath.Join(dir, "channels.json"), testCodec(t))
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	err = v.RegisterChannel(ctx, model.ExitChannel{
		TenantID: "tenant-1",
		Name:     "smtp-relay",
		Type:     model.ExitTypeSMTP,
	})
	if err != nil {
		t.Fatal(err)
	}

	channels, err := v.ListChannels(ctx, "tenant-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(channels) != 1 {
		t.Fatalf("expected 1 channel, got %d", len(channels))
	}
	if channels[0].Name != "smtp-relay" {
		t.Fatalf("expected smtp-relay, got %s", channels[0].Name)
	}
	if channels[0].PublicKey != nil {
		t.Fatal("public key should be nil in listing")
	}
}

func TestVerifyRequiresVerifiedChannel(t *testing.T) {
	dir := t.TempDir()
	v, _ := NewExitVerifier(filepath.Join(dir, "channels.json"), testCodec(t))

	ctx := context.Background()
	v.RegisterChannel(ctx, model.ExitChannel{
		TenantID: "tenant-1",
		Name:     "test",
		Type:     "smtp",
	})

	channels, _ := v.ListChannels(ctx, "tenant-1")
	chID := channels[0].ID

	env := model.Envelope{TenantID: "tenant-1"}
	err := v.Verify(ctx, env, chID)
	if err != ErrChannelNotVerified {
		t.Fatalf("expected ErrChannelNotVerified, got %v", err)
	}

	// Verify the channel
	v.VerifyChannel(ctx, chID, "tenant-1")

	err = v.Verify(ctx, env, chID)
	if err != nil {
		t.Fatalf("expected nil after verify, got %v", err)
	}
}

func TestVerifyTenantIsolation(t *testing.T) {
	dir := t.TempDir()
	v, _ := NewExitVerifier(filepath.Join(dir, "channels.json"), testCodec(t))

	ctx := context.Background()
	v.RegisterChannel(ctx, model.ExitChannel{
		TenantID: "tenant-1",
		Name:     "test",
		Type:     "smtp",
	})

	channels, _ := v.ListChannels(ctx, "tenant-1")
	chID := channels[0].ID
	v.VerifyChannel(ctx, chID, "tenant-1")

	// tenant-2 should not see tenant-1's channels
	env := model.Envelope{TenantID: "tenant-2"}
	err := v.Verify(ctx, env, chID)
	if err != ErrChannelNotFound {
		t.Fatalf("expected ErrChannelNotFound for wrong tenant, got %v", err)
	}
}

func TestRegisterInvalidChannel(t *testing.T) {
	dir := t.TempDir()
	v, _ := NewExitVerifier(filepath.Join(dir, "channels.json"), testCodec(t))

	ctx := context.Background()

	tests := []struct {
		name string
		ch   model.ExitChannel
	}{
		{name: "all empty", ch: model.ExitChannel{}},
		{name: "missing name", ch: model.ExitChannel{Type: "smtp", TenantID: "t1"}},
		{name: "missing type", ch: model.ExitChannel{Name: "n", TenantID: "t1"}},
		{name: "missing tenant", ch: model.ExitChannel{Name: "n", Type: "smtp"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if err := v.RegisterChannel(ctx, tc.ch); err != ErrInvalidChannel {
				t.Fatalf("expected ErrInvalidChannel, got %v", err)
			}
		})
	}
}

func TestNewExitVerifierReadError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.json")

	// Encrypted codec expects JSON-wrapped ciphertext; garbage fails to decrypt.
	if err := os.WriteFile(path, []byte("not-json-garbage"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewExitVerifier(path, testCodec(t)); err == nil {
		t.Fatal("expected error from unreadable channels file, got nil")
	}
}

func TestNewExitVerifierPersistsAndReloads(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "channels.json")

	ctx := context.Background()
	codec := testCodec(t)

	v1, err := NewExitVerifier(path, codec)
	if err != nil {
		t.Fatal(err)
	}
	if err := v1.RegisterChannel(ctx, model.ExitChannel{
		TenantID: "tenant-x",
		Name:     "n",
		Type:     model.ExitTypeSMTP,
	}); err != nil {
		t.Fatal(err)
	}

	// Reload from disk using a fresh verifier — exercises ReadJSON happy path.
	v2, err := NewExitVerifier(path, codec)
	if err != nil {
		t.Fatal(err)
	}
	got, err := v2.ListChannels(ctx, "tenant-x")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 channel after reload, got %d", len(got))
	}
}

func TestVerifyChannelNotFound(t *testing.T) {
	dir := t.TempDir()
	v, _ := NewExitVerifier(filepath.Join(dir, "channels.json"), testCodec(t))

	ctx := context.Background()
	// No channel registered.
	if err := v.VerifyChannel(ctx, "ch_missing", "tenant-1"); err != ErrChannelNotFound {
		t.Fatalf("expected ErrChannelNotFound, got %v", err)
	}

	// Register a channel but call VerifyChannel with the wrong tenant.
	if err := v.RegisterChannel(ctx, model.ExitChannel{
		TenantID: "tenant-1",
		Name:     "n",
		Type:     model.ExitTypeSMTP,
	}); err != nil {
		t.Fatal(err)
	}
	channels, _ := v.ListChannels(ctx, "tenant-1")
	if err := v.VerifyChannel(ctx, channels[0].ID, "tenant-2"); err != ErrChannelNotFound {
		t.Fatalf("expected ErrChannelNotFound for wrong tenant, got %v", err)
	}
}

func TestGetChannel(t *testing.T) {
	dir := t.TempDir()
	v, _ := NewExitVerifier(filepath.Join(dir, "channels.json"), testCodec(t))

	ctx := context.Background()
	if err := v.RegisterChannel(ctx, model.ExitChannel{
		TenantID:  "tenant-1",
		Name:      "smtp-relay",
		Type:      model.ExitTypeSMTP,
		PublicKey: []byte("pubkey-bytes"),
	}); err != nil {
		t.Fatal(err)
	}
	channels, _ := v.ListChannels(ctx, "tenant-1")
	chID := channels[0].ID

	t.Run("found returns full channel including public key", func(t *testing.T) {
		got, err := v.GetChannel(ctx, chID, "tenant-1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.ID != chID {
			t.Fatalf("expected id %s, got %s", chID, got.ID)
		}
		if got.Name != "smtp-relay" {
			t.Fatalf("expected name smtp-relay, got %s", got.Name)
		}
		// GetChannel, unlike ListChannels, must NOT redact the public key.
		if string(got.PublicKey) != "pubkey-bytes" {
			t.Fatalf("expected full public key, got %q", got.PublicKey)
		}
	})

	t.Run("wrong tenant returns ErrChannelNotFound", func(t *testing.T) {
		if _, err := v.GetChannel(ctx, chID, "tenant-other"); err != ErrChannelNotFound {
			t.Fatalf("expected ErrChannelNotFound, got %v", err)
		}
	})

	t.Run("unknown id returns ErrChannelNotFound", func(t *testing.T) {
		if _, err := v.GetChannel(ctx, "ch_does_not_exist", "tenant-1"); err != ErrChannelNotFound {
			t.Fatalf("expected ErrChannelNotFound, got %v", err)
		}
	})
}

func TestGenerateChannelIDShape(t *testing.T) {
	id, err := generateChannelID()
	if err != nil {
		t.Fatalf("unexpected error from generateChannelID: %v", err)
	}
	// "ch_" prefix + 8 bytes hex encoded = 3 + 16 = 19 chars.
	if len(id) != 19 {
		t.Fatalf("expected 19-char id, got %d (%q)", len(id), id)
	}
	if id[:3] != "ch_" {
		t.Fatalf("expected ch_ prefix, got %q", id)
	}

	// Should be unique across calls.
	id2, err := generateChannelID()
	if err != nil {
		t.Fatal(err)
	}
	if id == id2 {
		t.Fatalf("expected unique ids, got duplicate %q", id)
	}
}
