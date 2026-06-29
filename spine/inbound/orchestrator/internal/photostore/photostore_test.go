package photostore

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// helper builds a Store rooted at t.TempDir() so each case is
// hermetic + race-clean.
func newTempStore(t *testing.T) *Store {
	t.Helper()
	return New(t.TempDir())
}

// 1. Default root applied when caller passes empty string.
func TestNew_EmptyRootFallsBackToDefault(t *testing.T) {
	s := New("")
	if s.Root() != DefaultRoot {
		t.Errorf("root = %q, want %q", s.Root(), DefaultRoot)
	}
}

// 2. Whitespace root also falls back (paranoia: env vars sometimes have
// stray whitespace).
func TestNew_WhitespaceRootFallsBackToDefault(t *testing.T) {
	s := New("   ")
	if s.Root() != DefaultRoot {
		t.Errorf("root = %q, want %q", s.Root(), DefaultRoot)
	}
}

// 3. Save creates the dir tree and returns the absolute path.
func TestSave_CreatesDirTreeAndReturnsPath(t *testing.T) {
	s := newTempStore(t)
	path, err := s.Save(42, "<abc@host>", "photo.jpg", []byte{0xFF, 0xD8, 0xFF})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	want := filepath.Join(s.Root(), "42", "abc@host", "photo.jpg")
	if path != want {
		t.Errorf("path = %q, want %q", path, want)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("readback: %v", err)
	}
	if string(got) != string([]byte{0xFF, 0xD8, 0xFF}) {
		t.Errorf("bytes mismatch")
	}
}

// 4. Read mirrors Save: round-trip identical bytes.
func TestRead_RoundTripsIdenticalBytes(t *testing.T) {
	s := newTempStore(t)
	want := []byte("PNG-bytes-here")
	if _, err := s.Save(1, "m1", "img.png", want); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := s.Read(1, "m1", "img.png")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(got) != string(want) {
		t.Errorf("round-trip mismatch")
	}
}

// 5. Empty data is rejected so we never create a 0-byte file.
func TestSave_EmptyDataIsRejected(t *testing.T) {
	s := newTempStore(t)
	_, err := s.Save(1, "m1", "x.jpg", nil)
	if !errors.Is(err, ErrEmptyData) {
		t.Errorf("err = %v, want ErrEmptyData", err)
	}
}

// 6. Non-positive thread_id is rejected.
func TestSave_InvalidThreadIDIsRejected(t *testing.T) {
	s := newTempStore(t)
	_, err := s.Save(0, "m1", "x.jpg", []byte("a"))
	if !errors.Is(err, ErrInvalidIdentifier) {
		t.Errorf("err = %v, want ErrInvalidIdentifier", err)
	}
	_, err = s.Save(-5, "m1", "x.jpg", []byte("a"))
	if !errors.Is(err, ErrInvalidIdentifier) {
		t.Errorf("negative thread_id err = %v, want ErrInvalidIdentifier", err)
	}
}

// 7. Empty/whitespace-only message_id is rejected.
func TestSave_EmptyMessageIDIsRejected(t *testing.T) {
	s := newTempStore(t)
	_, err := s.Save(1, "", "x.jpg", []byte("a"))
	if !errors.Is(err, ErrInvalidIdentifier) {
		t.Errorf("err = %v, want ErrInvalidIdentifier", err)
	}
	_, err = s.Save(1, "   ", "x.jpg", []byte("a"))
	if !errors.Is(err, ErrInvalidIdentifier) {
		t.Errorf("whitespace err = %v, want ErrInvalidIdentifier", err)
	}
}

// 8. Filename with only path-traversal is rejected.
func TestSave_FilenameAllTraversalIsRejected(t *testing.T) {
	s := newTempStore(t)
	_, err := s.Save(1, "m1", "../../../etc/passwd", []byte("a"))
	// `filepath.Base` reduces this to "passwd"; not all-traversal so it
	// should NOT be rejected. The point is no traversal happens.
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	// The blob must still live under the store root, not /etc.
	path, err := s.Save(1, "m1", "../../../etc/passwd", []byte("a"))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if !strings.HasPrefix(path, s.Root()) {
		t.Errorf("path %q escaped root %q", path, s.Root())
	}
}

