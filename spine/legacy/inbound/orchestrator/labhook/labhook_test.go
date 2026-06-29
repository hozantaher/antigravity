package labhook

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"common/maillabclient"
)

// ════════════════════════════════════════════════════════════════════════
// Brutal coverage for ML5.1 — orchestrator pre-send abort hook.
// ════════════════════════════════════════════════════════════════════════

// fixture spins up a fake lab API. handler controls the response.
func fixture(t *testing.T, handler http.HandlerFunc) (*LabEvaluator, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	client := maillabclient.New(srv.URL, "")
	return New("lab", client), srv
}

// 1. nil evaluator returns (false, "") safely.
func TestS51_LabHook_NilEvaluator(t *testing.T) {
	var e *LabEvaluator
	skip, reason := e.ShouldSkip(context.Background(), EvaluateInput{RecipientAddr: "r@x"})
	if skip {
		t.Errorf("nil evaluator skip=true")
	}
	if reason != "" {
		t.Errorf("nil evaluator reason=%q", reason)
	}
}

// 2. Mode != "lab" → no-op (production safe).
func TestS51_LabHook_DisabledMode(t *testing.T) {
	var called int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called++
		w.Write([]byte(`{"decision":"reject"}`))
	}))
	defer srv.Close()
	client := maillabclient.New(srv.URL, "")
	e := New("proxy", client) // not "lab"
	skip, _ := e.ShouldSkip(context.Background(), EvaluateInput{RecipientAddr: "r@x.lab"})
	if skip {
		t.Error("disabled mode skip=true")
	}
	if called != 0 {
		t.Error("disabled mode called the API")
	}
}

// 3. Empty recipient → no-op (no domain to evaluate).
func TestS51_LabHook_EmptyRecipient(t *testing.T) {
	e, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("API called for empty recipient")
	})
	skip, _ := e.ShouldSkip(context.Background(), EvaluateInput{})
	if skip {
		t.Error("empty recipient skip=true")
	}
}

// 4. Recipient without @ → no-op (no domain to extract).
func TestS51_LabHook_RecipientNoAt(t *testing.T) {
	e, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("API called for malformed recipient")
	})
	skip, _ := e.ShouldSkip(context.Background(), EvaluateInput{RecipientAddr: "not-an-email"})
	if skip {
		t.Error("malformed recipient skip=true")
	}
}

// 5. Mode="lab" + accept verdict → proceed.
func TestS51_LabHook_AcceptProceeds(t *testing.T) {
	e, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(maillabclient.EvaluateResponse{Decision: "accept"})
	})
	skip, reason := e.ShouldSkip(context.Background(), EvaluateInput{RecipientAddr: "r@x.lab"})
	if skip {
		t.Errorf("accept got skip=true, reason=%q", reason)
	}
}

// 6. Mode="lab" + reject verdict → skip.
func TestS51_LabHook_RejectSkips(t *testing.T) {
	e, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(maillabclient.EvaluateResponse{
			Decision: "reject", Reason: "size", FiredBy: "static",
		})
	})
	skip, reason := e.ShouldSkip(context.Background(), EvaluateInput{RecipientAddr: "r@x.lab"})
	if !skip {
		t.Error("reject skip=false")
	}
	if !strings.Contains(reason, "reject") {
		t.Errorf("reason missing verdict: %q", reason)
	}
	if !strings.Contains(reason, "static") {
		t.Errorf("reason missing fired_by: %q", reason)
	}
}

// 7. Greylist verdict → skip.
func TestS51_LabHook_GreylistSkips(t *testing.T) {
	e, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(maillabclient.EvaluateResponse{
			Decision: "greylist", FiredBy: "greylist",
		})
	})
	skip, reason := e.ShouldSkip(context.Background(), EvaluateInput{RecipientAddr: "r@outlook.lab"})
	if !skip {
		t.Error("greylist skip=false")
	}
	if !strings.Contains(reason, "greylist") {
		t.Errorf("reason: %q", reason)
	}
}

