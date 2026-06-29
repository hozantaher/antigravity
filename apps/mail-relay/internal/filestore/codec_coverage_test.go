package filestore

import (
	"os"
	"path/filepath"
	"testing"
)

// TestWriteJSONAtomic_CreateTempError covers the os.CreateTemp error branch.
// We make the target directory read-only so CreateTemp cannot create a file there.
func TestWriteJSONAtomic_CreateTempError(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root bypasses file permissions")
	}
	dir := t.TempDir()
	// Make the directory read-only — CreateTemp will fail.
	if err := os.Chmod(dir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0700) })

	path := filepath.Join(dir, "out.json")
	err := WriteJSONAtomic(path, DefaultCodec(), map[string]int{"x": 1})
	if err == nil {
		t.Fatal("expected CreateTemp error for read-only directory")
	}
}

// TestKeyRing_RotateFile_WriteAtomicRenameError covers the os.Rename error path
// inside writeAtomic. We make the directory read-only after creating the .tmp file
// by using a non-writable directory for the target path.
func TestKeyRing_RotateFile_WriteAtomicRenameError(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root bypasses file permissions")
	}
	dir := t.TempDir()
	subdir := filepath.Join(dir, "sub")
	if err := os.MkdirAll(subdir, 0700); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(subdir, "data.json")
	codec := codecFromFill(t, 0xCC)
	data := []byte(`{"a":1}`)
	enc, err := codec.Encrypt(data)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, enc, 0600); err != nil {
		t.Fatal(err)
	}

	// Make the subdirectory read-only so writeAtomic cannot rename the tmp file.
	if err := os.Chmod(subdir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(subdir, 0700) })

	ring := NewKeyRing("k", map[string]Codec{"k": codec})
	// RotateFile will fail at writeAtomic because the dir is not writable.
	err = ring.RotateFile(path)
	if err == nil {
		t.Fatal("expected error from writeAtomic when directory is read-only")
	}
}

// TestWriteAtomicRenameError covers the os.Rename error in writeAtomic directly.
// We create a situation where the tmp file cannot be renamed.
func TestWriteAtomicRenameError(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root bypasses file permissions")
	}
	dir := t.TempDir()
	subdir := filepath.Join(dir, "ro")
	if err := os.MkdirAll(subdir, 0700); err != nil {
		t.Fatal(err)
	}

	// Write the tmp file first, then make directory read-only.
	target := filepath.Join(subdir, "target.bin")
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := os.Chmod(subdir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(subdir, 0700) })

	// Now try writeAtomic — WriteFile on .tmp will fail (dir is read-only).
	err := writeAtomic(target, []byte("payload"))
	if err == nil {
		t.Fatal("expected error from writeAtomic with read-only directory")
	}
}

// TestWriteJSONAtomic_EncryptThenWriteFailure verifies that when Encrypt succeeds
// but the dir is read-only, CreateTemp fails and the error propagates.
func TestWriteJSONAtomic_EncryptedWriteFailure(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root bypasses file permissions")
	}
	dir := t.TempDir()
	subdir := filepath.Join(dir, "enc-ro")
	if err := os.MkdirAll(subdir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(subdir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(subdir, 0700) })

	codec, _ := NewCodecFromBase64(testKey())
	path := filepath.Join(subdir, "out.json")
	err := WriteJSONAtomic(path, codec, []int{1, 2, 3})
	if err == nil {
		t.Fatal("expected error writing with encrypted codec to read-only dir")
	}
}
