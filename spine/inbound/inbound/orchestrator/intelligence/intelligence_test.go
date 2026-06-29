package intelligence

import (
	"strings"
	"testing"
	"time"
)

func TestConfig_Struct(t *testing.T) {
	cfg := Config{TargetIndustries: []string{"machinery", "construction"}}
	if len(cfg.TargetIndustries) != 2 { t.Error("industries") }
}

func TestConfig_CompanyFields(t *testing.T) {
	cfg := Config{
		TargetIndustries: []string{"machinery"},
		FirmyDB:          nil,
		CompanyStore:     nil,
	}
	if cfg.FirmyDB != nil {
		t.Error("FirmyDB should default to nil")
	}
	if cfg.CompanyStore != nil {
		t.Error("CompanyStore should default to nil")
	}
}

func TestLoopResult_CompanySynced(t *testing.T) {
	r := LoopResult{CompanySynced: 42, CompanyMetrics: 10}
	if r.CompanySynced != 42 {
		t.Errorf("CompanySynced = %d, want 42", r.CompanySynced)
	}
	if r.CompanyMetrics != 10 {
		t.Errorf("CompanyMetrics = %d, want 10", r.CompanyMetrics)
	}
}

func TestLoopResult_Struct(t *testing.T) {
	r := LoopResult{
		StartedAt: time.Now(), Duration: 5 * time.Second,
		PausesResumed: 3, ScoresRecalculated: 100, ScoresUpdated: 10,
		Promoted: 5, Demoted: 2, Blocked: 1, Suppressed: 4,
		DomainsChecked: 50, DomainsFlagged: 3,
	}
	if r.Promoted != 5 { t.Error("promoted") }
	if r.Suppressed != 4 { t.Error("suppressed") }
}

func TestDomainReport_Struct(t *testing.T) {
	r := DomainReport{
		Domain: "firma.cz", Type: "corporate", TotalSent: 100,
		BounceRate: 0.05, Complaints: 0, DailyCap: 3,
		IsSuppressed: false, ActiveContacts: 5,
	}
	if r.BounceRate != 0.05 { t.Error("bounce rate") }
	if r.IsSuppressed { t.Error("should not be suppressed") }
}

func TestWeeklyReport_Struct(t *testing.T) {
	r := WeeklyReport{
		Period: "2026-03-28 — 2026-04-04",
		ContactStats: map[string]int{"total": 1000, "active": 500},
		ScoreDistrib: map[string]int{"auto": 300, "low": 400, "manual": 200, "block": 100},
		EngagementRate: 0.25,
		ReplyRate: 0.05,
		BounceRate: 0.03,
	}
	if r.EngagementRate != 0.25 { t.Error("engagement") }
	if r.ReplyRate != 0.05 { t.Error("reply") }
}

func TestFormatReport(t *testing.T) {
	r := &WeeklyReport{
		Period: "2026-03-28 — 2026-04-04",
		ContactStats: map[string]int{"total": 1000, "active": 500, "suppressed": 5},
		ScoreDistrib: map[string]int{"auto": 300, "low": 400, "manual": 200, "block": 100},
		SuppressStats: map[string]int{"hard_bounce": 3, "complaint": 2},
		TopDomains: []DomainReport{
			{Domain: "firma.cz", TotalSent: 50, BounceRate: 0.02},
			{Domain: "bad.cz", TotalSent: 10, BounceRate: 0.20, IsSuppressed: true},
		},
		EngagementRate: 0.25,
		ReplyRate: 0.05,
		BounceRate: 0.03,
	}

	output := FormatReport(r)

	checks := []string{
		"Weekly Intelligence Report",
		"2026-03-28",
		"Total:",
		"Active:",
		"Auto",
		"Open rate:",
		"Reply rate:",
		"Bounce rate:",
		"firma.cz",
		"hard_bounce",
		"! bad.cz",
	}

	for _, check := range checks {
		if !strings.Contains(output, check) {
			t.Errorf("report missing %q", check)
		}
	}
}

func TestFormatReport_Empty(t *testing.T) {
	r := &WeeklyReport{
		Period:       "test",
		ContactStats: map[string]int{},
		ScoreDistrib: map[string]int{},
	}
	output := FormatReport(r)
	if output == "" { t.Error("should produce output even with empty data") }
}

