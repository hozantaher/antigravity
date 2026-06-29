package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakeWebResolver is a Resolver for testing the DNS audit handler.
// It does NOT depend on the probe package to avoid import cycles.
type fakeWebResolver struct {
	records map[string][]string
	errs    map[string]error
}

func (f *fakeWebResolver) LookupTXT(_ context.Context, name string) ([]string, error) {
	if e, ok := f.errs[name]; ok {
		return nil, e
	}
	if r, ok := f.records[name]; ok {
		return r, nil
	}
	return nil, nil
}

// ── GET /api/dns-audit ───────────────────────────────────────────────────────

func TestHandleDnsAudit_MethodNotAllowed(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/dns-audit", nil)
	w := httptest.NewRecorder()
	s.handleDnsAudit(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestHandleDnsAudit_NoDomains_ReturnsJSON(t *testing.T) {
	// Server with no sending domains configured → status "skip"
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/dns-audit", nil)
	w := httptest.NewRecorder()
	s.handleDnsAudit(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var body map[string]any
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("body decode: %v", err)
	}
	if _, ok := body["status"]; !ok {
		t.Error("response must have 'status' field")
	}
}

func TestHandleDnsAudit_ValidRecords_StatusOK(t *testing.T) {
	res := &fakeWebResolver{
		records: map[string][]string{
			"example.com":        {"v=spf1 include:mailprovider.net ~all"},
			"_dmarc.example.com": {"v=DMARC1; p=reject; rua=mailto:dmarc@example.com"},
		},
	}
	s := newTestServerWithDNS(t, []string{"example.com"}, res)
	req := httptest.NewRequest(http.MethodGet, "/api/dns-audit", nil)
	w := httptest.NewRecorder()
	s.handleDnsAudit(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var resp dnsAuditResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Status != "ok" {
		t.Errorf("status = %q, want ok", resp.Status)
	}
}

func TestHandleDnsAudit_MissingSPF_StatusErr(t *testing.T) {
	res := &fakeWebResolver{
		records: map[string][]string{
			"example.com":        {"not-spf"},
			"_dmarc.example.com": {"v=DMARC1; p=reject"},
		},
	}
	s := newTestServerWithDNS(t, []string{"example.com"}, res)
	req := httptest.NewRequest(http.MethodGet, "/api/dns-audit", nil)
	w := httptest.NewRecorder()
	s.handleDnsAudit(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 (even on error status), got %d", w.Code)
	}
	var resp dnsAuditResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Status != "err" {
		t.Errorf("status = %q, want err", resp.Status)
	}
}

func TestHandleDnsAudit_DMARC_pNone_Warn(t *testing.T) {
	res := &fakeWebResolver{
		records: map[string][]string{
			"x.com":        {"v=spf1 -all"},
			"_dmarc.x.com": {"v=DMARC1; p=none"},
		},
	}
	s := newTestServerWithDNS(t, []string{"x.com"}, res)
	req := httptest.NewRequest(http.MethodGet, "/api/dns-audit", nil)
	w := httptest.NewRecorder()
	s.handleDnsAudit(w, req)

	var resp dnsAuditResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Status != "warn" {
		t.Errorf("DMARC p=none should be warn, got %q", resp.Status)
	}
}

func TestHandleDnsAudit_MultipleDomains_WorstWins(t *testing.T) {
	res := &fakeWebResolver{
		records: map[string][]string{
			"good.com":        {"v=spf1 -all"},
			"_dmarc.good.com": {"v=DMARC1; p=reject"},
			// bad.com: no SPF
			"_dmarc.bad.com": {"v=DMARC1; p=reject"},
		},
	}
	s := newTestServerWithDNS(t, []string{"good.com", "bad.com"}, res)
	req := httptest.NewRequest(http.MethodGet, "/api/dns-audit", nil)
	w := httptest.NewRecorder()
	s.handleDnsAudit(w, req)

	var resp dnsAuditResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Status != "err" {
		t.Errorf("worst-wins: expected err, got %q", resp.Status)
	}
}

func TestHandleDnsAudit_ResponseContainsDomains(t *testing.T) {
	res := &fakeWebResolver{
		records: map[string][]string{
			"myco.com":        {"v=spf1 ~all"},
			"_dmarc.myco.com": {"v=DMARC1; p=quarantine"},
		},
	}
	s := newTestServerWithDNS(t, []string{"myco.com"}, res)
	req := httptest.NewRequest(http.MethodGet, "/api/dns-audit", nil)
	w := httptest.NewRecorder()
	s.handleDnsAudit(w, req)

	var resp dnsAuditResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if len(resp.Domains) == 0 {
		t.Error("response must include domain results")
	}
}

func TestHandleDnsAudit_ResponseHasLatency(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/dns-audit", nil)
	w := httptest.NewRecorder()
	s.handleDnsAudit(w, req)

	var body map[string]any
	json.NewDecoder(w.Body).Decode(&body)
	if _, ok := body["latency_ms"]; !ok {
		t.Error("response must include latency_ms")
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

// dnsAuditResponse is the expected JSON shape from GET /api/dns-audit.
type dnsAuditResponse struct {
	Status    string            `json:"status"`
	Detail    string            `json:"detail"`
	LatencyMs int64             `json:"latency_ms"`
	Domains   map[string]any    `json:"domains"`
}

// newTestServerWithDNS creates a Server wired with specific sending domains
// and a fake DNS resolver for handler-level DNS audit tests.
func newTestServerWithDNS(t *testing.T, domains []string, res dnsResolver) *Server {
	t.Helper()
	s := NewServer(nil, "http://localhost:8080")
	s.sendingDomains = domains
	s.dnsResolver = res
	return s
}
