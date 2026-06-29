package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"mail-lab-api/internal/exec"
)

// ════════════════════════════════════════════════════════════════════════
// Brutal coverage for ML2.3 — /v1/profile/{domain}/check endpoint.
// ════════════════════════════════════════════════════════════════════════

// stubRegistry is a hand-rolled fake of the ProfileRegistry interface.
// Captured args go into the public fields so tests can inspect dispatch.
type stubRegistry struct {
	getResp   interface{}
	getErr    error
	listResp  []interface{}
	applyResp interface{}
	applyErr  error
	checkResp struct{ d, reason string }
	checkErr  error
	dsnResp   struct {
		dsn      interface{}
		decision string
	}
	dsnErr error

	rateRecordResp struct{ count, limit int }
	rateRecordErr  error
	rateCountResp  struct{ count, limit int }
	rateCountErr   error
	greyResp       struct {
		allow  bool
		reason string
	}
	greyErr     error
	evalResp    interface{}
	evalErr     error
	quotaAddResp   struct{ used, cap int64 }
	quotaAddErr    error
	quotaGetResp   struct{ used, cap int64 }
	quotaGetErr    error
	resetErr       error
	gotResetSource string

	gotCheckDomain string
	gotCheckCtx    map[string]interface{}
	gotDSNDomain   string
	gotDSNEnv      map[string]interface{}
	gotDSNCtx      map[string]interface{}
	gotRateDomain  string
	gotRateMailbox string
	gotGreyDomain  string
	gotGreyTriple  [3]string
	gotEvalDomain  string
	gotEvalRaw     map[string]interface{}
	gotQuotaDomain  string
	gotQuotaMailbox string
	gotQuotaBytes   int64
}

func (s *stubRegistry) Get(_ string) (interface{}, error) { return s.getResp, s.getErr }
func (s *stubRegistry) List() []interface{}               { return s.listResp }
func (s *stubRegistry) Apply(_ string, _ map[string]interface{}) (interface{}, error) {
	return s.applyResp, s.applyErr
}
func (s *stubRegistry) Check(domain string, ctx map[string]interface{}) (string, string, error) {
	s.gotCheckDomain = domain
	s.gotCheckCtx = ctx
	return s.checkResp.d, s.checkResp.reason, s.checkErr
}
func (s *stubRegistry) PreviewDSN(domain string, env, ctx map[string]interface{}) (interface{}, string, error) {
	s.gotDSNDomain = domain
	s.gotDSNEnv = env
	s.gotDSNCtx = ctx
	return s.dsnResp.dsn, s.dsnResp.decision, s.dsnErr
}
func (s *stubRegistry) RateRecord(domain, mailbox string) (int, int, error) {
	s.gotRateDomain = domain
	s.gotRateMailbox = mailbox
	return s.rateRecordResp.count, s.rateRecordResp.limit, s.rateRecordErr
}
func (s *stubRegistry) RateCount(domain, mailbox string) (int, int, error) {
	s.gotRateDomain = domain
	s.gotRateMailbox = mailbox
	return s.rateCountResp.count, s.rateCountResp.limit, s.rateCountErr
}
func (s *stubRegistry) GreylistAllow(domain, ip, sender, recipient string) (bool, string, error) {
	s.gotGreyDomain = domain
	s.gotGreyTriple = [3]string{ip, sender, recipient}
	return s.greyResp.allow, s.greyResp.reason, s.greyErr
}
func (s *stubRegistry) EvaluateFromMap(domain string, raw map[string]interface{}) (interface{}, error) {
	s.gotEvalDomain = domain
	s.gotEvalRaw = raw
	return s.evalResp, s.evalErr
}
func (s *stubRegistry) QuotaAdd(domain, mailbox string, bytes int64) (int64, int64, error) {
	s.gotQuotaDomain = domain
	s.gotQuotaMailbox = mailbox
	s.gotQuotaBytes = bytes
	return s.quotaAddResp.used, s.quotaAddResp.cap, s.quotaAddErr
}
func (s *stubRegistry) QuotaUsage(domain, mailbox string) (int64, int64, error) {
	s.gotQuotaDomain = domain
	s.gotQuotaMailbox = mailbox
	return s.quotaGetResp.used, s.quotaGetResp.cap, s.quotaGetErr
}
func (s *stubRegistry) ResetAll(source string) error {
	s.gotResetSource = source
	return s.resetErr
}

