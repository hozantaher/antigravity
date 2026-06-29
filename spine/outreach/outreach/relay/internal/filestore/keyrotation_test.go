package filestore

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func makeKey(t *testing.T, fill byte) string {
	t.Helper()
	b := make([]byte, 32)
	for i := range b {
		b[i] = fill
	}
	return base64.StdEncoding.EncodeToString(b)
}

func codecFromFill(t *testing.T, fill byte) Codec {
	t.Helper()
	c, err := NewCodecFromBase64(makeKey(t, fill))
	if err != nil {
		t.Fatalf("NewCodecFromBase64: %v", err)
	}
	return c
}

func TestKeyRing_CurrentAccessors(t *testing.T) {
	codecA := codecFromFill(t, 0xAA)
	codecB := codecFromFill(t, 0xBB)
	ring := NewKeyRing("kB", map[string]Codec{
		"kA": codecA,
		"kB": codecB,
	})

	if got := ring.CurrentKeyID(); got != "kB" {
		t.Fatalf("CurrentKeyID = %q, want kB", got)
	}
	cur := ring.CurrentCodec()
	if !cur.encrypted() {
		t.Fatal("CurrentCodec must be encrypted")
	}

	got, ok := ring.CodecForKey("kA")
	if !ok {
		t.Fatal("CodecForKey(kA) should be present")
	}
	if !got.encrypted() {
		t.Fatal("CodecForKey(kA) must be encrypted")
	}

	if _, ok := ring.CodecForKey("missing"); ok {
		t.Fatal("CodecForKey(missing) should be absent")
	}
}

func TestKeyRing_RotateFile_ReencryptsFromOldKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rotate.json")

	oldCodec := codecFromFill(t, 0x11)
	newCodec := codecFromFill(t, 0x22)

	payload := []byte(`{"hello":"world"}`)
	encryptedOld, err := oldCodec.Encrypt(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encryptedOld, 0600); err != nil {
		t.Fatal(err)
	}

	ring := NewKeyRing("new", map[string]Codec{
		"old": oldCodec,
		"new": newCodec,
	})

	if err := ring.RotateFile(path); err != nil {
		t.Fatalf("RotateFile: %v", err)
	}

	// File should now decrypt under the new codec.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := newCodec.Decrypt(raw)
	if err != nil {
		t.Fatalf("decrypt with new codec: %v", err)
	}
	if !bytes.Equal(plain, payload) {
		t.Fatalf("rotated payload mismatch: got %q, want %q", plain, payload)
	}
}

func TestKeyRing_RotateFile_MissingFileNoop(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "does-not-exist.json")

	ring := NewKeyRing("k", map[string]Codec{
		"k": codecFromFill(t, 0x01),
	})
	if err := ring.RotateFile(path); err != nil {
		t.Fatalf("missing file should be a no-op, got %v", err)
	}
	// The file should still not exist.
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("missing file should remain missing, stat err = %v", err)
	}
}

func TestKeyRing_RotateFile_EmptyFileNoop(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.json")
	if err := os.WriteFile(path, []byte{}, 0600); err != nil {
		t.Fatal(err)
	}

	ring := NewKeyRing("k", map[string]Codec{
		"k": codecFromFill(t, 0x02),
	})
	if err := ring.RotateFile(path); err != nil {
		t.Fatalf("empty file should be a no-op, got %v", err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Size() != 0 {
		t.Fatalf("empty file should remain empty, size = %d", fi.Size())
	}
}

func TestKeyRing_RotateFile_UnknownKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "unknown.json")

	otherCodec := codecFromFill(t, 0x77)
	encrypted, err := otherCodec.Encrypt([]byte("payload"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encrypted, 0600); err != nil {
		t.Fatal(err)
	}

	ring := NewKeyRing("a", map[string]Codec{
		"a": codecFromFill(t, 0x01),
		"b": codecFromFill(t, 0x02),
	})
	err = ring.RotateFile(path)
	if err == nil {
		t.Fatal("expected error rotating file encrypted with unknown key")
	}
}

func TestKeyRing_RotateFile_ReadError(t *testing.T) {
	// Path that cannot be read because it is a directory.
	dir := t.TempDir()
	ring := NewKeyRing("k", map[string]Codec{
		"k": codecFromFill(t, 0x05),
	})
	err := ring.RotateFile(dir)
	if err == nil {
		t.Fatal("expected error reading a directory as file")
	}
}

func TestWriteAtomic_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "atomic.bin")
	payload := []byte("atomic-payload")

	if err := writeAtomic(path, payload); err != nil {
		t.Fatalf("writeAtomic: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("writeAtomic payload mismatch: got %q, want %q", got, payload)
	}

	// Temp file should not linger.
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("tmp file should be gone, stat err = %v", err)
	}
}

func TestWriteAtomic_WriteError(t *testing.T) {
	// Directory does not exist, so the tmp file cannot be created.
	missing := filepath.Join(t.TempDir(), "no-such-dir", "file.bin")
	if err := writeAtomic(missing, []byte("x")); err == nil {
		t.Fatal("expected error writing to nonexistent directory")
	}
}

func TestKeyRing_RotateFile_SingleKeyRoundTrip(t *testing.T) {
	// Ring with only the current key -- rotation is idempotent.
	dir := t.TempDir()
	path := filepath.Join(dir, "only.json")

	only := codecFromFill(t, 0x44)
	enc, err := only.Encrypt([]byte("payload-only"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, enc, 0600); err != nil {
		t.Fatal(err)
	}

	ring := NewKeyRing("only", map[string]Codec{"only": only})
	if err := ring.RotateFile(path); err != nil {
		t.Fatalf("RotateFile: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := only.Decrypt(raw)
	if err != nil {
		t.Fatalf("decrypt after rotation: %v", err)
	}
	if !bytes.Equal(plain, []byte("payload-only")) {
		t.Fatalf("payload = %q, want payload-only", plain)
	}
}
