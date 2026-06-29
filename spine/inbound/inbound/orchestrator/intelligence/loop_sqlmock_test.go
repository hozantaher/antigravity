package intelligence

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"common/health"
)

func expectCategoryRefresh(mock sqlmock.Sqlmock, refreshed int64) {
	mock.ExpectExec(`INSERT INTO categories`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`WITH RECURSIVE ancestors AS`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`WITH RECURSIVE expanded AS`).
		WillReturnResult(sqlmock.NewResult(0, refreshed))
}

// expectRunOnceMinimal sets up the full DB expectation sequence for RunOnce
// with no FirmyDB, CompanyStore, LLMClient, or Alert configured.
// All queries return empty results so RunOnce completes without side effects.
//
// Step ordering matches loop.go RunOnce exactly:
//  1. thread.ResumeExpiredPauses
//     1b. thread.ExpireStaleThreads
//  2. enrich.AutoSuppressFromEvents (3 queries)
//  3. CheckDomainHealth
//  4. enrich.RecalculateFast (2 execs)
//     4b. UpdateEngagementClusters
//  5. DetectZeroEngagement
//  6. verifyEmailsBatch (domain cache + companies)
//  7. ares.RunSync
//  8. classify.RunReclassifyNACE
//  9. enrich.PromoteCompanies
//  10. category.RefreshCounts
//  11. segment.RefreshAll
//  12. audit log DELETE
func expectRunOnceMinimal(mock sqlmock.Sqlmock) {
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

	// 4b. UpdateEngagementClusters
	mock.ExpectExec(`UPDATE companies c`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 5. DetectZeroEngagement
	mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 6. verifyEmailsBatch: LoadDomainCache + companies SELECT
	mock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "mx_exists", "mx_host", "is_catch_all",
			"is_disposable", "is_spamtrap", "smtp_connectable", "checked_at",
		}))
	mock.ExpectQuery(`SELECT id, email FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email"}))

	// 7. ares.RunSync — 1 query (empty → break)
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	// 8. classify.RunReclassifyNACE — 1 query (empty → break)
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

	// 9. enrich.PromoteCompanies — 1 query (empty → break)
	mock.ExpectQuery(`SELECT id, firmy_cz_id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "firmy_cz_id", "ico", "name", "email",
			"telephone", "website", "address_locality", "street_address", "postal_code",
			"velikost_firmy", "pravni_forma", "description",
			"sector_tags", "sector_confidence",
			"region_normalized", "icp_score",
		}))

	// 10. category.RefreshCounts
	expectCategoryRefresh(mock, 0)

	// 11. segment.RefreshAll
	mock.ExpectQuery(`SELECT .+ FROM segments`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "name", "description", "query",
			"company_count", "last_built_at", "created_at", "updated_at",
		}))

	// 12. audit log DELETE
	mock.ExpectExec(`DELETE FROM operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(0, 0))
}

func TestRunOnce_MinimalConfig_AllEmpty(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	expectRunOnceMinimal(mock)

	result, err := RunOnce(context.Background(), db, Config{
		TargetIndustries: []string{"machinery"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("result should not be nil")
	}
	if result.PausesResumed != 0 {
		t.Errorf("PausesResumed = %d, want 0", result.PausesResumed)
	}
	if result.Suppressed != 0 {
		t.Errorf("Suppressed = %d, want 0", result.Suppressed)
	}
	if result.EmailsVerified != 0 {
		t.Errorf("EmailsVerified = %d, want 0", result.EmailsVerified)
	}
	if result.Duration == 0 {
		t.Error("Duration should be set after RunOnce completes")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled DB expectations: %v", err)
	}
}

func TestRunOnce_WithPausesResumed(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// 1. thread.ResumeExpiredPauses — 3 resumed
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 3))

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

	// 4. RecalculateFast
	mock.ExpectExec(`UPDATE outreach_contacts oc`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`UPDATE contacts c`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 4b. UpdateEngagementClusters
	mock.ExpectExec(`UPDATE companies c`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 5. DetectZeroEngagement
	mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 6. verifyEmailsBatch
	mock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "mx_exists", "mx_host", "is_catch_all",
			"is_disposable", "is_spamtrap", "smtp_connectable", "checked_at",
		}))
	mock.ExpectQuery(`SELECT id, email FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email"}))

	// 7. ares.RunSync
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	// 8. classify.RunReclassifyNACE
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

	// 9. enrich.PromoteCompanies
	mock.ExpectQuery(`SELECT id, firmy_cz_id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "firmy_cz_id", "ico", "name", "email",
			"telephone", "website", "address_locality", "street_address", "postal_code",
			"velikost_firmy", "pravni_forma", "description",
			"sector_tags", "sector_confidence",
			"region_normalized", "icp_score",
		}))

	// 10. category.RefreshCounts
	expectCategoryRefresh(mock, 0)

	// 11. segment.RefreshAll
	mock.ExpectQuery(`SELECT .+ FROM segments`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "name", "description", "query",
			"company_count", "last_built_at", "created_at", "updated_at",
		}))

	// 12. audit log DELETE
	mock.ExpectExec(`DELETE FROM operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	result, err := RunOnce(context.Background(), db, Config{
		TargetIndustries: []string{"machinery"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.PausesResumed != 3 {
		t.Errorf("PausesResumed = %d, want 3", result.PausesResumed)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled DB expectations: %v", err)
	}
}

// ── G13: consecutive failure tracking via health registry ──

func TestRunDaemon_ReportsUnhealthyOnConsecutiveFailures(t *testing.T) {
	// RunDaemon recovers panics and calls markFail on each failure.
	// Passing a nil *sql.DB makes thread.NewManager(nil).ResumeExpiredPauses
	// panic with a nil-pointer dereference on the very first DB call.
	// After 3+ recovered panics the health registry must show ok=false.
	ctx, cancel := context.WithCancel(context.Background())

	reg := health.New()

	cfg := Config{
		TargetIndustries: []string{},
		Health:           reg,
	}

	go func() {
		time.Sleep(200 * time.Millisecond)
		cancel()
	}()

	RunDaemon(ctx, nil, cfg, 50*time.Millisecond) //nolint:errcheck

	snapshot := reg.Snapshot()
	var intelStatus *health.DaemonStatus
	for _, s := range snapshot {
		if s.Name == "intel_loop" {
			intelStatus = s
			break
		}
	}
	if intelStatus == nil {
		t.Fatal("intel_loop not found in health snapshot")
	}
	if intelStatus.OK {
		t.Error("expected intel_loop to be unhealthy after consecutive failures, got ok=true")
	}
}
