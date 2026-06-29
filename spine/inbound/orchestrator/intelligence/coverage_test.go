package intelligence

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
	"common/health"
	"orchestrator/llm"
)

// ── PrintHealthReport ─────────────────────────────────────────────────────────

func TestPrintHealthReport_WritesJSON(t *testing.T) {
	report := &HealthReport{
		GeneratedAt:       time.Now().UTC().Format(time.RFC3339),
		TotalCompanies:    1000,
		EligibleCompanies: 900,
		ClassifiedPct:     75.0,
		EmailValidPct:     60.0,
		AvgCompleteness:   0.70,
		ICPTierCounts: map[string]int{
			"ideal": 100,
			"good":  300,
		},
		EngagementClusters: map[string]int{
			"champion":        50,
			"never_contacted": 500,
		},
		SectorDistribution: map[string]int{
			"machinery": 200,
		},
	}

	// PrintHealthReport writes to os.Stdout; we capture via the function itself
	// by calling it and verifying no error is returned.
	err := PrintHealthReport(report)
	if err != nil {
		t.Fatalf("PrintHealthReport returned error: %v", err)
	}
}

func TestPrintHealthReport_EmptyReport(t *testing.T) {
	report := &HealthReport{
		GeneratedAt:        time.Now().UTC().Format(time.RFC3339),
		ICPTierCounts:      map[string]int{},
		EngagementClusters: map[string]int{},
		SectorDistribution: map[string]int{},
	}
	if err := PrintHealthReport(report); err != nil {
		t.Fatalf("PrintHealthReport returned error: %v", err)
	}
}

// ── HealthReport struct ───────────────────────────────────────────────────────

func TestHealthReport_Struct(t *testing.T) {
	r := HealthReport{
		GeneratedAt:       "2026-04-14T12:00:00Z",
		TotalCompanies:    5000,
		EligibleCompanies: 4800,
		ClassifiedPct:     82.5,
		EmailValidPct:     71.3,
		AvgCompleteness:   0.68,
		ICPTierCounts:     map[string]int{"ideal": 200},
		EngagementClusters: map[string]int{"champion": 30},
		SectorDistribution: map[string]int{"metalwork": 500},
		SegmentHealth:      []SegmentSummary{{ID: 1, Name: "Premium"}},
	}
	if r.TotalCompanies != 5000 {
		t.Errorf("TotalCompanies = %d, want 5000", r.TotalCompanies)
	}
	if len(r.SegmentHealth) != 1 {
		t.Errorf("SegmentHealth len = %d, want 1", len(r.SegmentHealth))
	}
}

func TestSegmentSummary_Struct(t *testing.T) {
	s := "2026-04-14T12:00:00Z"
	seg := SegmentSummary{
		ID:            42,
		Name:          "Core Prospects",
		CompanyCount:  150,
		LastBuiltAt:   &s,
		AvgICPScore:   0.78,
		EmailValidPct: 0.85,
		ClassifiedPct: 0.92,
		Champions:     10,
		WarmGhosts:    25,
		Untouched:     115,
	}
	if seg.ID != 42 {
		t.Errorf("ID = %d, want 42", seg.ID)
	}
	if *seg.LastBuiltAt != s {
		t.Errorf("LastBuiltAt = %q, want %q", *seg.LastBuiltAt, s)
	}
}

// ── BuildHealthReport — segment with non-nil last_built_at ───────────────────