func newCheckServer(reg *stubRegistry) *Server {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer("", exec.DockerRunner{}, logger).WithProfiles(reg)
	return srv
}

func doCheck(t *testing.T, srv *Server, domain string, body []byte) *http.Response {
	t.Helper()
	req := httptest.NewRequest("POST", "/v1/profile/"+domain+"/check", bytes.NewReader(body))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	return w.Result()
}

// 1. 200 + decision body on happy path.
func TestS23H_Check_Happy(t *testing.T) {
	reg := &stubRegistry{}
	reg.checkResp.d = "accept"
	srv := newCheckServer(reg)

	resp := doCheck(t, srv, "seznam.lab", []byte(`{"size_bytes":100}`))
	if resp.StatusCode != 200 {
		t.Fatalf("status %d, want 200", resp.StatusCode)
	}
	var body checkResponse
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if body.Decision != "accept" {
		t.Errorf("decision %q, want accept", body.Decision)
	}
}

// 2. Domain extracted into stub call (path routing).
func TestS23H_Check_PassesDomain(t *testing.T) {
	reg := &stubRegistry{}
	reg.checkResp.d = "accept"
	srv := newCheckServer(reg)

	doCheck(t, srv, "outlook.lab", []byte(`{}`))
	if reg.gotCheckDomain != "outlook.lab" {
		t.Errorf("got domain %q, want outlook.lab", reg.gotCheckDomain)
	}
}

// 3. Context body unmarshaled and forwarded.
func TestS23H_Check_PassesContext(t *testing.T) {
	reg := &stubRegistry{}
	reg.checkResp.d = "reject"
	reg.checkResp.reason = "test"
	srv := newCheckServer(reg)

	doCheck(t, srv, "seznam.lab", []byte(`{"size_bytes":42,"sender_ip":"1.2.3.4"}`))
	if v, ok := reg.gotCheckCtx["sender_ip"]; !ok || v != "1.2.3.4" {
		t.Errorf("sender_ip not forwarded: %v", reg.gotCheckCtx)
	}
}

// 4. 404 on unknown domain (registry returns ErrUnknownDomain shape).
func TestS23H_Check_Unknown_Returns404(t *testing.T) {
	reg := &stubRegistry{checkErr: errors.New("unknown")}
	srv := newCheckServer(reg)
	resp := doCheck(t, srv, "never.lab", []byte(`{}`))
	if resp.StatusCode != 404 {
		t.Errorf("status %d, want 404", resp.StatusCode)
	}
}

// 5. 400 on malformed JSON body.
func TestS23H_Check_MalformedBody_Returns400(t *testing.T) {
	reg := &stubRegistry{}
	reg.checkResp.d = "accept"
	srv := newCheckServer(reg)
	resp := doCheck(t, srv, "seznam.lab", []byte(`{not json`))
	if resp.StatusCode != 400 {
		t.Errorf("status %d, want 400", resp.StatusCode)
	}
}

// 6. Empty body (zero ContentLength) accepted as nil context.
func TestS23H_Check_EmptyBody_OK(t *testing.T) {
	reg := &stubRegistry{}
	reg.checkResp.d = "accept"
	srv := newCheckServer(reg)
	req := httptest.NewRequest("POST", "/v1/profile/seznam.lab/check", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 200 {
		t.Errorf("status %d, want 200", w.Result().StatusCode)
	}
}

// 7. Reason field present in 200 response when set.
func TestS23H_Check_ReasonInBody(t *testing.T) {
	reg := &stubRegistry{}
	reg.checkResp.d = "reject"
	reg.checkResp.reason = "size exceeded"
	srv := newCheckServer(reg)

	resp := doCheck(t, srv, "seznam.lab", []byte(`{}`))
	var body checkResponse
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if body.Reason != "size exceeded" {
		t.Errorf("reason %q, want 'size exceeded'", body.Reason)
	}
}

// 8. Endpoint is auth-gated (X-Lab-Api-Key required when set).
func TestS23H_Check_RequiresAuth(t *testing.T) {
	reg := &stubRegistry{}
	reg.checkResp.d = "accept"
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer("secret-key", exec.DockerRunner{}, logger).WithProfiles(reg)

	req := httptest.NewRequest("POST", "/v1/profile/seznam.lab/check", bytes.NewReader([]byte(`{}`)))
	req.Header.Set("Content-Type", "application/json")
	// no X-Lab-Api-Key
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 401 {
		t.Errorf("no auth got %d, want 401", w.Result().StatusCode)
	}
}

// 9. Endpoint disabled when no Profiles registry attached.
func TestS23H_Check_NoRegistry_Returns404(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer("", exec.DockerRunner{}, logger) // no .WithProfiles
	req := httptest.NewRequest("POST", "/v1/profile/seznam.lab/check", bytes.NewReader([]byte(`{}`)))
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	// stdlib mux returns 404 when path not registered
	if w.Result().StatusCode != 404 {
		t.Errorf("disabled got %d, want 404", w.Result().StatusCode)
	}
}

// 10. Response Content-Type is application/json.
func TestS23H_Check_ContentType(t *testing.T) {
	reg := &stubRegistry{}
	reg.checkResp.d = "accept"
	srv := newCheckServer(reg)

	resp := doCheck(t, srv, "seznam.lab", []byte(`{}`))
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("content-type %q, want application/json", ct)
	}
}

