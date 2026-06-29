package sender

// Unit tests for BuildThreadHeaders and the engine's In-Reply-To / References
// header injection.
//
// Per memory feedback_extreme_testing: ≥10 test cases, boundary + error +
// integration paths covered.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"common/config"
)

// ── BuildThreadHeaders unit tests ─────────────────────────────────────────────

// 1. Empty inReplyTo → both values empty (first-step guard).
func TestBuildThreadHeaders_EmptyInReplyTo_NoHeaders(t *testing.T) {
	irt, refs := BuildThreadHeaders("", []string{"<prev@x.cz>"})
	if irt != "" {
		t.Errorf("In-Reply-To should be empty for empty input, got %q", irt)
	}
	if refs != "" {
		t.Errorf("References should be empty for empty input, got %q", refs)
	}
}

// 2. Single parent → In-Reply-To wrapped in angle brackets, References = same.
func TestBuildThreadHeaders_SingleParent_CorrectFormat(t *testing.T) {
	const id = "<abc123.456@firma.cz>"
	irt, refs := BuildThreadHeaders(id, []string{id})
	if irt != id {
		t.Errorf("In-Reply-To = %q, want %q", irt, id)
	}
	if refs != id {
		t.Errorf("References = %q, want %q", refs, id)
	}
}

// 3. Three-step chain → References contains all three IDs comma-space separated.
func TestBuildThreadHeaders_ThreeIDs_AllInReferences(t *testing.T) {
	ids := []string{
		"<id1.nanos@host>",
		"<id2.nanos@host>",
		"<id3.nanos@host>",
	}
	irt, refs := BuildThreadHeaders(ids[2], ids)
	if irt != ids[2] {
		t.Errorf("In-Reply-To = %q, want last id %q", irt, ids[2])
	}
	wantRefs := "<id1.nanos@host>, <id2.nanos@host>, <id3.nanos@host>"
	if refs != wantRefs {
		t.Errorf("References = %q, want %q", refs, wantRefs)
	}
}

// 4. Chain of exactly maxReferencesChainDepth (10) → all 10 IDs emitted, no truncation.
func TestBuildThreadHeaders_ExactlyMaxDepth_AllEmitted(t *testing.T) {
	chain := make([]string, maxReferencesChainDepth)
	for i := range chain {
		chain[i] = "<id" + string(rune('a'+i)) + "@host>"
	}
	_, refs := BuildThreadHeaders(chain[len(chain)-1], chain)
	parts := strings.Split(refs, ", ")
	if len(parts) != maxReferencesChainDepth {
		t.Errorf("References has %d parts, want %d", len(parts), maxReferencesChainDepth)
	}
}

// 5. Chain of 15 → truncated to newest 10, oldest 5 dropped.
func TestBuildThreadHeaders_LongChain_TruncatedToMax(t *testing.T) {
	chain := make([]string, 15)
	for i := range chain {
		chain[i] = strings.ToLower("<idxxx" + string(rune('a'+i)) + "@host>")
	}
	_, refs := BuildThreadHeaders(chain[14], chain)
	parts := strings.Split(refs, ", ")
	if len(parts) != maxReferencesChainDepth {
		t.Errorf("References truncated to %d, want %d", len(parts), maxReferencesChainDepth)
	}
	// Last entry in truncated refs must be the same as the last entry in chain.
	if parts[len(parts)-1] != chain[14] {
		t.Errorf("last References entry = %q, want %q", parts[len(parts)-1], chain[14])
	}
}

// 6. IDs without angle brackets → wrapAngleBrackets applied.
func TestBuildThreadHeaders_NoBrackets_WrapsAngleBrackets(t *testing.T) {
	bare := "abc123.456@host.cz"
	irt, refs := BuildThreadHeaders(bare, []string{bare})
	want := "<" + bare + ">"
	if irt != want {
		t.Errorf("In-Reply-To = %q, want %q", irt, want)
	}
	if refs != want {
		t.Errorf("References = %q, want %q", refs, want)
	}
}

// 7. CRLF injection in IDs → stripped.
func TestBuildThreadHeaders_CRLFInjection_Stripped(t *testing.T) {
	evil := "<abc\r\nBcc: spy@evil.cz\r\n@host>"
	irt, refs := BuildThreadHeaders(evil, []string{evil})
	if strings.Contains(irt, "\r") || strings.Contains(irt, "\n") {
		t.Errorf("In-Reply-To contains CR/LF after stripping: %q", irt)
	}
	if strings.Contains(refs, "\r") || strings.Contains(refs, "\n") {
		t.Errorf("References contains CR/LF after stripping: %q", refs)
	}
}

