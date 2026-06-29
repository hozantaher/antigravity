package imap

// uid_fetch_test.go — UID FETCH / UID SEARCH upgrade tests (#878).
//
// Before this PR the poller issued SEARCH UNSEEN (returns sequence numbers)
// and FETCH {seq} (BODY.PEEK[]), which are vulnerable to EXPUNGE races.
// After this PR it issues UID SEARCH UNSEEN + UID FETCH <uid> (UID BODY.PEEK[]).
//
// Tests required (≥10 per feedback_extreme_testing):
//  1.  doFetch sends UID SEARCH, not plain SEARCH
//  2.  doFetch sends UID FETCH, not plain FETCH
//  3.  UID SEARCH happy path — single UID returned and fetched
//  4.  UID FETCH multiple UIDs returned out of order — sorted ascending before processing
//  5.  Concurrent mailbox modification (mock test) — UID FETCH stable, SEQ FETCH would fail
//  6.  Server does not support UID SEARCH — fallback warning logged, SEQ SEARCH used
//  7.  Empty UID set — no UID FETCH attempted, LOGOUT immediately
//  8.  UID FETCH write error for one message — continues with remaining UIDs
//  9.  Race detector: concurrent pollOnceInjected calls on distinct pollers
// 10.  UID SEARCH with SINCE clause — format is "UID SEARCH UNSEEN SINCE …"
// 11.  fetchMessageByUID happy path — command line contains "UID FETCH"
// 12.  fetchMessageByUID write error — returns error

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"common/config"
	"orchestrator/thread"
)

// ── helpers ──────────────────────────────────────────────────────────────────

// captureConn records every Write call and delegates Reads to a scriptConn.
type captureConn struct {
	*scriptConn
	mu      sync.Mutex
	written []string
}

func newCaptureConn(responses ...string) *captureConn {
	return &captureConn{scriptConn: newScriptConn(responses...)}
}

func (c *captureConn) Write(p []byte) (int, error) {
	c.mu.Lock()
	c.written = append(c.written, string(p))
	c.mu.Unlock()
	return c.scriptConn.Write(p)
}

// commandsSent returns the list of commands sent by the IMAP code.
func (c *captureConn) commandsSent() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, len(c.written))
	copy(out, c.written)
	return out
}

// buildUIDFetchMsg returns a minimal UID FETCH response for a single message.
// seqNum is the IMAP sequence number (in untagged response line), uid is the
// UID echoed by the server as required by RFC 3501 §6.4.8.
func buildUIDFetchMsg(seqNum int, uid int64, msgID string) string {
	headers := fmt.Sprintf("Message-ID: %s\r\nFrom: user@example.com\r\nSubject: Test\r\n", msgID)
	body := "Test body"
	return fmt.Sprintf(
		"* %d FETCH (UID %d BODY[] {%d}\r\n%s\r\n\r\n%s)\r\nA003 OK FETCH completed\r\n",
		seqNum, uid, len(headers)+len("\r\n\r\n")+len(body), headers, body,
	)
}

// ── 1. doFetch sends "UID SEARCH", not plain "SEARCH" ────────────────────────

func TestDoFetch_SendsUIDSearch(t *testing.T) {
	conn := newCaptureConn(
		"A001 OK LOGIN\r\n",
		"* 2 EXISTS\r\n* OK [UIDVALIDITY 1000] UIDs valid\r\nA001 OK SELECT done\r\n",
		"A001 OK NOOP\r\n",
		"A002 OK UID SEARCH completed\r\n", // no UIDs
		"A001 OK LOGOUT\r\n",
	)
	p := NewPoller(nil, nil)
	mb := config.MailboxConfig{Username: "u", Password: "p", IMAPHost: "h"}
	if _, err := p.doFetch(context.Background(), conn, mb, 0); err != nil {
		t.Fatalf("doFetch error: %v", err)
	}

	cmds := conn.commandsSent()
	found := false
	for _, cmd := range cmds {
		if strings.Contains(cmd, "UID SEARCH") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected UID SEARCH in commands, got: %v", cmds)
	}

	// Confirm plain "SEARCH UNSEEN" is NOT sent (without UID prefix).
	for _, cmd := range cmds {
		bare := strings.TrimLeft(cmd, "A0123456789 ")
		if strings.HasPrefix(bare, "SEARCH") {
			t.Errorf("plain SEQ SEARCH sent instead of UID SEARCH: %q", cmd)
		}
	}
}

