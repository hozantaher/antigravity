package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// TestReplySentimentClassifier_TableDriven exercises the full prompt →
// extractCategory → adapter chain against a mock Ollama. The table covers
// every shape of model response we have observed in production:
//
//   - bare label            (`negative`)
//   - whitespace + newline  (`negative \n`)
//   - "Category: " prefix   (the model sometimes echoes the prompt)
//   - extra prose preamble  (`Sure, the category is negative.`)
//   - all six valid labels
//   - unknown label         (extractCategory falls back to "interested")
//   - empty response        (extractCategory falls back to "interested")
//
// The fallback contract on Sprint A: even when the model returns garbage
// the classifier must return SOME valid category so the inbound pipeline
// can route the reply rather than panic / no-op.
func TestReplySentimentClassifier_TableDriven(t *testing.T) {
	cases := []struct {
		name     string
		response string
		want     string
	}{
		{"bare interested", "interested", "interested"},
		{"bare meeting", "meeting", "meeting"},
		{"bare later", "later", "later"},
		{"bare objection", "objection", "objection"},
		{"bare negative", "negative", "negative"},
		{"bare ooo", "ooo", "ooo"},

		{"trailing newline", "negative\n", "negative"},
		{"leading whitespace + newline", "  negative \n", "negative"},
		{"uppercase", "NEGATIVE", "negative"},
		{"with period", "negative.", "negative"},
		{"with comma", "negative, the lead refused", "negative"},

		{"category: prefix", "Category: negative", "negative"},
		{"category : prefix space", "category : ooo", "ooo"},
		{"category: prefix newline", "Category: meeting\n", "meeting"},

		{"prose then label", "Sure, the category is negative.", "negative"},
		{"label embedded", "I think this reply is interested overall", "interested"},

		{"unknown label", "spam", "interested"},        // falls back via default
		{"empty response", "", "interested"},           // falls back via default
		{"only whitespace", "   \n\t  ", "interested"}, // falls back via default
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			client := makeTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				_ = json.NewEncoder(w).Encode(generateResponse{
					Response: c.response,
					Done:     true,
				})
			})
			r := NewReplySentimentClassifier(client)
			got, err := r.ClassifySentiment(context.Background(), "irrelevant — mock controls response")
			if err != nil {
				t.Fatalf("ClassifySentiment: %v", err)
			}
			if got != c.want {
				t.Errorf("response=%q: got %q, want %q", c.response, got, c.want)
			}
		})
	}
}

// TestReplySentimentClassifier_PromptShape pins the prompt contract:
// every classification call MUST embed the reply text inside a prompt
// that contains the category vocabulary. If a future refactor breaks the
// embedding, the LLM would be classifying a different shape of input
// than what was tuned against the sample bank.
func TestReplySentimentClassifier_PromptShape(t *testing.T) {
	var seenPrompt string
	var mu sync.Mutex

	client := makeTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		var req generateRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		mu.Lock()
		seenPrompt = req.Prompt
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(generateResponse{Response: "negative", Done: true})
	})

	classifier := NewReplySentimentClassifier(client)
	const reply = "Nemám zájem, odhlaste mě prosím."
	if _, err := classifier.ClassifySentiment(context.Background(), reply); err != nil {
		t.Fatalf("classify: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	for _, want := range []string{
		"interested", "meeting", "later", "objection", "negative", "ooo",
		reply, // the actual reply must be embedded
	} {
		if !strings.Contains(seenPrompt, want) {
			t.Errorf("prompt missing %q (got %d chars)", want, len(seenPrompt))
		}
	}
}

// TestReplySentimentClassifier_LongReplyTruncated pins the 500-char
// truncation in ClassifySentiment. Without it, a very long auto-reply
// or quoted-history thread would balloon the prompt and risk Ollama
// context overflow on small models like gemma2:2b (8k context).
func TestReplySentimentClassifier_LongReplyTruncated(t *testing.T) {
	var seenPrompt string
	var mu sync.Mutex

	client := makeTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		var req generateRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		mu.Lock()
		seenPrompt = req.Prompt
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(generateResponse{Response: "negative", Done: true})
	})

	long := strings.Repeat("a", 2000)
	classifier := NewReplySentimentClassifier(client)
	if _, err := classifier.ClassifySentiment(context.Background(), long); err != nil {
		t.Fatalf("classify: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	// Reply text should be present at exactly 500 chars (everything beyond
	// is dropped). A simple count of consecutive 'a' runs in the prompt
	// gives us the embedded length without depending on the prompt format.
	maxRun := 0
	cur := 0
	for _, ch := range seenPrompt {
		if ch == 'a' {
			cur++
			if cur > maxRun {
				maxRun = cur
			}
		} else {
			cur = 0
		}
	}
	if maxRun != 500 {
		t.Errorf("longest 'a' run in prompt = %d, want 500 (truncation)", maxRun)
	}
}

// TestReplySentimentClassifier_TimeoutSurface verifies the classifier
// surfaces a context-cancellation as an error rather than blocking
// forever. Sprint A.5: callers (inbound.go) need to fall back to keyword
// classification when Ollama hangs.
func TestReplySentimentClassifier_TimeoutSurface(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done() // hold the request until the client cancels
	}))
	t.Cleanup(srv.Close)

	client := &Client{
		baseURL:    srv.URL,
		model:      "test-model",
		httpClient: srv.Client(),
	}
	classifier := NewReplySentimentClassifier(client)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before the call so the request fails immediately

	_, err := classifier.ClassifySentiment(ctx, "Test reply.")
	if err == nil {
		t.Fatal("expected error from cancelled context, got nil")
	}
}