// 8. Empty references slice → In-Reply-To set, References empty.
func TestBuildThreadHeaders_EmptyRefsSlice_NoReferences(t *testing.T) {
	irt, refs := BuildThreadHeaders("<parent@host>", []string{})
	if irt != "<parent@host>" {
		t.Errorf("In-Reply-To = %q, want <parent@host>", irt)
	}
	if refs != "" {
		t.Errorf("References = %q, want empty", refs)
	}
}

// 9. Nil references slice → same as empty.
func TestBuildThreadHeaders_NilRefsSlice_NoReferences(t *testing.T) {
	irt, refs := BuildThreadHeaders("<parent@host>", nil)
	if irt != "<parent@host>" {
		t.Errorf("In-Reply-To = %q, want <parent@host>", irt)
	}
	if refs != "" {
		t.Errorf("References = %q, want empty", refs)
	}
}

// 10. Empty ID strings in chain are skipped.
func TestBuildThreadHeaders_EmptyIDsInChain_Skipped(t *testing.T) {
	chain := []string{"", "<real1@host>", "", "<real2@host>", ""}
	_, refs := BuildThreadHeaders("<real2@host>", chain)
	parts := strings.Split(refs, ", ")
	if len(parts) != 2 {
		t.Errorf("References has %d parts, want 2 (empty IDs must be skipped); refs=%q", len(parts), refs)
	}
}

// ── Engine integration: headers reach relay ───────────────────────────────────

// 11. Engine correctly injects In-Reply-To + References from SendRequest fields
//
//	into the req.Headers map before submitting to the relay.
func TestEngine_ThreadHeaders_InjectedIntoRelay(t *testing.T) {
	type relayBody struct {
		Headers map[string]string `json:"headers"`
	}

	var mu sync.Mutex
	var captured relayBody
	var hits int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/submit" {
			http.NotFound(w, r)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var body relayBody
		json.Unmarshal(raw, &body) //nolint:errcheck
		mu.Lock()
		captured = body
		atomic.AddInt32(&hits, 1)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"envelope_id":"e1","status":"accepted"}`)) //nolint:errcheck
	}))
	defer srv.Close()

	mb := config.MailboxConfig{
		Address:    "sender@firma.cz",
		SMTPHost:   "smtp.firma.cz",
		SMTPPort:   587,
		Username:   "sender@firma.cz",
		Password:   "pw",
		DailyLimit: 100,
	}
	eng := NewEngine([]config.MailboxConfig{mb}, config.SendingConfig{
		WindowStart: 0, WindowEnd: 24,
		MinDelaySeconds: 0, MaxDelaySeconds: 0,
		MaxPerDomainHour: 1000,
	}, config.SafetyConfig{MaxBounceRate: 0.5})
	eng.WithAntiTrace(NewAntiTraceClient(srv.URL, "tok"))

	const parentID = "<parent123.456@firma.cz>"
	eng.Enqueue(SendRequest{
		CampaignID:         1,
		ContactID:          42,
		Step:               1,
		ToAddress:          "recipient@target.cz",
		Subject:            "Follow-up",
		BodyPlain:          "Hi",
		InReplyToMessageID: parentID,
		ReferencesChain:    []string{parentID},
	})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	go func() { eng.Run(ctx, nil) }() //nolint:errcheck

	// Wait for relay hit.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&hits) >= 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()

	mu.Lock()
	hdrs := captured.Headers
	mu.Unlock()

	if atomic.LoadInt32(&hits) < 1 {
		t.Fatal("relay received 0 requests — engine did not send")
	}

	if v := hdrs["In-Reply-To"]; v == "" {
		t.Errorf("In-Reply-To header missing in relay payload; all headers: %v", hdrs)
	}
	if v := hdrs["References"]; v == "" {
		t.Errorf("References header missing in relay payload; all headers: %v", hdrs)
	}
}

// 12. Step 0 (first send): In-Reply-To and References must NOT appear in relay payload.
func TestEngine_FirstStep_NoThreadHeaders(t *testing.T) {
	type relayBody struct {
		Headers map[string]string `json:"headers"`
	}

	var mu sync.Mutex
	var captured relayBody
	var hits int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/submit" {
			http.NotFound(w, r)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var body relayBody
		json.Unmarshal(raw, &body) //nolint:errcheck
		mu.Lock()
		captured = body
		atomic.AddInt32(&hits, 1)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"envelope_id":"e2","status":"accepted"}`)) //nolint:errcheck
	}))
	defer srv.Close()

	mb := config.MailboxConfig{
		Address:    "sender@firma.cz",
		SMTPHost:   "smtp.firma.cz",
		SMTPPort:   587,
		Username:   "sender@firma.cz",
		Password:   "pw",
		DailyLimit: 100,
	}
	eng := NewEngine([]config.MailboxConfig{mb}, config.SendingConfig{
		WindowStart: 0, WindowEnd: 24,
		MinDelaySeconds: 0, MaxDelaySeconds: 0,
		MaxPerDomainHour: 1000,
	}, config.SafetyConfig{MaxBounceRate: 0.5})
	eng.WithAntiTrace(NewAntiTraceClient(srv.URL, "tok"))

	// Step 0, no InReplyToMessageID set.
	eng.Enqueue(SendRequest{
		CampaignID: 1,
		ContactID:  43,
		Step:       0,
		ToAddress:  "recipient2@target.cz",
		Subject:    "Initial",
		BodyPlain:  "Hello",
	})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	go func() { eng.Run(ctx, nil) }() //nolint:errcheck

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&hits) >= 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()

	mu.Lock()
	hdrs := captured.Headers
	mu.Unlock()

	if atomic.LoadInt32(&hits) < 1 {
		t.Fatal("relay received 0 requests — engine did not send")
	}

	if v, ok := hdrs["In-Reply-To"]; ok && v != "" {
		t.Errorf("In-Reply-To must not appear in first-step send, got %q", v)
	}
	if v, ok := hdrs["References"]; ok && v != "" {
		t.Errorf("References must not appear in first-step send, got %q", v)
	}
}