func TestMaxInt(t *testing.T) {
	if maxInt(3, 5) != 5 { t.Error("max(3,5)") }
	if maxInt(5, 3) != 5 { t.Error("max(5,3)") }
	if maxInt(3, 3) != 3 { t.Error("max(3,3)") }
}

func TestMinInt(t *testing.T) {
	if minInt(3, 5) != 3 { t.Error("min(3,5)") }
	if minInt(5, 3) != 3 { t.Error("min(5,3)") }
	if minInt(3, 3) != 3 { t.Error("min(3,3)") }
}

func TestFormatReport_WithIndustrySegments(t *testing.T) {
	r := &WeeklyReport{
		Period:       "2026-04-01 — 2026-04-07",
		ContactStats: map[string]int{"total": 100},
		ScoreDistrib: map[string]int{},
		IndustrySegments: []IndustrySegment{
			{Industry: "machinery", AutoCount: 45, AvgScore: 0.75},
			{Industry: "metal", AutoCount: 20, AvgScore: 0.62},
		},
	}
	output := FormatReport(r)
	if !strings.Contains(output, "AUTO-QUEUE BY INDUSTRY") {
		t.Errorf("missing industry segment header: %s", output)
	}
	if !strings.Contains(output, "machinery") {
		t.Errorf("missing machinery segment: %s", output)
	}
}

// ── DomainReport struct ──

func TestDomainReport_AllFields(t *testing.T) {
	r := DomainReport{
		Domain:         "example.cz",
		Type:           "corporate",
		TotalSent:      500,
		BounceRate:     0.10,
		Complaints:     2,
		DailyCap:       3,
		IsSuppressed:   true,
		ActiveContacts: 15,
	}
	if r.Domain != "example.cz" { t.Error("domain") }
	if r.TotalSent != 500 { t.Error("total_sent") }
	if r.BounceRate != 0.10 { t.Error("bounce_rate") }
	if r.Complaints != 2 { t.Error("complaints") }
	if !r.IsSuppressed { t.Error("suppressed") }
	if r.ActiveContacts != 15 { t.Error("active_contacts") }
}

func TestDomainReport_ZeroValues(t *testing.T) {
	r := DomainReport{}
	if r.TotalSent != 0 { t.Error("zero total_sent") }
	if r.BounceRate != 0 { t.Error("zero bounce_rate") }
	if r.IsSuppressed { t.Error("not suppressed by default") }
}

// ── IndustrySegment struct ──

func TestIndustrySegment_Struct(t *testing.T) {
	seg := IndustrySegment{Industry: "construction", AutoCount: 30, AvgScore: 0.68}
	if seg.Industry != "construction" { t.Error("industry") }
	if seg.AutoCount != 30 { t.Error("count") }
	if seg.AvgScore != 0.68 { t.Error("avg score") }
}

// ── WeeklyReport all fields ──

func TestWeeklyReport_AllFields(t *testing.T) {
	r := WeeklyReport{
		Period:         "2026-01-01 — 2026-01-07",
		ContactStats:   map[string]int{"total": 1000},
		ScoreDistrib:   map[string]int{"auto": 300},
		SuppressStats:  map[string]int{"hard_bounce": 10},
		TopDomains:     []DomainReport{{Domain: "a.cz"}},
		IndustrySegments: []IndustrySegment{{Industry: "IT"}},
		EngagementRate: 0.30,
		ReplyRate:      0.08,
		BounceRate:     0.02,
		NewLast7Days:   50,
	}
	if r.NewLast7Days != 50 { t.Error("NewLast7Days") }
	if r.EngagementRate != 0.30 { t.Error("engagement") }
	if len(r.TopDomains) != 1 { t.Error("top domains") }
	if len(r.IndustrySegments) != 1 { t.Error("industry segments") }
}

// ── Config struct ──

func TestConfig_WithAllFields(t *testing.T) {
	cfg := Config{
		TargetIndustries: []string{"machinery", "construction", "metal"},
		FirmyDB:          nil,
		CompanyStore:     nil,
		Health:           nil,
		Alert:            nil,
	}
	if len(cfg.TargetIndustries) != 3 { t.Errorf("got %d industries", len(cfg.TargetIndustries)) }
	if cfg.FirmyDB != nil { t.Error("nil FirmyDB") }
}

