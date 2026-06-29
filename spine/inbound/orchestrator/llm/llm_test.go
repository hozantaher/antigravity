package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// ── Generate — HTTP-stubbed unit tests ──

func makeTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return &Client{
		baseURL:    srv.URL,
		model:      "test-model",
		httpClient: srv.Client(),
	}
}

func TestGenerate_Success(t *testing.T) {
	c := makeTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(generateResponse{
			Response:      "  machinery  ",
			TotalDuration: 1_000_000,
			Done:          true,
		})
	})
	text, dur, err := c.Generate(context.Background(), "classify this")
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if text != "machinery" { t.Errorf("want 'machinery', got %q", text) }
	if dur == 0 { t.Error("duration should be non-zero") }
}

func TestGenerate_NonOKStatus(t *testing.T) {
	c := makeTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	})
	_, _, err := c.Generate(context.Background(), "prompt")
	if err == nil { t.Error("expected error on non-OK status") }
	if !strings.Contains(err.Error(), "503") { t.Errorf("error should mention status, got: %v", err) }
}

func TestGenerate_DecodeError(t *testing.T) {
	c := makeTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "not-json")
	})
	_, _, err := c.Generate(context.Background(), "prompt")
	if err == nil { t.Error("expected decode error") }
}

// ── ModelLoaded — HTTP-stubbed tests ──

func TestModelLoaded_ExactMatch(t *testing.T) {
	c := makeTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"models": []map[string]string{{"name": "test-model"}},
		})
	})
	ok, err := c.ModelLoaded(context.Background())
	if err != nil { t.Fatal(err) }
	if !ok { t.Error("exact match should return true") }
}

func TestModelLoaded_TagMatch(t *testing.T) {
	c := makeTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"models": []map[string]string{{"name": "test-model:latest"}},
		})
	})
	ok, err := c.ModelLoaded(context.Background())
	if err != nil { t.Fatal(err) }
	if !ok { t.Error("tag match (model:latest) should return true") }
}

func TestModelLoaded_NotFound(t *testing.T) {
	c := makeTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"models": []map[string]string{{"name": "other-model"}},
		})
	})
	ok, err := c.ModelLoaded(context.Background())
	if err != nil { t.Fatal(err) }
	if ok { t.Error("unrelated model should return false") }
}

func TestModelLoaded_TransportError(t *testing.T) {
	c := &Client{
		baseURL: "http://localhost:11434",
		model:   "test-model",
		httpClient: &http.Client{
			Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				return nil, io.ErrUnexpectedEOF
			}),
		},
	}
	_, err := c.ModelLoaded(context.Background())
	if err == nil { t.Error("expected transport error from ModelLoaded") }
}

func TestModelLoaded_DecodeError(t *testing.T) {
	c := makeTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "{bad json")
	})
	_, err := c.ModelLoaded(context.Background())
	if err == nil { t.Error("expected decode error") }
}

// ── Config / Constructor ──

func TestNewClient_Defaults(t *testing.T) {
	c := NewClient(Config{})
	if c.baseURL != "http://localhost:11434" { t.Errorf("baseURL: %s", c.baseURL) }
	if c.model != "gemma2:2b" { t.Errorf("model: %s", c.model) }
}

func TestNewClient_Custom(t *testing.T) {
	c := NewClient(Config{BaseURL: "https://ollama.railway.app/", Model: "llama3:8b"})
	if c.baseURL != "https://ollama.railway.app" { t.Errorf("baseURL trailing slash: %s", c.baseURL) }
	if c.model != "llama3:8b" { t.Errorf("model: %s", c.model) }
}

// ── Tag Extraction ──

func TestExtractTags_Single(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"machinery", "machinery"},
		{"**manufacturing**", "manufacturing"},
		{"The tag is construction.", "construction"},
		{"agriculture - farming equipment", "agriculture"},
		{"This is something completely different", "other"},
		{"MACHINERY", "machinery"},
		{"", "other"},
	}
	for _, tt := range tests {
		got := extractTags(tt.in)
		if len(got) == 0 || got[0] != tt.want {
			t.Errorf("extractTags(%q)[0] = %v, want %q", tt.in, got, tt.want)
		}
	}
}