// 13. Engine with 5-step chain → References contains all 5 IDs.
func TestEngine_FiveStepChain_FullReferencesChain(t *testing.T) {
	type relayBody struct {
		Headers map[string]string `json:"headers"`
	}

	var mu sync.Mutex
	var captured relayBody
	var hits int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/submit" {
			http.NotFound(w, r)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var body relayBody
		json.Unmarshal(raw, &body) //nolint:errcheck
		mu.Lock()
		captured = body
		atomic.AddInt32(&hits, 1)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"envelope_id":"e3","status":"accepted"}`)) //nolint:errcheck
	}))
	defer srv.Close()

	mb := config.MailboxConfig{
		Address:    "sender@firma.cz",
		SMTPHost:   "smtp.firma.cz",
		SMTPPort:   587,
		Username:   "sender@firma.cz",
		Password:   "pw",
		DailyLimit: 100,
	}
	eng := NewEngine([]config.MailboxConfig{mb}, config.SendingConfig{
		WindowStart: 0, WindowEnd: 24,
		MinDelaySeconds: 0, MaxDelaySeconds: 0,
		MaxPerDomainHour: 1000,
	}, config.SafetyConfig{MaxBounceRate: 0.5})
	eng.WithAntiTrace(NewAntiTraceClient(srv.URL, "tok"))

	chain := []string{
		"<step0@firma.cz>",
		"<step1@firma.cz>",
		"<step2@firma.cz>",
		"<step3@firma.cz>",
		"<step4@firma.cz>",
	}
	eng.Enqueue(SendRequest{
		CampaignID:         1,
		ContactID:          44,
		Step:               5,
		ToAddress:          "recipient3@target.cz",
		Subject:            "Step 5",
		BodyPlain:          "Fifth follow-up",
		InReplyToMessageID: chain[4],
		ReferencesChain:    chain,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	go func() { eng.Run(ctx, nil) }() //nolint:errcheck

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&hits) >= 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()

	mu.Lock()
	hdrs := captured.Headers
	mu.Unlock()

	if atomic.LoadInt32(&hits) < 1 {
		t.Fatal("relay received 0 requests")
	}

	refsHdr := hdrs["References"]
	parts := strings.Split(refsHdr, ", ")
	if len(parts) != 5 {
		t.Errorf("References has %d entries, want 5; value=%q", len(parts), refsHdr)
	}

	// In-Reply-To must be the last entry in chain.
	if irt := hdrs["In-Reply-To"]; irt != chain[4] {
		t.Errorf("In-Reply-To = %q, want %q", irt, chain[4])
	}
}
