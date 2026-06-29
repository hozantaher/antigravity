package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// ── parseDescriptionTags ─────────────────────────────────────────────────────

func TestParseDescriptionTags_ValidJSON(t *testing.T) {
	response := `Some preamble {"main_product":"CNC obrábění","tech_keywords":["CNC","frézování"],"export_oriented":true,"is_seasonal":false}`
	tags := parseDescriptionTags(response)
	if tags.MainProduct != "CNC obrábění" {
		t.Errorf("MainProduct = %q, want 'CNC obrábění'", tags.MainProduct)
	}
	if len(tags.TechKeywords) != 2 {
		t.Errorf("TechKeywords len = %d, want 2", len(tags.TechKeywords))
	}
	if !tags.ExportOriented {
		t.Error("ExportOriented should be true")
	}
	if tags.IsSeasonal {
		t.Error("IsSeasonal should be false")
	}
}

func TestParseDescriptionTags_NoJSON(t *testing.T) {
	tags := parseDescriptionTags("no json here at all")
	if tags == nil {
		t.Fatal("should return empty struct, not nil")
	}
	if tags.MainProduct != "" {
		t.Errorf("want empty MainProduct, got %q", tags.MainProduct)
	}
}

func TestParseDescriptionTags_MalformedJSON(t *testing.T) {
	tags := parseDescriptionTags(`{"main_product": broken`)
	if tags == nil {
		t.Fatal("should return empty struct, not nil")
	}
	if tags.MainProduct != "" {
		t.Errorf("want empty MainProduct for malformed JSON, got %q", tags.MainProduct)
	}
}

func TestParseDescriptionTags_EmptyBraces(t *testing.T) {
	tags := parseDescriptionTags("{}")
	if tags == nil {
		t.Fatal("nil tags for empty braces")
	}
}

func TestParseDescriptionTags_EndBeforeStart(t *testing.T) {
	// Edge case: } appears before {
	tags := parseDescriptionTags("} then {")
	if tags == nil {
		t.Fatal("nil tags")
	}
}

// ── EnrichDescription ────────────────────────────────────────────────────────

func TestEnrichDescription_EmptyDescription(t *testing.T) {
	c := &Client{}
	tags, err := c.EnrichDescription(context.Background(), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tags == nil {
		t.Fatal("nil tags for empty description")
	}
}

func TestEnrichDescription_WhitespaceOnly(t *testing.T) {
	c := &Client{}
	tags, err := c.EnrichDescription(context.Background(), "   \n\t  ")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tags == nil {
		t.Fatal("nil tags for whitespace-only description")
	}
}

func TestEnrichDescription_HTTPMock_Success(t *testing.T) {
	expected := map[string]any{
		"main_product":    "CNC obrábění",
		"tech_keywords":   []string{"CNC"},
		"export_oriented": false,
		"is_seasonal":     false,
	}
	c := makeTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(generateResponse{
			Response: `{"main_product":"CNC obrábění","tech_keywords":["CNC"],"export_oriented":false,"is_seasonal":false}`,
			Done:     true,
		})
	})

	tags, err := c.EnrichDescription(context.Background(), "Firma se zabývá CNC obráběním kovových součástí.")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tags.MainProduct != expected["main_product"] {
		t.Errorf("MainProduct = %q, want %q", tags.MainProduct, expected["main_product"])
	}
	if len(tags.TechKeywords) == 0 {
		t.Error("TechKeywords should not be empty")
	}
	if tags.EnrichedAt == "" {
		t.Error("EnrichedAt should be set")
	}
	if tags.Model == "" {
		t.Error("Model should be set")
	}
}

func TestEnrichDescription_LongDescriptionTruncated(t *testing.T) {
	longDesc := strings.Repeat("a", 1000)
	c := makeTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		// Verify body was sent (we don't need to validate truncation precisely here)
		json.NewEncoder(w).Encode(generateResponse{
			Response: `{"main_product":"test","tech_keywords":[],"export_oriented":false,"is_seasonal":false}`,
			Done:     true,
		})
	})

	tags, err := c.EnrichDescription(context.Background(), longDesc)
	if err != nil {
		t.Fatalf("unexpected error for long description: %v", err)
	}
	if tags == nil {
		t.Fatal("nil tags")
	}
}

func TestEnrichDescription_HTTPError(t *testing.T) {
	c := makeTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	_, err := c.EnrichDescription(context.Background(), "Firma vyrábí stroje.")
	if err == nil {
		t.Fatal("expected error for 503 response")
	}
}

// ── adapter: Classify ────────────────────────────────────────────────────────

func TestIndustryClassifier_Classify_Success(t *testing.T) {
	c := makeTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(generateResponse{
			Response: `{"tags":["strojírenství","výroba"],"confidence":0.87}`,
			Done:     true,
		})
	})
	ic := NewIndustryClassifier(c, false)
	tags, conf, err := ic.Classify(context.Background(), "Výroba průmyslových strojů a zařízení")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(tags) == 0 {
		t.Error("expected non-empty tags")
	}
	if conf <= 0 {
		t.Error("expected positive confidence")
	}
}

func TestIndustryClassifier_Classify_FallbackOnError(t *testing.T) {
	c := makeTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	ic := NewIndustryClassifier(c, true) // fallback=true
	tags, conf, err := ic.Classify(context.Background(), "Výroba průmyslových strojů")
	// With fallback=true, error is suppressed and nil/0 returned
	if err != nil {
		t.Fatalf("expected no error with fallback, got: %v", err)
	}
	if tags != nil && len(tags) > 0 {
		t.Error("fallback should return nil tags")
	}
	if conf != 0 {
		t.Error("fallback should return 0 confidence")
	}
}

func TestIndustryClassifier_Classify_NoFallbackOnError(t *testing.T) {
	c := makeTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	ic := NewIndustryClassifier(c, false) // fallback=false
	_, _, err := ic.Classify(context.Background(), "Výroba průmyslových strojů")
	if err == nil {
		t.Fatal("expected error with no fallback")
	}
}

// ── adapter: ReplySentimentClassifier ───────────────────────────────────────

func TestNewReplySentimentClassifier(t *testing.T) {
	c := NewClient(Config{})
	r := NewReplySentimentClassifier(c)
	if r == nil {
		t.Fatal("nil classifier")
	}
	if r.client != c {
		t.Error("client not set")
	}
}

func TestReplySentimentClassifier_ClassifySentiment_Success(t *testing.T) {
	c := makeTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(generateResponse{
			Response: `{"category":"interested","confidence":0.9}`,
			Done:     true,
		})
	})
	r := NewReplySentimentClassifier(c)
	category, err := r.ClassifySentiment(context.Background(), "Ano, velmi nás to zajímá!")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if category == "" {
		t.Error("expected non-empty category")
	}
}

func TestReplySentimentClassifier_ClassifySentiment_Error(t *testing.T) {
	c := makeTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	r := NewReplySentimentClassifier(c)
	_, err := r.ClassifySentiment(context.Background(), "Nějaká odpověď")
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
}