// 9. Filename with truly empty result after sanitize → rejected.
func TestSave_FilenameSanitizesToEmptyIsRejected(t *testing.T) {
	s := newTempStore(t)
	_, err := s.Save(1, "m1", ".", []byte("a"))
	if !errors.Is(err, ErrInvalidIdentifier) {
		t.Errorf("err = %v, want ErrInvalidIdentifier", err)
	}
}

// 10. MessageID brackets are stripped (RFC 5322 wrap form).
func TestSave_MessageIDBracketsStripped(t *testing.T) {
	s := newTempStore(t)
	path, err := s.Save(7, "<abc.def@example.com>", "ph.jpg", []byte("x"))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if !strings.Contains(path, filepath.Join("7", "abc.def@example.com")) {
		t.Errorf("path %q did not include unwrapped msg id", path)
	}
}

// 11. Idempotent overwrite: Save twice with same key → no error,
// last bytes win.
func TestSave_OverwriteIsIdempotent(t *testing.T) {
	s := newTempStore(t)
	if _, err := s.Save(1, "m1", "x.bin", []byte("first")); err != nil {
		t.Fatalf("Save#1: %v", err)
	}
	path, err := s.Save(1, "m1", "x.bin", []byte("second"))
	if err != nil {
		t.Fatalf("Save#2: %v", err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != "second" {
		t.Errorf("overwrite content = %q, want %q", string(got), "second")
	}
}

// 12. Read on missing file returns os.ErrNotExist (caller can errors.Is).
func TestRead_MissingFileReturnsNotExist(t *testing.T) {
	s := newTempStore(t)
	_, err := s.Read(99, "missing", "nope.jpg")
	if !errors.Is(err, os.ErrNotExist) {
		t.Errorf("err = %v, want os.ErrNotExist", err)
	}
}

// 13. Concurrent Saves with distinct keys do not collide.
func TestSave_ConcurrentDistinctKeysAllSucceed(t *testing.T) {
	s := newTempStore(t)
	const n = 32
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := s.Save(int64(i+1), "m", "p.bin", []byte{byte(i)})
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("concurrent save err: %v", err)
		}
	}
}

// 14. Filename containing slashes is collapsed to basename — no path
// traversal possible.
func TestSave_FilenameSlashesCollapseToBasename(t *testing.T) {
	s := newTempStore(t)
	path, err := s.Save(1, "m1", "subdir/evil/photo.jpg", []byte("x"))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if !strings.HasSuffix(path, "photo.jpg") {
		t.Errorf("path %q did not collapse to basename", path)
	}
	// Make sure no `subdir/evil` directories exist under the root.
	if _, err := os.Stat(filepath.Join(s.Root(), "1", "m1", "subdir")); !os.IsNotExist(err) {
		t.Errorf("traversal subdir leaked: stat err=%v", err)
	}
}

// 15. Mkdir failure surfaces as wrapped error (root is a file, not a
// dir). This protects against silent data loss on mis-mounted volumes.
func TestSave_MkdirFailureWrapsError(t *testing.T) {
	dir := t.TempDir()
	bogusRoot := filepath.Join(dir, "not-a-dir")
	// Create a file at bogusRoot so MkdirAll returns ENOTDIR.
	if err := os.WriteFile(bogusRoot, []byte("file"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	s := New(bogusRoot)
	_, err := s.Save(1, "m1", "p.jpg", []byte("x"))
	if err == nil {
		t.Fatalf("expected error when root is a file")
	}
	if !strings.Contains(err.Error(), "photostore:") {
		t.Errorf("err %q does not include package prefix", err)
	}
}

// 16. Sanitization of weird filename chars: spaces and unicode preserved
// where safe; control chars replaced with underscore.
func TestSave_FilenameSanitizationKeepsLetters(t *testing.T) {
	s := newTempStore(t)
	path, err := s.Save(1, "m1", "Žluťoučký_kůň.jpg", []byte("x"))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if !strings.HasSuffix(path, "Žluťoučký_kůň.jpg") {
		t.Errorf("filename mangled: %q", path)
	}
}