func TestBuildHealthReport_SegmentWithLastBuiltAt(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT\s+COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{
			"total", "eligible", "classified_pct", "email_valid_pct", "avg_completeness",
		}).AddRow(100, 90, 80.0, 70.0, 0.65))
	mock.ExpectQuery(`SELECT COALESCE\(icp_tier`).
		WillReturnRows(sqlmock.NewRows([]string{"tier", "count"}))
	mock.ExpectQuery(`SELECT COALESCE\(engagement_cluster`).
		WillReturnRows(sqlmock.NewRows([]string{"cluster", "count"}))
	mock.ExpectQuery(`SELECT sector_primary`).
		WillReturnRows(sqlmock.NewRows([]string{"sector", "count"}))

	// Segment with a non-null last_built_at and non-null email/classified pct
	builtAt := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "name", "company_count", "last_built_at",
			"avg_icp_score", "email_valid_pct", "classified_pct",
			"champions", "warm_ghosts", "untouched",
		}).AddRow(1, "VIP", 20, builtAt, 0.90, 0.80, 0.95, 3, 5, 12))

	report, err := BuildHealthReport(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(report.SegmentHealth) != 1 {
		t.Fatalf("SegmentHealth = %d, want 1", len(report.SegmentHealth))
	}
	seg := report.SegmentHealth[0]
	if seg.LastBuiltAt == nil {
		t.Error("LastBuiltAt should be set (non-null value)")
	}
	if seg.EmailValidPct != 0.80 {
		t.Errorf("EmailValidPct = %f, want 0.80", seg.EmailValidPct)
	}
	if seg.ClassifiedPct != 0.95 {
		t.Errorf("ClassifiedPct = %f, want 0.95", seg.ClassifiedPct)
	}
}

// ── RunLLMEnrich ─────────────────────────────────────────────────────────────

// makeLLMTestServer creates an httptest server that returns fixed Ollama responses.
func makeLLMTestServer(t *testing.T, handler http.HandlerFunc) *llm.Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return llm.NewClient(llm.Config{
		BaseURL: srv.URL,
		Model:   "test-model",
		Timeout: 5 * time.Second,
	})
}

// ollamaResponse builds a minimal Ollama /api/generate JSON response.
func ollamaResponse(text string) []byte {
	type resp struct {
		Response string `json:"response"`
		Done     bool   `json:"done"`
	}
	b, _ := json.Marshal(resp{Response: text, Done: true})
	return b
}