// ── 2. doFetch sends "UID FETCH", not plain "FETCH" ──────────────────────────

func TestDoFetch_SendsUIDFetch(t *testing.T) {
	fetchResp := buildUIDFetchMsg(1, 42, "<msg-42@test.cz>")
	conn := newCaptureConn(
		"A001 OK LOGIN\r\n",
		"* 1 EXISTS\r\n* OK [UIDVALIDITY 1000] UIDs valid\r\nA001 OK SELECT done\r\n",
		"A001 OK NOOP\r\n",
		"* SEARCH 42\r\nA002 OK UID SEARCH\r\n",
		fetchResp,
		"A001 OK LOGOUT\r\n",
	)
	p := NewPoller(nil, nil)
	mb := config.MailboxConfig{Username: "u", Password: "p", IMAPHost: "h"}
	result, err := p.doFetch(context.Background(), conn, mb, 0)
	if err != nil {
		t.Fatalf("doFetch error: %v", err)
	}
	if len(result.Messages) == 0 {
		t.Fatal("expected at least one message")
	}

	cmds := conn.commandsSent()
	found := false
	for _, cmd := range cmds {
		if strings.Contains(cmd, "UID FETCH") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected UID FETCH in commands, got: %v", cmds)
	}

	// Confirm plain "FETCH <seq> (BODY.PEEK[])" without UID prefix is NOT sent.
	for _, cmd := range cmds {
		bare := strings.TrimLeft(cmd, "A0123456789 ")
		if strings.HasPrefix(bare, "FETCH ") {
			t.Errorf("plain SEQ FETCH sent instead of UID FETCH: %q", cmd)
		}
	}
}

// ── 3. UID SEARCH happy path — single UID returned and fetched ────────────────

func TestDoFetch_UIDSearch_SingleUID(t *testing.T) {
	fetchResp := buildUIDFetchMsg(1, 77, "<single@test.cz>")
	conn := newScriptConn(
		"A001 OK LOGIN\r\n",
		"* 1 EXISTS\r\n* OK [UIDVALIDITY 5000] UIDs valid\r\nA001 OK SELECT done\r\n",
		"A001 OK NOOP\r\n",
		"* SEARCH 77\r\nA002 OK UID SEARCH\r\n",
		fetchResp,
		"A001 OK LOGOUT\r\n",
	)
	p := NewPoller(nil, nil)
	mb := config.MailboxConfig{Username: "u", Password: "p", IMAPHost: "h"}
	result, err := p.doFetch(context.Background(), conn, mb, 0)
	if err != nil {
		t.Fatalf("doFetch error: %v", err)
	}
	if len(result.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(result.Messages))
	}
	if result.Messages[0].UID != 77 {
		t.Errorf("UID = %d, want 77", result.Messages[0].UID)
	}
}

// ── 4. Multiple UIDs returned out of order — sorted ascending ─────────────────

func TestDoFetch_UIDSearch_OutOfOrder_SortedAscending(t *testing.T) {
	// Server returns UIDs 30, 10, 20 (out of order). They must be fetched
	// and stored in ascending order: 10, 20, 30.
	conn := newScriptConn(
		"A001 OK LOGIN\r\n",
		"* 3 EXISTS\r\n* OK [UIDVALIDITY 1234] UIDs valid\r\nA001 OK SELECT done\r\n",
		"A001 OK NOOP\r\n",
		"* SEARCH 30 10 20\r\nA002 OK UID SEARCH\r\n",
		buildUIDFetchMsg(3, 30, "<mid-30@test.cz>"),
		buildUIDFetchMsg(1, 10, "<mid-10@test.cz>"),
		buildUIDFetchMsg(2, 20, "<mid-20@test.cz>"),
		"A001 OK LOGOUT\r\n",
	)
	p := NewPoller(nil, nil)
	mb := config.MailboxConfig{Username: "u", Password: "p", IMAPHost: "h"}
	result, err := p.doFetch(context.Background(), conn, mb, 0)
	if err != nil {
		t.Fatalf("doFetch error: %v", err)
	}
	if len(result.Messages) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(result.Messages))
	}
	// Verify ascending order: 10, 20, 30.
	wantUIDs := []int64{10, 20, 30}
	for i, want := range wantUIDs {
		if result.Messages[i].UID != want {
			t.Errorf("Messages[%d].UID = %d, want %d", i, result.Messages[i].UID, want)
		}
	}
}

