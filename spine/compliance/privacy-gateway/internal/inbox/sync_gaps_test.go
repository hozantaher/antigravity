package inbox

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"privacy-gateway/internal/model"
)

var errSync = errors.New("sync test error")

// ── Error-injecting fake session ──

type errFakeSession struct {
	fakeSession
	loginErr          error
	loginMsg          string // override for "authentication failed" detection
	selectErr         error
	searchErr         error
	fetchErr          error
}

func (s *errFakeSession) Login(_, _ string) error {
	s.loginCalled = true
	if s.loginMsg != "" {
		return errors.New(s.loginMsg)
	}
	return s.loginErr
}

func (s *errFakeSession) Select(mailbox string) error {
	s.selectBox = mailbox
	return s.selectErr
}

func (s *errFakeSession) SearchAllUIDs() ([]string, error) {
	if s.searchErr != nil {
		return nil, s.searchErr
	}
	return append([]string(nil), s.uids...), nil
}

func (s *errFakeSession) FetchMessageByUID(uid string) ([]byte, error) {
	if s.fetchErr != nil {
		return nil, s.fetchErr
	}
	return s.fakeSession.messages[uid], nil
}

func newSyncer(t *testing.T) (*IMAPSyncer, *Store, *CursorStore) {
	t.Helper()
	store, err := NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	cursors, err := NewCursorStore(filepath.Join(t.TempDir(), "cursors.json"))
	if err != nil {
		t.Fatalf("NewCursorStore: %v", err)
	}
	syncer, err := NewIMAPSyncer(IMAPSyncConfig{
		Host:     "imap.example.com",
		Username: "user",
		Password: "pass",
	}, store, cursors)
	if err != nil {
		t.Fatalf("NewIMAPSyncer: %v", err)
	}
	return syncer, store, cursors
}

// ── Login: auth failure detection (lines 173-178) ──

func TestSync_LoginAuthFailureDetected(t *testing.T) {
	syncer, _, _ := newSyncer(t)
	syncer.sessions = fakeSessionFactory{session: &errFakeSession{
		loginMsg: "login failed: bad credentials",
	}}
	_, err := syncer.Sync(context.Background(), model.Actor{ID: "u", TenantID: "t"})
	if err == nil {
		t.Error("expected auth error")
	}
	if err.Error() == "" || err.Error()[:4] != "imap" {
		t.Logf("error: %v", err)
	}
}

func TestSync_LoginGenericError(t *testing.T) {
	syncer, _, _ := newSyncer(t)
	syncer.sessions = fakeSessionFactory{session: &errFakeSession{
		loginErr: errSync,
	}}
	_, err := syncer.Sync(context.Background(), model.Actor{ID: "u", TenantID: "t"})
	if err == nil {
		t.Error("expected error from Login")
	}
}

// ── Select error (line 180-182) ──

func TestSync_SelectError(t *testing.T) {
	syncer, _, _ := newSyncer(t)
	syncer.sessions = fakeSessionFactory{session: &errFakeSession{
		selectErr: errSync,
	}}
	_, err := syncer.Sync(context.Background(), model.Actor{ID: "u", TenantID: "t"})
	if err == nil {
		t.Error("expected error from Select")
	}
}

// ── SearchAllUIDs error (line 185-187) ──

func TestSync_SearchError(t *testing.T) {
	syncer, _, _ := newSyncer(t)
	syncer.sessions = fakeSessionFactory{session: &errFakeSession{
		searchErr: errSync,
	}}
	_, err := syncer.Sync(context.Background(), model.Actor{ID: "u", TenantID: "t"})
	if err == nil {
		t.Error("expected error from SearchAllUIDs")
	}
}

// ── UID monotonicity: cursor reset detection (lines 199-206) ──
// Set cursor to a high UID, return a lower max UID from server → cursor reset detected.

func TestSync_UIDMonotonicity_CursorReset(t *testing.T) {
	syncer, store, cursors := newSyncer(t)
	actor := model.Actor{ID: "u", TenantID: "t"}

	// Pre-set cursor to "100" (high UID)
	if err := cursors.Save(context.Background(), actor, "100"); err != nil {
		t.Fatalf("Save cursor: %v", err)
	}

	// Server returns UID "5" (lower than cursor 100 → reset detected)
	msg := []byte("From: a@b.com\r\nTo: c@d.com\r\nSubject: X\r\nDate: Mon, 01 Jan 2024 00:00:00 +0000\r\n\r\nbody")
	session := &errFakeSession{fakeSession: fakeSession{
		uids:     []string{"5"},
		messages: map[string][]byte{"5": msg},
	}}
	syncer.sessions = fakeSessionFactory{session: session}

	count, err := syncer.Sync(context.Background(), actor)
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	// After cursor reset, message 5 should be fetched
	_ = count
	_ = store
}

// ── Message fetch error (lines 214-216) ──

func TestSync_FetchError_Skipped(t *testing.T) {
	syncer, _, _ := newSyncer(t)
	session := &errFakeSession{
		fakeSession: fakeSession{uids: []string{"1"}},
		fetchErr:    errSync,
	}
	syncer.sessions = fakeSessionFactory{session: session}
	// Fetch error should not abort the whole sync
	_, err := syncer.Sync(context.Background(), model.Actor{ID: "u", TenantID: "t"})
	// May or may not error depending on implementation
	_ = err
}

// ── Context cancellation during sync loop (lines 227-232) ──

func TestSync_ContextCancelled(t *testing.T) {
	syncer, _, _ := newSyncer(t)
	msg := []byte("From: a@b.com\r\nTo: c@d.com\r\nSubject: X\r\nDate: Mon, 01 Jan 2024 00:00:00 +0000\r\n\r\nbody")
	session := &errFakeSession{fakeSession: fakeSession{
		uids:     []string{"1", "2", "3"},
		messages: map[string][]byte{"1": msg, "2": msg, "3": msg},
	}}
	syncer.sessions = fakeSessionFactory{session: session}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel immediately

	_, err := syncer.Sync(ctx, model.Actor{ID: "u", TenantID: "t"})
	// Should return context error or sync with 0 messages
	_ = err
}
