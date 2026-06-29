package enrich

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"
)

// ══════════════════════════════════════════
//  Domain Classifier
// ══════════════════════════════════════════

func TestClassifyDomain_Freemail(t *testing.T) {
	freemails := []string{
		// Czech
		"seznam.cz", "email.cz", "centrum.cz", "volny.cz",
		"tiscali.cz", "post.cz", "atlas.cz", "azet.cz",
		// Slovak
		"azet.sk", "centrum.sk", "zoznam.sk",
		// Global
		"gmail.com", "hotmail.com", "outlook.com", "outlook.cz",
		"protonmail.com", "yahoo.com", "icloud.com",
		"gmx.net", "mail.com",
	}
	for _, d := range freemails {
		if ClassifyDomain(d) != DomainFreemail { t.Errorf("%s should be freemail", d) }
	}
}

func TestClassifyDomain_Corporate(t *testing.T) {
	corps := []string{"firma.cz", "technotrade.cz", "alza.cz", "example.com"}
	for _, d := range corps {
		if ClassifyDomain(d) != DomainCorporate { t.Errorf("%s should be corporate", d) }
	}
}

func TestClassifyDomain_Gov(t *testing.T) {
	if ClassifyDomain("mzp.gov.cz") != DomainGov { t.Error("gov.cz should be gov") }
}

func TestClassifyDomain_Edu(t *testing.T) {
	edus := []string{"fit.cvut.cz", "fi.muni.cz", "fav.vutbr.cz"}
	for _, d := range edus {
		r := ClassifyDomain(d)
		if r != DomainEdu && r != DomainGov { t.Errorf("%s should be edu/gov, got %s", d, r) }
	}
}

func TestClassifyDomain_CaseInsensitive(t *testing.T) {
	if ClassifyDomain("GMAIL.COM") != DomainFreemail { t.Error("case insensitive") }
}

func TestClassifyDomain_Empty(t *testing.T) {
	if ClassifyDomain("") != DomainUnknown { t.Error("empty should be unknown") }
}

func TestIsFreemail(t *testing.T) {
	if !IsFreemail("seznam.cz") { t.Error("seznam is freemail") }
	if IsFreemail("firma.cz") { t.Error("firma is not freemail") }
}