// ── 5. Concurrent mailbox modification: UID stable, SEQ would fail ────────────
//
// This test simulates the core race condition of issue #878. With SEQ FETCH the
// sequence of messages 1,2,3 could shift to 1,2 after an expunge — the poller
// would then fetch the wrong message at position 2. With UID FETCH the server
// always returns the message for the requested UID regardless of what other
// clients do.
//
// We model this by having the poller fetch UIDs 10 and 20. If it used SEQ
// numbers it would send "FETCH 1" and "FETCH 2" which, after a concurrent
// expunge, would return wrong messages. With UID FETCH it sends
// "UID FETCH 10" and "UID FETCH 20" which are stable. We verify the commands
// actually contain the UID values, not the positional indices 1 and 2.
func TestDoFetch_UIDFetch_StableUnderExpunge(t *testing.T) {
	conn := newCaptureConn(
		"A001 OK LOGIN\r\n",
		"* 5 EXISTS\r\n* OK [UIDVALIDITY 9999] UIDs valid\r\nA001 OK SELECT done\r\n",
		"A001 OK NOOP\r\n",
		"* SEARCH 10 20\r\nA002 OK UID SEARCH\r\n",
		buildUIDFetchMsg(1, 10, "<stable-10@test.cz>"),
		buildUIDFetchMsg(2, 20, "<stable-20@test.cz>"),
		"A001 OK LOGOUT\r\n",
	)
	p := NewPoller(nil, nil)
	mb := config.MailboxConfig{Username: "u", Password: "p", IMAPHost: "h"}
	if _, err := p.doFetch(context.Background(), conn, mb, 0); err != nil {
		t.Fatalf("doFetch error: %v", err)
	}

	cmds := conn.commandsSent()
	// Both FETCH commands must reference the UID values 10 and 20, not the
	// sequence numbers 1 and 2.
	uidFetches := 0
	for _, cmd := range cmds {
		if strings.Contains(cmd, "UID FETCH") {
			uidFetches++
			if strings.Contains(cmd, "UID FETCH 10") || strings.Contains(cmd, "UID FETCH 20") {
				// Good — referencing by UID.
			} else {
				t.Errorf("UID FETCH command does not reference expected UIDs: %q", cmd)
			}
		}
	}
	if uidFetches != 2 {
		t.Errorf("expected 2 UID FETCH commands, got %d; commands: %v", uidFetches, cmds)
	}
}

// ── 6. Server does not support UID SEARCH — fallback to SEQ SEARCH ────────────

