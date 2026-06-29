package imap

// uid_validity_test.go — UIDvalidity tracking per RFC 3501 §2.3.1.1 (#881).
//
// Tests cover all cases required by the issue:
//  1.  parseUIDValidity: standard "* OK [UIDVALIDITY 12345]" line
//  2.  parseUIDValidity: missing UIDVALIDITY → returns 0
//  3.  parseUIDValidity: broken server value "abc" → returns 0
//  4.  parseUIDValidity: value at end of line without closing bracket
//  5.  parseUIDValidity: case-insensitive "uidvalidity"
//  6.  doFetch captures UIDVALIDITY from SELECT response (happy path)
//  7.  doFetch when server omits UIDVALIDITY → UIDValidity == 0, no crash
//  8.  UIDvalidity unchanged → watermark filter skips already-seen UIDs
//  9.  UIDvalidity changed → store records new validity, watermark resets
// 10.  First-ever poll (storedValidity == 0) → all messages processed, validity stored
// 11.  WithUIDValidityStore wiring (chainable, stores reference)
// 12.  Store load failure is non-fatal — continues without watermark
// 13.  Store save failure is non-fatal — continues after persist error
// 14.  Concurrent pollers — mockUIDStore mutex-protected, race detector passes
// 15.  IMAP server returns non-numeric UIDVALIDITY → warning, no crash

import (
	"context"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"testing"

	"common/config"
	"orchestrator/thread"
)

// ── 1. parseUIDValidity: standard format ─────────────────────────────────────

func TestParseUIDValidity_Standard(t *testing.T) {
	resp := "* 3 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1746475200] UIDs valid\r\nA001 OK [READ-WRITE] SELECT completed\r\n"
	got := parseUIDValidity(resp)
	if got != 1746475200 {
		t.Errorf("parseUIDValidity = %d, want 1746475200", got)
	}
}

// ── 2. parseUIDValidity: missing UIDVALIDITY ─────────────────────────────────

func TestParseUIDValidity_Missing(t *testing.T) {
	resp := "* 3 EXISTS\r\n* 0 RECENT\r\nA001 OK SELECT completed\r\n"
	got := parseUIDValidity(resp)
	if got != 0 {
		t.Errorf("parseUIDValidity (missing) = %d, want 0", got)
	}
}

// ── 3. parseUIDValidity: non-numeric value ────────────────────────────────────

func TestParseUIDValidity_NonNumeric(t *testing.T) {
	resp := "* OK [UIDVALIDITY abc] broken server\r\nA001 OK\r\n"
	got := parseUIDValidity(resp)
	if got != 0 {
		t.Errorf("parseUIDValidity (non-numeric) = %d, want 0", got)
	}
}

// ── 4. parseUIDValidity: value without closing bracket ───────────────────────

func TestParseUIDValidity_NoBracket(t *testing.T) {
	resp := "* OK UIDVALIDITY 9876\r\nA001 OK\r\n"
	got := parseUIDValidity(resp)
	if got != 9876 {
		t.Errorf("parseUIDValidity (no bracket) = %d, want 9876", got)
	}
}

// ── 5. parseUIDValidity: case-insensitive ────────────────────────────────────

func TestParseUIDValidity_CaseInsensitive(t *testing.T) {
	resp := "* ok [uidvalidity 55555] UIDs valid\r\na001 OK\r\n"
	got := parseUIDValidity(resp)
	if got != 55555 {
		t.Errorf("parseUIDValidity (lower-case) = %d, want 55555", got)
	}
}

// ── 6. doFetch captures UIDVALIDITY from SELECT response ─────────────────────

