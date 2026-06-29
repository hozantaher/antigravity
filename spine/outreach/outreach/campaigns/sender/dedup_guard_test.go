// dedup_guard_test.go — coverage for the 8-axis dedup guard.
// Per memory feedback_extreme_testing: ≥10 test cases per change including
// boundary, error, integration, and property paths.
//
// Axes in evaluation order:
//   1. crm_active_client (Sprint CRM-5, #793)
//   2. dnt
//   3. lifetime_touches
//   4. cross_campaign_cooldown
//   5. bounce_cluster (Sprint C1, #784)
//   6. region_rate_limit (Sprint C3, #785)
//   7. engagement_decay (Sprint C4)
//   8. per_domain_cooldown

package sender

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// rowsContact returns a sqlmock Rows for the contact load query.
// Columns: dnt, lifetime_touches, email_domain, region, parent_ico, crm_client_id
func rowsContact(dnt bool, lifetime int, domain string) *sqlmock.Rows {
	r := sqlmock.NewRows([]string{"dnt", "lifetime_touches", "email_domain", "region", "parent_ico", "crm_client_id"})
	if domain == "" {
		r.AddRow(dnt, lifetime, nil, nil, nil, nil)
	} else {
		r.AddRow(dnt, lifetime, domain, nil, nil, nil)
	}
	return r
}

// rowsContactWithICO returns sqlmock Rows with parent_ico set.
func rowsContactWithICO(dnt bool, lifetime int, domain, parentICO string) *sqlmock.Rows {
	r := sqlmock.NewRows([]string{"dnt", "lifetime_touches", "email_domain", "region", "parent_ico", "crm_client_id"})
	var domainVal, icoVal interface{}
	if domain != "" {
		domainVal = domain
	}
	if parentICO != "" {
		icoVal = parentICO
	}
	r.AddRow(dnt, lifetime, domainVal, nil, icoVal, nil)
	return r
}

// rowsContactWithRegion returns sqlmock Rows with region set.
func rowsContactWithRegion(dnt bool, lifetime int, domain, region string) *sqlmock.Rows {
	r := sqlmock.NewRows([]string{"dnt", "lifetime_touches", "email_domain", "region", "parent_ico", "crm_client_id"})
	var domainVal, regionVal interface{}
	if domain != "" {
		domainVal = domain
	}
	if region != "" {
		regionVal = region
	}
	r.AddRow(dnt, lifetime, domainVal, regionVal, nil, nil)
	return r
}

// rowsContactWithCRM returns sqlmock Rows with crm_client_id set
// (contact is in eWAY-CRM klienti or aktivní OP).
func rowsContactWithCRM(dnt bool, lifetime int, domain string, crmClientID int64) *sqlmock.Rows {
	r := sqlmock.NewRows([]string{"dnt", "lifetime_touches", "email_domain", "region", "parent_ico", "crm_client_id"})
	var domainVal interface{}
	if domain != "" {
		domainVal = domain
	}
	r.AddRow(dnt, lifetime, domainVal, nil, nil, crmClientID)
	return r
}

// ── Config tests ──────────────────────────────────────────────────────

func TestDefaultDedupGuardConfig(t *testing.T) {
	c := DefaultDedupGuardConfig()
	if c.CrossCampaignCooldown != 90*24*time.Hour {
		t.Errorf("cross-campaign cooldown wrong: %v", c.CrossCampaignCooldown)
	}
	if c.PerDomainCooldown != 180*24*time.Hour {
		t.Errorf("per-domain cooldown wrong: %v", c.PerDomainCooldown)
	}
	if c.LifetimeMaxTouches != 3 {
		t.Errorf("lifetime max wrong: %d", c.LifetimeMaxTouches)
	}
	if c.BounceClusterThreshold != 0.30 {
		t.Errorf("bounce cluster threshold wrong: %v", c.BounceClusterThreshold)
	}
	if c.BounceClusterWindow != 30*24*time.Hour {
		t.Errorf("bounce cluster window wrong: %v", c.BounceClusterWindow)
	}
	if c.RegionMaxPerHour != 2 {
		t.Errorf("region max per hour wrong: %d", c.RegionMaxPerHour)
	}
	if c.RegionWindow != 1*time.Hour {
		t.Errorf("region window wrong: %v", c.RegionWindow)
	}
	if c.EngagementDecayMinSends != 3 {
		t.Errorf("engagement decay min sends wrong: %d", c.EngagementDecayMinSends)
	}
	if c.EngagementDecayWindow != 365*24*time.Hour {
		t.Errorf("engagement decay window wrong: %v", c.EngagementDecayWindow)
	}
}

