package llm

// k3_llm_test.go — K3 TDD + property + monkey tests for llm package.
// Coverage targets (from /tmp/orch3.out):
//   anthropic.go:57   — complete() empty response branch
//   anthropic.go:74   — ClassifyIndustry error from complete
//   anthropic.go:79   — extractTags returns [] fallback to ["other"]
//   anthropic.go:95   — SummarizeDescription error from complete
//   anthropic.go:108  — ClassifySentiment error from complete
//   anthropic.go:112  — ClassifySentiment empty cat fallback
//   classify.go:39    — Client.ClassifyIndustry empty description early return
//   enrich.go:69      — parseDescriptionTags JSON unmarshal error (additional cases)

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/quick"

	anthropic "github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// ─────────────────────────────────────────────────────────────────────────────
// AnthropicClient.complete: empty response branch (anthropic.go:57-59)
// ─────────────────────────────────────────────────────────────────────────────

func TestAnthropicComplete_EmptyContentArray(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{
			"id":"msg_empty","type":"message","role":"assistant",
			"content":[],"model":"claude-haiku-4-5-20251001",
			"stop_reason":"end_turn","stop_sequence":null,
			"usage":{"input_tokens":1,"output_tokens":0}
		}`))
	}))
	defer srv.Close()

	ac := &AnthropicClient{
		client: anthropic.NewClient(
			option.WithAPIKey("test-key"),
			option.WithBaseURL(srv.URL+"/"),
		),
		model: anthropic.ModelClaudeHaiku4_5_20251001,
	}

	_, err := ac.complete(context.Background(), "test prompt")
	if err == nil {
		t.Fatal("expected error for empty content array")
	}
	if !strings.Contains(err.Error(), "empty response") {
		t.Errorf("expected 'empty response' in error, got: %v", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// AnthropicClient.ClassifyIndustry: complete error path (anthropic.go:74-76)
// ─────────────────────────────────────────────────────────────────────────────

func TestAnthropicClassifyIndustry_CompleteError_PropagatesError(t *testing.T) {
	ac := NewAnthropicClient(AnthropicConfig{APIKey: "invalid-key"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancelled — HTTP call fails

	res, err := ac.ClassifyIndustry(ctx, "výroba bagru a strojů")
	if err == nil {
		t.Error("expected error from ClassifyIndustry with cancelled context")
	}
	if res != nil {
		t.Errorf("result should be nil on error; got %v", res)
	}
}

// TestAnthropicClassifyIndustry_NoTagsInResponse verifies extractTags falls
// back to ["other"] when the LLM response has no recognisable tags (anthropic.go:79-81).
func TestAnthropicClassifyIndustry_NoTagsInResponse_FallsBackToOther(t *testing.T) {
	srv := fakeAnthropicServer("totally_unrecognised_xyz123")
	defer srv.Close()
	c := newTestAnthropicClient(srv)

	res, err := c.ClassifyIndustry(context.Background(), "firma xyz")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(res.Tags) == 0 || res.Tags[0] != "other" {
		t.Errorf("expected fallback to [other], got %v", res.Tags)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// AnthropicClient.SummarizeDescription: error branch (anthropic.go:95-97)
// ─────────────────────────────────────────────────────────────────────────────

func TestAnthropicSummarizeDescription_CompleteError(t *testing.T) {
	ac := NewAnthropicClient(AnthropicConfig{APIKey: "invalid-key"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := ac.SummarizeDescription(ctx, "Firma vyrábí CNC součásti.")
	if err == nil {
		t.Error("expected error from SummarizeDescription with cancelled context")
	}
	if !strings.Contains(err.Error(), "anthropic summarize") {
		t.Errorf("error should be wrapped with 'anthropic summarize'; got: %v", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// AnthropicClient.ClassifySentiment: error + empty cat branches (anthropic.go:108-114)
// ─────────────────────────────────────────────────────────────────────────────

func TestAnthropicClassifySentiment_CompleteError(t *testing.T) {
	ac := NewAnthropicClient(AnthropicConfig{APIKey: "invalid-key"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := ac.ClassifySentiment(ctx, "Ano, máme zájem.")
	if err == nil {
		t.Error("expected error from ClassifySentiment with cancelled context")
	}
	if !strings.Contains(err.Error(), "anthropic sentiment") {
		t.Errorf("expected 'anthropic sentiment' wrapper; got: %v", err)
	}
}

func TestAnthropicClassifySentiment_UnrecognizedResponse_NonEmpty(t *testing.T) {
	// When extractCategory returns "" (no recognised word), ClassifySentiment sets cat = "neutral".
	// extractCategory in classify.go actually defaults to "interested" if nothing matches.
	// Either way, the output must not be empty.
	srv := fakeAnthropicServer("xyz_not_a_valid_sentiment_abc")
	defer srv.Close()
	c := newTestAnthropicClient(srv)

	cat, err := c.ClassifySentiment(context.Background(), "some reply text")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cat == "" {
		t.Error("category must not be empty even for unknown responses")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Client.ClassifyIndustry: empty description early return (classify.go:39-41)
// ─────────────────────────────────────────────────────────────────────────────

func TestClientClassifyIndustry_EmptyDescription_ReturnsOther(t *testing.T) {
	c := &Client{baseURL: "http://unused", model: "test", httpClient: &http.Client{}}
	res, err := c.ClassifyIndustry(context.Background(), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(res.Tags) == 0 || res.Tags[0] != "other" {
		t.Errorf("expected [other] for empty description, got %v", res.Tags)
	}
	if res.Confidence != 0 {
		t.Errorf("confidence for empty = %f, want 0", res.Confidence)
	}
}

func TestClientClassifyIndustry_EmptyDescription_NoHTTPCall(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := &Client{baseURL: srv.URL, model: "test", httpClient: srv.Client()}
	c.ClassifyIndustry(context.Background(), "") //nolint:errcheck
	if called {
		t.Error("HTTP call should NOT be made for empty description")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// parseDescriptionTags: additional unmarshal error cases (enrich.go:69-71)
// (ValidJSON, NoJSON, MalformedJSON, EmptyBraces, EndBeforeStart already in enrich_adapter_test.go)
// ─────────────────────────────────────────────────────────────────────────────

func TestParseDescriptionTags_WrongTypes_UnmarshalError(t *testing.T) {
	// tech_keywords must be []string; supplying a number causes unmarshal to fail.
	tags := parseDescriptionTags(`{"main_product":"test","tech_keywords":42,"export_oriented":false,"is_seasonal":false}`)
	if tags == nil {
		t.Fatal("should return non-nil DescriptionTags even on unmarshal error")
	}
	if tags.MainProduct != "" {
		t.Errorf("MainProduct = %q, want empty (unmarshal failed)", tags.MainProduct)
	}
}

func TestParseDescriptionTags_EmptyString_ReturnsEmptyStruct(t *testing.T) {
	tags := parseDescriptionTags("")
	if tags == nil {
		t.Fatal("should return non-nil DescriptionTags for empty string")
	}
	if tags.MainProduct != "" || len(tags.TechKeywords) != 0 {
		t.Errorf("unexpected non-zero fields for empty input: %+v", tags)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Properties: pure functions never panic, invariants hold
// ─────────────────────────────────────────────────────────────────────────────

func TestParseDescriptionTags_NeverPanics_Property(t *testing.T) {
	f := func(s string) bool {
		defer func() { recover() }()
		tags := parseDescriptionTags(s)
		return tags != nil
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("parseDescriptionTags panicked: %v", err)
	}
}

func TestExtractTags_AlwaysNonEmpty_Property(t *testing.T) {
	f := func(s string) bool {
		return len(extractTags(s)) > 0
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("extractTags returned empty slice: %v", err)
	}
}

func TestExtractCategory_AlwaysNonEmpty_Property(t *testing.T) {
	f := func(s string) bool {
		return extractCategory(s) != ""
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("extractCategory returned empty string: %v", err)
	}
}

func TestClientClassifyIndustry_NeverPanics_Property(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"response":"machinery","done":true}`))
	}))
	defer srv.Close()
	c := &Client{baseURL: srv.URL, model: "test", httpClient: srv.Client()}

	f := func(s string) bool {
		defer func() { recover() }()
		c.ClassifyIndustry(context.Background(), s) //nolint:errcheck
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 100}); err != nil {
		t.Errorf("Client.ClassifyIndustry panicked: %v", err)
	}
}

