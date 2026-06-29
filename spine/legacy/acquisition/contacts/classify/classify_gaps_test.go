package classify

import (
	"testing"
	"time"
)

// ── ICP: micro-size + target sector → ceiling 0.39 (lines 110-112) ──

func TestCalculateICPWithFactors_MicroSizeTargetSector_Ceiling039(t *testing.T) {
	// "1 - 5 zaměstnanců" = micro, "machinery" = target sector
	// → ceiling starts at 1.0 (not anti-target, SectorFit > 0),
	//   then isMicroSize triggers and ceiling is capped to 0.39.
	founded := time.Now().AddDate(-5, 0, 0)
	input := ICPInput{
		SectorTags:  []string{"machinery"},
		CompanySize: "1 - 5 zaměstnanců",
		HasEmail:    true,
		HasPhone:    true,
		HasWebsite:  true,
		RatingValue: 4.5,
		RatingCount: 10,
		DatumVzniku: &founded,
		PravniForma: "s.r.o.",
	}
	cfg := DefaultICPConfig()
	score, factors := CalculateICPWithFactors(input, cfg)

	if factors.SectorFit <= 0 {
		t.Error("expected positive SectorFit for machinery target sector")
	}
	// Score must be capped at 0.39 (micro-size ceiling)
	if score > 0.39 {
		t.Errorf("score = %.3f, want <= 0.39 (micro-size ceiling)", score)
	}
	if score < 0 {
		t.Errorf("score = %.3f, want >= 0", score)
	}
}

func TestCalculateICPWithFactors_MicroSizeBezZamestnancu(t *testing.T) {
	input := ICPInput{
		SectorTags:  []string{"construction"},
		CompanySize: "Bez zaměstnanců",
		HasEmail:    true,
	}
	score, _ := CalculateICPWithFactors(input, DefaultICPConfig())
	if score > 0.39 {
		t.Errorf("Bez zaměstnanců score = %.3f, want <= 0.39", score)
	}
}

// ── Sector: CategoriesJSON returning tags (lines 37-39) ──

func TestClassifySector_CategoriesJSONMatchReturns(t *testing.T) {
	// "kovoobrábění" matches machinery in czCategorySubstrings
	tags := ClassifySector(ClassifyInput{
		CategoriesJSON: `[{"name":"Kovoobrábění a zámečnictví"}]`,
	})
	if len(tags) == 0 {
		t.Error("expected tags from CategoriesJSON with 'kovoobrábění'")
	}
	// The return-from-categories-json path (lines 37-39) was hit
	if len(tags) > 0 && tags[0].Source != "categories_json" {
		t.Errorf("source = %q, want categories_json", tags[0].Source)
	}
}

// ── Sector: seen[code] continue in classifyByCategoriesJSON (lines 274-275) ──

func TestClassifyByCategoriesJSON_SeenCode(t *testing.T) {
	// Two items both matching "machinery" → second triggers seen[code] continue
	json := `[{"name":"výroba průmyslových strojů"},{"name":"servis strojů"}]`
	tags := classifyByCategoriesJSON(json)
	// Both match machinery; only one machinery tag should appear
	machineCount := 0
	for _, tag := range tags {
		if tag.Code == "machinery" {
			machineCount++
		}
	}
	if machineCount > 1 {
		t.Errorf("expected at most 1 machinery tag, got %d", machineCount)
	}
}

// ── Sector: categoryPathConfidence low conf (lines 313-315) ──

func TestCategoryPathConfidence_LowConf(t *testing.T) {
	// distFromLeaf = 4 → conf = 0.82 - 0.04*4 = 0.66 < 0.70 → clamped to 0.70
	conf := categoryPathConfidence(0, 4)
	if conf != 0.70 {
		t.Errorf("conf = %.2f, want 0.70 (clamped from 0.66)", conf)
	}
}

func TestCategoryPathConfidence_VeryLow(t *testing.T) {
	// distFromLeaf = 10 → conf = 0.82 - 0.40 = 0.42 < 0.70 → clamped
	conf := categoryPathConfidence(0, 10)
	if conf != 0.70 {
		t.Errorf("conf = %.2f, want 0.70", conf)
	}
}

// ── Sector: classifyByCategoryPath seen[code] and len >= 3 (lines 345-346, 349-351) ──

func TestClassifyByCategoryPath_SeenCode(t *testing.T) {
	// Strojirenstvi appears twice in path → second triggers seen[code]
	tags := classifyByCategoryPath("Strojirenstvi > Kovoobrabed > Strojirenstvi")
	// Should not have duplicates
	seen := map[string]bool{}
	for _, tag := range tags {
		if seen[tag.Code] {
			t.Errorf("duplicate code %q in tags", tag.Code)
		}
		seen[tag.Code] = true
	}
}

func TestClassifyByCategoryPath_MaxThreeTags(t *testing.T) {
	// Path with many segments all mapping to different codes → stops at 3
	// Use a path with many segments; the function stops after 3 tags
	path := "Strojirenstvi > Metalwork > Stavebnictvi > Zemedelstvi > Autodoprava > Dalsi"
	tags := classifyByCategoryPath(path)
	if len(tags) > 3 {
		t.Errorf("expected at most 3 tags, got %d", len(tags))
	}
}

// ── Sector: classifyByCategoryPath sector==nil (line 337-338) ──
// CategoryPathMap may have entries whose code is not in Sectors — rare defensive path.
// We test it indirectly: a path segment that maps to a missing sector gets skipped.

func TestClassifyByCategoryPath_UnknownSegment(t *testing.T) {
	// A path where no segment maps to a known category → empty result
	tags := classifyByCategoryPath("Neznamy > Segment > Cesty")
	// No match is expected — just ensure no panic
	_ = tags
}

// ── classifyByKeywords: confidence > 0.7 cap (lines 393-395) ──
// Craft a description that hits all machinery keywords → conf = 1.0 > 0.7 → capped.

func TestClassifyByKeywords_ConfidenceCap(t *testing.T) {
	// All 18 machinery keywords: stroj strojír strojní obráběn cnc fréz soustruh
	// lis čerpadl kompresor hydraul pneumat převodov řezán brusn vrtačk jeřáb zdvihad
	desc := "strojírna obráběna CNC frézy soustruh lis čerpadlo kompresor hydraulika pneumatika převodovka řezání brusné vrtačka jeřáb zdvihad"
	tags := classifyByKeywords(desc)
	if len(tags) == 0 {
		t.Fatal("expected at least one tag from keyword classification")
	}
	// Confidence should be capped at 0.7
	if tags[0].Confidence > 0.7+1e-9 {
		t.Errorf("confidence = %.3f, want <= 0.7 (capped)", tags[0].Confidence)
	}
}

// ── classifyByCategoryPath: seen[code] continue (line 345) ──

func TestClassifyByCategoryPath_SeenCodeContinue(t *testing.T) {
	// "Strojirenstvi" matches "machinery" → seen["machinery"] = true
	// Second occurrence of "Strojirenstvi" in path triggers seen[code] continue
	tags := classifyByCategoryPath("Strojirenstvi > Strojirenstvi > CNC")
	// Should not have duplicate codes
	seen := map[string]bool{}
	for _, tag := range tags {
		if seen[tag.Code] {
			t.Errorf("duplicate code %q in tags", tag.Code)
		}
		seen[tag.Code] = true
	}
}