// ── ML2.4 — DSN preview endpoint ──────────────────────────────────────

func doDSN(t *testing.T, srv *Server, domain string, body []byte) *http.Response {
	t.Helper()
	req := httptest.NewRequest("POST", "/v1/profile/"+domain+"/dsn", bytes.NewReader(body))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	return w.Result()
}

// 1. 200 + dsn body on happy path.
func TestS24H_DSN_Happy(t *testing.T) {
	reg := &stubRegistry{}
	reg.dsnResp.decision = "reject"
	reg.dsnResp.dsn = map[string]string{"status_code": "5.7.1"}
	srv := newCheckServer(reg)

	resp := doDSN(t, srv, "seznam.lab", []byte(`{"envelope":{"original_to":"a@x"},"context":{"size_bytes":99}}`))
	if resp.StatusCode != 200 {
		t.Fatalf("status %d, want 200", resp.StatusCode)
	}
	var out dsnResponse
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out.Decision != "reject" {
		t.Errorf("decision %q, want reject", out.Decision)
	}
}

// 2. Envelope + context forwarded into stub.
func TestS24H_DSN_PassesEnvelopeAndContext(t *testing.T) {
	reg := &stubRegistry{}
	reg.dsnResp.decision = "reject"
	srv := newCheckServer(reg)

	doDSN(t, srv, "gmail.lab", []byte(`{"envelope":{"original_to":"x@y"},"context":{"size_bytes":42}}`))
	if reg.gotDSNDomain != "gmail.lab" {
		t.Errorf("domain %q", reg.gotDSNDomain)
	}
	if v, _ := reg.gotDSNEnv["original_to"].(string); v != "x@y" {
		t.Errorf("envelope not forwarded: %v", reg.gotDSNEnv)
	}
	if v, _ := reg.gotDSNCtx["size_bytes"].(float64); v != 42 {
		t.Errorf("context not forwarded: %v", reg.gotDSNCtx)
	}
}

// 3. 404 on unknown domain.
func TestS24H_DSN_Unknown_Returns404(t *testing.T) {
	reg := &stubRegistry{dsnErr: errors.New("nope")}
	srv := newCheckServer(reg)
	resp := doDSN(t, srv, "never.lab", []byte(`{}`))
	if resp.StatusCode != 404 {
		t.Errorf("status %d, want 404", resp.StatusCode)
	}
}

// 4. 400 on malformed body.
func TestS24H_DSN_MalformedBody_Returns400(t *testing.T) {
	reg := &stubRegistry{}
	srv := newCheckServer(reg)
	resp := doDSN(t, srv, "seznam.lab", []byte(`{not json`))
	if resp.StatusCode != 400 {
		t.Errorf("status %d, want 400", resp.StatusCode)
	}
}

// 5. Endpoint disabled when no Profiles registry attached.
func TestS24H_DSN_NoRegistry_Returns404(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer("", exec.DockerRunner{}, logger)
	req := httptest.NewRequest("POST", "/v1/profile/seznam.lab/dsn", bytes.NewReader([]byte(`{}`)))
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 404 {
		t.Errorf("disabled got %d, want 404", w.Result().StatusCode)
	}
}

// ── ML2.5 — rate-limit endpoints ──────────────────────────────────────