func TestRunLLMEnrich_EmptyBatch(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// No rows returned → empty batch, nothing to enrich.
	mock.ExpectQuery(`SELECT id, description`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "description", "sector_confidence"}))

	client := makeLLMTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("LLM should not be called for empty batch")
	})

	result, err := RunLLMEnrich(context.Background(), db, LLMEnrichConfig{
		Client:    client,
		BatchSize: 10,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Processed != 0 {
		t.Errorf("Processed = %d, want 0", result.Processed)
	}
	if result.Enriched != 0 {
		t.Errorf("Enriched = %d, want 0", result.Enriched)
	}
}

func TestRunLLMEnrich_DBQueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, description`).
		WillReturnError(errIntel("db error"))

	client := makeLLMTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("LLM should not be called on DB error")
	})

	result, err := RunLLMEnrich(context.Background(), db, LLMEnrichConfig{
		Client:    client,
		BatchSize: 10,
	})
	if err == nil {
		t.Error("expected error from DB query failure")
	}
	if result == nil {
		t.Error("result should not be nil even on error")
	}
}

func TestRunLLMEnrich_DryRun(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, description`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "description", "sector_confidence"}).
			AddRow(1, "Firma vyrábí CNC součásti.", 0.5))

	// LLM returns valid description tags JSON.
	tagsResponse := `{"main_product":"CNC","tech_keywords":["frézování"],"export_oriented":false,"is_seasonal":false}`
	client := makeLLMTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write(ollamaResponse(tagsResponse))
	})

	result, err := RunLLMEnrich(context.Background(), db, LLMEnrichConfig{
		Client:    client,
		BatchSize: 10,
		DryRun:    true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Processed != 1 {
		t.Errorf("Processed = %d, want 1", result.Processed)
	}
	if result.Enriched != 1 {
		t.Errorf("Enriched = %d, want 1 (dry run counts as enriched)", result.Enriched)
	}
	if result.Errors != 0 {
		t.Errorf("Errors = %d, want 0", result.Errors)
	}
	if result.Duration == 0 {
		t.Error("Duration should be set")
	}
}

func TestRunLLMEnrich_DefaultBatchSize(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// BatchSize=0 → should default to 100.
	mock.ExpectQuery(`SELECT id, description`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "description", "sector_confidence"}))

	client := makeLLMTestServer(t, func(w http.ResponseWriter, r *http.Request) {})

	result, err := RunLLMEnrich(context.Background(), db, LLMEnrichConfig{
		Client:    client,
		BatchSize: 0, // triggers default
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Processed != 0 {
		t.Errorf("Processed = %d, want 0", result.Processed)
	}
}

func TestRunLLMEnrich_LLMError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, description`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "description", "sector_confidence"}).
			AddRow(2, "Firma dodává materiál.", 0.3))

	// LLM server returns HTTP 500 → EnrichDescription fails.
	client := makeLLMTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	result, err := RunLLMEnrich(context.Background(), db, LLMEnrichConfig{
		Client:    client,
		BatchSize: 10,
	})
	if err != nil {
		t.Fatalf("unexpected error from RunLLMEnrich itself: %v", err)
	}
	if result.Processed != 1 {
		t.Errorf("Processed = %d, want 1", result.Processed)
	}
	if result.Errors != 1 {
		t.Errorf("Errors = %d, want 1 (LLM call failed)", result.Errors)
	}
}

func TestRunLLMEnrich_FullPath_LowConfidence(t *testing.T) {
	// LLM succeeds for EnrichDescription; ClassifyIndustry returns low confidence.
	// Result: description_tags updated, no sector upgrade.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, description`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "description", "sector_confidence"}).
			AddRow(3, "Opravna obuvi Brno.", 0.2))

	// Enrich returns description tags; classify returns low confidence industry.
	callCount := 0
	tagsJSON := `{"main_product":"obuv","tech_keywords":[],"export_oriented":false,"is_seasonal":false}`
	classifyJSON := `{"tags":["retail"],"confidence":0.55}` // < 0.75 → no sector upgrade

	client := makeLLMTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if callCount == 1 {
			// EnrichDescription call
			w.Write(ollamaResponse(tagsJSON))
		} else {
			// ClassifyIndustry call
			w.Write(ollamaResponse(classifyJSON))
		}
	})

	// Expect UPDATE companies SET description_tags (no sector upgrade)
	mock.ExpectExec(`UPDATE companies SET description_tags`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	result, err := RunLLMEnrich(context.Background(), db, LLMEnrichConfig{
		Client:    client,
		BatchSize: 10,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Processed != 1 {
		t.Errorf("Processed = %d, want 1", result.Processed)
	}
	if result.Enriched != 1 {
		t.Errorf("Enriched = %d, want 1", result.Enriched)
	}
	if result.ConfidenceBoosted != 0 {
		t.Errorf("ConfidenceBoosted = %d, want 0 (low confidence)", result.ConfidenceBoosted)
	}
}

func TestRunLLMEnrich_FullPath_HighConfidence(t *testing.T) {
	// LLM succeeds and returns high-confidence classification → sector upgraded.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, description`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "description", "sector_confidence"}).
			AddRow(4, "CNC obrábění kovů, export do Německa.", 0.4))

	callCount := 0
	tagsJSON := `{"main_product":"CNC","tech_keywords":["frézování"],"export_oriented":true,"is_seasonal":false}`
	classifyJSON := `{"tags":["machinery","metalwork"],"confidence":0.88}` // >= 0.75 + > sectorConf 0.4

	client := makeLLMTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if callCount == 1 {
			w.Write(ollamaResponse(tagsJSON))
		} else {
			w.Write(ollamaResponse(classifyJSON))
		}
	})

	// Expect UPDATE companies SET description_tags, sector_tags, ... (full upgrade)
	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	result, err := RunLLMEnrich(context.Background(), db, LLMEnrichConfig{
		Client:    client,
		BatchSize: 10,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Processed != 1 {
		t.Errorf("Processed = %d, want 1", result.Processed)
	}
	if result.Enriched != 1 {
		t.Errorf("Enriched = %d, want 1", result.Enriched)
	}
	if result.ConfidenceBoosted != 1 {
		t.Errorf("ConfidenceBoosted = %d, want 1", result.ConfidenceBoosted)
	}
}

func TestRunLLMEnrich_PersistError(t *testing.T) {
	// LLM succeeds but DB UPDATE fails for description_tags.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, description`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "description", "sector_confidence"}).
			AddRow(5, "Výroba nábytku.", 0.1))

	callCount := 0
	tagsJSON := `{"main_product":"nábytek","tech_keywords":[],"export_oriented":false,"is_seasonal":false}`
	classifyJSON := `{"tags":["furniture"],"confidence":0.50}` // low confidence → simple update path

	client := makeLLMTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if callCount == 1 {
			w.Write(ollamaResponse(tagsJSON))
		} else {
			w.Write(ollamaResponse(classifyJSON))
		}
	})

	// DB UPDATE fails
	mock.ExpectExec(`UPDATE companies SET description_tags`).
		WillReturnError(errIntel("disk full"))

	result, err := RunLLMEnrich(context.Background(), db, LLMEnrichConfig{
		Client:    client,
		BatchSize: 10,
	})
	if err != nil {
		t.Fatalf("unexpected error from RunLLMEnrich: %v", err)
	}
	if result.Errors != 1 {
		t.Errorf("Errors = %d, want 1 (persist failed)", result.Errors)
	}
	if result.Enriched != 0 {
		t.Errorf("Enriched = %d, want 0 (persist failed)", result.Enriched)
	}
}