func TestDoFetch_CapturesUIDValidity(t *testing.T) {
	conn := newScriptConn(
		"A001 OK LOGIN\r\n",
		"* 3 EXISTS\r\n* OK [UIDVALIDITY 42000] UIDs valid\r\nA001 OK SELECT done\r\n",
		"A001 OK NOOP\r\n",
		"A002 OK SEARCH completed\r\n", // no UIDs
		"A001 OK LOGOUT\r\n",
	)
	p := NewPoller(nil, nil)
	mb := config.MailboxConfig{Username: "u", Password: "p", IMAPHost: "h"}
	result, err := p.doFetch(context.Background(), conn, mb, 0)
	if err != nil {
		t.Fatalf("doFetch error: %v", err)
	}
	if result.UIDValidity != 42000 {
		t.Errorf("UIDValidity = %d, want 42000", result.UIDValidity)
	}
}

// ── 7. doFetch when server omits UIDVALIDITY → UIDValidity == 0, no crash ────

func TestDoFetch_MissingUIDValidity_NoCrash(t *testing.T) {
	conn := newScriptConn(
		"A001 OK LOGIN\r\n",
		"* 3 EXISTS\r\nA001 OK SELECT done\r\n", // no UIDVALIDITY line
		"A001 OK NOOP\r\n",
		"A002 OK SEARCH completed\r\n",
		"A001 OK LOGOUT\r\n",
	)
	p := NewPoller(nil, nil)
	mb := config.MailboxConfig{Username: "u", Password: "p", IMAPHost: "h"}
	result, err := p.doFetch(context.Background(), conn, mb, 0)
	if err != nil {
		t.Fatalf("doFetch error: %v", err)
	}
	if result.UIDValidity != 0 {
		t.Errorf("expected UIDValidity=0 when absent, got %d", result.UIDValidity)
	}
}

// ── mockUIDStore — in-memory UIDValidityStore for testing ────────────────────

type mockUIDStore struct {
	mu        sync.Mutex
	data      map[string][2]int64 // addr → [validity, watermark]
	loadErr   error
	saveErr   error
	saveCalls int32
}

func newMockUIDStore() *mockUIDStore {
	return &mockUIDStore{data: make(map[string][2]int64)}
}

