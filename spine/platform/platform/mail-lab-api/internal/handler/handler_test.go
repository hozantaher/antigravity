package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"mail-lab-api/internal/exec"
)

// fakeRunner records every call and returns scripted outputs/errors.
// Mailboxes is the in-memory account store kept in sync with ExpectedCalls
// so the handler's exists-check via `setup email list` reflects state.
type fakeRunner struct {
	mu             sync.Mutex
	calls          []call
	stdinCalls     []stdinCall
	mailboxes      map[string]bool // canonical "exists" set
	failOn         map[string]error
	stdinFailOn    map[string]error
}

type stdinCall struct {
	Name  string
	Args  []string
	Stdin []byte
}

type call struct {
	Name string
	Args []string
}

func newFakeRunner() *fakeRunner {
	return &fakeRunner{
		mailboxes: map[string]bool{},
		failOn:    map[string]error{},
	}
}

func (f *fakeRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call{Name: name, Args: append([]string(nil), args...)})

	// Branch on the docker-mailserver subcommand.
	// Form: docker exec <container> setup email <action> [args]
	if len(args) >= 5 && args[0] == "exec" && args[2] == "setup" && args[3] == "email" {
		action := args[4]
		switch action {
		case "list":
			out := bytes.Buffer{}
			for addr := range f.mailboxes {
				out.WriteString("* " + addr + " ( 0 / ~ ) [0 messages]\n")
			}
			return out.String(), nil
		case "add":
			if len(args) < 7 {
				return "", &runnerError{msg: "add: missing args"}
			}
			addr := args[5]
			if err, ok := f.failOn["add:"+addr]; ok {
				return "", err
			}
			if f.mailboxes[addr] {
				return "", &runnerError{msg: "already exists"}
			}
			f.mailboxes[addr] = true
			return "User '" + addr + "' added\n", nil
		case "del":
			// args: exec <container> setup email del -y <addr>  (7 elements)
			if len(args) < 7 {
				return "", &runnerError{msg: "del: missing args"}
			}
			addr := args[6]
			if err, ok := f.failOn["del:"+addr]; ok {
				return "", err
			}
			delete(f.mailboxes, addr)
			return "User '" + addr + "' deleted\n", nil
		}
	}
	// doveadm fetch — form: docker exec <container> doveadm fetch -u <addr> ...
	if len(args) >= 6 && args[0] == "exec" && args[2] == "doveadm" && args[3] == "fetch" {
		// Return empty output (no messages) for all mailboxes in ML1 unit tests.
		return "", nil
	}
	return "", nil
}

type runnerError struct{ msg string }

func (e *runnerError) Error() string { return e.msg }

// helper builds a server with the fake runner + key ready for httptest.
func newTestServer(t *testing.T) (*Server, *fakeRunner) {
	t.Helper()
	r := newFakeRunner()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := NewServer("test-key", r, logger)
	return s, r
}

// ─────────────────────────────────────────────────────────────────────
// Brutal test suite — 14 assertions for ML1.5 (#217).
// ─────────────────────────────────────────────────────────────────────

// 1. POST without API key → 401.
func TestPOST_NoKey_Unauthorized(t *testing.T) {
	s, _ := newTestServer(t)
	req := httptest.NewRequest("POST", "/v1/mailbox", strings.NewReader(`{"address":"a@seznam.lab","password":"p"}`))
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status: %d, want 401", rec.Code)
	}
}

// 2. POST with wrong key → 401 (constant-time guarded).
func TestPOST_WrongKey_Unauthorized(t *testing.T) {
	s, _ := newTestServer(t)
	req := httptest.NewRequest("POST", "/v1/mailbox", strings.NewReader(`{"address":"a@seznam.lab","password":"p"}`))
	req.Header.Set("X-Lab-Api-Key", "wrong-key")
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status: %d, want 401", rec.Code)
	}
}

// 3. POST with correct key + body → 201 + Location header.
func TestPOST_Success(t *testing.T) {
	s, r := newTestServer(t)
	req := httptest.NewRequest("POST", "/v1/mailbox", strings.NewReader(`{"address":"alice@seznam.lab","password":"hunter2"}`))
	req.Header.Set("X-Lab-Api-Key", "test-key")
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status: %d, want 201, body=%s", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); loc != "/v1/mailbox/alice@seznam.lab" {
		t.Errorf("Location: %q", loc)
	}
	if !r.mailboxes["alice@seznam.lab"] {
		t.Error("mailbox not in fake state after POST")
	}
}

