package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewDescriptionSummarizer(t *testing.T) {
	c := NewClient(Config{})
	s := NewDescriptionSummarizer(c)
	if s == nil {
		t.Fatal("nil summarizer")
	}
	if s.client != c {
		t.Error("client not set")
	}
}

func TestDescriptionSummarizer_SummarizeViaHTTPMock(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"response":       "Firma se zabývá výrobou strojů.",
			"done":           true,
			"total_duration": 100000,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL})
	s := NewDescriptionSummarizer(c)

	summary, err := s.Summarize(context.Background(), "Dlouhý popis firmy která vyrábí mnoho různých strojů pro průmysl")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if summary != "Firma se zabývá výrobou strojů." {
		t.Errorf("summary = %q, want mock response", summary)
	}
}

func TestDescriptionSummarizer_SummarizeError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL})
	s := NewDescriptionSummarizer(c)

	_, err := s.Summarize(context.Background(), "Firma se zabývá výrobou a prodejem nejrůznějších strojů pro průmyslové využití")
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
}

func TestNewIndustryClassifier(t *testing.T) {
	c := NewClient(Config{})
	ic := NewIndustryClassifier(c, true)
	if ic == nil {
		t.Fatal("nil classifier")
	}
	if !ic.fallback {
		t.Error("fallback should be true")
	}
}