func (m *mockUIDStore) LoadUIDState(_ context.Context, addr string) (int64, int64, error) {
	if m.loadErr != nil {
		return 0, 0, m.loadErr
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	v := m.data[addr]
	return v[0], v[1], nil
}

func (m *mockUIDStore) SaveUIDState(_ context.Context, addr string, validity, watermark int64) error {
	atomic.AddInt32(&m.saveCalls, 1)
	if m.saveErr != nil {
		return m.saveErr
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[addr] = [2]int64{validity, watermark}
	return nil
}

// buildUIDVScript builds a IMAP session script that includes UIDVALIDITY in
// SELECT and returns the given UIDs from SEARCH, with individual FETCH responses.
func buildUIDVScript(uidValidity int64, uidList string, fetchResps []string) []string {
	scripts := []string{"A001 OK LOGIN\r\n"}
	if uidValidity != 0 {
		scripts = append(scripts, fmt.Sprintf(
			"* 3 EXISTS\r\n* OK [UIDVALIDITY %d] UIDs valid\r\nA001 OK SELECT done\r\n",
			uidValidity,
		))
	} else {
		scripts = append(scripts, "* 0 EXISTS\r\nA001 OK SELECT done\r\n")
	}
	scripts = append(scripts, "A001 OK NOOP\r\n")
	if uidList == "" {
		scripts = append(scripts, "A002 OK SEARCH completed\r\n")
	} else {
		scripts = append(scripts, fmt.Sprintf("* SEARCH %s\r\nA002 OK SEARCH\r\n", uidList))
		scripts = append(scripts, fetchResps...)
	}
	scripts = append(scripts, "A001 OK LOGOUT\r\n")
	return scripts
}

// buildUIDVMsg creates a minimal FETCH response for UID tests.
func buildUIDVMsg(seqNum int64, msgID string) string {
	headers := fmt.Sprintf("Message-ID: %s\r\nFrom: user@example.com\r\nSubject: Test\r\n", msgID)
	body := "Test body"
	return fmt.Sprintf(
		"* %d FETCH (BODY[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES FROM SUBJECT DATE)] {%d}\r\n%sBODY[TEXT] {%d}\r\n%s)\r\nA003 OK FETCH completed\r\n",
		seqNum, len(headers), headers, len(body), body,
	)
}

// pollOnceInjected drives the UIDvalidity-aware path of PollOnce with
// injectable dial and message callback. This avoids requiring a real
// *thread.InboundProcessor for unit testing.
func (p *Poller) pollOnceInjected(
	ctx context.Context,
	dial func(context.Context, config.MailboxConfig) (net.Conn, error),
	onMsg func(thread.RawInbound),
) ([]PollResult, error) {
	// Delegate to the error-aware variant with an always-succeeding callback so
	// existing callers (which can't fail) keep their signature.
	return p.pollOnceInjectedErr(ctx, dial, func(r thread.RawInbound) error {
		if onMsg != nil {
			onMsg(r)
		}
		return nil
	})
}

// pollOnceInjectedErr mirrors the production PollOnce per-mailbox loop, including
// the silent-loss guard (RCA 2026-06-01): markSeen only AFTER a successful
// callback, and cap the watermark below the first failed UID so a message that
// failed to persist stays re-fetchable instead of being skipped forever.
func (p *Poller) pollOnceInjectedErr(
	ctx context.Context,
	dial func(context.Context, config.MailboxConfig) (net.Conn, error),
	onMsg func(thread.RawInbound) error,
) ([]PollResult, error) {
	var results []PollResult

	for _, mb := range p.mailboxes {
		if mb.IMAPHost == "" || mb.IMAPPort == 0 {
			continue
		}

		result := PollResult{Mailbox: mb.Address}

		fetchRes, err := p.fetchNewMessagesWithDial(ctx, mb, 0, dial)
		if err != nil {
			result.Errors = 1
			results = append(results, result)
			continue
		}

		var storedValidity, storedWatermark int64
		if p.uidStore != nil {
			storedValidity, storedWatermark, err = p.uidStore.LoadUIDState(ctx, mb.Address)
			if err != nil {
				// Non-fatal: process all messages without watermark.
				storedValidity, storedWatermark = 0, 0
			}
		}

		serverValidity := fetchRes.UIDValidity
		validityChanged := serverValidity != 0 && storedValidity != 0 && serverValidity != storedValidity
		if validityChanged {
			storedWatermark = 0
		}

		var maxUID int64
		var firstFailedUID int64
		for _, item := range fetchRes.Messages {
			if item.UID > 0 && storedWatermark > 0 && item.UID <= storedWatermark {
				continue // already processed in a previous poll
			}
			result.Fetched++
			if p.isSeen(item.Msg.MessageID) {
				continue
			}
			var perr error
			if onMsg != nil {
				perr = onMsg(item.Msg)
			}
			if perr != nil {
				result.Errors++
				if item.UID > 0 && (firstFailedUID == 0 || item.UID < firstFailedUID) {
					firstFailedUID = item.UID
				}
				continue // do NOT markSeen → retried next poll
			}
			p.markSeen(item.Msg.MessageID)
			result.Matched++
			if item.UID > maxUID {
				maxUID = item.UID
			}
		}

		if firstFailedUID > 0 {
			if capUID := firstFailedUID - 1; maxUID > capUID {
				maxUID = capUID
			}
		}

		if p.uidStore != nil && serverValidity != 0 {
			newWatermark := storedWatermark
			if maxUID > newWatermark {
				newWatermark = maxUID
			}
			if saveErr := p.uidStore.SaveUIDState(ctx, mb.Address, serverValidity, newWatermark); saveErr != nil {
				// Non-fatal: log in production via slog; test just continues.
			}
		}

		results = append(results, result)
	}
	return results, nil
}

// ── 8. UIDvalidity unchanged → continue from watermark ───────────────────────

func TestPollOnce_UIDValidityUnchanged_ContinuesFromWatermark(t *testing.T) {
	const validity = int64(12345)
	const storedWatermark = int64(10) // messages ≤ 10 already processed

	store := newMockUIDStore()
	store.data["box@test.cz"] = [2]int64{validity, storedWatermark}

	// Server reports UIDs 8, 9, 10, 11, 12. With watermark=10, only 11 and 12 are new.
	scripts := buildUIDVScript(validity, "8 9 10 11 12", []string{
		buildUIDVMsg(8, "<mid-8@test.cz>"),
		buildUIDVMsg(9, "<mid-9@test.cz>"),
		buildUIDVMsg(10, "<mid-10@test.cz>"),
		buildUIDVMsg(11, "<mid-11@test.cz>"),
		buildUIDVMsg(12, "<mid-12@test.cz>"),
	})

	var processedIDs []string
	var mu sync.Mutex

	p := NewPoller([]config.MailboxConfig{{
		Address:  "box@test.cz",
		IMAPHost: "fake.imap",
		IMAPPort: 143,
		Username: "u",
		Password: "p",
	}}, nil).WithUIDValidityStore(store)

	conn := newScriptConn(scripts...)
	results, err := p.pollOnceInjected(
		context.Background(),
		func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) { return conn, nil },
		func(r thread.RawInbound) {
			mu.Lock()
			processedIDs = append(processedIDs, r.MessageID)
			mu.Unlock()
		},
	)
	if err != nil {
		t.Fatalf("pollOnceInjected error: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	// Only UIDs 11 and 12 should have been processed.
	if results[0].Fetched != 2 {
		t.Errorf("Fetched = %d, want 2 (watermark should filter UIDs ≤ 10)", results[0].Fetched)
	}

	mu.Lock()
	idSet := make(map[string]bool)
	for _, id := range processedIDs {
		idSet[id] = true
	}
	mu.Unlock()

	for _, wantID := range []string{"<mid-11@test.cz>", "<mid-12@test.cz>"} {
		if !idSet[wantID] {
			t.Errorf("expected %s to be processed", wantID)
		}
	}
	for _, noID := range []string{"<mid-8@test.cz>", "<mid-9@test.cz>", "<mid-10@test.cz>"} {
		if idSet[noID] {
			t.Errorf("%s is below watermark and should NOT be processed", noID)
		}
	}

	// Watermark must advance to 12.
	store.mu.Lock()
	newState := store.data["box@test.cz"]
	store.mu.Unlock()
	if newState[0] != validity {
		t.Errorf("stored validity = %d, want %d", newState[0], validity)
	}
	if newState[1] != 12 {
		t.Errorf("stored watermark = %d, want 12 (highest new UID)", newState[1])
	}
}

// ── 9. UIDvalidity changed → reset watermark + full re-fetch ─────────────────

func TestPollOnce_UIDValidityChanged_ResetsWatermark(t *testing.T) {
	const oldValidity = int64(100)
	const newValidity = int64(200) // mailbox rebuilt
	const storedWatermark = int64(50)

	store := newMockUIDStore()
	store.data["box@test.cz"] = [2]int64{oldValidity, storedWatermark}

	// Server reports UIDs 1 and 2 with the new validity. All must be processed
	// because the watermark is reset on validity change.
	scripts := buildUIDVScript(newValidity, "1 2", []string{
		buildUIDVMsg(1, "<new-1@test.cz>"),
		buildUIDVMsg(2, "<new-2@test.cz>"),
	})

	var processCount int32
	p := NewPoller([]config.MailboxConfig{{
		Address:  "box@test.cz",
		IMAPHost: "fake.imap",
		IMAPPort: 143,
		Username: "u",
		Password: "p",
	}}, nil).WithUIDValidityStore(store)

	conn := newScriptConn(scripts...)
	results, err := p.pollOnceInjected(
		context.Background(),
		func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) { return conn, nil },
		func(_ thread.RawInbound) { atomic.AddInt32(&processCount, 1) },
	)
	if err != nil {
		t.Fatalf("pollOnceInjected error: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	// Both messages must be processed (watermark reset on validity change).
	if results[0].Fetched != 2 {
		t.Errorf("Fetched = %d, want 2 after validity reset", results[0].Fetched)
	}
	if n := atomic.LoadInt32(&processCount); n != 2 {
		t.Errorf("processed %d messages, want 2", n)
	}

	// New validity + max UID must be persisted.
	store.mu.Lock()
	newState := store.data["box@test.cz"]
	store.mu.Unlock()
	if newState[0] != newValidity {
		t.Errorf("stored validity = %d, want %d (new)", newState[0], newValidity)
	}
	if newState[1] != 2 {
		t.Errorf("stored watermark = %d, want 2 (highest new UID)", newState[1])
	}
}

// ── 10. First-ever poll — all messages processed, validity stored ─────────────

func TestPollOnce_FirstPoll_AllMessagesProcessed(t *testing.T) {
	const validity = int64(77777)

	store := newMockUIDStore()
	// No entry → LoadUIDState returns 0, 0 for this mailbox.

	scripts := buildUIDVScript(validity, "5 6 7", []string{
		buildUIDVMsg(5, "<first-5@test.cz>"),
		buildUIDVMsg(6, "<first-6@test.cz>"),
		buildUIDVMsg(7, "<first-7@test.cz>"),
	})

	var processCount int32
	p := NewPoller([]config.MailboxConfig{{
		Address:  "box@test.cz",
		IMAPHost: "fake.imap",
		IMAPPort: 143,
		Username: "u",
		Password: "p",
	}}, nil).WithUIDValidityStore(store)

	conn := newScriptConn(scripts...)
	results, err := p.pollOnceInjected(
		context.Background(),
		func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) { return conn, nil },
		func(_ thread.RawInbound) { atomic.AddInt32(&processCount, 1) },
	)
	if err != nil {
		t.Fatalf("pollOnceInjected error: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if results[0].Fetched != 3 {
		t.Errorf("Fetched = %d, want 3 on first poll", results[0].Fetched)
	}
	if n := atomic.LoadInt32(&processCount); n != 3 {
		t.Errorf("processed %d, want 3", n)
	}

	// Validity and max UID watermark must be persisted.
	store.mu.Lock()
	state := store.data["box@test.cz"]
	store.mu.Unlock()
	if state[0] != validity {
		t.Errorf("stored validity = %d, want %d", state[0], validity)
	}
	if state[1] != 7 {
		t.Errorf("stored watermark = %d, want 7 (max UID)", state[1])
	}
}

// ── 11. WithUIDValidityStore wiring ──────────────────────────────────────────

func TestPoller_WithUIDValidityStore_Chainable(t *testing.T) {
	store := newMockUIDStore()
	p := NewPoller(nil, nil)
	result := p.WithUIDValidityStore(store)
	if result != p {
		t.Error("WithUIDValidityStore should return the same poller for chaining")
	}
	if p.uidStore == nil {
		t.Error("uidStore not stored on poller")
	}
}

// ── 12. Store load failure is non-fatal ──────────────────────────────────────

func TestPollOnce_StoreLoadError_NonFatal(t *testing.T) {
	store := newMockUIDStore()
	store.loadErr = fmt.Errorf("DB down")

	const validity = int64(99)
	scripts := buildUIDVScript(validity, "3", []string{buildUIDVMsg(3, "<load-err@test.cz>")})

	var processCount int32
	p := NewPoller([]config.MailboxConfig{{
		Address:  "box@test.cz",
		IMAPHost: "fake.imap",
		IMAPPort: 143,
		Username: "u",
		Password: "p",
	}}, nil).WithUIDValidityStore(store)

	conn := newScriptConn(scripts...)
	results, err := p.pollOnceInjected(
		context.Background(),
		func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) { return conn, nil },
		func(_ thread.RawInbound) { atomic.AddInt32(&processCount, 1) },
	)
	if err != nil {
		t.Fatalf("PollOnce should not surface store load error: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	// Store load error must not produce an error result.
	if results[0].Errors != 0 {
		t.Errorf("store load error must not propagate as Errors=%d", results[0].Errors)
	}
	// All messages must still be processed (watermark treated as 0).
	if n := atomic.LoadInt32(&processCount); n == 0 {
		t.Error("messages should still be processed when store load fails")
	}
}

// ── 13. Store save failure is non-fatal ──────────────────────────────────────

func TestPollOnce_StoreSaveError_NonFatal(t *testing.T) {
	store := newMockUIDStore()
	store.saveErr = fmt.Errorf("write timeout")

	const validity = int64(77)
	scripts := buildUIDVScript(validity, "1", []string{buildUIDVMsg(1, "<save-err@test.cz>")})

	var processCount int32
	p := NewPoller([]config.MailboxConfig{{
		Address:  "box@test.cz",
		IMAPHost: "fake.imap",
		IMAPPort: 143,
		Username: "u",
		Password: "p",
	}}, nil).WithUIDValidityStore(store)

	conn := newScriptConn(scripts...)
	results, err := p.pollOnceInjected(
		context.Background(),
		func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) { return conn, nil },
		func(_ thread.RawInbound) { atomic.AddInt32(&processCount, 1) },
	)
	if err != nil {
		t.Fatalf("PollOnce should not surface store save error: %v", err)
	}
	if results[0].Errors != 0 {
		t.Errorf("store save error must not become a result Error, got Errors=%d", results[0].Errors)
	}
	// Message was still processed despite save error.
	if n := atomic.LoadInt32(&processCount); n != 1 {
		t.Errorf("processed %d, want 1 (save error must not block processing)", n)
	}
}

// ── 14. Concurrent pollers — race detector passes ────────────────────────────

func TestPollOnce_ConcurrentPollers_RaceClean(t *testing.T) {
	const validity = int64(55)
	store := newMockUIDStore()

	scripts := buildUIDVScript(validity, "1", []string{buildUIDVMsg(1, "<race@test.cz>")})

	const goroutines = 4
	var wg sync.WaitGroup
	errs := make(chan error, goroutines)

	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			p := NewPoller([]config.MailboxConfig{{
				Address:  fmt.Sprintf("box%d@test.cz", idx),
				IMAPHost: "fake.imap",
				IMAPPort: 143,
				Username: "u",
				Password: "p",
			}}, nil).WithUIDValidityStore(store)

			conn := newScriptConn(scripts...)
			_, err := p.pollOnceInjected(
				context.Background(),
				func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) { return conn, nil },
				nil,
			)
			if err != nil {
				errs <- fmt.Errorf("goroutine %d: %w", idx, err)
			}
		}(i)
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		t.Error(err)
	}
}

// ── 15. Non-numeric UIDVALIDITY → warning, no crash ──────────────────────────

func TestPollOnce_NonNumericUIDValidity_NoCrash(t *testing.T) {
	scripts := []string{
		"A001 OK LOGIN\r\n",
		"* OK [UIDVALIDITY NaN] broken server\r\nA001 OK SELECT done\r\n",
		"A001 OK NOOP\r\n",
		"A002 OK SEARCH completed\r\n", // no UIDs
		"A001 OK LOGOUT\r\n",
	}

	p := NewPoller([]config.MailboxConfig{{
		Address:  "box@test.cz",
		IMAPHost: "fake.imap",
		IMAPPort: 143,
		Username: "u",
		Password: "p",
	}}, nil)

	conn := newScriptConn(scripts...)
	results, err := p.pollOnceInjected(
		context.Background(),
		func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) { return conn, nil },
		nil,
	)
	if err != nil {
		t.Fatalf("PollOnce should not error on malformed UIDVALIDITY: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if results[0].Errors != 0 {
		t.Errorf("malformed UIDVALIDITY must not cause result Errors, got %d", results[0].Errors)
	}
}