// 8. Spam verdict → skip.
func TestS51_LabHook_SpamSkips(t *testing.T) {
	e, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(maillabclient.EvaluateResponse{Decision: "spam"})
	})
	skip, reason := e.ShouldSkip(context.Background(), EvaluateInput{RecipientAddr: "r@x.lab"})
	if !skip || !strings.Contains(reason, "spam") {
		t.Errorf("spam skip=%v reason=%q", skip, reason)
	}
}

// 9. Lab API error → fail-open (proceed) with note in reason.
func TestS51_LabHook_APIError_FailsOpen(t *testing.T) {
	e, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"boom"}`))
	})
	skip, reason := e.ShouldSkip(context.Background(), EvaluateInput{RecipientAddr: "r@x.lab"})
	if skip {
		t.Errorf("API error caused skip=true (should fail-open)")
	}
	if !strings.Contains(reason, "error") {
		t.Errorf("API error reason missing 'error': %q", reason)
	}
}

// 10. RecordRate=true is sent to lab.
func TestS51_LabHook_RecordRateIsTrue(t *testing.T) {
	var gotBody []byte
	e, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 8192)
		n, _ := r.Body.Read(buf)
		gotBody = buf[:n]
		json.NewEncoder(w).Encode(maillabclient.EvaluateResponse{Decision: "accept"})
	})
	e.ShouldSkip(context.Background(), EvaluateInput{RecipientAddr: "r@x.lab"})
	if !strings.Contains(string(gotBody), `"record_rate":true`) {
		t.Errorf("body missing record_rate=true: %s", gotBody)
	}
}

// 11. Domain extraction lowercases.
func TestS51_LabHook_DomainLowercased(t *testing.T) {
	var gotPath string
	e, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		json.NewEncoder(w).Encode(maillabclient.EvaluateResponse{Decision: "accept"})
	})
	e.ShouldSkip(context.Background(), EvaluateInput{RecipientAddr: "USER@SEZNAM.LAB"})
	if !strings.Contains(gotPath, "seznam.lab") {
		t.Errorf("domain not lowercased: %s", gotPath)
	}
	if strings.Contains(gotPath, "SEZNAM") {
		t.Errorf("domain still uppercase: %s", gotPath)
	}
}

// 12. EvaluateInput fields propagated to client request body.
func TestS51_LabHook_FieldsPropagated(t *testing.T) {
	var gotReq map[string]interface{}
	e, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&gotReq)
		json.NewEncoder(w).Encode(maillabclient.EvaluateResponse{Decision: "accept"})
	})
	e.ShouldSkip(context.Background(), EvaluateInput{
		SenderMailbox: "op@gmail.lab",
		SenderIP:      "1.2.3.4",
		RecipientAddr: "p@seznam.lab",
		SizeBytes:     12345,
		HasDkim:       true,
		LinkRatio:     0.42,
	})
	if v, _ := gotReq["sender_mailbox"].(string); v != "op@gmail.lab" {
		t.Errorf("sender_mailbox: %v", gotReq)
	}
	if v, _ := gotReq["recipient_addr"].(string); v != "p@seznam.lab" {
		t.Errorf("recipient_addr: %v", gotReq)
	}
	if v, _ := gotReq["size_bytes"].(float64); v != 12345 {
		t.Errorf("size_bytes: %v", gotReq)
	}
	if v, _ := gotReq["has_dkim"].(bool); !v {
		t.Errorf("has_dkim: %v", gotReq)
	}
	if v, _ := gotReq["link_ratio"].(float64); v != 0.42 {
		t.Errorf("link_ratio: %v", gotReq)
	}
}

// 13. SenderAddr autofilled from SenderMailbox.
func TestS51_LabHook_SenderAddrFromMailbox(t *testing.T) {
	var gotReq map[string]interface{}
	e, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&gotReq)
		json.NewEncoder(w).Encode(maillabclient.EvaluateResponse{Decision: "accept"})
	})
	e.ShouldSkip(context.Background(), EvaluateInput{
		SenderMailbox: "marketer@gmail.lab",
		RecipientAddr: "p@seznam.lab",
	})
	if v, _ := gotReq["sender_addr"].(string); v != "marketer@gmail.lab" {
		t.Errorf("sender_addr not auto-filled: %v", gotReq)
	}
}

// 14. Reason includes verdict reason field.
func TestS51_LabHook_ReasonIncludesVerdictReason(t *testing.T) {
	e, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(maillabclient.EvaluateResponse{
			Decision: "reject",
			Reason:   "size_bytes exceeded max_message_size_bytes",
			FiredBy:  "static",
		})
	})
	_, reason := e.ShouldSkip(context.Background(), EvaluateInput{RecipientAddr: "r@x.lab"})
	if !strings.Contains(reason, "size_bytes exceeded") {
		t.Errorf("reason missing verdict reason: %q", reason)
	}
}

// 15. Concurrent calls race-free.
func TestS51_LabHook_Concurrent(t *testing.T) {
	e, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(maillabclient.EvaluateResponse{Decision: "accept"})
	})
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			e.ShouldSkip(context.Background(), EvaluateInput{
				RecipientAddr: "r@x.lab",
				SizeBytes:     int64(i),
			})
		}(i)
	}
	wg.Wait()
}

// 16. Enabled() reports correctly.
func TestS51_LabHook_Enabled(t *testing.T) {
	cases := []struct {
		mode    string
		client  *maillabclient.Client
		want    bool
	}{
		{"lab", maillabclient.New("http://x", ""), true},
		{"proxy", maillabclient.New("http://x", ""), false},
		{"lab", nil, false},
		{"", maillabclient.New("http://x", ""), false},
	}
	for i, c := range cases {
		e := New(c.mode, c.client)
		if got := e.Enabled(); got != c.want {
			t.Errorf("case %d: Enabled()=%v, want %v", i, got, c.want)
		}
	}
}

// 17. Nil Client + mode=lab → no-op (defensive).
func TestS51_LabHook_NilClientLab(t *testing.T) {
	e := New("lab", nil)
	skip, reason := e.ShouldSkip(context.Background(), EvaluateInput{RecipientAddr: "r@x.lab"})
	if skip {
		t.Errorf("nil client + lab mode skip=true")
	}
	if reason != "" {
		t.Errorf("nil client + lab mode reason=%q", reason)
	}
}

// 18. Endpoint path uses /v1/profile/{domain}/evaluate.
func TestS51_LabHook_EndpointPath(t *testing.T) {
	var gotPath string
	e, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		json.NewEncoder(w).Encode(maillabclient.EvaluateResponse{Decision: "accept"})
	})
	e.ShouldSkip(context.Background(), EvaluateInput{RecipientAddr: "r@gmail.lab"})
	want := "/v1/profile/gmail.lab/evaluate"
	if gotPath != want {
		t.Errorf("path %q, want %q", gotPath, want)
	}
}

// 19. Context cancellation propagates.
func TestS51_LabHook_ContextCancel(t *testing.T) {
	e, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		w.WriteHeader(200)
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	skip, reason := e.ShouldSkip(ctx, EvaluateInput{RecipientAddr: "r@x.lab"})
	// Cancelled before the request → fail-open with error in reason.
	if skip {
		t.Error("cancelled ctx should not skip (fail-open)")
	}
	if reason == "" || !strings.Contains(reason, "error") {
		t.Errorf("cancelled reason should mention error: %q", reason)
	}
}

// 20. Domain-of helper edge cases.
func TestS51_LabHook_DomainOf(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"a@b.lab", "b.lab"},
		{"  a@B.LAB  ", "b.lab"}, // trimmed + lowered
		{"no-at-here", ""},
		{"", ""},
		{"@just-domain", "just-domain"},
	}
	for _, c := range cases {
		got := domainOf(c.in)
		if got != c.want {
			t.Errorf("domainOf(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