// ── verifyEmailsBatch additional coverage ────────────────────────────────────

// expectRunOnceWithHealth adds health registry expectations on top of minimal.
func expectRunOnceMinimalFull(mock sqlmock.Sqlmock) {
	// thread.ResumeExpiredPauses
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// thread.ExpireStaleThreads
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// enrich.AutoSuppressFromEvents — 3 queries
	mock.ExpectQuery(`SELECT DISTINCT c\.email, e\.id`).
		WillReturnRows(sqlmock.NewRows([]string{"email", "id"}))
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))

	// CheckDomainHealth
	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}))

	// enrich.RecalculateFast
	mock.ExpectExec(`UPDATE outreach_contacts oc`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`UPDATE contacts c`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// UpdateEngagementClusters
	mock.ExpectExec(`UPDATE companies c`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// DetectZeroEngagement
	mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// verifyEmailsBatch: LoadDomainCache + companies SELECT
	mock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "mx_exists", "mx_host", "is_catch_all",
			"is_disposable", "is_spamtrap", "smtp_connectable", "checked_at",
		}))
	mock.ExpectQuery(`SELECT id, email FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email"}))

	// ares.RunSync
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	// classify.RunReclassifyNACE
	mock.ExpectQuery(`SELECT id, COALESCE\(name`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "name", "ico", "email",
			"pravni_forma", "category_path", "categories_json",
			"description", "velikost_firmy",
			"postal_code", "address_locality",
			"website", "telephone",
			"rating_value", "rating_count",
			"nace_codes",
			"v_insolvenci", "v_likvidaci",
		}))

	// enrich.PromoteCompanies
	mock.ExpectQuery(`SELECT id, firmy_cz_id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "firmy_cz_id", "ico", "name", "email",
			"telephone", "website", "address_locality", "street_address", "postal_code",
			"velikost_firmy", "pravni_forma", "description",
			"sector_tags", "sector_confidence",
			"region_normalized", "icp_score",
		}))
}