func TestDoFetch_UIDSearchNotSupported_FallbackToSEQ(t *testing.T) {
	// Server returns BAD on UID SEARCH (first commandResponse call).
	// Fallback: plain SEARCH UNSEEN (second commandResponse call) succeeds.
	conn := newCaptureConn(
		"A001 OK LOGIN\r\n",
		"* 2 EXISTS\r\n* OK [UIDVALIDITY 1] UIDs valid\r\nA001 OK SELECT done\r\n",
		"A001 OK NOOP\r\n",
		"A002 BAD UID not supported\r\n",         // UID SEARCH fails
		"* SEARCH 3\r\nA002 OK SEARCH\r\n",        // SEQ SEARCH succeeds
		buildUIDFetchMsg(1, 3, "<fallback@test.cz>"), // fetch by "UID" 3 (actually SEQ here)
		"A001 OK LOGOUT\r\n",
	)
	p := NewPoller(nil, nil)
	mb := config.MailboxConfig{Username: "u", Password: "p", IMAPHost: "h"}

	// Should NOT return an error — fallback must be transparent.
	result, err := p.doFetch(context.Background(), conn, mb, 0)
	if err != nil {
		t.Fatalf("doFetch should not error when UID SEARCH falls back: %v", err)
	}
	// At least the message from SEQ SEARCH should have been fetched.
	if len(result.Messages) == 0 {
		t.Fatal("expected at least 1 message after fallback to SEQ SEARCH")
	}

	// Confirm both UID SEARCH and fallback SEARCH were sent.
	cmds := conn.commandsSent()
	var hasUIDSearch, hasSEQSearch bool
	for _, cmd := range cmds {
		if strings.Contains(cmd, "UID SEARCH") {
			hasUIDSearch = true
		}
		// Fallback: command contains "SEARCH UNSEEN" but NOT "UID SEARCH"
		if strings.Contains(cmd, "SEARCH UNSEEN") && !strings.Contains(cmd, "UID SEARCH") {
			hasSEQSearch = true
		}
	}
	if !hasUIDSearch {
		t.Error("expected UID SEARCH to be attempted first")
	}
	if !hasSEQSearch {
		t.Error("expected fallback SEQ SEARCH to be sent after UID SEARCH failure")
	}
}

// ── 7. Empty UID set — no UID FETCH attempted ─────────────────────────────────

func TestDoFetch_UIDSearch_EmptyResult_NoFetch(t *testing.T) {
	conn := newCaptureConn(
		"A001 OK LOGIN\r\n",
		"* 0 EXISTS\r\n* OK [UIDVALIDITY 1] UIDs valid\r\nA001 OK SELECT done\r\n",
		"A001 OK NOOP\r\n",
		"A002 OK UID SEARCH completed\r\n", // no UIDs in response
		"A001 OK LOGOUT\r\n",
	)
	p := NewPoller(nil, nil)
	mb := config.MailboxConfig{Username: "u", Password: "p", IMAPHost: "h"}
	result, err := p.doFetch(context.Background(), conn, mb, 0)
	if err != nil {
		t.Fatalf("doFetch error: %v", err)
	}
	if len(result.Messages) != 0 {
		t.Errorf("expected 0 messages on empty UID set, got %d", len(result.Messages))
	}
	// No UID FETCH should have been sent.
	cmds := conn.commandsSent()
	for _, cmd := range cmds {
		if strings.Contains(cmd, "UID FETCH") {
			t.Errorf("UID FETCH should not be sent for empty UID set: %q", cmd)
		}
	}
}

// ── 8. UID FETCH write error for one message — continues with others ──────────

func TestDoFetch_UIDFetch_PartialFailure_Continues(t *testing.T) {
	// Two UIDs: 5 and 6. UID FETCH for 5 succeeds; we simulate failure by
	// returning an invalid/empty fetch response for 6 — poller must still
	// return the successfully fetched message.
	conn := newScriptConn(
		"A001 OK LOGIN\r\n",
		"* 2 EXISTS\r\n* OK [UIDVALIDITY 3] UIDs valid\r\nA001 OK SELECT done\r\n",
		"A001 OK NOOP\r\n",
		"* SEARCH 5 6\r\nA002 OK UID SEARCH\r\n",
		buildUIDFetchMsg(1, 5, "<good-5@test.cz>"),
		// Empty / malformed response for UID 6 — fetchMessageByUID returns nil msg
		"A003 OK FETCH completed\r\n",
		"A001 OK LOGOUT\r\n",
	)
	p := NewPoller(nil, nil)
	mb := config.MailboxConfig{Username: "u", Password: "p", IMAPHost: "h"}
	result, err := p.doFetch(context.Background(), conn, mb, 0)
	if err != nil {
		t.Fatalf("doFetch error: %v", err)
	}
	// At least the message for UID 5 must be present.
	if len(result.Messages) == 0 {
		t.Fatal("expected at least 1 message when only one UID fetch fails")
	}
}

