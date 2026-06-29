// Package photostore persists inbound photo attachment binaries to a
// Railway volume so the photo-parse audit pipeline (Track E migration
// 019, ROPA Činnost č. 6) can later reference the raw blob even after
// the parsed extract has been written into photo_parse_audit.
//
// The package is intentionally small: it owns the `{root}/{thread_id}/
// {message_id}/{filename}` layout and nothing else. Higher-level
// orchestration (LLM call + DB insert) lives in
// services/orchestrator/internal/photoparse so each layer remains
// independently unit-testable.
//
// Volume layout:
//
//	{root}/
//	  {thread_id}/
//	    {message_id}/
//	      {sanitized_filename}
//
// A single photo blob therefore has a stable on-disk path that the
// orchestrator records as `photo_parse_audit.blob_ref`.
package photostore

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
)

// DefaultRoot is the volume mount point on Railway. main.go can
// override via the PHOTO_VOLUME_DIR env var.
const DefaultRoot = "/data/photos"

// ErrEmptyData rejects zero-byte input early — a 0-byte file would
// pollute the volume and is never useful for vision parsing.
var ErrEmptyData = errors.New("photostore: empty data")

// ErrInvalidIdentifier protects callers from path traversal via
// caller-supplied IDs. ThreadID/MessageID/Filename are sanitized but
// MessageID and Filename also cannot be empty.
var ErrInvalidIdentifier = errors.New("photostore: invalid identifier")

// Store is a tiny value type that closes over the volume root. It is
// safe for concurrent use — every method computes its own paths and
// uses atomic write semantics (write-temp + rename).
type Store struct {
	root string
}

// New constructs a Store with the given root. An empty root falls
// back to DefaultRoot so callers that ship without configuring the
// env var still write to the canonical volume mount.
func New(root string) *Store {
	if strings.TrimSpace(root) == "" {
		root = DefaultRoot
	}
	return &Store{root: root}
}

// Root exposes the configured root for tests + callers that need to
// build the same path independently (e.g. cleanup utilities).
func (s *Store) Root() string {
	return s.root
}

// Save writes data under {root}/{threadID}/{messageID}/{sanitized
// filename} and returns the absolute path. The path is the value
// callers persist into photo_parse_audit.blob_ref.
//
// Concurrency: when the same (thread, message, filename) is written
// twice (e.g. the IMAP poller re-fetches the same UID), Save is
// idempotent — the second writer overwrites with identical bytes.
//
// Atomicity: data is first written to a `<filename>.tmp` next to the
// target, then os.Rename'd into place. A crash mid-write leaves a
// recoverable .tmp file rather than a half-written blob.
func (s *Store) Save(threadID int64, messageID, filename string, data []byte) (string, error) {
	if len(data) == 0 {
		return "", ErrEmptyData
	}
	if threadID <= 0 {
		return "", fmt.Errorf("%w: thread_id=%d", ErrInvalidIdentifier, threadID)
	}
	cleanMessageID := sanitizeIdentifier(messageID)
	if cleanMessageID == "" {
		return "", fmt.Errorf("%w: message_id empty", ErrInvalidIdentifier)
	}
	cleanFilename := sanitizeFilename(filename)
	if cleanFilename == "" {
		return "", fmt.Errorf("%w: filename empty after sanitize", ErrInvalidIdentifier)
	}

	dir := filepath.Join(s.root, strconv.FormatInt(threadID, 10), cleanMessageID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("photostore: mkdir %s: %w", dir, err)
	}

	target := filepath.Join(dir, cleanFilename)
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return "", fmt.Errorf("photostore: write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, target); err != nil {
		// Best-effort cleanup so a stuck .tmp doesn't grow forever.
		_ = os.Remove(tmp)
		return "", fmt.Errorf("photostore: rename %s -> %s: %w", tmp, target, err)
	}
	return target, nil
}

// Read returns the bytes at the canonical path for the (thread,
// message, filename) tuple. Returns os.ErrNotExist when missing.
//
// This is the symmetric inverse of Save and is used by tests + future
// audit-export tooling. Production photo-parse pipeline persists the
// extract into photo_parse_audit at write time, so Read is not on
// the hot path.
func (s *Store) Read(threadID int64, messageID, filename string) ([]byte, error) {
	cleanMessageID := sanitizeIdentifier(messageID)
	cleanFilename := sanitizeFilename(filename)
	if cleanMessageID == "" || cleanFilename == "" {
		return nil, fmt.Errorf("%w: empty identifier", ErrInvalidIdentifier)
	}
	path := filepath.Join(
		s.root,
		strconv.FormatInt(threadID, 10),
		cleanMessageID,
		cleanFilename,
	)
	return os.ReadFile(path)
}

// sanitizeFilename collapses anything that could escape the storage
// directory (path separators, parent traversal, NULs) into safe
// alphanumeric/underscore/dash/dot tokens. Empty result → caller
// rejects.
func sanitizeFilename(s string) string {
	s = strings.TrimSpace(s)
	// Drop directory traversal even if RFC 2231 decoding produced it.
	s = filepath.Base(s)
	if s == "." || s == "/" || s == `\` {
		return ""
	}
	var b strings.Builder
	for _, r := range s {
		switch {
		case unicode.IsLetter(r), unicode.IsDigit(r):
			b.WriteRune(r)
		case r == '.', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	out := strings.Trim(b.String(), ".")
	return out
}

// sanitizeIdentifier strips characters that are unsafe in filesystem
// path segments while keeping enough of the SMTP Message-ID for
// debugging. RFC 5322 Message-IDs are wrapped in `<...>`; we strip the
// brackets and anything that could escape the directory.
func sanitizeIdentifier(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "<")
	s = strings.TrimSuffix(s, ">")
	s = strings.ReplaceAll(s, "/", "_")
	s = strings.ReplaceAll(s, `\`, "_")
	s = strings.ReplaceAll(s, "..", "_")
	s = strings.ReplaceAll(s, "\x00", "_")
	return strings.TrimSpace(s)
}