func TestRunOnce_WithHealthRegistry(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	expectRunOnceMinimalFull(mock)

	// category.RefreshCounts
	mock.ExpectQuery(`SELECT`).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	// segment.RefreshAll
	mock.ExpectQuery(`SELECT`).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	// audit log DELETE
	mock.ExpectExec(`DELETE FROM operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	reg := health.New()
	result, err := RunOnce(context.Background(), db, Config{
		TargetIndustries: []string{"machinery"},
		Health:           reg,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("result should not be nil")
	}

	// Health registry should have intel_loop marked OK.
	snapshot := reg.Snapshot()
	var found bool
	for _, s := range snapshot {
		if s.Name == "intel_loop" {
			found = true
			if !s.OK {
				t.Error("intel_loop should be OK after successful RunOnce")
			}
		}
	}
	if !found {
		t.Error("intel_loop not found in health registry after RunOnce")
	}
}

func TestRunOnce_WithSuppressedContacts(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// thread.ResumeExpiredPauses
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// thread.ExpireStaleThreads
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// AutoSuppressFromEvents returns suppressed contacts via rows
	mock.ExpectQuery(`SELECT DISTINCT c\.email, e\.id`).
		WillReturnRows(sqlmock.NewRows([]string{"email", "id"}).
			AddRow("bounce@example.cz", 1))
	// After finding bounce event, queries for suppress contact + domain
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))

	// CheckDomainHealth
	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}))

	// RecalculateFast
	mock.ExpectExec(`UPDATE outreach_contacts oc`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`UPDATE contacts c`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// UpdateEngagementClusters
	mock.ExpectExec(`UPDATE companies c`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// DetectZeroEngagement
	mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// verifyEmailsBatch
	mock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "mx_exists", "mx_host", "is_catch_all",
			"is_disposable", "is_spamtrap", "smtp_connectable", "checked_at",
		}))
	mock.ExpectQuery(`SELECT id, email FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email"}))

	// ares.RunSync
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	// classify.RunReclassifyNACE
	mock.ExpectQuery(`SELECT id, COALESCE\(name`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "name", "ico", "email",
			"pravni_forma", "category_path", "categories_json",
			"description", "velikost_firmy",
			"postal_code", "address_locality",
			"website", "telephone",
			"rating_value", "rating_count",
			"nace_codes",
			"v_insolvenci", "v_likvidaci",
		}))

	// PromoteCompanies
	mock.ExpectQuery(`SELECT id, firmy_cz_id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "firmy_cz_id", "ico", "name", "email",
			"telephone", "website", "address_locality", "street_address", "postal_code",
			"velikost_firmy", "pravni_forma", "description",
			"sector_tags", "sector_confidence",
			"region_normalized", "icp_score",
		}))

	// category.RefreshCounts
	mock.ExpectQuery(`SELECT`).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	// segment.RefreshAll
	mock.ExpectQuery(`SELECT`).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	// audit log DELETE
	mock.ExpectExec(`DELETE FROM operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	result, err := RunOnce(context.Background(), db, Config{
		TargetIndustries: []string{},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("result should not be nil")
	}
}

// ── LLMEnrichResult struct ────────────────────────────────────────────────────

func TestLLMEnrichResult_Struct(t *testing.T) {
	r := LLMEnrichResult{
		Processed:         100,
		Enriched:          80,
		ConfidenceBoosted: 20,
		Errors:            5,
		Duration:          3 * time.Second,
	}
	if r.Processed != 100 {
		t.Errorf("Processed = %d, want 100", r.Processed)
	}
	if r.ConfidenceBoosted != 20 {
		t.Errorf("ConfidenceBoosted = %d, want 20", r.ConfidenceBoosted)
	}
}

func TestLLMEnrichConfig_Struct(t *testing.T) {
	cfg := LLMEnrichConfig{
		BatchSize: 50,
		DryRun:    true,
	}
	if cfg.BatchSize != 50 {
		t.Errorf("BatchSize = %d, want 50", cfg.BatchSize)
	}
	if !cfg.DryRun {
		t.Error("DryRun should be true")
	}
}

// ── FormatReport edge cases ───────────────────────────────────────────────────

func TestFormatReport_ContainsBox(t *testing.T) {
	r := &WeeklyReport{
		Period:       "2026-04-07 — 2026-04-14",
		ContactStats: map[string]int{},
		ScoreDistrib: map[string]int{},
	}
	out := FormatReport(r)
	if !strings.Contains(out, "╔") || !strings.Contains(out, "╚") {
		t.Error("expected box-drawing characters in output")
	}
}

// ── verifyEmailsBatch direct sqlmock tests ────────────────────────────────────

func TestVerifyEmailsBatch_LoadCacheError(t *testing.T) {
	// LoadDomainCache fails but verifyEmailsBatch should continue gracefully.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// LoadDomainCache error
	mock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnError(errIntel("cache error"))

	// Companies query returns empty
	mock.ExpectQuery(`SELECT id, email FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email"}))

	verified, invalid := verifyEmailsBatch(context.Background(), db, 100)
	if verified != 0 {
		t.Errorf("verified = %d, want 0", verified)
	}
	if invalid != 0 {
		t.Errorf("invalid = %d, want 0", invalid)
	}
}

func TestVerifyEmailsBatch_CompaniesQueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// LoadDomainCache succeeds
	mock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "mx_exists", "mx_host", "is_catch_all",
			"is_disposable", "is_spamtrap", "smtp_connectable", "checked_at",
		}))

	// Companies query errors
	mock.ExpectQuery(`SELECT id, email FROM companies`).
		WillReturnError(errIntel("query error"))

	verified, invalid := verifyEmailsBatch(context.Background(), db, 100)
	if verified != 0 {
		t.Errorf("verified = %d, want 0 on query error", verified)
	}
	if invalid != 0 {
		t.Errorf("invalid = %d, want 0", invalid)
	}
}

func TestRunLLMEnrich_HighConfidencePersistError(t *testing.T) {
	// High confidence LLM result but DB update for the upgrade fails.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, description`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "description", "sector_confidence"}).
			AddRow(6, "Výroba strojů, export EU.", 0.3))

	callCount := 0
	tagsJSON := `{"main_product":"stroje","tech_keywords":["automation"],"export_oriented":true,"is_seasonal":false}`
	classifyJSON := `{"tags":["machinery"],"confidence":0.90}`

	client := makeLLMTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if callCount == 1 {
			w.Write(ollamaResponse(tagsJSON))
		} else {
			w.Write(ollamaResponse(classifyJSON))
		}
	})

	// DB UPDATE fails for the high-confidence sector upgrade path.
	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnError(errIntel("db write error"))

	result, err := RunLLMEnrich(context.Background(), db, LLMEnrichConfig{
		Client:    client,
		BatchSize: 10,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// ConfidenceBoosted should be 0 (persist failed), Enriched should still be 1.
	if result.ConfidenceBoosted != 0 {
		t.Errorf("ConfidenceBoosted = %d, want 0 (persist failed)", result.ConfidenceBoosted)
	}
	if result.Enriched != 1 {
		t.Errorf("Enriched = %d, want 1 (still counted as enriched)", result.Enriched)
	}
}

// ── verifyEmailsBatch with actual email processing ────────────────────────────

func TestVerifyEmailsBatch_WithInvalidEmail(t *testing.T) {
	// An email with invalid syntax will return StatusInvalid without any DNS calls.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// LoadDomainCache — empty
	mock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "mx_exists", "mx_host", "is_catch_all",
			"is_disposable", "is_spamtrap", "smtp_connectable", "checked_at",
		}))

	// Companies query returns one row with an invalid email (no @ → syntax invalid)
	mock.ExpectQuery(`SELECT id, email FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email"}).
			AddRow(int64(10), "notanemail"))

	// SaveCompanyResult will UPDATE companies
	mock.ExpectExec(`UPDATE companies`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	verified, invalid := verifyEmailsBatch(context.Background(), db, 100)
	if verified != 1 {
		t.Errorf("verified = %d, want 1", verified)
	}
	if invalid != 1 {
		t.Errorf("invalid = %d, want 1 (invalid syntax)", invalid)
	}
}

func TestVerifyEmailsBatch_SaveError(t *testing.T) {
	// Email processing succeeds but SaveCompanyResult returns an error (logged, not fatal).
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "mx_exists", "mx_host", "is_catch_all",
			"is_disposable", "is_spamtrap", "smtp_connectable", "checked_at",
		}))

	mock.ExpectQuery(`SELECT id, email FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email"}).
			AddRow(int64(11), "bad-email-no-at"))

	// SaveCompanyResult fails
	mock.ExpectExec(`UPDATE companies`).
		WillReturnError(errIntel("disk full"))

	// Even with save error, verified should be incremented and function should not panic.
	verified, _ := verifyEmailsBatch(context.Background(), db, 100)
	if verified != 1 {
		t.Errorf("verified = %d, want 1 (save error is non-fatal)", verified)
	}
}

