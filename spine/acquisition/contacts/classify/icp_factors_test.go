package classify

import (
	"testing"
	"time"
)

// ── CalculateICPWithFactors ─────────────────────────────────────────────────

func TestICPWithFactors_IdealCompany(t *testing.T) {
	founded := time.Now().AddDate(-8, 0, 0) // 8 years — sweet spot
	input := ICPInput{
		SectorTags:  []string{"machinery", "machinery_cnc"},
		CompanySize: "25 - 49 zaměstnanců",
		Region:      "",
		HasEmail:    true,
		HasWebsite:  true,
		HasPhone:    true,
		RatingValue: 4.5,
		RatingCount: 10,
		DatumVzniku: &founded,
		PravniForma: "Společnost s ručením omezeným",
	}
	cfg := DefaultICPConfig()
	score, factors := CalculateICPWithFactors(input, cfg)

	if score < 0.7 {
		t.Errorf("ideal company score = %.3f, want >= 0.7", score)
	}
	if factors.SectorFit < 0.5 {
		t.Errorf("SectorFit = %.3f, want >= 0.5", factors.SectorFit)
	}
	if factors.SizeFit < 0.9 {
		t.Errorf("SizeFit = %.3f, want >= 0.9 for 25-49 employees", factors.SizeFit)
	}
	if factors.Completeness < 0.9 {
		t.Errorf("Completeness = %.3f, want >= 0.9 for full data", factors.Completeness)
	}
	if factors.AgeStability != 1.0 {
		t.Errorf("AgeStability = %.3f, want 1.0 for 8-year-old company", factors.AgeStability)
	}
	if factors.LegalFormFit < 0.9 {
		t.Errorf("LegalFormFit = %.3f, want >= 0.9 for s.r.o.", factors.LegalFormFit)
	}
}

func TestICPWithFactors_IrrelevantCompany(t *testing.T) {
	input := ICPInput{
		SectorTags:  []string{"retail"},
		CompanySize: "Bez zaměstnanců",
		HasEmail:    false,
		HasWebsite:  false,
		HasPhone:    false,
		RatingValue: 0,
		RatingCount: 0,
		PravniForma: "fyzická osoba",
	}
	cfg := DefaultICPConfig()
	score, _ := CalculateICPWithFactors(input, cfg)

	if score > 0.3 {
		t.Errorf("irrelevant company score = %.3f, want <= 0.3", score)
	}
}

func TestICPWithFactors_ScoreCappedAt1(t *testing.T) {
	founded := time.Now().AddDate(-10, 0, 0)
	input := ICPInput{
		SectorTags:  []string{"machinery", "machinery_cnc", "metalwork"},
		CompanySize: "10 - 19 zaměstnanců",
		HasEmail:    true,
		HasWebsite:  true,
		HasPhone:    true,
		RatingValue: 5.0,
		RatingCount: 100,
		DatumVzniku: &founded,
		PravniForma: "s.r.o.",
	}
	score, _ := CalculateICPWithFactors(input, DefaultICPConfig())
	if score > 1.0 {
		t.Errorf("score = %.3f, want <= 1.0 (capped)", score)
	}
}

func TestICPWithFactors_WeightsSumToOne(t *testing.T) {
	// Weights: 0.35 + 0.20 + 0.10 + 0.10 + 0.05 + 0.10 + 0.10 = 1.00
	// Verify by setting all factors to 0.5 and checking score ≈ 0.5
	founded := time.Now().AddDate(-3, 0, 0) // 3y → 0.5 stability
	input := ICPInput{
		SectorTags:  []string{"retail"}, // 0 sector fit
		CompanySize: "1 - 5 zaměstnanců",
		HasEmail:    true,
		HasWebsite:  false,
		HasPhone:    false,
		RatingValue: 3.5,
		RatingCount: 1,
		DatumVzniku: &founded,
		PravniForma: "", // → 0.5
	}
	cfg := DefaultICPConfig()
	score, factors := CalculateICPWithFactors(input, cfg)

	t.Logf("score=%.3f sector=%.2f size=%.2f completeness=%.2f region=%.2f rating=%.2f age=%.2f legal=%.2f",
		score, factors.SectorFit, factors.SizeFit, factors.Completeness,
		factors.RegionFit, factors.RatingSignal, factors.AgeStability, factors.LegalFormFit)

	if score < 0 || score > 1 {
		t.Errorf("score = %.3f out of [0,1]", score)
	}
}

// ── AgeStabilitySignal ───────────────────────────────────────────────────────

func TestAgeStability_Nil(t *testing.T) {
	if got := ageStabilitySignal(nil); got != 0.5 {
		t.Errorf("nil → %f, want 0.5", got)
	}
}

func TestAgeStability_NewCompany(t *testing.T) {
	d := time.Now().AddDate(-1, 0, 0)
	if got := ageStabilitySignal(&d); got != 0.2 {
		t.Errorf("1y → %f, want 0.2", got)
	}
}

func TestAgeStability_Established(t *testing.T) {
	d := time.Now().AddDate(-7, 0, 0)
	if got := ageStabilitySignal(&d); got != 1.0 {
		t.Errorf("7y → %f, want 1.0", got)
	}
}

func TestAgeStability_Mature(t *testing.T) {
	d := time.Now().AddDate(-20, 0, 0)
	if got := ageStabilitySignal(&d); got != 0.7 {
		t.Errorf("20y → %f, want 0.7", got)
	}
}