// ── Happy path (all 8 axes pass) ──────────────────────────────────────

func TestCheckEligibility_HappyPath(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	// Contact with domain, no CRM link, region NULL, parent_ico NULL
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(42)).WillReturnRows(rowsContact(false, 0, "firma.cz"))
	// cross_campaign_cooldown: no rows
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	// bounce_cluster: skipped (no parent_ico)
	// region_rate_limit: skipped (no region)
	// engagement_decay: 0 sends, 0 engaged
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(0, 0))
	// per_domain_cooldown: no rows
	mock.ExpectQuery("FROM send_events se.*JOIN contacts").WillReturnError(sql.ErrNoRows)

	res, err := CheckEligibility(context.Background(), db, 42, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.Eligible {
		t.Errorf("expected eligible, got: reason=%q", res.Reason)
	}
	// All 8 axes evaluated
	if len(res.RulesEvaluated) != 8 {
		t.Errorf("expected 8 rules evaluated, got %d: %v", len(res.RulesEvaluated), res.RulesEvaluated)
	}
	// crm_active_client must be FIRST
	if len(res.RulesEvaluated) > 0 && res.RulesEvaluated[0] != "crm_active_client" {
		t.Errorf("expected first rule = crm_active_client, got %q", res.RulesEvaluated[0])
	}
}

// ── CRM active client axis tests (Sprint CRM-5) ────────────────────────

func TestCheckEligibility_CRMActiveClientBlocks(t *testing.T) {
	// Contact linked to a crm_clients row → block immediately.
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(401)).
		WillReturnRows(rowsContactWithCRM(false, 0, "firma.cz", 12345))
	res, err := CheckEligibility(context.Background(), db, 401, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.Eligible {
		t.Error("expected blocked by CRM active client")
	}
	if res.Reason != "crm_active_client" {
		t.Errorf("reason should be crm_active_client, got %q", res.Reason)
	}
	// Only first rule evaluated (short-circuit before DNT)
	if len(res.RulesEvaluated) != 1 || res.RulesEvaluated[0] != "crm_active_client" {
		t.Errorf("expected RulesEvaluated=[crm_active_client], got %v", res.RulesEvaluated)
	}
}

func TestCheckEligibility_CRMActiveClient_NoCRMLink(t *testing.T) {
	// Standard contact without CRM link → CRM axis evaluated, doesn't block,
	// flow continues through dnt/lifetime/etc.
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(402)).
		WillReturnRows(rowsContact(false, 0, "firma.cz"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(0, 0))
	mock.ExpectQuery("FROM send_events se.*JOIN contacts").WillReturnError(sql.ErrNoRows)
	res, err := CheckEligibility(context.Background(), db, 402, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !res.Eligible {
		t.Errorf("expected eligible (no CRM link), got %q", res.Reason)
	}
	// crm_active_client must be FIRST in evaluation order
	if len(res.RulesEvaluated) < 1 || res.RulesEvaluated[0] != "crm_active_client" {
		t.Errorf("expected first rule = crm_active_client, got %v", res.RulesEvaluated)
	}
}

func TestCheckEligibility_CRMActiveClient_OverridesDNT(t *testing.T) {
	// Contact with both DNT and CRM link → CRM wins (evaluated first).
	// Operator sees "in CRM" reason rather than "DNT" — more actionable.
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(403)).
		WillReturnRows(rowsContactWithCRM(true, 5, "firma.cz", 99))
	res, _ := CheckEligibility(context.Background(), db, 403, DefaultDedupGuardConfig())
	if res.Reason != "crm_active_client" {
		t.Errorf("CRM must override DNT, got %q", res.Reason)
	}
}

// ── DNT axis tests ────────────────────────────────────────────────────