// ── maxInt/minInt edge cases ──

func TestMaxInt_NegativeValues(t *testing.T) {
	if maxInt(-5, -3) != -3 { t.Error("max(-5,-3) = -3") }
	if maxInt(-10, 0) != 0 { t.Error("max(-10,0) = 0") }
}

func TestMinInt_NegativeValues(t *testing.T) {
	if minInt(-5, -3) != -5 { t.Error("min(-5,-3) = -5") }
	if minInt(0, -10) != -10 { t.Error("min(0,-10) = -10") }
}

func TestMaxInt_LargeValues(t *testing.T) {
	if maxInt(1000000, 999999) != 1000000 { t.Error("large values") }
}

func TestMinInt_LargeValues(t *testing.T) {
	if minInt(1000000, 999999) != 999999 { t.Error("large values") }
}

// ── FormatReport formatting correctness ──

func TestFormatReport_NoSuppressStats(t *testing.T) {
	r := &WeeklyReport{
		Period:       "test",
		ContactStats: map[string]int{"total": 100},
		ScoreDistrib: map[string]int{},
		SuppressStats: map[string]int{}, // empty
	}
	output := FormatReport(r)
	if strings.Contains(output, "SUPPRESSIONS") {
		t.Error("should not show SUPPRESSIONS section when empty")
	}
}

func TestFormatReport_NoTopDomains(t *testing.T) {
	r := &WeeklyReport{
		Period:       "test",
		ContactStats: map[string]int{},
		ScoreDistrib: map[string]int{},
		TopDomains:   []DomainReport{}, // empty
	}
	output := FormatReport(r)
	if strings.Contains(output, "TOP DOMAINS") {
		t.Error("should not show TOP DOMAINS when none")
	}
}

func TestFormatReport_WithSuppressedDomain(t *testing.T) {
	r := &WeeklyReport{
		Period:       "test",
		ContactStats: map[string]int{},
		ScoreDistrib: map[string]int{},
		TopDomains: []DomainReport{
			{Domain: "good.cz", TotalSent: 100, BounceRate: 0.01, IsSuppressed: false},
			{Domain: "evil.cz", TotalSent: 50, BounceRate: 0.25, IsSuppressed: true},
		},
	}
	output := FormatReport(r)
	if !strings.Contains(output, "! evil.cz") {
		t.Error("suppressed domain should have ! prefix")
	}
	if !strings.Contains(output, "good.cz") {
		t.Error("good domain should appear")
	}
}

func TestFormatReport_ZeroEngagement(t *testing.T) {
	r := &WeeklyReport{
		Period:         "test",
		ContactStats:   map[string]int{},
		ScoreDistrib:   map[string]int{},
		EngagementRate: 0,
		ReplyRate:      0,
		BounceRate:     0,
	}
	output := FormatReport(r)
	if !strings.Contains(output, "0.0%") {
		t.Errorf("zero rates should show 0.0%%: %s", output)
	}
}

// ── LoopResult all fields ──

func TestLoopResult_AllFields(t *testing.T) {
	r := LoopResult{
		PausesResumed:          1,
		ScoresRecalculated:     100,
		ScoresUpdated:          10,
		Promoted:               5,
		Demoted:                2,
		Blocked:                1,
		Suppressed:             3,
		DomainsChecked:         50,
		DomainsFlagged:         2,
		CompanySynced:          20,
		CompanyMetrics:         15,
		CategoryPathBackfilled: 30,
		CategoryReclassified:   8,
		EmailsVerified:         200,
		EmailsInvalid:          10,
		NACEReclassified:       5,
		ARESSynced:             25,
		ContactsPromoted:       7,
	}
	if r.PausesResumed != 1 { t.Error("PausesResumed") }
	if r.EmailsVerified != 200 { t.Error("EmailsVerified") }
	if r.ARESSynced != 25 { t.Error("ARESSynced") }
	if r.ContactsPromoted != 7 { t.Error("ContactsPromoted") }
	if r.NACEReclassified != 5 { t.Error("NACEReclassified") }
}