func TestClientClassifyIndustry_ConfidenceInRange_Property(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"response":"machinery","done":true}`))
	}))
	defer srv.Close()
	c := &Client{baseURL: srv.URL, model: "test", httpClient: srv.Client()}

	f := func(s string) bool {
		res, err := c.ClassifyIndustry(context.Background(), s)
		if err != nil {
			return true
		}
		return res.Confidence >= 0 && res.Confidence <= 1.0
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 50}); err != nil {
		t.Errorf("confidence out of [0,1]: %v", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Monkey: extreme inputs / no panics
// ─────────────────────────────────────────────────────────────────────────────

func TestAnthropicClassifyIndustry_ExtremeInputs_NoPanic(t *testing.T) {
	srv := fakeAnthropicServer("[machinery]")
	defer srv.Close()
	c := newTestAnthropicClient(srv)

	for _, input := range []string{
		"",
		strings.Repeat("x", 1000),
		strings.Repeat("ě", 300),
		"\n\t\r ",
	} {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("panicked for input len=%d: %v", len(input), r)
				}
			}()
			c.ClassifyIndustry(context.Background(), input) //nolint:errcheck
		}()
	}
}

func TestNewAnthropicClient_ExtremeAPIKeys_NoPanic(t *testing.T) {
	for _, key := range []string{
		"",
		strings.Repeat("k", 1000),
		"key with spaces",
		"sk-" + strings.Repeat("x", 200),
	} {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("panicked for key len=%d: %v", len(key), r)
				}
			}()
			c := NewAnthropicClient(AnthropicConfig{APIKey: key})
			if c == nil {
				t.Errorf("NewAnthropicClient returned nil for key len=%d", len(key))
			}
		}()
	}
}

func TestIndustryResult_ExtremeConfidence_NoPanic(t *testing.T) {
	for _, v := range []float64{
		math.MaxFloat64, -1.0, 0, 1.0, math.NaN(), math.Inf(1),
	} {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("panicked for confidence %v: %v", v, r)
				}
			}()
			r := IndustryResult{Tags: []string{"machinery"}, Confidence: v}
			_ = r.Confidence > 0
		}()
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrent safety
// ─────────────────────────────────────────────────────────────────────────────

func TestAnthropicClient_ConcurrentClassify_NoRace(t *testing.T) {
	srv := fakeAnthropicServer("[machinery]")
	defer srv.Close()
	c := newTestAnthropicClient(srv)

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.ClassifyIndustry(context.Background(), "výroba strojů") //nolint:errcheck
		}()
	}
	wg.Wait()
}

func TestParseDescriptionTags_ConcurrentCalls_NoRace(t *testing.T) {
	input := `{"main_product":"CNC","tech_keywords":["frézování"],"export_oriented":true,"is_seasonal":false}`
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = parseDescriptionTags(input).MainProduct
		}()
	}
	wg.Wait()
}

// ─────────────────────────────────────────────────────────────────────────────
// Boundary: DescriptionTags edge cases
// ─────────────────────────────────────────────────────────────────────────────

func TestDescriptionTags_BoundaryValues(t *testing.T) {
	cases := []struct {
		name, json string
	}{
		{"empty_tech_keywords", `{"main_product":"test","tech_keywords":[],"export_oriented":false,"is_seasonal":false}`},
		{"many_tech_keywords", `{"main_product":"x","tech_keywords":["CNC","svařování","frézování","soustružení","obrábění"],"export_oriented":true,"is_seasonal":true}`},
		{"long_main_product", `{"main_product":"` + strings.Repeat("a", 80) + `","tech_keywords":[],"export_oriented":false,"is_seasonal":false}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("panicked: %v", r)
				}
			}()
			if tags := parseDescriptionTags(tc.json); tags == nil {
				t.Error("expected non-nil tags")
			}
		})
	}
}

// TestAnthropicClient_InvalidAPIKey_AllMethods_NoPanic is a catch-all monkey
// test that calls every AnthropicClient method with a cancelled context and
// verifies none of them panic.
func TestAnthropicClient_InvalidAPIKey_AllMethods_NoPanic(t *testing.T) {
	ac := NewAnthropicClient(AnthropicConfig{APIKey: "sk-invalid"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	type callFn struct {
		name string
		fn   func()
	}
	calls := []callFn{
		{"ClassifyIndustry", func() { ac.ClassifyIndustry(ctx, "test") }},         //nolint:errcheck
		{"SummarizeDescription", func() { ac.SummarizeDescription(ctx, "test") }}, //nolint:errcheck
		{"ClassifySentiment", func() { ac.ClassifySentiment(ctx, "test") }},       //nolint:errcheck
		{"GenerateOpener", func() { ac.GenerateOpener(ctx, "f", "d", "n") }},      //nolint:errcheck
		{"Ping", func() { ac.Ping(ctx) }},                                          //nolint:errcheck
	}
	for _, call := range calls {
		t.Run(call.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("%s panicked: %v", call.name, r)
				}
			}()
			call.fn()
		})
	}
}