func TestDomainFromEmail(t *testing.T) {
	tests := []struct{ in, want string }{
		{"jan@firma.cz", "firma.cz"}, {"A@B.CZ", "b.cz"}, {"nope", ""}, {"", ""},
	}
	for _, tt := range tests {
		if got := DomainFromEmail(tt.in); got != tt.want {
			t.Errorf("DomainFromEmail(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// ══════════════════════════════════════════
//  Industry Classifier
// ══════════════════════════════════════════

func TestClassifyIndustry_Machinery(t *testing.T) {
	desc := "Zabýváme se strojírenskou výrobou, CNC obráběním a výrobou fréz."
	tags := ClassifyIndustry(desc)
	if len(tags) == 0 { t.Fatal("expected tags for machinery description") }
	if tags[0].Tag != "machinery" { t.Errorf("top tag: %s, want machinery", tags[0].Tag) }
	if tags[0].Confidence < 0.1 { t.Errorf("confidence too low: %f", tags[0].Confidence) }
}

func TestClassifyIndustry_Construction(t *testing.T) {
	desc := "Stavební firma, provádíme zateplení fasád, betonáž a izolace."
	tags := ClassifyIndustry(desc)
	if len(tags) == 0 { t.Fatal("expected construction tags") }
	found := false
	for _, tag := range tags {
		if tag.Tag == "construction" { found = true }
	}
	if !found { t.Error("should contain construction tag") }
}

func TestClassifyIndustry_Multiple(t *testing.T) {
	desc := "Výroba strojů pro zemědělství, prodej traktorů a kombajnů. Strojírenská výroba."
	tags := ClassifyIndustry(desc)
	if len(tags) < 2 { t.Fatalf("expected ≥2 tags, got %d", len(tags)) }
}

func TestClassifyIndustry_Empty(t *testing.T) {
	tags := ClassifyIndustry("")
	if tags != nil { t.Error("empty desc should return nil") }
}

func TestClassifyIndustry_NoMatch(t *testing.T) {
	tags := ClassifyIndustry("Nabízíme právní poradenství a účetní služby.")
	if len(tags) != 0 { t.Errorf("expected 0 tags for legal/accounting, got %d", len(tags)) }
}

func TestClassifyIndustry_FoodProcessing(t *testing.T) {
	desc := "Výroba potravin, pekárna a mlékárenské produkty."
	tags := ClassifyIndustry(desc)
	if len(tags) == 0 { t.Fatal("expected food_processing tags") }
	found := false
	for _, tag := range tags {
		if tag.Tag == "food_processing" { found = true }
	}
	if !found { t.Error("should contain food_processing tag") }
}

func TestClassifyIndustry_Plastics(t *testing.T) {
	desc := "Vstřikování plastů, výroba termoplastových dílů a laminátů."
	tags := ClassifyIndustry(desc)
	if len(tags) == 0 { t.Fatal("expected plastics tags") }
	found := false
	for _, tag := range tags {
		if tag.Tag == "plastics" { found = true }
	}
	if !found { t.Error("should contain plastics tag") }
}

func TestClassifyIndustry_Max3(t *testing.T) {
	desc := "Strojírenská výroba, stavební stroje, zemědělská technika, kovoobrábění, dřevovýroba, autodíly, solární panely."
	tags := ClassifyIndustry(desc)
	if len(tags) > 3 { t.Errorf("max 3 tags, got %d", len(tags)) }
}

func TestClassifyIndustry_Sorted(t *testing.T) {
	desc := "Výroba strojů a CNC obrábění, soustruhů a fréz. Také stavební práce."
	tags := ClassifyIndustry(desc)
	if len(tags) >= 2 {
		if tags[0].Confidence < tags[1].Confidence {
			t.Error("should be sorted by confidence desc")
		}
	}
}

func TestTagStrings(t *testing.T) {
	tags := []IndustryTag{{Tag: "a", Confidence: 0.8}, {Tag: "b", Confidence: 0.5}}
	s := TagStrings(tags)
	if len(s) != 2 || s[0] != "a" || s[1] != "b" { t.Errorf("TagStrings: %v", s) }
}

func TestMaxConfidence(t *testing.T) {
	tags := []IndustryTag{{Confidence: 0.3}, {Confidence: 0.9}, {Confidence: 0.5}}
	if MaxConfidence(tags) != 0.9 { t.Error("wrong max") }
	if MaxConfidence(nil) != 0.0 { t.Error("nil should be 0") }
}

// ══════════════════════════════════════════
//  Targeting Score
// ══════════════════════════════════════════

func TestTargetingScore_Default(t *testing.T) {
	score, factors := CalculateTargeting(TargetingInput{})
	if score != 0.5 { t.Errorf("default score: %f, want 0.5", score) }
	if factors.BaseScore != 0.5 { t.Error("base should be 0.5") }
}

func TestTargetingScore_IndustryFit(t *testing.T) {
	score, _ := CalculateTargeting(TargetingInput{
		IndustryTags:     []IndustryTag{{Tag: "machinery", Confidence: 0.8}},
		TargetIndustries: []string{"machinery"},
	})
	if score <= 0.5 { t.Errorf("industry fit should boost score: %f", score) }
}

func TestTargetingScore_IndustryNoFit(t *testing.T) {
	score, _ := CalculateTargeting(TargetingInput{
		IndustryTags:     []IndustryTag{{Tag: "automotive", Confidence: 0.8}},
		TargetIndustries: []string{"machinery"},
	})
	if score != 0.5 { t.Errorf("no fit should be neutral: %f", score) }
}

func TestTargetingScore_CorporateBonus(t *testing.T) {
	corp, _ := CalculateTargeting(TargetingInput{DomainType: DomainCorporate})
	free, _ := CalculateTargeting(TargetingInput{DomainType: DomainFreemail})
	if corp <= free { t.Errorf("corporate (%f) should score higher than freemail (%f)", corp, free) }
}

func TestTargetingScore_GovPenalty(t *testing.T) {
	score, _ := CalculateTargeting(TargetingInput{DomainType: DomainGov})
	if score >= 0.5 { t.Errorf("gov should penalize: %f", score) }
}

func TestTargetingScore_BounceHistory(t *testing.T) {
	score, _ := CalculateTargeting(TargetingInput{TotalSent: 1, TotalBounced: 1})
	if score >= 0.3 { t.Errorf("bounced should heavily penalize: %f", score) }
}

func TestTargetingScore_RepliedBonus(t *testing.T) {
	score, _ := CalculateTargeting(TargetingInput{TotalSent: 3, TotalReplied: 1})
	if score < 0.8 { t.Errorf("replied should boost heavily: %f", score) }
}

func TestTargetingScore_RecentContact(t *testing.T) {
	recent := time.Now().Add(-7 * 24 * time.Hour)
	score, f := CalculateTargeting(TargetingInput{LastContacted: &recent})
	if f.RecencyDecay >= 0 { t.Errorf("recent contact should decay: %f", f.RecencyDecay) }
	_ = score
}

func TestTargetingScore_HoneypotPenalty(t *testing.T) {
	score, _ := CalculateTargeting(TargetingInput{HoneypotSignals: 3})
	if score >= 0.5 { t.Errorf("honeypot signals should penalize: %f", score) }
}

func TestTargetingScore_SuppressedDomain(t *testing.T) {
	score, _ := CalculateTargeting(TargetingInput{DomainSuppressed: true})
	if score >= 0.3 { t.Errorf("suppressed domain: %f", score) }
}

func TestTargetingScore_GhostRatio(t *testing.T) {
	// 5 sent, 0 opened = ghost ratio 1.0 > 0.8 threshold
	score, f := CalculateTargeting(TargetingInput{TotalSent: 5, TotalOpened: 0})
	if f.Engagement >= 0 { t.Errorf("ghost should penalize engagement: %f", f.Engagement) }
	_ = score
}

func TestTargetingScore_GhostRatioNeedsMinSent(t *testing.T) {
	// 2 sent = below threshold, no ghost penalty
	_, f := CalculateTargeting(TargetingInput{TotalSent: 2, TotalOpened: 0})
	if f.Engagement != 0 { t.Errorf("< 3 sent should not trigger ghost: %f", f.Engagement) }
}

func TestTargetingScore_GhostRatioDataInconsistency(t *testing.T) {
	// Edge: TotalOpened > TotalSent (data bug) — should not panic or produce NaN
	score, _ := CalculateTargeting(TargetingInput{TotalSent: 3, TotalOpened: 10})
	if score < 0 || score > 1 { t.Errorf("inconsistent data should still clamp: %f", score) }
}

func TestTargetingScore_RoleBasedPenalty(t *testing.T) {
	normal, _ := CalculateTargeting(TargetingInput{DomainType: DomainCorporate})
	roleBased, _ := CalculateTargeting(TargetingInput{DomainType: DomainCorporate, IsRoleBased: true})
	if roleBased >= normal { t.Errorf("role-based (%f) should score lower than normal (%f)", roleBased, normal) }
}

func TestTargetingScore_CompoundNegative(t *testing.T) {
	// Everything bad: freemail + gov suppressed + bounced + honeypot
	score, _ := CalculateTargeting(TargetingInput{
		DomainType: DomainGov, DomainSuppressed: true,
		TotalSent: 5, TotalBounced: 5, HoneypotSignals: 5,
		IsRoleBased: true,
	})
	if score != 0.0 { t.Errorf("compound negative should clamp to 0: %f", score) }
}

func TestTargetingScore_DomainBounceRate(t *testing.T) {
	clean, _ := CalculateTargeting(TargetingInput{DomainBounceRate: 0.01})
	medium, _ := CalculateTargeting(TargetingInput{DomainBounceRate: 0.07})
	high, _ := CalculateTargeting(TargetingInput{DomainBounceRate: 0.15})
	if medium >= clean { t.Errorf("medium bounce (%f) should be < clean (%f)", medium, clean) }
	if high >= medium { t.Errorf("high bounce (%f) should be < medium (%f)", high, medium) }
}

func TestTargetingScore_ComplaintRate(t *testing.T) {
	clean, _ := CalculateTargeting(TargetingInput{DomainComplaintRate: 0.0})
	complained, _ := CalculateTargeting(TargetingInput{DomainComplaintRate: 0.005})
	if complained >= clean { t.Errorf("complaint (%f) should be < clean (%f)", complained, clean) }
}

func TestTargetingScore_Clamped(t *testing.T) {
	// Max everything positive
	score, _ := CalculateTargeting(TargetingInput{
		IndustryTags: []IndustryTag{{Tag: "x", Confidence: 1.0}},
		TargetIndustries: []string{"x"},
		DomainType: DomainCorporate,
		CompanySize: "25 - 49 zaměstnanců",
		TotalSent: 5, TotalReplied: 3,
	})
	if score > 1.0 { t.Errorf("score should be clamped to 1.0: %f", score) }

	// Max everything negative
	score2, _ := CalculateTargeting(TargetingInput{
		DomainType: DomainGov, DomainSuppressed: true,
		TotalSent: 5, TotalBounced: 5, HoneypotSignals: 5,
	})
	if score2 < 0.0 { t.Errorf("score should be clamped to 0.0: %f", score2) }
}

func TestTargetingDecision(t *testing.T) {
	tests := []struct{ score float64; want string }{
		{0.9, "auto"}, {0.7, "auto"}, {0.5, "low"}, {0.4, "low"},
		{0.3, "manual"}, {0.2, "manual"}, {0.1, "block"}, {0.0, "block"},
	}
	for _, tt := range tests {
		if got := TargetingDecision(tt.score); got != tt.want {
			t.Errorf("TargetingDecision(%f) = %q, want %q", tt.score, got, tt.want)
		}
	}
}

func TestScoreTier(t *testing.T) {
	tests := []struct {
		score float64
		want  string
	}{
		{1.0, "auto"}, {0.9, "auto"}, {0.7, "auto"},
		{0.69, "low"}, {0.5, "low"}, {0.4, "low"},
		{0.39, "manual"}, {0.3, "manual"}, {0.2, "manual"},
		{0.19, "block"}, {0.1, "block"}, {0.0, "block"},
	}
	for _, tt := range tests {
		if got := scoreTier(tt.score); got != tt.want {
			t.Errorf("scoreTier(%f) = %q, want %q", tt.score, got, tt.want)
		}
	}
}

func TestCompanySizeBonus(t *testing.T) {
	if companySizeBonus("25 - 49 zaměstnanců") != 0.2 { t.Error("sweet spot") }
	if companySizeBonus("Bez zaměstnanců") >= 0 { t.Error("no employees should penalize") }
	if companySizeBonus("1000 - 1499 zaměstnanců") >= 0 { t.Error("too big should penalize") }
	if companySizeBonus("unknown") != 0 { t.Error("unknown should be neutral") }
}

// ══════════════════════════════════════════
//  Honeypot Detection
// ══════════════════════════════════════════

func TestDetectHoneypot_TypoDomain(t *testing.T) {
	signals := DetectHoneypot("user@gmial.com")
	found := false
	for _, s := range signals {
		if s.Type == "typo_domain" { found = true; break }
	}
	if !found { t.Error("should detect typo domain gmial.com") }
}

func TestDetectHoneypot_RoleBased(t *testing.T) {
	roles := []string{"abuse@firma.cz", "postmaster@firma.cz", "noreply@firma.cz",
		"admin@firma.cz", "support@firma.cz"}
	for _, email := range roles {
		signals := DetectHoneypot(email)
		found := false
		for _, s := range signals {
			if s.Type == "role_based" { found = true }
		}
		if !found { t.Errorf("should detect role-based: %s", email) }
	}
}

func TestDetectHoneypot_Suspicious(t *testing.T) {
	suspicious := []string{"test@firma.cz", "asdf@firma.cz", "xxx@firma.cz"}
	for _, email := range suspicious {
		signals := DetectHoneypot(email)
		found := false
		for _, s := range signals {
			if s.Type == "suspicious_pattern" { found = true }
		}
		if !found { t.Errorf("should detect suspicious: %s", email) }
	}
}

func TestDetectHoneypot_AllNumeric(t *testing.T) {
	signals := DetectHoneypot("123456@firma.cz")
	found := false
	for _, s := range signals {
		if s.Type == "suspicious_pattern" { found = true }
	}
	if !found { t.Error("should detect all-numeric local part") }
}

func TestDetectHoneypot_ConsecutiveDots(t *testing.T) {
	signals := DetectHoneypot("jan..novak@firma.cz")
	found := false
	for _, s := range signals {
		if s.Details == "consecutive dots in local part" { found = true }
	}
	if !found { t.Error("should detect consecutive dots") }
}

func TestDetectHoneypot_SingleChar(t *testing.T) {
	signals := DetectHoneypot("x@firma.cz")
	found := false
	for _, s := range signals {
		if s.Details == "single character local part" { found = true }
	}
	if !found { t.Error("should detect single char local part") }
}

func TestDetectHoneypot_NewCzechTypos(t *testing.T) {
	typos := []struct{ in, corrected string }{
		{"user@szenam.cz", "seznam.cz"},
		{"user@volni.cz", "volny.cz"},
		{"user@cetrum.cz", "centrum.cz"},
		{"user@gmai.com", "gmail.com"},
	}
	for _, tt := range typos {
		signals := DetectHoneypot(tt.in)
		found := false
		for _, s := range signals {
			if s.Type == "typo_domain" && strings.Contains(s.Details, tt.corrected) { found = true }
		}
		if !found { t.Errorf("should detect typo in %s → %s", tt.in, tt.corrected) }
	}
}

func TestDetectHoneypot_Clean(t *testing.T) {
	signals := DetectHoneypot("jan.novak@firma.cz")
	if len(signals) != 0 { t.Errorf("clean email should have 0 signals, got %d", len(signals)) }
}

func TestDetectHoneypot_InvalidEmail(t *testing.T) {
	signals := DetectHoneypot("notanemail")
	if len(signals) != 0 { t.Error("invalid email should return empty") }
}

func TestIsRoleBasedEmail(t *testing.T) {
	if !IsRoleBasedEmail("abuse@firma.cz") { t.Error("abuse is role-based") }
	if !IsRoleBasedEmail("NOREPLY@firma.cz") { t.Error("case insensitive") }
	if IsRoleBasedEmail("jan@firma.cz") { t.Error("jan is not role-based") }
}

func TestFixTypoDomain(t *testing.T) {
	tests := []struct{ in, want string }{
		{"user@gmial.com", "user@gmail.com"},
		{"user@sezanm.cz", "user@seznam.cz"},
		{"user@firma.cz", "user@firma.cz"},       // no change
		{"user@hotmal.com", "user@hotmail.com"},
		// no @ sign — returns original unchanged
		{"notanemail", "notanemail"},
		{"", ""},
	}
	for _, tt := range tests {
		if got := FixTypoDomain(tt.in); got != tt.want {
			t.Errorf("FixTypoDomain(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestMaxSeverity(t *testing.T) {
	signals := []HoneypotSignal{
		{Severity: "low"}, {Severity: "high"}, {Severity: "medium"},
	}
	if MaxSeverity(signals) != "high" { t.Error("should return high") }
	if MaxSeverity(nil) != "" { t.Error("nil should return empty") }
}

func TestIsAllNumeric(t *testing.T) {
	if !isAllNumeric("12345") { t.Error("should be numeric") }
	if isAllNumeric("12a45") { t.Error("not all numeric") }
	if isAllNumeric("") { t.Error("empty is not numeric") }
}

// ══════════════════════════════════════════
//  Recalc helpers (recalc.go)
// ══════════════════════════════════════════

func TestSplitComma(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []string
	}{
		{"single", "hello", []string{"hello"}},
		{"two", "a,b", []string{"a", "b"}},
		{"three", "machinery,construction,plastics", []string{"machinery", "construction", "plastics"}},
		{"empty_between", "a,,b", []string{"a", "", "b"}},
		{"trailing", "a,b,", []string{"a", "b", ""}},
		{"leading", ",a,b", []string{"", "a", "b"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := splitComma(tt.in)
			if len(got) != len(tt.want) {
				t.Fatalf("splitComma(%q) = %d parts, want %d: %v", tt.in, len(got), len(tt.want), got)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("splitComma(%q)[%d] = %q, want %q", tt.in, i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestNullString(t *testing.T) {
	tests := []struct {
		name  string
		input sql.NullString
		want  string
	}{
		{"valid", sql.NullString{String: "hello", Valid: true}, "hello"},
		{"null", sql.NullString{Valid: false}, ""},
		{"valid_empty", sql.NullString{String: "", Valid: true}, ""},
		{"null_with_value", sql.NullString{String: "ghost", Valid: false}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := nullString(tt.input); got != tt.want {
				t.Errorf("nullString() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestNullFloat(t *testing.T) {
	tests := []struct {
		name  string
		input sql.NullFloat64
		want  float64
	}{
		{"valid", sql.NullFloat64{Float64: 3.14, Valid: true}, 3.14},
		{"null", sql.NullFloat64{Valid: false}, 0},
		{"valid_zero", sql.NullFloat64{Float64: 0, Valid: true}, 0},
		{"null_with_value", sql.NullFloat64{Float64: 9.99, Valid: false}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := nullFloat(tt.input); got != tt.want {
				t.Errorf("nullFloat() = %f, want %f", got, tt.want)
			}
		})
	}
}

func TestNullBool(t *testing.T) {
	tests := []struct {
		name  string
		input sql.NullBool
		want  bool
	}{
		{"valid_true", sql.NullBool{Bool: true, Valid: true}, true},
		{"valid_false", sql.NullBool{Bool: false, Valid: true}, false},
		{"null", sql.NullBool{Valid: false}, false},
		{"null_with_true", sql.NullBool{Bool: true, Valid: false}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := nullBool(tt.input); got != tt.want {
				t.Errorf("nullBool() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestParseIndustryTagsFromDB(t *testing.T) {
	tests := []struct {
		name     string
		input    sql.NullString
		wantLen  int
		wantTags []string
	}{
		{"null", sql.NullString{Valid: false}, 0, nil},
		{"empty_string", sql.NullString{String: "", Valid: true}, 0, nil},
		{"empty_array", sql.NullString{String: "{}", Valid: true}, 0, nil},
		{"single_tag", sql.NullString{String: "{machinery}", Valid: true}, 1, []string{"machinery"}},
		{"two_tags", sql.NullString{String: "{machinery,construction}", Valid: true}, 2, []string{"machinery", "construction"}},
		{"three_tags", sql.NullString{String: "{plastics,food_processing,automotive}", Valid: true}, 3, []string{"plastics", "food_processing", "automotive"}},
		// malformed: 2-char string stripped to "" hits the inner empty guard
		{"malformed_two_chars", sql.NullString{String: "{a", Valid: true}, 0, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseIndustryTagsFromDB(tt.input, 0.5)
			if len(got) != tt.wantLen {
				t.Fatalf("parseIndustryTagsFromDB() = %d tags, want %d: %v", len(got), tt.wantLen, got)
			}
			for i, tag := range got {
				if tag.Tag != tt.wantTags[i] {
					t.Errorf("tag[%d] = %q, want %q", i, tag.Tag, tt.wantTags[i])
				}
				if tag.Confidence != 0.5 {
					t.Errorf("tag[%d] confidence = %f, want 0.5", i, tag.Confidence)
				}
			}
		})
	}
}

// ══════════════════════════════════════════
//  MX Domain Verification
// ══════════════════════════════════════════

func TestVerifyDomainMX_KnownProviderMap(t *testing.T) {
	// Verify the provider map is consistent (fragment → provider).
	for fragment, provider := range knownMXProviders {
		if got := knownMXProviders[fragment]; got != provider {
			t.Errorf("knownMXProviders[%q] = %q, want %q", fragment, got, provider)
		}
	}
	// Spot-check a few well-known entries.
	expected := map[string]string{
		"google":     "Google",
		"outlook":    "Microsoft",
		"seznam":     "Seznam",
		"amazonses":  "AWS SES",
		"protonmail": "ProtonMail",
	}
	for fragment, want := range expected {
		if got := knownMXProviders[fragment]; got != want {
			t.Errorf("knownMXProviders[%q] = %q, want %q", fragment, got, want)
		}
	}
}

func TestVerifyDomainMX_EmptyDomain(t *testing.T) {
	result := VerifyDomainMX("")
	if result.Verified {
		t.Error("empty domain should not be verified")
	}
	if result.Provider != "" {
		t.Errorf("empty domain provider should be empty, got %q", result.Provider)
	}
}

func TestVerifyDomainMX_InvalidDomain(t *testing.T) {
	result := VerifyDomainMX("not-a-real-domain-xyzxyz.invalid")
	if result.Verified {
		t.Error("invalid domain should not be verified")
	}
	if result.Provider != "" {
		t.Errorf("invalid domain provider should be empty, got %q", result.Provider)
	}
}

// ══════════════════════════════════════════
//  buildPGArray
// ══════════════════════════════════════════

func TestBuildPGArray_Empty(t *testing.T) {
	got := buildPGArray(nil)
	want := "ARRAY[]::text[]"
	if got != want {
		t.Errorf("buildPGArray(nil) = %q, want %q", got, want)
	}
	got2 := buildPGArray([]string{})
	if got2 != want {
		t.Errorf("buildPGArray([]) = %q, want %q", got2, want)
	}
}

func TestBuildPGArray_Single(t *testing.T) {
	got := buildPGArray([]string{"machinery"})
	want := "ARRAY['machinery']"
	if got != want {
		t.Errorf("buildPGArray([machinery]) = %q, want %q", got, want)
	}
}

func TestBuildPGArray_Multiple(t *testing.T) {
	got := buildPGArray([]string{"machinery", "metalwork", "automotive"})
	want := "ARRAY['machinery','metalwork','automotive']"
	if got != want {
		t.Errorf("buildPGArray(multiple) = %q, want %q", got, want)
	}
}

func TestBuildPGArray_ApostropheEscaping(t *testing.T) {
	// SQL injection prevention: apostrophes must be doubled
	got := buildPGArray([]string{"o'neil", "it's", "don't"})
	want := "ARRAY['o''neil','it''s','don''t']"
	if got != want {
		t.Errorf("buildPGArray(apostrophe) = %q, want %q", got, want)
	}
}

func TestBuildPGArray_WhitespacePreserved(t *testing.T) {
	got := buildPGArray([]string{"heavy machinery", "metal work"})
	want := "ARRAY['heavy machinery','metal work']"
	if got != want {
		t.Errorf("buildPGArray(whitespace) = %q, want %q", got, want)
	}
}

func TestBuildPGArray_MultipleApostrophes(t *testing.T) {
	got := buildPGArray([]string{"it's o'clock"})
	want := "ARRAY['it''s o''clock']"
	if got != want {
		t.Errorf("buildPGArray(multiple apostrophes) = %q, want %q", got, want)
	}
}

func TestBuildPGArray_EmptyStringElement(t *testing.T) {
	got := buildPGArray([]string{""})
	want := "ARRAY['']"
	if got != want {
		t.Errorf("buildPGArray(['']) = %q, want %q", got, want)
	}
}

// ══════════════════════════════════════════
//  companySizeBonus — full branch coverage
// ══════════════════════════════════════════

func TestCompanySizeBonus_AllBranches(t *testing.T) {
	cases := []struct {
		size string
		want float64
	}{
		// sweet spot 0.2
		{"10 - 19 zaměstnanců", 0.2},
		{"20 - 24 zaměstnanci", 0.2},
		{"25 - 49 zaměstnanců", 0.2},
		// mid 0.15
		{"50 - 99 zaměstnanců", 0.15},
		{"100 - 199 zaměstnanců", 0.15},
		// small 0.1
		{"6 - 9 zaměstnanců", 0.1},
		// micro 0.05
		{"1 - 5 zaměstnanců", 0.05},
		// large 0.05
		{"200 - 249 zaměstnanců", 0.05},
		{"250 - 499 zaměstnanců", 0.05},
		// too big -0.05
		{"500 - 999 zaměstnanců", -0.05},
		{"1000 - 1499 zaměstnanců", -0.05},
		// no staff -0.1
		{"Bez zaměstnanců", -0.1},
		// unknown 0.0
		{"", 0.0},
		{"unknown", 0.0},
		{"2000+", 0.0},
	}
	for _, tc := range cases {
		got := companySizeBonus(tc.size)
		if got != tc.want {
			t.Errorf("companySizeBonus(%q) = %v, want %v", tc.size, got, tc.want)
		}
	}
}

// ══════════════════════════════════════════
//  IsRoleBasedEmail — missing branch
// ══════════════════════════════════════════

func TestIsRoleBasedEmail_NoAtSign(t *testing.T) {
	if IsRoleBasedEmail("abuse") {
		t.Error("email with no @ should return false")
	}
	if IsRoleBasedEmail("") {
		t.Error("empty string should return false")
	}
}

// ══════════════════════════════════════════
//  Consent — uncovered branches
// ══════════════════════════════════════════

func TestTargetingScore_RecencyDecay_MediumRange(t *testing.T) {
	// 45 days ago → daysSince in [30, 90) → RecencyDecay = -0.1
	contacted := time.Now().Add(-45 * 24 * time.Hour)
	_, f := CalculateTargeting(TargetingInput{LastContacted: &contacted})
	if f.RecencyDecay != -0.1 {
		t.Errorf("45-day recency: want -0.1, got %f", f.RecencyDecay)
	}
}

func TestTargetingScore_HoneypotPenalty_Clamp(t *testing.T) {
	// 6 honeypot signals → penalty = -0.6 → clamped to -0.5
	_, f := CalculateTargeting(TargetingInput{HoneypotSignals: 6})
	if f.HoneypotPenalty != -0.5 {
		t.Errorf("honeypot clamp: want -0.5, got %f", f.HoneypotPenalty)
	}
}

func TestDetectHoneypot_LongLocalPart(t *testing.T) {
	// local part >64 chars → RFC violation → suspicious_pattern high
	local := strings.Repeat("a", 65)
	email := local + "@example.com"
	signals := DetectHoneypot(email)
	found := false
	for _, s := range signals {
		if s.Details == "local part exceeds 64 chars" {
			found = true
		}
	}
	if !found {
		t.Errorf("should detect long local part (65 chars): %s", email)
	}
}

func TestEnrichWithContext_NoEmail(t *testing.T) {
	p := NewPipeline(PipelineConfig{})
	ec, reason := p.EnrichWithContext(context.Background(), RawContact{})
	if reason != "no_email" || ec != nil {
		t.Errorf("no_email branch: got reason=%q, ec=%v", reason, ec)
	}
}

func TestEnrichWithContext_ExclusionHardBlock(t *testing.T) {
	p := NewPipeline(PipelineConfig{})
	// .gov.cz domain suffix → hard block
	ec, reason := p.EnrichWithContext(context.Background(), RawContact{
		Email: "info@uradprace.gov.cz",
		Name:  "Úřad práce ČR",
	})
	if reason != "exclusion_hard_block" || ec != nil {
		t.Errorf("exclusion_hard_block branch: got reason=%q, ec=%v", reason, ec)
	}
}

func TestEnrichWithContext_BelowThreshold(t *testing.T) {
	// Very high min targeting score → below_threshold
	p := NewPipeline(PipelineConfig{MinTargetingScore: 0.99})
	ec, reason := p.EnrichWithContext(context.Background(), RawContact{
		Email: "jan.novak@strojirna.cz",
		Name:  "Jan Novák - strojírenství",
	})
	if reason != "below_threshold" || ec != nil {
		t.Errorf("below_threshold branch: got reason=%q, ec=%v", reason, ec)
	}
}

// ══════════════════════════════════════════
//  min64
// ══════════════════════════════════════════

// TestCalculateTargeting_OpenedExceedsSent covers the defensive guard on line 114
// where opened > totalSent (data inconsistency) → clamp opened to totalSent.
func TestCalculateTargeting_OpenedExceedsSent(t *testing.T) {
	// TotalOpened > TotalSent triggers the guard; TotalReplied=0 and TotalBounced=0
	// so we enter the ghost-ratio branch (TotalSent >= 3, no bounced/replied/opened signal)
	_, factors := CalculateTargeting(TargetingInput{
		TotalSent:   3,
		TotalOpened: 10, // > TotalSent — data inconsistency guard fires
		TotalReplied: 0,
		TotalBounced: 0,
	})
	// After clamping, opened == sent, so ghostRatio == 0.0 → no negative engagement
	if factors.Engagement < -0.1 {
		t.Errorf("clamped opened should not produce strong ghost penalty, got %f", factors.Engagement)
	}
}

func TestMin64(t *testing.T) {
	if min64(1.0, 2.0) != 1.0 {
		t.Error("min64(1, 2) should be 1")
	}
	if min64(2.0, 1.0) != 1.0 {
		t.Error("min64(2, 1) should be 1")
	}
	if min64(3.0, 3.0) != 3.0 {
		t.Error("min64(3, 3) should be 3")
	}
	if min64(-1.0, 0.0) != -1.0 {
		t.Error("min64(-1, 0) should be -1")
	}
}