// 4. POST duplicate → 409.
func TestPOST_Duplicate_Conflict(t *testing.T) {
	s, r := newTestServer(t)
	r.mailboxes["bob@seznam.lab"] = true
	req := httptest.NewRequest("POST", "/v1/mailbox", strings.NewReader(`{"address":"bob@seznam.lab","password":"p"}`))
	req.Header.Set("X-Lab-Api-Key", "test-key")
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Errorf("status: %d, want 409", rec.Code)
	}
}

// 5. POST malformed JSON → 400.
func TestPOST_MalformedJSON(t *testing.T) {
	s, _ := newTestServer(t)
	req := httptest.NewRequest("POST", "/v1/mailbox", strings.NewReader(`{not-json`))
	req.Header.Set("X-Lab-Api-Key", "test-key")
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status: %d, want 400", rec.Code)
	}
}

// 6. POST missing address or password → 400.
func TestPOST_MissingFields(t *testing.T) {
	s, _ := newTestServer(t)
	req := httptest.NewRequest("POST", "/v1/mailbox", strings.NewReader(`{"address":"","password":"x"}`))
	req.Header.Set("X-Lab-Api-Key", "test-key")
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status: %d, want 400", rec.Code)
	}
}

// 7. POST invalid email → 400.
func TestPOST_InvalidEmail(t *testing.T) {
	s, _ := newTestServer(t)
	req := httptest.NewRequest("POST", "/v1/mailbox", strings.NewReader(`{"address":"not-an-email","password":"p"}`))
	req.Header.Set("X-Lab-Api-Key", "test-key")
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status: %d, want 400", rec.Code)
	}
}

// 8. POST unsupported domain → 400.
func TestPOST_UnsupportedDomain(t *testing.T) {
	s, _ := newTestServer(t)
	req := httptest.NewRequest("POST", "/v1/mailbox", strings.NewReader(`{"address":"x@unknown.lab","password":"p"}`))
	req.Header.Set("X-Lab-Api-Key", "test-key")
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status: %d, want 400", rec.Code)
	}
}

// 9. GET non-existent mailbox → 404.
func TestGET_NotFound(t *testing.T) {
	s, _ := newTestServer(t)
	req := httptest.NewRequest("GET", "/v1/mailbox/missing@seznam.lab", nil)
	req.Header.Set("X-Lab-Api-Key", "test-key")
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status: %d, want 404", rec.Code)
	}
}

// 10. GET existing mailbox → 200 + correct payload.
func TestGET_Found(t *testing.T) {
	s, r := newTestServer(t)
	r.mailboxes["carol@seznam.lab"] = true
	req := httptest.NewRequest("GET", "/v1/mailbox/carol@seznam.lab", nil)
	req.Header.Set("X-Lab-Api-Key", "test-key")
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
	var got mailboxResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Address != "carol@seznam.lab" || got.Domain != "seznam.lab" {
		t.Errorf("payload: %+v", got)
	}
}

// 11. DELETE existing mailbox → 204 + state cleared.
func TestDELETE_Success(t *testing.T) {
	s, r := newTestServer(t)
	r.mailboxes["dan@seznam.lab"] = true
	req := httptest.NewRequest("DELETE", "/v1/mailbox/dan@seznam.lab", nil)
	req.Header.Set("X-Lab-Api-Key", "test-key")
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("status: %d, want 204", rec.Code)
	}
	if r.mailboxes["dan@seznam.lab"] {
		t.Error("mailbox still in state after DELETE")
	}
}

// 12. DELETE non-existent → 404.
func TestDELETE_NotFound(t *testing.T) {
	s, _ := newTestServer(t)
	req := httptest.NewRequest("DELETE", "/v1/mailbox/ghost@seznam.lab", nil)
	req.Header.Set("X-Lab-Api-Key", "test-key")
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status: %d, want 404", rec.Code)
	}
}

// 13. /healthz needs no auth + reports uptime_seconds.
func TestHealthz_NoAuthRequired(t *testing.T) {
	s, _ := newTestServer(t)
	req := httptest.NewRequest("GET", "/healthz", nil)
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: %d, want 200", rec.Code)
	}
	var got healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Status != "ok" {
		t.Errorf("status field: %q", got.Status)
	}
	if got.UptimeSeconds < 0 {
		t.Errorf("uptime negative: %d", got.UptimeSeconds)
	}
}

