package intelligence

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"common/alert"
	"contacts/company"
	"common/health"
	"orchestrator/llm"
)

// ── helpers ──────────────────────────────────────────────────────────────────

func expectCategoryRefreshCoverage(mock sqlmock.Sqlmock, refreshed int64) {
	mock.ExpectExec(`INSERT INTO categories`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`WITH RECURSIVE ancestors AS`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`WITH RECURSIVE expanded AS`).
		WillReturnResult(sqlmock.NewResult(0, refreshed))
}

// expectRunOnceCore sets up all DB expectations for RunOnce through step 9
// (classify.RunReclassifyNACE). Steps 10-12 are added by callers if needed.
// Uses AnyTimes() pattern where later steps may fail gracefully.
func expectRunOnceCore(mock sqlmock.Sqlmock) {
	// 1. thread.ResumeExpiredPauses
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// 1b. thread.ExpireStaleThreads
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 2. enrich.AutoSuppressFromEvents — 3 queries
	mock.ExpectQuery(`SELECT DISTINCT c\.email, e\.id`).
		WillReturnRows(sqlmock.NewRows([]string{"email", "id"}))
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))

	// 3. CheckDomainHealth
	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}))

	// 4. enrich.RecalculateFast — 2 ExecContext calls
	mock.ExpectExec(`UPDATE outreach_contacts oc`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`UPDATE contacts c`).
		WillReturnResult(sqlmock.NewResult(0, 0))
}

