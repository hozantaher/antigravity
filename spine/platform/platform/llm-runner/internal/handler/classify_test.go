package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- ParseClassification table-driven (≥10 cases) ---

func TestParseClassification_TableDriven(t *testing.T) {
	cases := []struct {
		name         string
		raw          string
		wantCategory string
		wantMinConf  float64
		wantLowConf  bool
	}{
		{"exact interested", "interested", "interested", 0.9, false},
		{"exact meeting", "meeting", "meeting", 0.9, false},
		{"exact later", "later", "later", 0.9, false},
		{"exact objection", "objection", "objection", 0.9, false},
		{"exact negative", "negative", "negative", 0.9, false},
		{"exact ooo", "ooo", "ooo", 0.9, false},
		{"prefix Category:", "Category: meeting", "meeting", 0.9, false},
		{"with whitespace", "   interested\n", "interested", 0.9, false},
		{"with punctuation", "interested.", "interested", 0.9, false},
		{"uppercase", "INTERESTED", "interested", 0.9, false},
		{"substring fallback", "the answer is later in the day", "later", 0.5, true},
		{"unknown", "banana smoothie", "unknown", 0.0, true},
		{"empty", "", "unknown", 0.0, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cat, conf := ParseClassification(tc.raw)
			if cat != tc.wantCategory {
				t.Fatalf("category: want %q, got %q", tc.wantCategory, cat)
			}
			if conf < tc.wantMinConf-0.001 {
				t.Fatalf("confidence: want ≥%.2f, got %.2f", tc.wantMinConf, conf)
			}
			if (conf < minClassifyConfidence) != tc.wantLowConf {
				t.Fatalf("low_conf: want %v (conf=%.2f, min=%.2f)", tc.wantLowConf, conf, minClassifyConfidence)
			}
		})
	}
}

// --- HTTP handler integration ---

func TestClassifyHandler_Success(t *testing.T) {
	client := &stubClient{generateOut: "interested"}
	handler := Classify(client, "llama3.2:3b", silentLogger())

	body := strings.NewReader(`{"text":"Kolik to stojí?"}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/classify", body)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var resp ClassifyResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Category != "interested" {
		t.Fatalf("category: %s", resp.Category)
	}
	if resp.Model != "llama3.2:3b" {
		t.Fatalf("model: %s", resp.Model)
	}
	if resp.LowConf {
		t.Fatal("expected high confidence, got low_confidence=true")
	}
	if client.generateCalls != 1 {
		t.Fatalf("expected 1 generate call, got %d", client.generateCalls)
	}
	if !strings.Contains(client.lastPrompt, "Kolik to stojí?") {
		t.Fatalf("prompt missing user text: %s", client.lastPrompt)
	}
}

func TestClassifyHandler_LowConfidence(t *testing.T) {
	client := &stubClient{generateOut: "the model says probably later for this"}
	handler := Classify(client, "llama3.2:3b", silentLogger())

	body := strings.NewReader(`{"text":"hello"}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/classify", body)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("got %d", w.Code)
	}
	var resp ClassifyResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Category != "later" {
		t.Fatalf("category: %s", resp.Category)
	}
	if !resp.LowConf {
		t.Fatalf("expected low_confidence=true (substring match), got false (conf=%.2f)", resp.Confidence)
	}
}

func TestClassifyHandler_OllamaError(t *testing.T) {
	client := &stubClient{generateErr: errBoom}
	handler := Classify(client, "m", silentLogger())

	req := httptest.NewRequest(http.MethodPost, "/v1/classify", strings.NewReader(`{"text":"x"}`))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "ollama call failed") {
		t.Fatalf("body: %s", w.Body.String())
	}
}

func TestClassifyHandler_MethodNotAllowed(t *testing.T) {
	client := &stubClient{}
	handler := Classify(client, "m", silentLogger())

	req := httptest.NewRequest(http.MethodGet, "/v1/classify", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestClassifyHandler_InvalidJSON(t *testing.T) {
	client := &stubClient{}
	handler := Classify(client, "m", silentLogger())

	req := httptest.NewRequest(http.MethodPost, "/v1/classify", strings.NewReader(`{not-json`))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestClassifyHandler_EmptyText(t *testing.T) {
	client := &stubClient{}
	handler := Classify(client, "m", silentLogger())

	req := httptest.NewRequest(http.MethodPost, "/v1/classify", strings.NewReader(`{"text":""}`))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "text is required") {
		t.Fatalf("body: %s", w.Body.String())
	}
	if client.generateCalls != 0 {
		t.Fatalf("ollama should not be called, got %d calls", client.generateCalls)
	}
}

func TestClassifyHandler_WhitespaceOnlyText(t *testing.T) {
	client := &stubClient{}
	handler := Classify(client, "m", silentLogger())

	req := httptest.NewRequest(http.MethodPost, "/v1/classify", strings.NewReader(`{"text":"   "}`))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestClassifyHandler_TruncatesLongInput(t *testing.T) {
	client := &stubClient{generateOut: "negative"}
	handler := Classify(client, "m", silentLogger())

	long := strings.Repeat("á", 1000) // 2000 bytes (UTF-8)
	body, _ := json.Marshal(ClassifyRequest{Text: long})
	req := httptest.NewRequest(http.MethodPost, "/v1/classify", strings.NewReader(string(body)))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("got %d (body %s)", w.Code, w.Body.String())
	}
	// Prompt by měl obsahovat truncated input — ne celých 2000 bytes.
	if len(client.lastPrompt) > len(classifyPrompt)+700 {
		t.Fatalf("prompt is too long; truncate broken: %d bytes", len(client.lastPrompt))
	}
}

func TestClassifyHandler_UnknownFieldsRejected(t *testing.T) {
	client := &stubClient{}
	handler := Classify(client, "m", silentLogger())

	req := httptest.NewRequest(http.MethodPost, "/v1/classify",
		strings.NewReader(`{"text":"hi","unexpected":"field"}`))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestClassifyHandler_RawWithCategoryPrefix(t *testing.T) {
	client := &stubClient{generateOut: "Category: negative"}
	handler := Classify(client, "m", silentLogger())

	req := httptest.NewRequest(http.MethodPost, "/v1/classify",
		strings.NewReader(`{"text":"nemám zájem"}`))
	w := httptest.NewRecorder()
	handler(w, req)

	var resp ClassifyResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Category != "negative" {
		t.Fatalf("category: %s (raw output had Category: prefix)", resp.Category)
	}
	if resp.LowConf {
		t.Fatalf("expected high confidence after prefix strip; got low (conf=%.2f)", resp.Confidence)
	}
}