func TestExtractTags_MultiTag(t *testing.T) {
	got := extractTags("machinery, metalwork")
	want := []string{"machinery", "metalwork"}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestExtractTags_NewTags(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"food_processing", "food_processing"},
		{"plastics", "plastics"},
	}
	for _, tc := range tests {
		got := extractTags(tc.input)
		if len(got) == 0 || got[0] != tc.want {
			t.Errorf("input %q: got %v, want %v", tc.input, got, tc.want)
		}
	}
}

func TestExtractTags_Dedup(t *testing.T) {
	got := extractTags("machinery, machinery, metalwork")
	if len(got) != 2 {
		t.Errorf("expected dedup to 2: got %v", got)
	}
}

func TestExtractTags_Max3(t *testing.T) {
	got := extractTags("machinery, construction, agriculture, transport, manufacturing")
	if len(got) != 3 {
		t.Errorf("expected max 3: got %v (len %d)", got, len(got))
	}
}

func TestExtractTags_FallsBackToOther(t *testing.T) {
	got := extractTags("definitely not a valid industry response xyz")
	if len(got) != 1 || got[0] != "other" {
		t.Errorf("expected [other], got %v", got)
	}
}

func TestExtractCategory(t *testing.T) {
	tests := []struct{ in, want string }{
		{"interested", "interested"},
		{"meeting - let's schedule", "meeting"},
		{"negative", "negative"},
		{"**ooo**", "ooo"},
		{"Later, not now", "later"},
		{"some random text", "interested"}, // default
		{"", "interested"},
		// first word doesn't match but body contains a category → hits strings.Contains path
		{"the person seems interested in our offer", "interested"},
		{"they are on objection ground", "objection"},
	}
	for _, tt := range tests {
		if got := extractCategory(tt.in); got != tt.want {
			t.Errorf("extractCategory(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestValidTags(t *testing.T) {
	expected := []string{"machinery", "construction", "agriculture", "transport", "manufacturing", "metalwork", "woodwork", "automotive", "energy", "waste", "food_processing", "plastics", "other"}
	for _, tag := range expected {
		if !ValidTags[tag] { t.Errorf("missing valid tag: %s", tag) }
	}
	if len(ValidTags) != 13 { t.Errorf("expected 13 tags, got %d", len(ValidTags)) }
}

// ── Generate transport error ──

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestGenerate_TransportError(t *testing.T) {
	c := &Client{
		baseURL: "http://localhost:11434",
		model:   "test-model",
		httpClient: &http.Client{
			Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				return nil, io.ErrUnexpectedEOF
			}),
		},
	}
	_, _, err := c.Generate(context.Background(), "prompt")
	if err == nil { t.Error("expected transport error") }
}

// ── Ping ──

func TestPing_Success(t *testing.T) {
	c := makeTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "Ollama is running")
	})
	if err := c.Ping(context.Background()); err != nil {
		t.Fatalf("ping: %v", err)
	}
}

func TestPing_NonOK(t *testing.T) {
	c := makeTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	if err := c.Ping(context.Background()); err == nil {
		t.Error("expected error on non-OK ping")
	}
}

func TestPing_TransportError(t *testing.T) {
	c := &Client{
		baseURL: "http://localhost:11434",
		model:   "test-model",
		httpClient: &http.Client{
			Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				return nil, io.ErrUnexpectedEOF
			}),
		},
	}
	if err := c.Ping(context.Background()); err == nil {
		t.Error("expected transport error from Ping")
	}
}

// ── ClassifyIndustry error path + truncation ──

func TestClassifyIndustry_GenerateError(t *testing.T) {
	c := &Client{
		baseURL: "http://localhost:11434",
		model:   "test-model",
		httpClient: &http.Client{
			Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				return nil, io.ErrUnexpectedEOF
			}),
		},
	}
	_, err := c.ClassifyIndustry(context.Background(), "description")
	if err == nil { t.Error("expected error from ClassifyIndustry on transport failure") }
}

func TestClassifyIndustry_TruncatesLongDescription(t *testing.T) {
	var capturedPrompt string
	c := makeTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		var req generateRequest
		json.NewDecoder(r.Body).Decode(&req)
		capturedPrompt = req.Prompt
		json.NewEncoder(w).Encode(generateResponse{Response: "machinery", Done: true})
	})
	longDesc := strings.Repeat("a", 600)
	c.ClassifyIndustry(context.Background(), longDesc)
	if strings.Contains(capturedPrompt, strings.Repeat("a", 501)) {
		t.Error("description should be truncated to 500 chars")
	}
}