// expectRunOnceAfterRecalc sets up steps 4b through 12 (post-recalc to end).
func expectRunOnceAfterRecalc(mock sqlmock.Sqlmock) {
	// 4b. UpdateEngagementClusters
	mock.ExpectExec(`UPDATE companies c`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 6. DetectZeroEngagement
	mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 7. verifyEmailsBatch
	mock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "mx_exists", "mx_host", "is_catch_all",
			"is_disposable", "is_spamtrap", "smtp_connectable", "checked_at",
		}))
	mock.ExpectQuery(`SELECT id, email FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email"}))

	// 8. ares.RunSync
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	// 9. classify.RunReclassifyNACE
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
}

// expectRunOnceTail sets up steps 10-12 (promote, category, segment, audit).
func expectRunOnceTail(mock sqlmock.Sqlmock) {
	// 10. enrich.PromoteCompanies
	mock.ExpectQuery(`SELECT id, firmy_cz_id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "firmy_cz_id", "ico", "name", "email",
			"telephone", "website", "address_locality", "street_address", "postal_code",
			"velikost_firmy", "pravni_forma", "description",
			"sector_tags", "sector_confidence",
			"region_normalized", "icp_score",
		}))

	// 11. category.RefreshCounts — 3-step refresh pipeline
	expectCategoryRefreshCoverage(mock, 0)

	// 11b. segment.RefreshAll — List does QueryContext (SELECT ... FROM segments)
	mock.ExpectQuery(`SELECT .+ FROM segments`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "name", "description", "query",
			"company_count", "last_built_at", "created_at", "updated_at",
		}))

	// 12. audit log DELETE
	mock.ExpectExec(`DELETE FROM operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(0, 0))
}

// newAlertTestServer creates an alert.Client backed by a test HTTP server.
func newAlertTestServer(t *testing.T) *alert.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALERT_WEBHOOK_URL", srv.URL)
	t.Setenv("ALERT_WEBHOOK_SECRET", "")
	return alert.New()
}

// ── Alert client: suppressed > 0 triggers AutoSuppressed ─────────────────────

func TestRunOnce_AlertOnSuppressed(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	alertClient := newAlertTestServer(t)

	// 1. thread.ResumeExpiredPauses
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// 1b. thread.ExpireStaleThreads
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 2. AutoSuppressFromEvents — returns 1 bounce event
	mock.ExpectQuery(`SELECT DISTINCT c\.email, e\.id`).
		WillReturnRows(sqlmock.NewRows([]string{"email", "id"}).
			AddRow("bounce@test.cz", 101))
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))

	// 3. CheckDomainHealth — 1 flagged domain (bounce_rate > 0.15)
	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}).AddRow(1, "bad.cz", 10, 2, 0, 0.20, 5, false))
	mock.ExpectExec(`UPDATE outreach_domains SET is_suppressed`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// 4. RecalculateFast — non-zero results
	mock.ExpectExec(`UPDATE outreach_contacts oc`).
		WillReturnResult(sqlmock.NewResult(0, 5))
	mock.ExpectExec(`UPDATE contacts c`).
		WillReturnResult(sqlmock.NewResult(0, 3))

	// 4b. UpdateEngagementClusters
	mock.ExpectExec(`UPDATE companies c`).
		WillReturnResult(sqlmock.NewResult(0, 10))

	// 6. DetectZeroEngagement
	mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WillReturnResult(sqlmock.NewResult(0, 2))

	// 7-9. Standard empty
	mock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "mx_exists", "mx_host", "is_catch_all",
			"is_disposable", "is_spamtrap", "smtp_connectable", "checked_at",
		}))
	mock.ExpectQuery(`SELECT id, email FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email"}))
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))
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

	// 10-12. Tail
	expectRunOnceTail(mock)

	result, err := RunOnce(context.Background(), db, Config{
		TargetIndustries: []string{"machinery"},
		Alert:            alertClient,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.DomainsFlagged != 1 {
		t.Errorf("DomainsFlagged = %d, want 1", result.DomainsFlagged)
	}
	if result.DomainsChecked != 1 {
		t.Errorf("DomainsChecked = %d, want 1", result.DomainsChecked)
	}
	if result.EngagementClusters != 10 {
		t.Errorf("EngagementClusters = %d, want 10", result.EngagementClusters)
	}
}

// ── CompanyStore.UpdateMetrics path ──────────────────────────────────────────

func TestRunOnce_WithCompanyStore(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	expectRunOnceCore(mock)

	// 4a. CompanyStore.UpdateMetrics — two ExecContext calls
	mock.ExpectExec(`UPDATE companies co SET`).
		WillReturnResult(sqlmock.NewResult(0, 25))
	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	expectRunOnceAfterRecalc(mock)
	expectRunOnceTail(mock)

	companyStore := company.NewStore(db)

	result, err := RunOnce(context.Background(), db, Config{
		TargetIndustries: []string{"machinery"},
		CompanyStore:     companyStore,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.CompanyMetrics != 25 {
		t.Errorf("CompanyMetrics = %d, want 25", result.CompanyMetrics)
	}
}

// ── CompanyStore.UpdateMetrics error ─────────────────────────────────────────

func TestRunOnce_CompanyStoreMetricsError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	expectRunOnceCore(mock)

	// 4a. CompanyStore.UpdateMetrics — first Exec errors
	mock.ExpectExec(`UPDATE companies co SET`).
		WillReturnError(errIntel("metrics update failed"))

	expectRunOnceAfterRecalc(mock)
	expectRunOnceTail(mock)

	companyStore := company.NewStore(db)

	result, err := RunOnce(context.Background(), db, Config{
		TargetIndustries: []string{"machinery"},
		CompanyStore:     companyStore,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.CompanyMetrics != 0 {
		t.Errorf("CompanyMetrics = %d, want 0 (error path)", result.CompanyMetrics)
	}
}

// ── FirmyDB + CompanyStore: company sync path ────────────────────────────────

func TestRunOnce_WithFirmyDBAndCompanyStore(t *testing.T) {
	outreachDB, outreachMock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New outreach: %v", err)
	}
	defer outreachDB.Close()

	firmyDB, firmyMock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New firmy: %v", err)
	}
	defer firmyDB.Close()

	// 1. thread.ResumeExpiredPauses
	outreachMock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// 1b. thread.ExpireStaleThreads
	outreachMock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 2. AutoSuppressFromEvents
	outreachMock.ExpectQuery(`SELECT DISTINCT c\.email, e\.id`).
		WillReturnRows(sqlmock.NewRows([]string{"email", "id"}))
	outreachMock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))
	outreachMock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))

	// 3. CheckDomainHealth
	outreachMock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}))

	// 4. RecalculateFast
	outreachMock.ExpectExec(`UPDATE outreach_contacts oc`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	outreachMock.ExpectExec(`UPDATE contacts c`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 4a. CompanyStore.UpdateMetrics — two Exec calls
	outreachMock.ExpectExec(`UPDATE companies co SET`).
		WillReturnResult(sqlmock.NewResult(0, 10))
	outreachMock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 4b. UpdateEngagementClusters
	outreachMock.ExpectExec(`UPDATE companies c`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 5. company.NewSyncer.Run — Phase 1: incremental sync
	// Gets max firmy_cz_id from outreach
	outreachMock.ExpectQuery(`SELECT COALESCE\(MAX\(firmy_cz_id\)`).
		WillReturnRows(sqlmock.NewRows([]string{"max"}).AddRow(0))
	// Queries firmyDB for rows — empty result
	firmyMock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "ico", "name", "email", "telephone", "website",
			"street_address", "address_locality", "postal_code", "description",
			"velikost_firmy", "pravni_forma", "category_path",
			"rating_value", "rating_count",
		}))
	// Phase 2: LinkContactByFirmyCzID
	outreachMock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// LinkContactByICO
	outreachMock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// Phase 3: UpdateMetrics (via store, inside syncer)
	outreachMock.ExpectExec(`UPDATE companies co SET`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	outreachMock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 5a. BackfillCategoriesJSON — queries firmyDB then updates outreach
	firmyMock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "categories_json"}))
	// 5b. BackfillCategoryPath — queries firmyDB then updates outreach
	firmyMock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "category_path"}))

	// 5c. classify.RunJob — no pending companies
	outreachMock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "name", "ico", "email",
			"pravni_forma", "category_path", "categories_json",
			"description", "velikost_firmy",
			"postal_code", "address_locality",
			"website", "telephone",
			"rating_value", "rating_count",
			"nace_codes",
			"v_insolvenci", "v_likvidaci", "datum_vzniku",
		}))

	// 6. DetectZeroEngagement
	outreachMock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 7. verifyEmailsBatch
	outreachMock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "mx_exists", "mx_host", "is_catch_all",
			"is_disposable", "is_spamtrap", "smtp_connectable", "checked_at",
		}))
	outreachMock.ExpectQuery(`SELECT id, email FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email"}))

	// 8. ares.RunSync
	outreachMock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	// 9. classify.RunReclassifyNACE
	outreachMock.ExpectQuery(`SELECT id, COALESCE\(name`).
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

	// 10. PromoteCompanies
	outreachMock.ExpectQuery(`SELECT id, firmy_cz_id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "firmy_cz_id", "ico", "name", "email",
			"telephone", "website", "address_locality", "street_address", "postal_code",
			"velikost_firmy", "pravni_forma", "description",
			"sector_tags", "sector_confidence",
			"region_normalized", "icp_score",
		}))

	// 11. category.RefreshCounts
	expectCategoryRefreshCoverage(outreachMock, 0)
	// 11b. segment.RefreshAll
	outreachMock.ExpectQuery(`SELECT .+ FROM segments`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "name", "description", "query",
			"company_count", "last_built_at", "created_at", "updated_at",
		}))
	// 12. audit log DELETE
	outreachMock.ExpectExec(`DELETE FROM operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	companyStore := company.NewStore(outreachDB)

	result, err := RunOnce(context.Background(), outreachDB, Config{
		TargetIndustries: []string{"machinery"},
		FirmyDB:          firmyDB,
		CompanyStore:     companyStore,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.CompanyMetrics != 10 {
		t.Errorf("CompanyMetrics = %d, want 10", result.CompanyMetrics)
	}
	if result.CompanySynced != 0 {
		t.Errorf("CompanySynced = %d, want 0", result.CompanySynced)
	}
}

// ── LLMClient empty batch path ───────────────────────────────────────────────

func TestRunOnce_WithLLMClient(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	expectRunOnceCore(mock)
	expectRunOnceAfterRecalc(mock)

	// 9b. RunLLMEnrich — SELECT returns empty batch
	mock.ExpectQuery(`SELECT id, description`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "description", "sector_confidence"}))

	expectRunOnceTail(mock)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("LLM should not be called for empty batch")
	}))
	t.Cleanup(srv.Close)
	llmClient := llm.NewClient(llm.Config{
		BaseURL: srv.URL,
		Model:   "test-model",
		Timeout: 5 * time.Second,
	})

	result, err := RunOnce(context.Background(), db, Config{
		TargetIndustries: []string{"machinery"},
		LLMClient:        llmClient,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.LLMEnrichProcessed != 0 {
		t.Errorf("LLMEnrichProcessed = %d, want 0", result.LLMEnrichProcessed)
	}
}

// ── LLM enrichment error path ───────────────────────────────────────────────

func TestRunOnce_LLMEnrichError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	expectRunOnceCore(mock)
	expectRunOnceAfterRecalc(mock)

	// 9b. RunLLMEnrich — SELECT errors
	mock.ExpectQuery(`SELECT id, description`).
		WillReturnError(errIntel("llm query error"))

	expectRunOnceTail(mock)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("LLM should not be called when DB query errors")
	}))
	t.Cleanup(srv.Close)
	llmClient := llm.NewClient(llm.Config{
		BaseURL: srv.URL,
		Model:   "test-model",
		Timeout: 5 * time.Second,
	})

	result, err := RunOnce(context.Background(), db, Config{
		TargetIndustries: []string{"machinery"},
		LLMClient:        llmClient,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.LLMEnrichProcessed != 0 {
		t.Errorf("LLMEnrichProcessed = %d, want 0", result.LLMEnrichProcessed)
	}
}

// ── Non-zero results in various steps ────────────────────────────────────────

func TestRunOnce_NonZeroPromoteAndSegments(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// 1. thread.ResumeExpiredPauses — 2 resumed
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 2))
	// 1b. thread.ExpireStaleThreads — 5 expired
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 5))

	// 2. AutoSuppressFromEvents
	mock.ExpectQuery(`SELECT DISTINCT c\.email, e\.id`).
		WillReturnRows(sqlmock.NewRows([]string{"email", "id"}))
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))

	// 3. CheckDomainHealth
	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}))

	// 4. RecalculateFast
	mock.ExpectExec(`UPDATE outreach_contacts oc`).
		WillReturnResult(sqlmock.NewResult(0, 50))
	mock.ExpectExec(`UPDATE contacts c`).
		WillReturnResult(sqlmock.NewResult(0, 30))

	// 4b. UpdateEngagementClusters — 15 updated
	mock.ExpectExec(`UPDATE companies c`).
		WillReturnResult(sqlmock.NewResult(0, 15))

	// 6. DetectZeroEngagement — 3 traps
	mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WillReturnResult(sqlmock.NewResult(0, 3))

	// 7-9. Standard empty
	mock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "mx_exists", "mx_host", "is_catch_all",
			"is_disposable", "is_spamtrap", "smtp_connectable", "checked_at",
		}))
	mock.ExpectQuery(`SELECT id, email FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email"}))
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))
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

	// 10. PromoteCompanies
	mock.ExpectQuery(`SELECT id, firmy_cz_id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "firmy_cz_id", "ico", "name", "email",
			"telephone", "website", "address_locality", "street_address", "postal_code",
			"velikost_firmy", "pravni_forma", "description",
			"sector_tags", "sector_confidence",
			"region_normalized", "icp_score",
		}))

	// 11. category.RefreshCounts
	expectCategoryRefreshCoverage(mock, 12)
	// 11b. segment.RefreshAll — empty segment list
	mock.ExpectQuery(`SELECT .+ FROM segments`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "name", "description", "query",
			"company_count", "last_built_at", "created_at", "updated_at",
		}))
	// 12. audit log DELETE — 100 rows
	mock.ExpectExec(`DELETE FROM operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(0, 100))

	reg := health.New()
	result, err := RunOnce(context.Background(), db, Config{
		TargetIndustries: []string{"machinery"},
		Health:           reg,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.PausesResumed != 2 {
		t.Errorf("PausesResumed = %d, want 2", result.PausesResumed)
	}
	if result.EngagementClusters != 15 {
		t.Errorf("EngagementClusters = %d, want 15", result.EngagementClusters)
	}
	if result.CategoryRefreshed != 12 {
		t.Errorf("CategoryRefreshed = %d, want 12", result.CategoryRefreshed)
	}
	if result.Duration == 0 {
		t.Error("Duration should be set")
	}
}

// ── RecalculateFast error ────────────────────────────────────────────────────

func TestRunOnce_RecalcError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// 1. thread.ResumeExpiredPauses
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// 1b. thread.ExpireStaleThreads
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 2. AutoSuppressFromEvents
	mock.ExpectQuery(`SELECT DISTINCT c\.email, e\.id`).
		WillReturnRows(sqlmock.NewRows([]string{"email", "id"}))
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))

	// 3. CheckDomainHealth
	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}))

	// 4. RecalculateFast — error
	mock.ExpectExec(`UPDATE outreach_contacts oc`).
		WillReturnError(errIntel("recalc error"))

	// 4b onward
	expectRunOnceAfterRecalc(mock)
	expectRunOnceTail(mock)

	result, err := RunOnce(context.Background(), db, Config{
		TargetIndustries: []string{"machinery"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ScoresRecalculated != 0 {
		t.Errorf("ScoresRecalculated = %d, want 0 (error path)", result.ScoresRecalculated)
	}
}

// ── LLM enrichment with processed results ───────────────────────────────────

func TestRunOnce_LLMEnrichWithResults(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	expectRunOnceCore(mock)
	expectRunOnceAfterRecalc(mock)

	// 9b. RunLLMEnrich — 1 company to enrich
	mock.ExpectQuery(`SELECT id, description`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "description", "sector_confidence"}).
			AddRow(10, "Výroba CNC strojů pro automobilový průmysl.", 0.3))

	callCount := 0
	tagsJSON := `{"main_product":"CNC","tech_keywords":["frézování"],"export_oriented":true,"is_seasonal":false}`
	classifyJSON := `{"tags":["machinery","automotive"],"confidence":0.85}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if callCount == 1 {
			w.Write(ollamaResponse(tagsJSON))
		} else {
			w.Write(ollamaResponse(classifyJSON))
		}
	}))
	t.Cleanup(srv.Close)
	llmClient := llm.NewClient(llm.Config{
		BaseURL: srv.URL,
		Model:   "test-model",
		Timeout: 5 * time.Second,
	})

	// LLM persist: sector upgrade (high confidence)
	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	expectRunOnceTail(mock)

	result, err := RunOnce(context.Background(), db, Config{
		TargetIndustries: []string{"machinery"},
		LLMClient:        llmClient,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.LLMEnrichProcessed != 1 {
		t.Errorf("LLMEnrichProcessed = %d, want 1", result.LLMEnrichProcessed)
	}
	if result.LLMEnrichBoosted != 1 {
		t.Errorf("LLMEnrichBoosted = %d, want 1", result.LLMEnrichBoosted)
	}
}
