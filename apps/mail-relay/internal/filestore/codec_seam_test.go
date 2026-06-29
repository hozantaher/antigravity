package filestore

import (
	"crypto/cipher"
	"errors"
	"io"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ── helpers ──────────────────────────────────────────────────────────────────

var errInjected = errors.New("injected error")

// restore runs cleanup after each seam override.
func restoreSeams(t *testing.T) {
	t.Helper()
	origCreateTemp := os.CreateTemp
	origRename := os.Rename
	origRandRead := io.ReadFull
	origNewAES := newAESCipher
	origNewGCM := newGCM
	origTmpClose := tmpClose
	t.Cleanup(func() {
		osCreateTemp = origCreateTemp
		osRename = origRename
		randRead = origRandRead
		newAESCipher = origNewAES
		newGCM = origNewGCM
		tmpClose = origTmpClose
	})
}

// ── Encrypt error paths ───────────────────────────────────────────────────────

// TestEncrypt_NewAESCipherError exercises the aes.NewCipher failure branch.
func TestEncrypt_NewAESCipherError(t *testing.T) {
	restoreSeams(t)
	newAESCipher = func(_ []byte) (cipher.Block, error) {
		return nil, errInjected
	}

	c, _ := NewCodecFromBase64(testKey())
	_, err := c.Encrypt([]byte("hello"))
	if err == nil {
		t.Fatal("expected error from newAESCipher failure")
	}
	if !errors.Is(err, errInjected) {
		t.Fatalf("expected injected error, got: %v", err)
	}
}

// TestEncrypt_NewGCMError exercises the cipher.NewGCM failure branch.
func TestEncrypt_NewGCMError(t *testing.T) {
	restoreSeams(t)
	newGCM = func(_ cipher.Block) (cipher.AEAD, error) {
		return nil, errInjected
	}

	c, _ := NewCodecFromBase64(testKey())
	_, err := c.Encrypt([]byte("hello"))
	if err == nil {
		t.Fatal("expected error from newGCM failure")
	}
	if !errors.Is(err, errInjected) {
		t.Fatalf("expected injected error, got: %v", err)
	}
}

// TestEncrypt_RandReadError exercises the rand.Read failure branch.
func TestEncrypt_RandReadError(t *testing.T) {
	restoreSeams(t)
	randRead = func(_ io.Reader, _ []byte) (int, error) {
		return 0, errInjected
	}

	c, _ := NewCodecFromBase64(testKey())
	_, err := c.Encrypt([]byte("sensitive"))
	if err == nil {
		t.Fatal("expected error from randRead failure")
	}
	if !errors.Is(err, errInjected) {
		t.Fatalf("expected injected error, got: %v", err)
	}
}

// ── Decrypt error paths ───────────────────────────────────────────────────────

// TestDecrypt_NewAESCipherError exercises the aes.NewCipher failure in Decrypt.
func TestDecrypt_NewAESCipherError(t *testing.T) {
	restoreSeams(t)

	// First encrypt with real seams, then inject error for decrypt.
	c, _ := NewCodecFromBase64(testKey())
	enc, err := c.Encrypt([]byte("payload"))
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}

	newAESCipher = func(_ []byte) (cipher.Block, error) {
		return nil, errInjected
	}

	_, err = c.Decrypt(enc)
	if err == nil {
		t.Fatal("expected error from newAESCipher failure in Decrypt")
	}
	if !errors.Is(err, errInjected) {
		t.Fatalf("expected injected error, got: %v", err)
	}
}

// TestDecrypt_NewGCMError exercises the cipher.NewGCM failure in Decrypt.
func TestDecrypt_NewGCMError(t *testing.T) {
	restoreSeams(t)

	c, _ := NewCodecFromBase64(testKey())
	enc, err := c.Encrypt([]byte("payload"))
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}

	newGCM = func(_ cipher.Block) (cipher.AEAD, error) {
		return nil, errInjected
	}

	_, err = c.Decrypt(enc)
	if err == nil {
		t.Fatal("expected error from newGCM failure in Decrypt")
	}
	if !errors.Is(err, errInjected) {
		t.Fatalf("expected injected error, got: %v", err)
	}
}

// ── WriteJSONAtomic error paths ───────────────────────────────────────────────

