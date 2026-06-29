package pool

import (
	"relay/internal/filestore"
	"relay/internal/model"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func testEncryptionKey(t *testing.T) string {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	return base64.StdEncoding.EncodeToString(key)
}

func newTestCodec(t *testing.T) filestore.Codec {
	t.Helper()
	c, err := filestore.NewCodecFromBase64(testEncryptionKey(t))
	if err != nil {
		t.Fatalf("failed to create codec: %v", err)
	}
	return c
}

func TestNewPersistentPool_EmptyStart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pool.json")

	p, err := NewPersistentPool(3, path, newTestCodec(t))
	if err != nil {
		t.Fatalf("NewPersistentPool: %v", err)
	}
	if p == nil {
		t.Fatal("expected non-nil pool")
	}
	if got := p.Size(); got != 0 {
		t.Fatalf("size = %d, want 0", got)
	}
	if got := p.MinSize(); got != 3 {
		t.Fatalf("minSize = %d, want 3", got)
	}
}

func TestPersistentPool_SubmitPersistsAndRestore(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pool.json")
	codec := newTestCodec(t)

	p, err := NewPersistentPool(1, path, codec)
	if err != nil {
		t.Fatal(err)
	}

	envs := []model.Envelope{
		{ID: "env_1", Status: model.StatusSealed},
		{ID: "env_2", Status: model.StatusSealed},
		{ID: "env_3", Status: model.StatusSealed},
	}
	for _, e := range envs {
		p.Submit(e)
	}
	if p.Size() != 3 {
		t.Fatalf("size = %d, want 3", p.Size())
	}

	// Verify file exists and is encrypted (no plaintext IDs).
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read persistence file: %v", err)
	}
	for _, e := range envs {
		for i := 0; i+len(e.ID) <= len(raw); i++ {
			if string(raw[i:i+len(e.ID)]) == e.ID {
				t.Fatalf("plaintext ID %q found in persisted file", e.ID)
			}
		}
	}

	// Restore in a new pool.
	restored, err := NewPersistentPool(1, path, codec)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if restored.Size() != 3 {
		t.Fatalf("restored size = %d, want 3", restored.Size())
	}
}

func TestPersistentPool_DrawPersistsReal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pool.json")
	codec := newTestCodec(t)

	p, err := NewPersistentPool(1, path, codec)
	if err != nil {
		t.Fatal(err)
	}
	p.Submit(model.Envelope{ID: "env_1", Status: model.StatusSealed})
	p.Submit(model.Envelope{ID: "env_2", Status: model.StatusSealed})

	env, isReal := p.Draw()
	if !isReal {
		t.Fatal("expected real draw")
	}
	if env.ID == "" {
		t.Fatal("expected a populated envelope")
	}
	if p.Size() != 1 {
		t.Fatalf("size after draw = %d, want 1", p.Size())
	}

	// The persisted file should reflect post-draw state.
	restored, err := NewPersistentPool(1, path, codec)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Size() != 1 {
		t.Fatalf("restored size = %d, want 1", restored.Size())
	}
}

func TestPersistentPool_DrawCoverDoesNotModifyPersistence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pool.json")
	codec := newTestCodec(t)

	p, err := NewPersistentPool(5, path, codec)
	if err != nil {
		t.Fatal(err)
	}
	p.Submit(model.Envelope{ID: "env_1"})
	p.Submit(model.Envelope{ID: "env_2"})

	// Snapshot file after submissions.
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	_, isReal := p.Draw()
	if isReal {
		t.Fatal("expected cover draw")
	}

	// Cover draws are not saved (code path returns early). The file must be untouched.
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatalf("persisted file changed on cover draw")
	}
}

func TestPersistentPool_Requeue(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pool.json")
	codec := newTestCodec(t)

	p, err := NewPersistentPool(1, path, codec)
	if err != nil {
		t.Fatal(err)
	}
	p.Submit(model.Envelope{ID: "env_1"})

	env, isReal := p.Draw()
	if !isReal {
		t.Fatal("expected real draw")
	}
	if p.Size() != 0 {
		t.Fatalf("size after draw = %d, want 0", p.Size())
	}

	p.Requeue(env)
	if p.Size() != 1 {
		t.Fatalf("size after requeue = %d, want 1", p.Size())
	}

	// Verify requeue persisted.
	restored, err := NewPersistentPool(1, path, codec)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Size() != 1 {
		t.Fatalf("restored size = %d, want 1", restored.Size())
	}
}

func TestPersistentPool_ReadError(t *testing.T) {
	// Write a file whose contents cannot be decrypted with the provided codec.
	dir := t.TempDir()
	path := filepath.Join(dir, "pool.json")
	if err := os.WriteFile(path, []byte("not-valid-encrypted-envelope"), 0600); err != nil {
		t.Fatal(err)
	}

	codec := newTestCodec(t)
	_, err := NewPersistentPool(1, path, codec)
	if err == nil {
		t.Fatal("expected error when persistence file is unreadable by codec")
	}
}

func TestPersistentPool_MinSizeAccessor(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pool.json")
	p, err := NewPersistentPool(7, path, newTestCodec(t))
	if err != nil {
		t.Fatal(err)
	}
	if p.MinSize() != 7 {
		t.Fatalf("MinSize = %d, want 7", p.MinSize())
	}
}

func TestPersistentPool_DefaultCodecPlaintextRoundTrip(t *testing.T) {
	// Covers the non-encrypted path of ReadJSON/WriteJSONAtomic.
	dir := t.TempDir()
	path := filepath.Join(dir, "pool.json")
	codec := filestore.DefaultCodec()

	p, err := NewPersistentPool(1, path, codec)
	if err != nil {
		t.Fatal(err)
	}
	p.Submit(model.Envelope{ID: "env_plain", Status: model.StatusSealed})
	if p.Size() != 1 {
		t.Fatalf("size = %d, want 1", p.Size())
	}

	restored, err := NewPersistentPool(1, path, codec)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Size() != 1 {
		t.Fatalf("restored size = %d, want 1", restored.Size())
	}
}