func TestCheckEligibility_DNTBlocks(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery("SELECT dnt").WithArgs(int64(7)).WillReturnRows(rowsContact(true, 0, "firma.cz"))

	res, err := CheckEligibility(context.Background(), db, 7, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Eligible {
		t.Error("expected blocked by DNT")
	}
	if res.Reason != "dnt_set" {
		t.Errorf("reason should be dnt_set, got %q", res.Reason)
	}
}

// ── Lifetime axis tests ───────────────────────────────────────────────

func TestCheckEligibility_LifetimeExhausted(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery("SELECT dnt").WithArgs(int64(11)).WillReturnRows(rowsContact(false, 3, "firma.cz"))

	res, err := CheckEligibility(context.Background(), db, 11, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Eligible {
		t.Error("expected blocked by lifetime")
	}
	if res.Reason != "lifetime_exhausted" {
		t.Errorf("reason should be lifetime_exhausted, got %q", res.Reason)
	}
}

func TestCheckEligibility_LifetimeBoundary(t *testing.T) {
	// lifetime_touches == max → block (>=, not >)
	// lifetime_touches == max-1 → allowed
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(12)).WillReturnRows(rowsContact(false, 2, "firma.cz"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(0, 0))
	mock.ExpectQuery("FROM send_events se.*JOIN contacts").WillReturnError(sql.ErrNoRows)
	res, err := CheckEligibility(context.Background(), db, 12, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !res.Eligible {
		t.Errorf("expected eligible at lifetime=2 (one below limit), got %q", res.Reason)
	}
}

// ── Cross-campaign cooldown axis tests ───────────────────────────────

func TestCheckEligibility_CrossCampaignCooldown(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(101)).WillReturnRows(rowsContact(false, 1, "firma.cz"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").
		WillReturnRows(sqlmock.NewRows([]string{"?column?"}).AddRow(1))

	res, err := CheckEligibility(context.Background(), db, 101, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.Eligible {
		t.Error("expected blocked by cross-campaign cooldown")
	}
	if res.Reason != "cross_campaign_cooldown" {
		t.Errorf("reason should be cross_campaign_cooldown, got %q", res.Reason)
	}
}

func TestCheckEligibility_CrossCampaignQueryError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(6)).WillReturnRows(rowsContact(false, 0, "firma.cz"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(errors.New("deadlock"))

	res, err := CheckEligibility(context.Background(), db, 6, DefaultDedupGuardConfig())
	if err == nil {
		t.Error("expected error propagated")
	}
	if res.Eligible {
		t.Error("must not be eligible on DB error")
	}
}

// ── Bounce cluster axis tests (Sprint C1) ────────────────────────────

func TestCheckEligibility_BounceClusterHappyPath(t *testing.T) {
	// Contact with parent_ico, but bounce rate below threshold → eligible.
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery("SELECT dnt").WithArgs(int64(111)).
		WillReturnRows(rowsContactWithICO(false, 0, "firma.cz", "ICO-123"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	// Bounce cluster query: 10 total, 2 bounced = 20% < 30% threshold → pass
	mock.ExpectQuery("SELECT COUNT.*FROM send_events se.*JOIN contacts c.*parent_ico").
		WillReturnRows(sqlmock.NewRows([]string{"total", "bounced"}).AddRow(10, 2))
	// region_rate_limit: skipped (region NULL)
	// engagement_decay: 0 sent
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(0, 0))
	// per_domain_cooldown
	mock.ExpectQuery("FROM send_events se.*JOIN contacts").WillReturnError(sql.ErrNoRows)

	res, err := CheckEligibility(context.Background(), db, 111, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.Eligible {
		t.Errorf("expected eligible, got reason: %q", res.Reason)
	}
	if len(res.RulesEvaluated) != 8 {
		t.Errorf("expected 8 rules evaluated, got %d", len(res.RulesEvaluated))
	}
}

func TestCheckEligibility_BounceClusterThresholdMet(t *testing.T) {
	// Bounce rate exactly at threshold should block.
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery("SELECT dnt").WithArgs(int64(112)).
		WillReturnRows(rowsContactWithICO(false, 0, "firma.cz", "ICO-456"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	// 10 sends, 3 bounced = 30% = threshold → block
	mock.ExpectQuery("SELECT COUNT.*FROM send_events se.*JOIN contacts c.*parent_ico").
		WillReturnRows(sqlmock.NewRows([]string{"total", "bounced"}).AddRow(10, 3))

	res, err := CheckEligibility(context.Background(), db, 112, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Eligible {
		t.Error("expected blocked by bounce cluster at 30% rate")
	}
	if res.Reason != "bounce_cluster" {
		t.Errorf("expected bounce_cluster, got %q", res.Reason)
	}
}

func TestCheckEligibility_BounceClusterExceedsThreshold(t *testing.T) {
	// Bounce rate 40% > 30% threshold → block.
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery("SELECT dnt").WithArgs(int64(113)).
		WillReturnRows(rowsContactWithICO(false, 0, "firma.cz", "ICO-789"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	// 10 sends, 4 bounced = 40% > 30% → block
	mock.ExpectQuery("SELECT COUNT.*FROM send_events se.*JOIN contacts c.*parent_ico").
		WillReturnRows(sqlmock.NewRows([]string{"total", "bounced"}).AddRow(10, 4))

	res, err := CheckEligibility(context.Background(), db, 113, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Eligible {
		t.Error("expected blocked at 40% bounce rate")
	}
	if res.Reason != "bounce_cluster" {
		t.Errorf("reason should be bounce_cluster, got %q", res.Reason)
	}
}

func TestCheckEligibility_BounceClusterNoisyLowSendCount(t *testing.T) {
	// Total sends < 5: even high bounce rate (3/4 = 75%) should not block.
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery("SELECT dnt").WithArgs(int64(114)).
		WillReturnRows(rowsContactWithICO(false, 0, "firma.cz", "ICO-999"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	// 4 sends, 3 bounced = 75%, but < 5 threshold → pass
	mock.ExpectQuery("SELECT COUNT.*FROM send_events se.*JOIN contacts c.*parent_ico").
		WillReturnRows(sqlmock.NewRows([]string{"total", "bounced"}).AddRow(4, 3))
	// region_rate_limit: skipped (region NULL)
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(0, 0))
	mock.ExpectQuery("FROM send_events se.*JOIN contacts").WillReturnError(sql.ErrNoRows)

	res, err := CheckEligibility(context.Background(), db, 114, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.Eligible {
		t.Errorf("expected eligible (noisy low count), got reason: %q", res.Reason)
	}
}

func TestCheckEligibility_BounceClusterEmptyICO(t *testing.T) {
	// Contact with NULL parent_ico: bounce cluster check skipped entirely.
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery("SELECT dnt").WithArgs(int64(115)).
		WillReturnRows(rowsContactWithICO(false, 0, "firma.cz", ""))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	// No bounce cluster query expected — skip to region (NULL) then engagement then domain
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(0, 0))
	mock.ExpectQuery("FROM send_events se.*JOIN contacts").WillReturnError(sql.ErrNoRows)

	res, err := CheckEligibility(context.Background(), db, 115, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.Eligible {
		t.Errorf("expected eligible (empty ICO skips check), got reason: %q", res.Reason)
	}
	if len(res.RulesEvaluated) != 8 {
		t.Errorf("expected 8 rules evaluated, got %d", len(res.RulesEvaluated))
	}
}

func TestCheckEligibility_BounceClusterQueryError(t *testing.T) {
	// Bounce cluster query fails → propagate error.
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery("SELECT dnt").WithArgs(int64(116)).
		WillReturnRows(rowsContactWithICO(false, 0, "firma.cz", "ICO-000"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("SELECT COUNT.*FROM send_events se.*JOIN contacts c.*parent_ico").
		WillReturnError(errors.New("connection timeout"))

	res, err := CheckEligibility(context.Background(), db, 116, DefaultDedupGuardConfig())
	if err == nil {
		t.Error("expected error propagated from bounce cluster query")
	}
	if res.Eligible {
		t.Error("must not be eligible on DB error")
	}
}

func TestCheckEligibility_BounceClusterZeroBounces(t *testing.T) {
	// Total sends >= 5 but zero bounces: bounce rate = 0 < 30% → eligible.
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery("SELECT dnt").WithArgs(int64(117)).
		WillReturnRows(rowsContactWithICO(false, 0, "firma.cz", "ICO-111"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	// 5 sends, 0 bounced = 0% → pass
	mock.ExpectQuery("SELECT COUNT.*FROM send_events se.*JOIN contacts c.*parent_ico").
		WillReturnRows(sqlmock.NewRows([]string{"total", "bounced"}).AddRow(5, 0))
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(0, 0))
	mock.ExpectQuery("FROM send_events se.*JOIN contacts").WillReturnError(sql.ErrNoRows)

	res, err := CheckEligibility(context.Background(), db, 117, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.Eligible {
		t.Errorf("expected eligible (zero bounces), got reason: %q", res.Reason)
	}
}

// ── Region rate limit axis tests (Sprint C3) ─────────────────────────

func TestCheckEligibility_RegionRateLimitHappyPath(t *testing.T) {
	// Contact in region with < 2 sends in rolling hour → eligible.
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery("SELECT dnt").WithArgs(int64(201)).
		WillReturnRows(rowsContactWithRegion(false, 0, "firma.cz", "Jihomoravský"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	// Bounce cluster: skipped (parent_ico NULL)
	// Region rate limit: 1 send < 2 max → pass
	mock.ExpectQuery("SELECT COUNT.*FROM send_events se.*JOIN contacts c.*WHERE c.region").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	// Engagement decay
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(0, 0))
	// Per-domain check
	mock.ExpectQuery("FROM send_events se.*JOIN contacts").WillReturnError(sql.ErrNoRows)

	res, err := CheckEligibility(context.Background(), db, 201, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.Eligible {
		t.Errorf("expected eligible, got reason: %q", res.Reason)
	}
	if len(res.RulesEvaluated) != 8 {
		t.Errorf("expected 8 rules evaluated, got %d", len(res.RulesEvaluated))
	}
}

func TestCheckEligibility_RegionRateLimitAtExactMax(t *testing.T) {
	// Contact in region with exactly 2 sends (at max) → block (>= semantics).
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery("SELECT dnt").WithArgs(int64(202)).
		WillReturnRows(rowsContactWithRegion(false, 0, "firma.cz", "Praha"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	// Region rate limit: 2 sends >= 2 max → block
	mock.ExpectQuery("SELECT COUNT.*FROM send_events se.*JOIN contacts c.*WHERE c.region").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(2))

	res, err := CheckEligibility(context.Background(), db, 202, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Eligible {
		t.Error("expected blocked at exactly 2 sends (max)")
	}
	if res.Reason != "region_rate_limit" {
		t.Errorf("expected region_rate_limit, got %q", res.Reason)
	}
}

func TestCheckEligibility_RegionRateLimitExceedsMax(t *testing.T) {
	// Contact in region with 3 sends (exceeds max) → block.
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery("SELECT dnt").WithArgs(int64(203)).
		WillReturnRows(rowsContactWithRegion(false, 0, "firma.cz", "Moravskoslezský"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	// Region rate limit: 3 sends >= 2 max → block
	mock.ExpectQuery("SELECT COUNT.*FROM send_events se.*JOIN contacts c.*WHERE c.region").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(3))

	res, err := CheckEligibility(context.Background(), db, 203, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Eligible {
		t.Error("expected blocked when region sends exceed max")
	}
	if res.Reason != "region_rate_limit" {
		t.Errorf("expected region_rate_limit, got %q", res.Reason)
	}
}

func TestCheckEligibility_RegionRateLimitNullRegion(t *testing.T) {
	// Contact with NULL region: region rate limit check skipped.
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery("SELECT dnt").WithArgs(int64(204)).
		WillReturnRows(rowsContactWithRegion(false, 0, "firma.cz", ""))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	// No region rate limit query expected — region is NULL/empty
	// Engagement decay
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(0, 0))
	// Per-domain check
	mock.ExpectQuery("FROM send_events se.*JOIN contacts").WillReturnError(sql.ErrNoRows)

	res, err := CheckEligibility(context.Background(), db, 204, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.Eligible {
		t.Errorf("expected eligible (null region skips check), got reason: %q", res.Reason)
	}
}

func TestCheckEligibility_RegionRateLimitQueryError(t *testing.T) {
	// Region rate limit query fails → propagate error.
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery("SELECT dnt").WithArgs(int64(205)).
		WillReturnRows(rowsContactWithRegion(false, 0, "firma.cz", "Liberecký"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("SELECT COUNT.*FROM send_events se.*JOIN contacts c.*WHERE c.region").
		WillReturnError(errors.New("connection lost"))

	res, err := CheckEligibility(context.Background(), db, 205, DefaultDedupGuardConfig())
	if err == nil {
		t.Error("expected error propagated from region rate limit query")
	}
	if res.Eligible {
		t.Error("must not be eligible on DB error")
	}
}

func TestCheckEligibility_RegionRateLimitZeroSends(t *testing.T) {
	// Region rate limit with zero sends in window → eligible.
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery("SELECT dnt").WithArgs(int64(206)).
		WillReturnRows(rowsContactWithRegion(false, 0, "firma.cz", "Plzeňský"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	// Region rate limit: 0 sends < 2 max → pass
	mock.ExpectQuery("SELECT COUNT.*FROM send_events se.*JOIN contacts c.*WHERE c.region").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	// Engagement decay
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(0, 0))
	// Per-domain check
	mock.ExpectQuery("FROM send_events se.*JOIN contacts").WillReturnError(sql.ErrNoRows)

	res, err := CheckEligibility(context.Background(), db, 206, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.Eligible {
		t.Errorf("expected eligible with zero sends in window, got reason: %q", res.Reason)
	}
}

// ── Engagement decay axis tests (Sprint C4) ──────────────────────────

func TestCheckEligibility_EngagementDecayHappyPath(t *testing.T) {
	// 2 sends in window, 0 engaged → under min floor (3) → eligible.
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(301)).WillReturnRows(rowsContact(false, 0, "firma.cz"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(2, 0))
	mock.ExpectQuery("FROM send_events se.*JOIN contacts").WillReturnError(sql.ErrNoRows)
	res, err := CheckEligibility(context.Background(), db, 301, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !res.Eligible {
		t.Errorf("expected eligible at sent=2 (under min 3), got %q", res.Reason)
	}
}

func TestCheckEligibility_EngagementDecayBlocks(t *testing.T) {
	// 4 sends, 0 engaged → block.
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(302)).WillReturnRows(rowsContact(false, 0, "firma.cz"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(4, 0))
	res, err := CheckEligibility(context.Background(), db, 302, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.Eligible {
		t.Error("expected blocked by engagement_decay")
	}
	if res.Reason != "engagement_decay" {
		t.Errorf("reason should be engagement_decay, got %q", res.Reason)
	}
}

func TestCheckEligibility_EngagementDecayBoundary(t *testing.T) {
	// 3 sends (=min), 0 engaged → block (>= semantic).
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(303)).WillReturnRows(rowsContact(false, 0, "firma.cz"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(3, 0))
	res, _ := CheckEligibility(context.Background(), db, 303, DefaultDedupGuardConfig())
	if res.Eligible {
		t.Error("expected blocked at sent=3 (=min, inclusive)")
	}
	if res.Reason != "engagement_decay" {
		t.Errorf("reason should be engagement_decay, got %q", res.Reason)
	}
}

func TestCheckEligibility_EngagementDecayWithOpens(t *testing.T) {
	// 5 sends, 2 engaged → eligible (engaged > 0).
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(304)).WillReturnRows(rowsContact(false, 0, "firma.cz"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(5, 2))
	mock.ExpectQuery("FROM send_events se.*JOIN contacts").WillReturnError(sql.ErrNoRows)
	res, err := CheckEligibility(context.Background(), db, 304, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !res.Eligible {
		t.Errorf("expected eligible (engaged > 0), got %q", res.Reason)
	}
}

func TestCheckEligibility_EngagementDecayQueryError(t *testing.T) {
	// Engagement query DB error → wrapped propagated, not eligible.
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(305)).WillReturnRows(rowsContact(false, 0, "firma.cz"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("LEFT JOIN tracking_events").WillReturnError(errors.New("db down"))
	_, err := CheckEligibility(context.Background(), db, 305, DefaultDedupGuardConfig())
	if err == nil {
		t.Error("expected wrapped DB error")
	}
}

// ── Per-domain cooldown axis tests ───────────────────────────────────

func TestCheckEligibility_PerDomainCooldown(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	// Note: contact ID 202 is also used for RegionRateLimitAtExactMax above,
	// but different sqlmock instances; no collision.
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(502)).WillReturnRows(rowsContact(false, 0, "shared.cz"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	// engagement_decay: 0 sends
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(0, 0))
	mock.ExpectQuery("FROM send_events se.*JOIN contacts").
		WillReturnRows(sqlmock.NewRows([]string{"?column?"}).AddRow(1))

	res, err := CheckEligibility(context.Background(), db, 502, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.Eligible {
		t.Error("expected blocked by per-domain cooldown")
	}
	if res.Reason != "per_domain_cooldown" {
		t.Errorf("reason should be per_domain_cooldown, got %q", res.Reason)
	}
}

func TestCheckEligibility_EmptyDomainSkipsDomainCheck(t *testing.T) {
	// Contact with NULL/empty email_domain: domain check skipped, others run.
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(503)).WillReturnRows(rowsContact(false, 0, ""))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	// No bounce cluster, no region check (both NULL)
	// Engagement decay: 0 sends
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(0, 0))
	// No per-domain query expected (email_domain is empty)

	res, err := CheckEligibility(context.Background(), db, 503, DefaultDedupGuardConfig())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !res.Eligible {
		t.Errorf("expected eligible, got reason %q", res.Reason)
	}
	// All 8 rules should still be evaluated (domain rule appears even if trivially skipped)
	if len(res.RulesEvaluated) != 8 {
		t.Errorf("expected 8 rules evaluated, got %d", len(res.RulesEvaluated))
	}
}

func TestCheckEligibility_DomainQueryError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(8)).WillReturnRows(rowsContact(false, 0, "firma.cz"))
	mock.ExpectQuery("FROM send_events.*WHERE contact_id").WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("LEFT JOIN tracking_events").
		WillReturnRows(sqlmock.NewRows([]string{"sent_count", "engaged_count"}).AddRow(0, 0))
	mock.ExpectQuery("FROM send_events se.*JOIN contacts").WillReturnError(errors.New("db down"))

	res, err := CheckEligibility(context.Background(), db, 8, DefaultDedupGuardConfig())
	if err == nil {
		t.Error("expected error propagated")
	}
	if res.Eligible {
		t.Error("must not be eligible on DB error")
	}
}

// ── Error and edge cases ──────────────────────────────────────────────

func TestCheckEligibility_ContactMissing(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(999)).WillReturnError(sql.ErrNoRows)

	res, err := CheckEligibility(context.Background(), db, 999, DefaultDedupGuardConfig())
	if !errors.Is(err, ErrContactMissing) {
		t.Errorf("expected ErrContactMissing, got %v", err)
	}
	if res.Eligible {
		t.Error("missing contact must not be eligible")
	}
}

func TestCheckEligibility_ContactQueryFailsOtherError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(5)).WillReturnError(errors.New("connection lost"))

	_, err := CheckEligibility(context.Background(), db, 5, DefaultDedupGuardConfig())
	if err == nil || errors.Is(err, ErrContactMissing) {
		t.Errorf("expected wrapped DB error, got %v", err)
	}
}

func TestCheckEligibility_ShortCircuitOnFirstFailure(t *testing.T) {
	// DNT trips → cross-campaign + domain queries must NOT run.
	// Post Sprint CRM-5: crm_active_client is evaluated FIRST (before DNT)
	// — for a non-CRM contact it passes, then DNT blocks. So 2 rules evaluated.
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(50)).WillReturnRows(rowsContact(true, 0, "firma.cz"))
	// No follow-up queries expected — sqlmock would error if we called them.

	res, _ := CheckEligibility(context.Background(), db, 50, DefaultDedupGuardConfig())
	if res.Reason != "dnt_set" {
		t.Errorf("expected dnt_set, got %q", res.Reason)
	}
	// crm_active_client (passed) → dnt (blocks). 2 rules evaluated.
	if len(res.RulesEvaluated) != 2 {
		t.Errorf("expected 2 rules (crm passed, dnt blocked), got %d", len(res.RulesEvaluated))
	}
}

func TestCheckEligibility_TightConfigBlocksAtLifetime1(t *testing.T) {
	// Custom config: lifetime max = 1 → contact with 1 touch blocked.
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT dnt").WithArgs(int64(60)).WillReturnRows(rowsContact(false, 1, "firma.cz"))

	cfg := DedupGuardConfig{
		CrossCampaignCooldown:   24 * time.Hour,
		PerDomainCooldown:       48 * time.Hour,
		LifetimeMaxTouches:      1,
		BounceClusterThreshold:  0.30,
		BounceClusterWindow:     30 * 24 * time.Hour,
		RegionMaxPerHour:        2,
		RegionWindow:            1 * time.Hour,
		EngagementDecayMinSends: 3,
		EngagementDecayWindow:   365 * 24 * time.Hour,
		EngagementDecayCooldown: 365 * 24 * time.Hour,
	}
	res, _ := CheckEligibility(context.Background(), db, 60, cfg)
	if res.Eligible {
		t.Error("expected blocked at tight config lifetime=1")
	}
}

func TestCheckEligibility_ContextCancellation(t *testing.T) {
	db, _, _ := sqlmock.New()
	defer db.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before query runs
	_, err := CheckEligibility(ctx, db, 70, DefaultDedupGuardConfig())
	if err == nil {
		t.Error("expected cancellation error")
	}
}