func TestVerifyEmailsBatch_MultipleEmails(t *testing.T) {
	// Two companies: one invalid email, one also invalid but different reason.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "mx_exists", "mx_host", "is_catch_all",
			"is_disposable", "is_spamtrap", "smtp_connectable", "checked_at",
		}))

	mock.ExpectQuery(`SELECT id, email FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email"}).
			AddRow(int64(20), "bad1").
			AddRow(int64(21), "bad2"))

	mock.ExpectExec(`UPDATE companies`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE companies`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	verified, invalid := verifyEmailsBatch(context.Background(), db, 100)
	if verified != 2 {
		t.Errorf("verified = %d, want 2", verified)
	}
	if invalid != 2 {
		t.Errorf("invalid = %d, want 2", invalid)
	}
}

// ── RunDaemon additional: success path resets consecutive failures ────────────

func TestRunDaemon_ContextCancelImmediately(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before start

	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// With nil db and cancelled context, RunDaemon will run once (panics),
	// then stop on the cancelled context. Just verify it doesn't block.
	done := make(chan error, 1)
	go func() {
		done <- RunDaemon(ctx, nil, Config{}, 100*time.Millisecond)
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Error("expected context.Canceled error")
		}
	case <-time.After(2 * time.Second):
		t.Error("RunDaemon did not stop after context cancellation")
	}
}