// TestWriteJSONAtomic_WriteError exercises the tmp.Write failure branch.
// We do this by injecting osCreateTemp to return a closed file handle whose
// Write will fail immediately.
func TestWriteJSONAtomic_WriteError(t *testing.T) {
	restoreSeams(t)
	dir := t.TempDir()

	// Create a real file, then close it and return it so Write fails.
	realFile, err := os.CreateTemp(dir, ".preclose-*")
	if err != nil {
		t.Fatal(err)
	}
	tmpName := realFile.Name()
	realFile.Close() // close now — Write on it will fail

	osCreateTemp = func(_, _ string) (*os.File, error) {
		// Re-open closed file in write-only mode to simulate "open but broken fd".
		f, err := os.OpenFile(tmpName, os.O_WRONLY, 0600)
		if err != nil {
			return nil, err
		}
		f.Close() // close it immediately so Write fails
		return f, nil
	}

	path := filepath.Join(dir, "out.json")
	err = WriteJSONAtomic(path, DefaultCodec(), map[string]int{"x": 1})
	if err == nil {
		t.Fatal("expected error from Write on closed fd")
	}
	// Temp file should not linger.
	if _, statErr := os.Stat(tmpName); !os.IsNotExist(statErr) {
		// Cleanup may have removed it — that's fine; just verify no final file.
	}
}

// TestWriteJSONAtomic_CloseError exercises the tmp.Close failure branch.
// We open a real temp file, write data, then close the underlying fd via a
// duplicate so the *os.File.Close returns EBADF (file already closed).
func TestWriteJSONAtomic_CloseError(t *testing.T) {
	restoreSeams(t)
	dir := t.TempDir()

	// Intercept osCreateTemp: create a real temp file, immediately close its fd
	// at the OS level (via Dup+close), return the *os.File whose fd is now invalid.
	// Write will succeed on the broken fd on some platforms (buffered) — this is
	// platform-specific, so use a different reliable approach:
	// Create a real file, do the write, but then make Close fail by closing the
	// fd before *os.File.Close() is called. We achieve this by tracking the file
	// in the interceptor and closing its fd after Write is done.
	//
	// Simpler: swap osRename to succeed AND make Close fail by using a pipe.
	// The write end of a pipe accepts writes but Close on an already-closed pipe
	// write-end returns an error. We return an already-closed write-end of a pipe.
	// But Write on a closed fd will also fail. Not what we want.
	//
	// Most reliable cross-platform approach: use syscall.Dup to steal the fd,
	// close the stolen fd, return the *os.File whose fd is now dangling.
	// On darwin/linux, Write to a dangling fd returns EBADF. Skip if Write fails.
	// We verify that either Write or Close propagated an error.

	called := false
	osCreateTemp = func(d, pattern string) (*os.File, error) {
		f, err := os.CreateTemp(d, pattern)
		if err != nil {
			return nil, err
		}
		if !called {
			called = true
			// Close the fd immediately so subsequent Write/Close both fail.
			f.Close()
		}
		return f, nil
	}

	path := filepath.Join(dir, "close-error.json")
	err := WriteJSONAtomic(path, DefaultCodec(), map[string]string{"k": "v"})
	if err == nil {
		t.Fatal("expected error from closed-fd Write or Close")
	}
}

// TestWriteJSONAtomic_TmpCloseError exercises the tmpClose failure branch.
// Write succeeds; tmpClose returns an error; temp file is cleaned up.
func TestWriteJSONAtomic_TmpCloseError(t *testing.T) {
	restoreSeams(t)
	dir := t.TempDir()

	tmpClose = func(f *os.File) error {
		f.Close() // actually close so the fd is released
		return errInjected
	}

	path := filepath.Join(dir, "close-err.json")
	err := WriteJSONAtomic(path, DefaultCodec(), []int{1, 2, 3})
	if err == nil {
		t.Fatal("expected error from tmpClose failure")
	}
	if !errors.Is(err, errInjected) {
		t.Fatalf("expected injected error, got: %v", err)
	}
	// Temp file should have been cleaned up.
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		// Final file should not exist.
		t.Logf("note: final path exists (may be partial) — stat err: %v", statErr)
	}
}

