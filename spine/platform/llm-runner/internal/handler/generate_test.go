package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- ScoreDraftConfidence table-driven (≥10 cases) ---

func TestScoreDraftConfidence_TableDriven(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want float64
	}{
		{"empty", "", 0.0},
		{"whitespace only", "   \n  ", 0.0},
		{"refusal as ai", "As an AI I cannot help with that", 0.2},
		{"unable to", "I am unable to generate text", 0.2},
		{"i cannot", "I cannot draft a response.", 0.2},
		{"error marker", "[error] model timeout", 0.2},
		{"too short", "ok", 0.3},
		{"medium length", "Děkujeme za vaši zprávu, ozvu se.", 0.5},
		{"long ok response", "Děkujeme za zájem o naši nabídku, brzy se vám ozveme s detaily o ceně a dostupnosti.", 0.85},
		{"mixed marker priority", "ok [ERROR] something", 0.2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ScoreDraftConfidence(tc.raw)
			if got != tc.want {
				t.Fatalf("got %.2f, want %.2f", got, tc.want)
			}
		})
	}
}

// --- HTTP handler integration ---

func TestGenerateHandler_Success(t *testing.T) {
	out := "Děkujeme za zprávu, brzy se ozveme s ceníkem našich strojů."
	client := &stubClient{generateOut: out}
	handler := Generate(client, "llama3.2:3b", silentLogger())

	body := strings.NewReader(`{"thread_context":"hi","last_reply":"Kolik to stojí?"}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/generate", body)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var resp GenerateResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.DraftText != out {
		t.Fatalf("draft mismatch: %s", resp.DraftText)
	}
	if resp.Model != "llama3.2:3b" {
		t.Fatalf("model: %s", resp.Model)
	}
	if resp.Confidence < 0.8 {
		t.Fatalf("expected high confidence, got %.2f", resp.Confidence)
	}
	if resp.LowConf {
		t.Fatal("expected low_confidence=false")
	}
}

func TestGenerateHandler_LowConfidenceShortDraft(t *testing.T) {
	client := &stubClient{generateOut: "ok"}
	handler := Generate(client, "m", silentLogger())

	req := httptest.NewRequest(http.MethodPost, "/v1/generate",
		strings.NewReader(`{"last_reply":"hi"}`))
	w := httptest.NewRecorder()
	handler(w, req)

	var resp GenerateResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !resp.LowConf {
		t.Fatalf("expected low_confidence=true for short draft, got false (conf=%.2f)", resp.Confidence)
	}
}

func TestGenerateHandler_OllamaError(t *testing.T) {
	client := &stubClient{generateErr: errBoom}
	handler := Generate(client, "m", silentLogger())

	req := httptest.NewRequest(http.MethodPost, "/v1/generate",
		strings.NewReader(`{"last_reply":"hi"}`))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", w.Code)
	}
}

func TestGenerateHandler_MethodNotAllowed(t *testing.T) {
	handler := Generate(&stubClient{}, "m", silentLogger())
	req := httptest.NewRequest(http.MethodGet, "/v1/generate", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestGenerateHandler_InvalidJSON(t *testing.T) {
	handler := Generate(&stubClient{}, "m", silentLogger())
	req := httptest.NewRequest(http.MethodPost, "/v1/generate",
		strings.NewReader("oops"))
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestGenerateHandler_EmptyLastReply(t *testing.T) {
	handler := Generate(&stubClient{}, "m", silentLogger())
	req := httptest.NewRequest(http.MethodPost, "/v1/generate",
		strings.NewReader(`{"last_reply":""}`))
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "last_reply is required") {
		t.Fatalf("body: %s", w.Body.String())
	}
}

func TestGenerateHandler_DefaultSystemPrompt(t *testing.T) {
	client := &stubClient{generateOut: "Děkujeme, brzy se ozveme s detaily."}
	handler := Generate(client, "m", silentLogger())

	req := httptest.NewRequest(http.MethodPost, "/v1/generate",
		strings.NewReader(`{"last_reply":"Kolik?"}`))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("got %d (body %s)", w.Code, w.Body.String())
	}
	// Default system prompt obsahuje "operátora B2B prodeje".
	if !strings.Contains(client.lastPrompt, "B2B") {
		t.Fatalf("expected default system prompt to be embedded; got %s", client.lastPrompt)
	}
}

func TestGenerateHandler_CustomSystemPromptOverride(t *testing.T) {
	client := &stubClient{generateOut: "Děkujeme, ozveme se s detaily ohledně techniky."}
	handler := Generate(client, "m", silentLogger())

	req := httptest.NewRequest(http.MethodPost, "/v1/generate",
		strings.NewReader(`{"last_reply":"hi","system_prompt":"PIRATE_MODE"}`))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("got %d (body %s)", w.Code, w.Body.String())
	}
	if !strings.Contains(client.lastPrompt, "PIRATE_MODE") {
		t.Fatalf("expected custom system prompt PIRATE_MODE in prompt, got %s", client.lastPrompt)
	}
	if strings.Contains(client.lastPrompt, "B2B") {
		t.Fatalf("default prompt leaked despite override; prompt %s", client.lastPrompt)
	}
}

func TestGenerateHandler_TruncatesLongContext(t *testing.T) {
	client := &stubClient{generateOut: "Děkujeme za info, ozveme se s nabídkou techniky brzy."}
	handler := Generate(client, "m", silentLogger())

	huge := strings.Repeat("a", 10_000)
	body, _ := json.Marshal(GenerateRequest{
		ThreadContext: huge,
		LastReply:     "Kolik?",
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/generate",
		strings.NewReader(string(body)))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("got %d", w.Code)
	}
	// Ollama prompt by měl být v nízkých kilobytech, ne 10kB.
	if len(client.lastPrompt) > 6000 {
		t.Fatalf("expected truncation to ~4kB context; got %d bytes prompt", len(client.lastPrompt))
	}
}

func TestGenerateHandler_PassesLastReplyAsUserPart(t *testing.T) {
	client := &stubClient{generateOut: "Děkujeme za zprávu, brzy odpovíme s detaily o ceně."}
	handler := Generate(client, "m", silentLogger())

	req := httptest.NewRequest(http.MethodPost, "/v1/generate",
		strings.NewReader(`{"last_reply":"Pošlete prosím ceník."}`))
	w := httptest.NewRecorder()
	handler(w, req)

	if !strings.Contains(client.lastPrompt, "Pošlete prosím ceník.") {
		t.Fatalf("last_reply not in prompt: %s", client.lastPrompt)
	}
}

func TestGenerateHandler_RefusalDraftIsLowConfidence(t *testing.T) {
	client := &stubClient{generateOut: "I cannot generate a response for this."}
	handler := Generate(client, "m", silentLogger())

	req := httptest.NewRequest(http.MethodPost, "/v1/generate",
		strings.NewReader(`{"last_reply":"hi"}`))
	w := httptest.NewRecorder()
	handler(w, req)

	var resp GenerateResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !resp.LowConf {
		t.Fatalf("expected low_confidence=true for refusal; got conf=%.2f", resp.Confidence)
	}
}