func TestClassifyIndustry_OtherTagConfidence(t *testing.T) {
	c := makeTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(generateResponse{Response: "other", Done: true})
	})
	result, err := c.ClassifyIndustry(context.Background(), "some description")
	if err != nil { t.Fatal(err) }
	if result.Confidence != 0.3 { t.Errorf("single 'other' tag should have confidence 0.3, got %f", result.Confidence) }
}

// ── ClassifySentiment ──

func TestClassifySentiment_EmptyInput(t *testing.T) {
	c := &Client{}
	cat, err := c.ClassifySentiment(context.Background(), "")
	if err != nil { t.Fatal(err) }
	if cat != "other" { t.Errorf("empty input: want 'other', got %q", cat) }
}

func TestClassifySentiment_GenerateError(t *testing.T) {
	c := &Client{
		baseURL: "http://localhost:11434",
		model:   "test-model",
		httpClient: &http.Client{
			Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				return nil, io.ErrUnexpectedEOF
			}),
		},
	}
	_, err := c.ClassifySentiment(context.Background(), "some reply")
	if err == nil { t.Error("expected error from ClassifySentiment on transport failure") }
}

func TestClassifySentiment_Truncation(t *testing.T) {
	var capturedPrompt string
	c := makeTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		var req generateRequest
		json.NewDecoder(r.Body).Decode(&req)
		capturedPrompt = req.Prompt
		json.NewEncoder(w).Encode(generateResponse{Response: "interested", Done: true})
	})
	longReply := strings.Repeat("b", 600)
	c.ClassifySentiment(context.Background(), longReply)
	if strings.Contains(capturedPrompt, strings.Repeat("b", 501)) {
		t.Error("reply should be truncated to 500 chars")
	}
}

// ── SummarizeDescription ──

func TestSummarizeDescription_ShortInput(t *testing.T) {
	c := &Client{}
	short := "Krátký text"
	got, err := c.SummarizeDescription(context.Background(), short)
	if err != nil { t.Fatal(err) }
	if got != short { t.Errorf("short input: got %q, want %q", got, short) }
}

func TestSummarizeDescription_LongInput(t *testing.T) {
	var capturedPrompt string
	c := makeTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		var req generateRequest
		json.NewDecoder(r.Body).Decode(&req)
		capturedPrompt = req.Prompt
		json.NewEncoder(w).Encode(generateResponse{Response: "summary", Done: true})
	})
	longDesc := strings.Repeat("c", 1100)
	c.SummarizeDescription(context.Background(), longDesc)
	if strings.Contains(capturedPrompt, strings.Repeat("c", 1001)) {
		t.Error("description should be truncated to 1000 chars")
	}
}

func TestSummarizeDescription_GenerateError(t *testing.T) {
	c := &Client{
		baseURL: "http://localhost:11434",
		model:   "test-model",
		httpClient: &http.Client{
			Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				return nil, io.ErrUnexpectedEOF
			}),
		},
	}
	_, err := c.SummarizeDescription(context.Background(), strings.Repeat("x", 200))
	if err == nil { t.Error("expected error from SummarizeDescription on transport failure") }
}

// ── Integration tests (only when Ollama running) ──

func skipIfNoOllama(t *testing.T) {
	c := NewClient(Config{})
	if err := c.Ping(context.Background()); err != nil {
		t.Skipf("Ollama not running: %v", err)
	}
}

func TestIntegration_Ping(t *testing.T) {
	skipIfNoOllama(t)
	c := NewClient(Config{})
	if err := c.Ping(context.Background()); err != nil {
		t.Fatalf("ping: %v", err)
	}
}

func TestIntegration_ModelLoaded(t *testing.T) {
	skipIfNoOllama(t)
	c := NewClient(Config{Model: "gemma2:2b"})
	loaded, err := c.ModelLoaded(context.Background())
	if err != nil { t.Fatalf("model check: %v", err) }
	if !loaded { t.Skip("gemma2:2b not loaded") }
}

func TestIntegration_ClassifyIndustry(t *testing.T) {
	skipIfNoOllama(t)
	c := NewClient(Config{Model: "gemma2:2b"})

	result, err := c.ClassifyIndustry(context.Background(),
		"Výroba strojů, CNC obráběním, fréz a soustruhů.")
	if err != nil { t.Fatalf("classify: %v", err) }

	if len(result.Tags) == 0 || !ValidTags[result.Tags[0]] {
		t.Errorf("invalid tags: %v", result.Tags)
	}
	// Primary tag should be machinery or manufacturing
	if result.Tags[0] != "machinery" && result.Tags[0] != "manufacturing" {
		t.Errorf("expected machinery/manufacturing, got %s", result.Tags[0])
	}
}