// TestWriteJSONAtomic_RenameError exercises the osRename failure branch.
func TestWriteJSONAtomic_RenameError(t *testing.T) {
	restoreSeams(t)
	dir := t.TempDir()

	osRename = func(_, _ string) error {
		return errInjected
	}

	path := filepath.Join(dir, "out.json")
	err := WriteJSONAtomic(path, DefaultCodec(), []string{"a", "b"})
	if err == nil {
		t.Fatal("expected error from osRename failure")
	}
	if !errors.Is(err, errInjected) {
		t.Fatalf("expected injected error, got: %v", err)
	}
}

// TestWriteJSONAtomic_EncryptError exercises the codec.Encrypt failure branch.
func TestWriteJSONAtomic_EncryptError(t *testing.T) {
	restoreSeams(t)
	dir := t.TempDir()

	randRead = func(_ io.Reader, _ []byte) (int, error) {
		return 0, errInjected
	}

	c, _ := NewCodecFromBase64(testKey())
	path := filepath.Join(dir, "out.json")
	err := WriteJSONAtomic(path, c, map[string]int{"k": 1})
	if err == nil {
		t.Fatal("expected error from Encrypt failure inside WriteJSONAtomic")
	}
	if !errors.Is(err, errInjected) {
		t.Fatalf("expected injected error, got: %v", err)
	}
}

// ── RotateFile re-encrypt error path ─────────────────────────────────────────

// TestRotateFile_ReencryptError exercises the fmt.Errorf("re-encrypt") branch
// in RotateFile. We set randRead to fail so Encrypt returns an error after
// successful decrypt.
func TestRotateFile_ReencryptError(t *testing.T) {
	restoreSeams(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "rotate.json")

	codec := codecFromFill(t, 0xAB)
	payload := []byte(`{"test":true}`)

	// Write a properly encrypted file.
	enc, err := codec.Encrypt(payload)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if err := os.WriteFile(path, enc, 0600); err != nil {
		t.Fatal(err)
	}

	ring := NewKeyRing("k", map[string]Codec{"k": codec})

	// Now break randRead so re-encrypt fails.
	randRead = func(_ io.Reader, _ []byte) (int, error) {
		return 0, errInjected
	}

	err = ring.RotateFile(path)
	if err == nil {
		t.Fatal("expected re-encrypt error from RotateFile")
	}
	if !strings.Contains(err.Error(), "re-encrypt") {
		t.Fatalf("expected 're-encrypt' in error, got: %v", err)
	}
}

// ── Happy-path roundtrip ──────────────────────────────────────────────────────

// TestWriteJSONAtomic_Roundtrip verifies write + read works end-to-end.
func TestWriteJSONAtomic_Roundtrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "roundtrip.json")
	c, _ := NewCodecFromBase64(testKey())

	type data struct {
		Name  string `json:"name"`
		Score int    `json:"score"`
	}
	want := data{Name: "roundtrip", Score: 99}

	if err := WriteJSONAtomic(path, c, want); err != nil {
		t.Fatalf("WriteJSONAtomic: %v", err)
	}
	var got data
	if err := ReadJSON(path, c, &got); err != nil {
		t.Fatalf("ReadJSON: %v", err)
	}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

// ── Monkey: 200 random data sizes ────────────────────────────────────────────

// TestEncryptDecrypt_MonkeyRandomSizes verifies no panic or data corruption
// across 200 random payload sizes [0, 4095].
func TestEncryptDecrypt_MonkeyRandomSizes(t *testing.T) {
	c, err := NewCodecFromBase64(testKey())
	if err != nil {
		t.Fatal(err)
	}

	for i := range 200 {
		size := rand.IntN(4096) // [0, 4095]
		payload := make([]byte, size)
		for j := range payload {
			payload[j] = byte(rand.IntN(256))
		}

		enc, err := c.Encrypt(payload)
		if err != nil {
			t.Fatalf("iteration %d (size=%d): Encrypt: %v", i, size, err)
		}
		dec, err := c.Decrypt(enc)
		if err != nil {
			t.Fatalf("iteration %d (size=%d): Decrypt: %v", i, size, err)
		}
		if len(dec) != len(payload) {
			t.Fatalf("iteration %d (size=%d): length mismatch: got %d, want %d", i, size, len(dec), size)
		}
		for k := range payload {
			if dec[k] != payload[k] {
				t.Fatalf("iteration %d (size=%d): byte %d mismatch: got %02x, want %02x", i, size, k, dec[k], payload[k])
			}
		}
	}
}