// ── LoopResult fields added later ─────────────────────────────────────────────

func TestLoopResult_NewFields(t *testing.T) {
	r := LoopResult{
		NACESubReclassified: 5,
		EngagementClusters:  10,
		SegmentsRefreshed:   3,
		LLMEnrichProcessed:  50,
		LLMEnrichBoosted:    12,
	}
	if r.NACESubReclassified != 5 {
		t.Errorf("NACESubReclassified = %d, want 5", r.NACESubReclassified)
	}
	if r.LLMEnrichProcessed != 50 {
		t.Errorf("LLMEnrichProcessed = %d, want 50", r.LLMEnrichProcessed)
	}
	if r.LLMEnrichBoosted != 12 {
		t.Errorf("LLMEnrichBoosted = %d, want 12", r.LLMEnrichBoosted)
	}
}

// ── PrintHealthReport: verify JSON contains expected keys ────────────────────

func TestPrintHealthReport_ValidJSON(t *testing.T) {
	// Capture stdout via a bytes buffer is not straightforward since
	// PrintHealthReport writes to os.Stdout. We test the function indirectly
	// by ensuring the HealthReport struct is JSON-serializable and that the
	// JSON encoder's Encode method works correctly.
	report := &HealthReport{
		GeneratedAt:        "2026-04-14T10:00:00Z",
		TotalCompanies:     500,
		EligibleCompanies:  450,
		ClassifiedPct:      88.0,
		EmailValidPct:      73.5,
		AvgCompleteness:    0.72,
		ICPTierCounts:      map[string]int{"ideal": 50},
		EngagementClusters: map[string]int{"champion": 10},
		SectorDistribution: map[string]int{"tech": 100},
		SegmentHealth: []SegmentSummary{
			{ID: 1, Name: "Main", CompanyCount: 200, Champions: 5},
		},
	}

	// Verify JSON serialization is correct (PrintHealthReport uses json.Encoder).
	b, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	if !bytes.Contains(b, []byte("generated_at")) {
		t.Error("JSON should contain generated_at")
	}
	if !bytes.Contains(b, []byte("total_companies")) {
		t.Error("JSON should contain total_companies")
	}
}