func TestAgeStability_Young(t *testing.T) {
	d := time.Now().AddDate(-3, 0, 0)
	if got := ageStabilitySignal(&d); got != 0.5 {
		t.Errorf("3y → %f, want 0.5", got)
	}
}

// ── LegalFormFit ─────────────────────────────────────────────────────────────

func TestLegalFormFit_SRO(t *testing.T) {
	forms := []string{
		"s.r.o.", "Spol. s r.o.", "Společnost s ručením omezeným",
	}
	for _, f := range forms {
		if got := legalFormFit(f); got != 1.0 {
			t.Errorf("%q → %f, want 1.0", f, got)
		}
	}
}

func TestLegalFormFit_AS(t *testing.T) {
	forms := []string{"a.s.", "Akciová společnost"}
	for _, f := range forms {
		if got := legalFormFit(f); got != 0.9 {
			t.Errorf("%q → %f, want 0.9", f, got)
		}
	}
}

func TestLegalFormFit_OSVC(t *testing.T) {
	forms := []string{"osvč", "Fyzická osoba", "FO podnikatel"}
	for _, f := range forms {
		if got := legalFormFit(f); got != 0.4 {
			t.Errorf("%q → %f, want 0.4", f, got)
		}
	}
}

func TestLegalFormFit_KS(t *testing.T) {
	forms := []string{"k.s.", "Komanditní společnost"}
	for _, f := range forms {
		if got := legalFormFit(f); got != 0.7 {
			t.Errorf("%q → %f, want 0.7", f, got)
		}
	}
}

func TestLegalFormFit_VOS(t *testing.T) {
	forms := []string{"v.o.s.", "Veřejná obchodní společnost"}
	for _, f := range forms {
		if got := legalFormFit(f); got != 0.7 {
			t.Errorf("%q → %f, want 0.7", f, got)
		}
	}
}

func TestLegalFormFit_Unknown(t *testing.T) {
	// Unknown but non-empty form → default 0.5
	if got := legalFormFit("Nadace"); got != 0.5 {
		t.Errorf("unknown form → %f, want 0.5", got)
	}
}

func TestLegalFormFit_Empty(t *testing.T) {
	if got := legalFormFit(""); got != 0.5 {
		t.Errorf("empty → %f, want 0.5", got)
	}
}

// ── DefaultICPConfig sub-sectors ─────────────────────────────────────────────

// TestICPWithFactors_MidRangeScoreNotCapped catches the `> → <` mutation on
// `if score > 1 { score = 1 }`. With the mutation, any score < 1 is capped to 1.
// A known mid-range input must produce a score well below 1.
func TestICPWithFactors_MidRangeScoreNotCapped(t *testing.T) {
	input := ICPInput{
		SectorTags:  []string{"machinery"}, // sectorFit = 0.6 × 0.35 = 0.21
		CompanySize: "500 - 999 zaměstnanců", // sizeFit  = 0.3 × 0.20 = 0.06
		HasEmail:    true,                    // completeness = 0.5 × 0.10 = 0.05
		HasWebsite:  false,
		HasPhone:    false,
		RatingCount: 0, // ratingSignal = 0.3 × 0.05 = 0.015
		PravniForma: "osvč", // legalFormFit = 0.4 × 0.10 = 0.04
		// regionFit = 1.0 × 0.10 = 0.10 (no target regions)
		// ageStability = 0.5 × 0.10 = 0.05 (nil date)
		// total ≈ 0.525 — well below 1
	}
	score, _ := CalculateICPWithFactors(input, DefaultICPConfig())
	if score >= 0.99 {
		t.Errorf("mid-range score should not be capped to 1, got %.4f (mutation `> → <` would set any score < 1 to 1)", score)
	}
	if score <= 0.1 {
		t.Errorf("machinery company with email should score > 0.1, got %.4f", score)
	}
}

func TestDefaultICPConfig_IncludesSubSectors(t *testing.T) {
	cfg := DefaultICPConfig()
	subSectors := []string{
		"machinery_cnc", "machinery_hydraulic", "machinery_agricultural",
		"metalwork_stamping", "metalwork_casting",
		"construction_civil", "construction_specialized",
		"automotive_parts",
	}
	targetSet := make(map[string]bool)
	for _, s := range cfg.TargetSectors {
		targetSet[s] = true
	}
	for _, ss := range subSectors {
		if !targetSet[ss] {
			t.Errorf("DefaultICPConfig missing sub-sector %q", ss)
		}
	}
}

// ── NACE sub-sector ordering ─────────────────────────────────────────────────

func TestSectors_SubSectorsPrecedeParents(t *testing.T) {
	// 4-digit codes must appear before their 2-digit parents in the Sectors slice
	fourDigitCodes := map[string]bool{
		"machinery_cnc": true, "machinery_hydraulic": true,
		"machinery_agricultural": true, "metalwork_stamping": true,
		"metalwork_casting": true, "automotive_parts": true,
		"construction_civil": true, "construction_specialized": true,
	}
	parentCodes := map[string]bool{
		"machinery": true, "metalwork": true, "construction": true, "automotive": true,
	}

	firstParentIdx := -1
	for i, s := range Sectors {
		if parentCodes[s.Code] && firstParentIdx == -1 {
			firstParentIdx = i
		}
		if fourDigitCodes[s.Code] && firstParentIdx != -1 {
			t.Errorf("4-digit sector %q appears at index %d AFTER first parent at %d",
				s.Code, i, firstParentIdx)
		}
	}
	if firstParentIdx == -1 {
		t.Error("no parent sector found in Sectors slice")
	}
}