// 14. Race: 100 concurrent POSTs for distinct addresses → 100 mailboxes.
// Catches any global-mutex bottleneck or shared-state corruption.
func TestPOST_ConcurrentDistinctAddresses(t *testing.T) {
	s, r := newTestServer(t)

	const N = 100
	var wg sync.WaitGroup
	var ok int64
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body := strings.NewReader(`{"address":"u` + itoa(i) + `@seznam.lab","password":"p"}`)
			req := httptest.NewRequest("POST", "/v1/mailbox", body)
			req.Header.Set("X-Lab-Api-Key", "test-key")
			rec := httptest.NewRecorder()
			s.Routes().ServeHTTP(rec, req)
			if rec.Code == http.StatusCreated {
				atomic.AddInt64(&ok, 1)
			}
		}(i)
	}
	wg.Wait()
	if ok != N {
		t.Errorf("only %d/%d succeeded", ok, N)
	}
	if len(r.mailboxes) != N {
		t.Errorf("state has %d mailboxes, want %d", len(r.mailboxes), N)
	}
}

// 15b. GET messages on non-existent mailbox → 404.
func TestGETMessages_NotFound(t *testing.T) {
	s, _ := newTestServer(t)
	req := httptest.NewRequest("GET", "/v1/mailbox/ghost@seznam.lab/messages", nil)
	req.Header.Set("X-Lab-Api-Key", "test-key")
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status: %d, want 404", rec.Code)
	}
}

// 15c. GET messages on empty mailbox → 200 with [] (not null).
func TestGETMessages_EmptyMailbox(t *testing.T) {
	s, r := newTestServer(t)
	r.mailboxes["empty@seznam.lab"] = true
	req := httptest.NewRequest("GET", "/v1/mailbox/empty@seznam.lab/messages", nil)
	req.Header.Set("X-Lab-Api-Key", "test-key")
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
	// Must be [] not null.
	body := strings.TrimSpace(rec.Body.String())
	if body == "null" {
		t.Error("GET messages returned null, want []")
	}
	var msgs []messageEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &msgs); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if msgs == nil {
		t.Error("messages slice is nil after unmarshal, want empty slice")
	}
}

// 15d. parseDoveadmFetch handles multi-record output correctly.
func TestParseDoveadmFetch(t *testing.T) {
	raw := "uid: 1\nfrom: alice@example.com\nsubject: Hello\ndate: 2026-05-01 10:00:00 +0000\nsize: 1234\n\n" +
		"uid: 2\nfrom: bob@example.com\nsubject: World\ndate: 2026-05-02 12:00:00 +0000\nsize: 567\n\n"
	msgs := parseDoveadmFetch(raw)
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2", len(msgs))
	}
	if msgs[0].UID != "1" || msgs[0].SizeBytes != 1234 {
		t.Errorf("msg[0]: %+v", msgs[0])
	}
	if msgs[1].UID != "2" || msgs[1].Subject != "World" {
		t.Errorf("msg[1]: %+v", msgs[1])
	}
}

// 15e. parseDoveadmFetch on empty string returns [] not nil.
func TestParseDoveadmFetch_Empty(t *testing.T) {
	msgs := parseDoveadmFetch("")
	if msgs == nil {
		t.Error("nil slice returned for empty input")
	}
	if len(msgs) != 0 {
		t.Errorf("expected 0 messages, got %d", len(msgs))
	}
}

// 15. Slog op tag is emitted on creation. Source-level audit (no real exec).
// Memory rule: every slog.Error/Warn/Info on the admin path must carry
// `op=mail-lab-api.<func>/<branch>` for Sentry grouping discipline.
func TestSlogOpTag_PresentOnCreate(t *testing.T) {
	src := mustReadSource(t, "handler.go")
	want := []string{
		`"op", "mail-lab-api.handleCreate"`,
		`"op", "mail-lab-api.handleDelete"`,
		`"op", "mail-lab-api.handleCreate/exec"`,
	}
	for _, w := range want {
		if !strings.Contains(src, w) {
			t.Errorf("handler.go missing slog op tag: %q", w)
		}
	}
}

// ── tiny helpers (avoid pulling strconv just for itoa in test) ─────────

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [16]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func mustReadSource(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(b)
}

func (f *fakeRunner) RunWithStdin(ctx context.Context, stdin []byte, name string, args ...string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stdinCalls = append(f.stdinCalls, stdinCall{
		Name:  name,
		Args:  append([]string(nil), args...),
		Stdin: append([]byte(nil), stdin...),
	})
	key := name + " " + strings.Join(args, " ")
	if err, ok := f.stdinFailOn[key]; ok {
		return "", err
	}
	return "", nil
}

// Compile-time guard: ensure exec.Runner is satisfied by fakeRunner.
var _ exec.Runner = (*fakeRunner)(nil)