// ── 9. Race detector: concurrent pollOnceInjected calls ───────────────────────

func TestDoFetch_ConcurrentPollers_UIDFetch_RaceClean(t *testing.T) {
	const goroutines = 4
	var wg sync.WaitGroup
	errs := make(chan error, goroutines)

	scripts := []string{
		"A001 OK LOGIN\r\n",
		"* 1 EXISTS\r\n* OK [UIDVALIDITY 42] UIDs valid\r\nA001 OK SELECT done\r\n",
		"A001 OK NOOP\r\n",
		"* SEARCH 100\r\nA002 OK UID SEARCH\r\n",
		buildUIDFetchMsg(1, 100, "<race-uid@test.cz>"),
		"A001 OK LOGOUT\r\n",
	}

	store := newMockUIDStore()

	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			addr := fmt.Sprintf("box%d@race.cz", idx)
			p := NewPoller([]config.MailboxConfig{{
				Address:  addr,
				IMAPHost: "fake.imap",
				IMAPPort: 143,
				Username: "u",
				Password: "p",
			}}, nil).WithUIDValidityStore(store)

			conn := newScriptConn(scripts...)
			_, err := p.pollOnceInjected(
				context.Background(),
				func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) { return conn, nil },
				func(_ thread.RawInbound) {},
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

// ── 10. UID SEARCH with SINCE clause ─────────────────────────────────────────

func TestDoFetch_UIDSearch_WithSINCE_CommandContainsUIDPrefix(t *testing.T) {
	conn := newCaptureConn(
		"A001 OK LOGIN\r\n",
		"* 0 EXISTS\r\n* OK [UIDVALIDITY 7] UIDs valid\r\nA001 OK SELECT done\r\n",
		"A001 OK NOOP\r\n",
		"A002 OK UID SEARCH completed\r\n",
		"A001 OK LOGOUT\r\n",
	)
	p := NewPoller(nil, nil)
	p.lastPoll = time.Now().Add(-24 * time.Hour) // non-zero → SINCE clause
	mb := config.MailboxConfig{Username: "u", Password: "p", IMAPHost: "h"}
	if _, err := p.doFetch(context.Background(), conn, mb, 0); err != nil {
		t.Fatalf("doFetch error: %v", err)
	}

	cmds := conn.commandsSent()
	found := false
	for _, cmd := range cmds {
		// Must be "UID SEARCH UNSEEN SINCE <date>", not "SEARCH UNSEEN SINCE".
		if strings.Contains(cmd, "UID SEARCH UNSEEN SINCE") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected 'UID SEARCH UNSEEN SINCE' in commands, got: %v", cmds)
	}
}

// ── 11. fetchMessageByUID happy path — command contains "UID FETCH" ───────────

func TestFetchMessageByUID_CommandLine(t *testing.T) {
	fetchResp := buildUIDFetchMsg(1, 99, "<uid-99@test.cz>")
	conn := newCaptureConn(fetchResp)

	msg, err := fetchMessageByUID(conn, "99")
	if err != nil {
		t.Fatalf("fetchMessageByUID error: %v", err)
	}
	if msg == nil {
		t.Fatal("expected non-nil message")
	}

	cmds := conn.commandsSent()
	found := false
	for _, cmd := range cmds {
		if strings.Contains(cmd, "UID FETCH 99") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected 'UID FETCH 99' in commands, got: %v", cmds)
	}
}

// ── 12. fetchMessageByUID write error returns error ───────────────────────────

func TestFetchMessageByUID_WriteError(t *testing.T) {
	conn := &errConn{} // Write always fails
	_, err := fetchMessageByUID(conn, "1")
	if err == nil {
		t.Fatal("expected write error from fetchMessageByUID")
	}
}

// ── 13. Watermark advances correctly with UID-sorted messages ─────────────────

func TestPollOnce_UIDSorted_WatermarkAdvancesCorrectly(t *testing.T) {
	// Server returns UIDs 30, 10, 20 (out of order). After sorting + processing,
	// the watermark must advance to 30 (the highest UID).
	const validity = int64(111)
	store := newMockUIDStore()

	scripts := []string{
		"A001 OK LOGIN\r\n",
		fmt.Sprintf("* 3 EXISTS\r\n* OK [UIDVALIDITY %d] UIDs valid\r\nA001 OK SELECT done\r\n", validity),
		"A001 OK NOOP\r\n",
		"* SEARCH 30 10 20\r\nA002 OK UID SEARCH\r\n",
		buildUIDFetchMsg(3, 30, "<m30@test.cz>"),
		buildUIDFetchMsg(1, 10, "<m10@test.cz>"),
		buildUIDFetchMsg(2, 20, "<m20@test.cz>"),
		"A001 OK LOGOUT\r\n",
	}

	var processed int32
	p := NewPoller([]config.MailboxConfig{{
		Address:  "sort@test.cz",
		IMAPHost: "fake.imap",
		IMAPPort: 143,
		Username: "u",
		Password: "p",
	}}, nil).WithUIDValidityStore(store)

	conn := newScriptConn(scripts...)
	results, err := p.pollOnceInjected(
		context.Background(),
		func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) { return conn, nil },
		func(_ thread.RawInbound) { atomic.AddInt32(&processed, 1) },
	)
	if err != nil {
		t.Fatalf("pollOnceInjected error: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if results[0].Fetched != 3 {
		t.Errorf("Fetched = %d, want 3", results[0].Fetched)
	}

	// Watermark must be 30 (max UID), not 20 (which would result if sort was wrong).
	store.mu.Lock()
	state := store.data["sort@test.cz"]
	store.mu.Unlock()
	if state[1] != 30 {
		t.Errorf("stored watermark = %d, want 30 (highest UID after sort)", state[1])
	}
}

// Silent-loss guard (RCA 2026-06-01): if processing UID 20 FAILS while 10 and 30
// succeed, the watermark must NOT advance to 30 — it must cap at 19 so UID 20
// (and 30) are re-fetched next poll. Before the fix the watermark jumped to the
// highest success (30) and the failed message was skipped forever.
func TestPollOnce_ProcessFailure_WatermarkCappedBelowFailedUID(t *testing.T) {
	const validity = int64(222)
	store := newMockUIDStore()

	scripts := []string{
		"A001 OK LOGIN\r\n",
		fmt.Sprintf("* 3 EXISTS\r\n* OK [UIDVALIDITY %d] UIDs valid\r\nA001 OK SELECT done\r\n", validity),
		"A001 OK NOOP\r\n",
		"* SEARCH 10 20 30\r\nA002 OK UID SEARCH\r\n",
		buildUIDFetchMsg(1, 10, "<m10@test.cz>"),
		buildUIDFetchMsg(2, 20, "<m20@test.cz>"),
		buildUIDFetchMsg(3, 30, "<m30@test.cz>"),
		"A001 OK LOGOUT\r\n",
	}

	p := NewPoller([]config.MailboxConfig{{
		Address:  "fail@test.cz",
		IMAPHost: "fake.imap",
		IMAPPort: 143,
		Username: "u",
		Password: "p",
	}}, nil).WithUIDValidityStore(store)

	conn := newScriptConn(scripts...)
	results, err := p.pollOnceInjectedErr(
		context.Background(),
		func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) { return conn, nil },
		func(r thread.RawInbound) error {
			if r.MessageID == "<m20@test.cz>" {
				return errors.New("simulated persist failure")
			}
			return nil
		},
	)
	if err != nil {
		t.Fatalf("pollOnceInjectedErr error: %v", err)
	}
	if len(results) != 1 || results[0].Errors != 1 {
		t.Fatalf("expected 1 result with 1 error, got %+v", results)
	}

	store.mu.Lock()
	state := store.data["fail@test.cz"]
	store.mu.Unlock()
	if state[1] != 19 {
		t.Errorf("stored watermark = %d, want 19 (capped below failed UID 20, not advanced to 30)", state[1])
	}
}