func TestIntegration_ClassifyIndustry_Construction(t *testing.T) {
	skipIfNoOllama(t)
	c := NewClient(Config{Model: "gemma2:2b"})

	result, err := c.ClassifyIndustry(context.Background(),
		"Stavební firma, provádíme zateplení fasád, betonáž a izolace.")
	if err != nil { t.Fatalf("classify: %v", err) }
	if len(result.Tags) == 0 || result.Tags[0] != "construction" {
		t.Errorf("expected construction, got %v", result.Tags)
	}
}

func TestIntegration_ClassifySentiment(t *testing.T) {
	skipIfNoOllama(t)
	c := NewClient(Config{Model: "gemma2:2b"})

	tests := []struct{ text string; acceptable []string }{
		{"Pošlete ceník prosím", []string{"interested"}},
		{"Nemáme zájem, neposílejte", []string{"negative"}},
		{"Jsem mimo kancelář do 15.4.", []string{"ooo", "later"}}, // LLM may interpret as "later"
	}

	for _, tt := range tests {
		cat, err := c.ClassifySentiment(context.Background(), tt.text)
		if err != nil { t.Fatalf("sentiment: %v", err) }
		ok := false
		for _, a := range tt.acceptable {
			if cat == a { ok = true; break }
		}
		if !ok {
			t.Errorf("sentiment(%q) = %q, want one of %v", tt.text, cat, tt.acceptable)
		}
	}
}

func TestIntegration_SummarizeDescription(t *testing.T) {
	skipIfNoOllama(t)
	c := NewClient(Config{Model: "gemma2:2b"})

	summary, err := c.SummarizeDescription(context.Background(),
		"Nabízíme kompletní sortiment stavebního materiálu a stavebnin - cihly, tvárnice bílé a šedé, nosné a nenosné překlady, U- profily, věncovky, cihelné bloky, šamotové cihly a lícové cihly. Dále pak pojiva, tepelné izolace a betonové prvky.")
	if err != nil { t.Fatalf("summarize: %v", err) }
	if summary == "" { t.Error("empty summary") }
	if len(summary) > 500 { t.Errorf("summary too long: %d chars", len(summary)) }
}

func TestIntegration_ClassifyIndustry_Empty(t *testing.T) {
	skipIfNoOllama(t)
	c := NewClient(Config{Model: "gemma2:2b"})
	result, err := c.ClassifyIndustry(context.Background(), "")
	if err != nil { t.Fatal(err) }
	if len(result.Tags) == 0 || result.Tags[0] != "other" { t.Errorf("empty should be 'other', got %v", result.Tags) }
}

// ── NewRequestWithContext error branches (invalid URL) ──

func TestGenerate_InvalidURL(t *testing.T) {
	c := &Client{baseURL: "://invalid", model: "test", httpClient: http.DefaultClient}
	_, _, err := c.Generate(context.Background(), "prompt")
	if err == nil { t.Error("invalid URL should return error from Generate") }
}

func TestPing_InvalidURL(t *testing.T) {
	c := &Client{baseURL: "://invalid", model: "test", httpClient: http.DefaultClient}
	if err := c.Ping(context.Background()); err == nil {
		t.Error("invalid URL should return error from Ping")
	}
}

func TestModelLoaded_InvalidURL(t *testing.T) {
	c := &Client{baseURL: "://invalid", model: "test", httpClient: http.DefaultClient}
	_, err := c.ModelLoaded(context.Background())
	if err == nil { t.Error("invalid URL should return error from ModelLoaded") }
}

func TestIntegration_Railway(t *testing.T) {
	url := os.Getenv("OLLAMA_URL")
	if url == "" { t.Skip("OLLAMA_URL not set") }

	c := NewClient(Config{BaseURL: url, Model: "gemma2:2b"})
	if err := c.Ping(context.Background()); err != nil {
		t.Fatalf("Railway Ollama ping: %v", err)
	}

	result, err := c.ClassifyIndustry(context.Background(), "Výroba strojů")
	if err != nil { t.Fatalf("Railway classify: %v", err) }
	if len(result.Tags) == 0 { t.Error("empty tags from Railway") }
}