// 1. GET rate returns count + limit + remaining.
func TestS25H_RateGet_Happy(t *testing.T) {
	reg := &stubRegistry{}
	reg.rateCountResp.count = 5
	reg.rateCountResp.limit = 100
	srv := newCheckServer(reg)

	req := httptest.NewRequest("GET", "/v1/profile/seznam.lab/rate/a@seznam.lab", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 200 {
		t.Fatalf("status %d, want 200", w.Result().StatusCode)
	}
	var body rateResponse
	_ = json.NewDecoder(w.Result().Body).Decode(&body)
	if body.Count != 5 || body.Limit != 100 || body.Remaining != 95 {
		t.Errorf("body %+v, want count=5 limit=100 remaining=95", body)
	}
}

// 2. POST rate/record forwards mailbox + domain.
func TestS25H_RateRecord_Happy(t *testing.T) {
	reg := &stubRegistry{}
	reg.rateRecordResp.count = 1
	reg.rateRecordResp.limit = 100
	srv := newCheckServer(reg)

	req := httptest.NewRequest("POST", "/v1/profile/seznam.lab/rate/x@seznam.lab/record", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 200 {
		t.Errorf("status %d, want 200", w.Result().StatusCode)
	}
	if reg.gotRateMailbox != "x@seznam.lab" || reg.gotRateDomain != "seznam.lab" {
		t.Errorf("forwarded args wrong: domain=%q mailbox=%q", reg.gotRateDomain, reg.gotRateMailbox)
	}
}

// 3. Remaining=0 when count >= limit (boundary).
func TestS25H_RateGet_RemainingZero(t *testing.T) {
	reg := &stubRegistry{}
	reg.rateCountResp.count = 100
	reg.rateCountResp.limit = 100
	srv := newCheckServer(reg)

	req := httptest.NewRequest("GET", "/v1/profile/seznam.lab/rate/a@seznam.lab", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	var body rateResponse
	_ = json.NewDecoder(w.Result().Body).Decode(&body)
	if body.Remaining != 0 {
		t.Errorf("remaining %d, want 0", body.Remaining)
	}
}

// 4. Remaining=-1 sentinel for unlimited (limit=0).
func TestS25H_RateGet_UnlimitedSentinel(t *testing.T) {
	reg := &stubRegistry{}
	reg.rateCountResp.count = 999
	reg.rateCountResp.limit = 0
	srv := newCheckServer(reg)

	req := httptest.NewRequest("GET", "/v1/profile/x.lab/rate/a@x.lab", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	var body rateResponse
	_ = json.NewDecoder(w.Result().Body).Decode(&body)
	if body.Remaining != -1 {
		t.Errorf("remaining %d, want -1 (unlimited)", body.Remaining)
	}
}

// 5. Unknown domain → 404.
func TestS25H_Rate_Unknown_Returns404(t *testing.T) {
	reg := &stubRegistry{rateCountErr: errors.New("nope")}
	srv := newCheckServer(reg)

	req := httptest.NewRequest("GET", "/v1/profile/never.lab/rate/a@x", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 404 {
		t.Errorf("status %d, want 404", w.Result().StatusCode)
	}
}

// 6. Endpoints disabled when no registry attached.
func TestS25H_Rate_NoRegistry_Returns404(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer("", exec.DockerRunner{}, logger)
	req := httptest.NewRequest("GET", "/v1/profile/seznam.lab/rate/a@x", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 404 {
		t.Errorf("disabled got %d, want 404", w.Result().StatusCode)
	}
}

// 7. Auth required when API key set.
func TestS25H_Rate_RequiresAuth(t *testing.T) {
	reg := &stubRegistry{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer("k", exec.DockerRunner{}, logger).WithProfiles(reg)
	req := httptest.NewRequest("GET", "/v1/profile/seznam.lab/rate/a@x", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 401 {
		t.Errorf("no auth got %d, want 401", w.Result().StatusCode)
	}
}

// ── ML3.2 — greylist endpoint ─────────────────────────────────────────

func doGrey(t *testing.T, srv *Server, domain string, body []byte) *http.Response {
	t.Helper()
	req := httptest.NewRequest("POST", "/v1/profile/"+domain+"/greylist/check", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	return w.Result()
}

// 1. 200 + allow body on happy path.
func TestS32H_Greylist_Happy(t *testing.T) {
	reg := &stubRegistry{}
	reg.greyResp.allow = true
	reg.greyResp.reason = "known"
	srv := newCheckServer(reg)

	resp := doGrey(t, srv, "outlook.lab",
		[]byte(`{"sender_ip":"1.2.3.4","sender_addr":"s@x","recipient_addr":"r@outlook.lab"}`))
	if resp.StatusCode != 200 {
		t.Fatalf("status %d, want 200", resp.StatusCode)
	}
	var body greylistResponse
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if !body.Allow || body.Reason != "known" {
		t.Errorf("body %+v, want allow=true reason=known", body)
	}
}

// 2. Triplet forwarded into stub.
func TestS32H_Greylist_PassesTriplet(t *testing.T) {
	reg := &stubRegistry{}
	srv := newCheckServer(reg)

	doGrey(t, srv, "outlook.lab",
		[]byte(`{"sender_ip":"9.9.9.9","sender_addr":"a@b","recipient_addr":"c@d"}`))
	if reg.gotGreyTriple != [3]string{"9.9.9.9", "a@b", "c@d"} {
		t.Errorf("triplet not forwarded: %v", reg.gotGreyTriple)
	}
}

// 3. Missing recipient_addr → 400.
func TestS32H_Greylist_MissingRecipient_400(t *testing.T) {
	reg := &stubRegistry{}
	srv := newCheckServer(reg)
	resp := doGrey(t, srv, "outlook.lab",
		[]byte(`{"sender_ip":"1.2.3.4","sender_addr":"s@x"}`))
	if resp.StatusCode != 400 {
		t.Errorf("status %d, want 400", resp.StatusCode)
	}
}

// 4. Malformed body → 400.
func TestS32H_Greylist_MalformedBody_400(t *testing.T) {
	reg := &stubRegistry{}
	srv := newCheckServer(reg)
	resp := doGrey(t, srv, "outlook.lab", []byte(`{not json`))
	if resp.StatusCode != 400 {
		t.Errorf("status %d, want 400", resp.StatusCode)
	}
}

// 5. Unknown domain → 404.
func TestS32H_Greylist_Unknown_404(t *testing.T) {
	reg := &stubRegistry{greyErr: errors.New("nope")}
	srv := newCheckServer(reg)
	resp := doGrey(t, srv, "never.lab",
		[]byte(`{"recipient_addr":"r@x"}`))
	if resp.StatusCode != 404 {
		t.Errorf("status %d, want 404", resp.StatusCode)
	}
}

// 6. Endpoint disabled when registry nil.
func TestS32H_Greylist_NoRegistry_404(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer("", exec.DockerRunner{}, logger)
	req := httptest.NewRequest("POST", "/v1/profile/outlook.lab/greylist/check",
		bytes.NewReader([]byte(`{"recipient_addr":"r@x"}`)))
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 404 {
		t.Errorf("disabled got %d, want 404", w.Result().StatusCode)
	}
}

// ── ML3.3 — evaluate endpoint ─────────────────────────────────────────

func doEval(t *testing.T, srv *Server, domain string, body []byte) *http.Response {
	t.Helper()
	req := httptest.NewRequest("POST", "/v1/profile/"+domain+"/evaluate", bytes.NewReader(body))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	return w.Result()
}

// 1. 200 + result body on happy path.
func TestS33H_Evaluate_Happy(t *testing.T) {
	reg := &stubRegistry{evalResp: map[string]string{"decision": "accept", "fired_by": "static"}}
	srv := newCheckServer(reg)
	resp := doEval(t, srv, "gmail.lab", []byte(`{"sender_mailbox":"a@x"}`))
	if resp.StatusCode != 200 {
		t.Fatalf("status %d, want 200", resp.StatusCode)
	}
	var got map[string]string
	_ = json.NewDecoder(resp.Body).Decode(&got)
	if got["decision"] != "accept" {
		t.Errorf("decision %q, want accept", got["decision"])
	}
}

// 2. Domain + raw body forwarded.
func TestS33H_Evaluate_PassesArgs(t *testing.T) {
	reg := &stubRegistry{evalResp: map[string]string{}}
	srv := newCheckServer(reg)
	doEval(t, srv, "outlook.lab", []byte(`{"sender_mailbox":"a@x","size_bytes":42}`))
	if reg.gotEvalDomain != "outlook.lab" {
		t.Errorf("domain %q, want outlook.lab", reg.gotEvalDomain)
	}
	if v, _ := reg.gotEvalRaw["sender_mailbox"].(string); v != "a@x" {
		t.Errorf("raw sender_mailbox not forwarded: %v", reg.gotEvalRaw)
	}
}

// 3. Empty body OK (zero ContentLength).
func TestS33H_Evaluate_EmptyBody(t *testing.T) {
	reg := &stubRegistry{evalResp: map[string]string{"decision": "accept"}}
	srv := newCheckServer(reg)
	req := httptest.NewRequest("POST", "/v1/profile/gmail.lab/evaluate", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 200 {
		t.Errorf("status %d, want 200", w.Result().StatusCode)
	}
}

// 4. Malformed body → 400.
func TestS33H_Evaluate_MalformedBody_400(t *testing.T) {
	reg := &stubRegistry{}
	srv := newCheckServer(reg)
	resp := doEval(t, srv, "gmail.lab", []byte(`{not json`))
	if resp.StatusCode != 400 {
		t.Errorf("status %d, want 400", resp.StatusCode)
	}
}

// 5. Unknown domain → 404.
func TestS33H_Evaluate_Unknown_404(t *testing.T) {
	reg := &stubRegistry{evalErr: errors.New("nope")}
	srv := newCheckServer(reg)
	resp := doEval(t, srv, "never.lab", []byte(`{}`))
	if resp.StatusCode != 404 {
		t.Errorf("status %d, want 404", resp.StatusCode)
	}
}

// 6. Endpoint disabled when registry nil.
func TestS33H_Evaluate_NoRegistry_404(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer("", exec.DockerRunner{}, logger)
	req := httptest.NewRequest("POST", "/v1/profile/gmail.lab/evaluate", bytes.NewReader([]byte(`{}`)))
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 404 {
		t.Errorf("disabled got %d, want 404", w.Result().StatusCode)
	}
}

// ── ML2.6 — quota endpoints ───────────────────────────────────────────

// 1. GET quota returns used + cap.
func TestS26H_Quota_GetHappy(t *testing.T) {
	reg := &stubRegistry{}
	reg.quotaGetResp.used = 1024
	reg.quotaGetResp.cap = 1073741824
	srv := newCheckServer(reg)

	req := httptest.NewRequest("GET", "/v1/profile/seznam.lab/quota/a@seznam.lab", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 200 {
		t.Fatalf("status %d, want 200", w.Result().StatusCode)
	}
	var body quotaResponse
	_ = json.NewDecoder(w.Result().Body).Decode(&body)
	if body.Used != 1024 || body.Cap != 1073741824 {
		t.Errorf("body %+v, want used=1024 cap=1073741824", body)
	}
}

// 2. POST quota/add forwards bytes.
func TestS26H_Quota_AddHappy(t *testing.T) {
	reg := &stubRegistry{}
	reg.quotaAddResp.used = 5000
	reg.quotaAddResp.cap = 1073741824
	srv := newCheckServer(reg)

	req := httptest.NewRequest("POST", "/v1/profile/seznam.lab/quota/a@seznam.lab/add",
		bytes.NewReader([]byte(`{"bytes":1024}`)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 200 {
		t.Fatalf("status %d, want 200", w.Result().StatusCode)
	}
	if reg.gotQuotaBytes != 1024 {
		t.Errorf("forwarded bytes %d, want 1024", reg.gotQuotaBytes)
	}
}

// 3. POST quota/add with bytes<=0 → 400.
func TestS26H_Quota_AddZero_400(t *testing.T) {
	reg := &stubRegistry{}
	srv := newCheckServer(reg)
	req := httptest.NewRequest("POST", "/v1/profile/seznam.lab/quota/a@seznam.lab/add",
		bytes.NewReader([]byte(`{"bytes":0}`)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 400 {
		t.Errorf("status %d, want 400", w.Result().StatusCode)
	}
}

// 4. Malformed body → 400.
func TestS26H_Quota_AddMalformed_400(t *testing.T) {
	reg := &stubRegistry{}
	srv := newCheckServer(reg)
	req := httptest.NewRequest("POST", "/v1/profile/seznam.lab/quota/a@seznam.lab/add",
		bytes.NewReader([]byte(`{not json`)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 400 {
		t.Errorf("status %d, want 400", w.Result().StatusCode)
	}
}

// 5. Unknown domain → 404.
func TestS26H_Quota_Unknown_404(t *testing.T) {
	reg := &stubRegistry{quotaGetErr: errors.New("nope")}
	srv := newCheckServer(reg)
	req := httptest.NewRequest("GET", "/v1/profile/never.lab/quota/a@x", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 404 {
		t.Errorf("status %d, want 404", w.Result().StatusCode)
	}
}

// 6. Endpoints disabled when no registry.
func TestS26H_Quota_NoRegistry_404(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer("", exec.DockerRunner{}, logger)
	req := httptest.NewRequest("GET", "/v1/profile/seznam.lab/quota/a@x", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 404 {
		t.Errorf("disabled got %d, want 404", w.Result().StatusCode)
	}
}

// 7. Auth required when API key set.
func TestS26H_Quota_RequiresAuth(t *testing.T) {
	reg := &stubRegistry{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer("k", exec.DockerRunner{}, logger).WithProfiles(reg)
	req := httptest.NewRequest("GET", "/v1/profile/seznam.lab/quota/a@x", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 401 {
		t.Errorf("no auth got %d, want 401", w.Result().StatusCode)
	}
}

// ── ML2.7 — operator reset endpoint ──────────────────────────────────

// 1. POST reset with embedded source = 200 + status ok.
func TestS27H_Reset_EmbeddedHappy(t *testing.T) {
	reg := &stubRegistry{}
	srv := newCheckServer(reg)
	req := httptest.NewRequest("POST", "/v1/profile/reset",
		bytes.NewReader([]byte(`{"source":"embedded"}`)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 200 {
		t.Fatalf("status %d, want 200", w.Result().StatusCode)
	}
	if reg.gotResetSource != "embedded" {
		t.Errorf("source %q, want embedded", reg.gotResetSource)
	}
}

// 2. POST reset with empty body defaults source to embedded.
func TestS27H_Reset_DefaultsToEmbedded(t *testing.T) {
	reg := &stubRegistry{}
	srv := newCheckServer(reg)
	req := httptest.NewRequest("POST", "/v1/profile/reset", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 200 {
		t.Errorf("status %d, want 200", w.Result().StatusCode)
	}
	if reg.gotResetSource != "embedded" {
		t.Errorf("default source %q, want embedded", reg.gotResetSource)
	}
}

// 3. POST reset with custom source forwards it.
func TestS27H_Reset_CustomSource(t *testing.T) {
	reg := &stubRegistry{}
	srv := newCheckServer(reg)
	req := httptest.NewRequest("POST", "/v1/profile/reset",
		bytes.NewReader([]byte(`{"source":"/etc/profiles"}`)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if reg.gotResetSource != "/etc/profiles" {
		t.Errorf("source %q, want /etc/profiles", reg.gotResetSource)
	}
}

// 4. Malformed body → 400.
func TestS27H_Reset_MalformedBody_400(t *testing.T) {
	reg := &stubRegistry{}
	srv := newCheckServer(reg)
	req := httptest.NewRequest("POST", "/v1/profile/reset",
		bytes.NewReader([]byte(`{not json`)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 400 {
		t.Errorf("status %d, want 400", w.Result().StatusCode)
	}
}

// 5. Registry error → 500.
func TestS27H_Reset_RegistryError_500(t *testing.T) {
	reg := &stubRegistry{resetErr: errors.New("disk fail")}
	srv := newCheckServer(reg)
	req := httptest.NewRequest("POST", "/v1/profile/reset", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 500 {
		t.Errorf("status %d, want 500", w.Result().StatusCode)
	}
}

// 6. Endpoint disabled when registry nil.
func TestS27H_Reset_NoRegistry_404(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer("", exec.DockerRunner{}, logger)
	req := httptest.NewRequest("POST", "/v1/profile/reset", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 404 {
		t.Errorf("disabled got %d, want 404", w.Result().StatusCode)
	}
}

// 7. Auth required.
func TestS27H_Reset_RequiresAuth(t *testing.T) {
	reg := &stubRegistry{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer("k", exec.DockerRunner{}, logger).WithProfiles(reg)
	req := httptest.NewRequest("POST", "/v1/profile/reset", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Result().StatusCode != 401 {
		t.Errorf("no auth got %d, want 401", w.Result().StatusCode)
	}
}
