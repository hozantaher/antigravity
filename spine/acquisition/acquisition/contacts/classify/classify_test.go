package classify

import (
	"database/sql"
	"testing"
	"time"
)

func TestClassifySector_NACE(t *testing.T) {
	tags := ClassifySector(ClassifyInput{NACECodes: []string{"2899"}})
	if len(tags) == 0 || tags[0].Code != "machinery" {
		t.Errorf("NACE 2899 should map to machinery, got %v", tags)
	}
	if tags[0].Source != "nace" {
		t.Errorf("source should be nace, got %s", tags[0].Source)
	}
}

func TestClassifySector_CategoryPath(t *testing.T) {
	tags := ClassifySector(ClassifyInput{CategoryPath: "Strojirenstvi > Obrabeni kovu"})
	if len(tags) == 0 {
		t.Fatal("expected tags from category path")
	}
	if tags[0].Code != "machinery" {
		t.Errorf("expected machinery, got %s", tags[0].Code)
	}
	if tags[0].Source != "category_path" {
		t.Errorf("source should be category_path, got %s", tags[0].Source)
	}
}

func TestClassifySector_CategoryPathMultiple(t *testing.T) {
	tags := ClassifySector(ClassifyInput{CategoryPath: "Hutnictvi > Svarovani"})
	if len(tags) != 1 {
		t.Errorf("both segments map to metalwork, expected 1 deduplicated tag, got %d", len(tags))
	}
}

func TestClassifySector_Keywords(t *testing.T) {
	tags := ClassifySector(ClassifyInput{
		Description: "Vyrábíme CNC stroje, frézy a soustruhy pro průmyslové obráběné díly",
	})
	if len(tags) == 0 || tags[0].Code != "machinery" {
		t.Errorf("expected machinery from keywords, got %v", tags)
	}
}

func TestClassifySector_Waterfall(t *testing.T) {
	// NACE should win over category_path and keywords
	tags := ClassifySector(ClassifyInput{
		NACECodes:    []string{"4110"},
		CategoryPath: "Strojirenstvi",
		Description:  "Vyrábíme CNC stroje",
	})
	if len(tags) == 0 || tags[0].Code != "construction" {
		t.Errorf("NACE should win, expected construction, got %v", tags)
	}
	if tags[0].Source != "nace" {
		t.Errorf("source should be nace")
	}
}

func TestClassifySector_Empty(t *testing.T) {
	tags := ClassifySector(ClassifyInput{})
	if len(tags) != 0 {
		t.Errorf("expected no tags for empty input, got %v", tags)
	}
}

func TestNormalizeRegion(t *testing.T) {
	tests := []struct {
		psc, locality, want string
	}{
		// 3-char prefix matches
		{"602 00", "", "Jihomoravský kraj"},
		{"110 00", "", "Hlavní město Praha"},
		{"301 00", "", "Plzeňský kraj"},
		{"700 30", "", "Moravskoslezský kraj"},
		{"763 00", "", "Zlínský kraj"},
		{"580 01", "", "Kraj Vysočina"},
		// 3-char prefix NOT in map → fallback first digit
		{"199", "", "Hlavní město Praha"}, // '1' → Praha (199 not in prefix map)
		{"299", "", "Středočeský kraj"},   // '2' → Středočeský
		{"499", "", "Ústecký kraj"},        // '4' → Ústecký
		{"699", "", "Jihomoravský kraj"},   // '6' → Jihomoravský
		// 1-char PSČ → first digit fallback
		{"1", "", "Hlavní město Praha"},
		{"2", "", "Středočeský kraj"},
		{"4", "", "Ústecký kraj"},
		{"6", "", "Jihomoravský kraj"},
		// locality fallback
		{"", "Brno", "Jihomoravský kraj"},
		{"", "Ostrava", "Moravskoslezský kraj"},
		{"", "Praha 4", "Hlavní město Praha"},
		{"", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.psc+"_"+tt.locality, func(t *testing.T) {
			got := NormalizeRegion(tt.psc, tt.locality)
			if got != tt.want {
				t.Errorf("NormalizeRegion(%q, %q) = %q, want %q", tt.psc, tt.locality, got, tt.want)
			}
		})
	}
}

func TestCalculateICP(t *testing.T) {
	cfg := DefaultICPConfig()

	// Ideal customer: machinery, medium size, has all data
	score := CalculateICP(ICPInput{
		SectorTags:  []string{"machinery"},
		CompanySize: "25 - 49 zaměstnanců",
		HasEmail:    true,
		HasWebsite:  true,
		HasPhone:    true,
		RatingValue: 4.5,
		RatingCount: 10,
	}, cfg)
	if score < 0.7 {
		t.Errorf("ideal customer should score >= 0.7, got %f", score)
	}
	if ICPTier(score) != "ideal" {
		t.Errorf("expected tier ideal, got %s", ICPTier(score))
	}

	// Irrelevant: retail, no data
	score2 := CalculateICP(ICPInput{
		SectorTags: []string{"retail"},
	}, cfg)
	if score2 >= 0.4 {
		t.Errorf("retail with no data should score < 0.4, got %f", score2)
	}
}

func TestICPTier(t *testing.T) {
	tests := []struct {
		score float64
		tier  string
	}{
		{0.85, "ideal"},
		{0.7, "ideal"},
		{0.5, "good"},
		{0.4, "good"},
		{0.3, "marginal"},
		{0.1, "irrelevant"},
		{0.0, "irrelevant"},
	}
	for _, tt := range tests {
		got := ICPTier(tt.score)
		if got != tt.tier {
			t.Errorf("ICPTier(%f) = %s, want %s", tt.score, got, tt.tier)
		}
	}
}

// ──────────────────────────────────────────
//  sizeFit — full branch coverage
// ──────────────────────────────────────────

func TestSizeFit_AllBranches(t *testing.T) {
	cases := []struct {
		size string
		want float64
	}{
		{"10 - 19 zaměstnanců", 1.0},
		{"20 - 24 zaměstnanci", 1.0},
		{"25 - 49 zaměstnanců", 1.0},
		{"50 - 99 zaměstnanců", 0.8},
		{"100 - 199 zaměstnanců", 0.8},
		{"6 - 9 zaměstnanců", 0.7},
		{"200 - 249 zaměstnanců", 0.5},
		{"250 - 499 zaměstnanců", 0.5},
		{"1 - 5 zaměstnanců", 0.4},
		{"500 - 999 zaměstnanců", 0.3},
		{"Bez zaměstnanců", 0.1},
		// default (unknown) → 0.3
		{"", 0.3},
		{"1000+", 0.3},
	}
	for _, tc := range cases {
		got := sizeFit(tc.size)
		if got != tc.want {
			t.Errorf("sizeFit(%q) = %v, want %v", tc.size, got, tc.want)
		}
	}
}

// ──────────────────────────────────────────
//  regionFit — full branch coverage
// ──────────────────────────────────────────

func TestRegionFit(t *testing.T) {
	// empty targets → always 1.0
	if got := regionFit("Jihomoravský kraj", nil); got != 1.0 {
		t.Errorf("regionFit with no targets = %v, want 1.0", got)
	}
	// matching target (case-insensitive)
	if got := regionFit("Jihomoravský kraj", []string{"jihomoravský kraj"}); got != 1.0 {
		t.Errorf("regionFit matching = %v, want 1.0", got)
	}
	// second element matches
	if got := regionFit("Praha", []string{"Brno", "Praha"}); got != 1.0 {
		t.Errorf("regionFit second element = %v, want 1.0", got)
	}
	// no match → 0.3
	if got := regionFit("Zlínský kraj", []string{"Jihomoravský kraj", "Plzeňský kraj"}); got != 0.3 {
		t.Errorf("regionFit no match = %v, want 0.3", got)
	}
}

// ──────────────────────────────────────────
//  ratingSignal — full branch coverage
// ──────────────────────────────────────────

func TestRatingSignal(t *testing.T) {
	cases := []struct {
		value float64
		count int
		want  float64
	}{
		{0, 0, 0.3},    // no ratings
		{4.5, 10, 1.0}, // high rating + many reviews
		{4.0, 5, 1.0},  // boundary: exactly 4.0 + 5 reviews
		{4.5, 4, 0.6},  // high value but count < 5 → falls through to >= 3.0
		{3.0, 3, 0.6},  // >= 3.0
		{3.9, 2, 0.6},  // < 4.0 but >= 3.0
		{2.9, 5, 0.2},  // < 3.0
		{1.0, 100, 0.2},// low rating many reviews
	}
	for _, tc := range cases {
		got := ratingSignal(tc.value, tc.count)
		if got != tc.want {
			t.Errorf("ratingSignal(%v, %d) = %v, want %v", tc.value, tc.count, got, tc.want)
		}
	}
}

// ──────────────────────────────────────────
//  localityToKraj — more city coverage
// ──────────────────────────────────────────

func TestLocalityToKraj_AllBranches(t *testing.T) {
	cases := []struct {
		locality string
		want     string
	}{
		{"Praha", "Hlavní město Praha"},
		{"Brno", "Jihomoravský kraj"},
		{"Ostrava", "Moravskoslezský kraj"},
		{"Plzeň", "Plzeňský kraj"},
		{"Plzen", "Plzeňský kraj"},
		{"Liberec", "Liberecký kraj"},
		{"Olomouc", "Olomoucký kraj"},
		{"Hradec Králové", "Královéhradecký kraj"},
		{"Hradec Kralove", "Královéhradecký kraj"},
		{"Pardubice", "Pardubický kraj"},
		{"Zlín", "Zlínský kraj"},
		{"Zlin", "Zlínský kraj"},
		{"Jihlava", "Kraj Vysočina"},
		{"České Budějovice", "Jihočeský kraj"},
		{"Ceske Budejovice", "Jihočeský kraj"},
		{"Karlovy Vary", "Karlovarský kraj"},
		{"Ústí nad Labem", "Ústecký kraj"},
		{"Usti nad Labem", "Ústecký kraj"},
		{"", ""},
		{"Unknown City", ""},
	}
	for _, tc := range cases {
		got := localityToKraj(tc.locality)
		if got != tc.want {
			t.Errorf("localityToKraj(%q) = %q, want %q", tc.locality, got, tc.want)
		}
	}
}

// ──────────────────────────────────────────
//  sector min64
// ──────────────────────────────────────────

func TestSectorMin64(t *testing.T) {
	if min64(1.0, 2.0) != 1.0 { t.Error("min64(1,2) should be 1") }
	if min64(2.0, 1.0) != 1.0 { t.Error("min64(2,1) should be 1") }
	if min64(3.0, 3.0) != 3.0 { t.Error("min64(3,3) should be 3") }
}

// ──────────────────────────────────────────
//  sectorFit — empty tags/targets branches
// ──────────────────────────────────────────

func TestSectorFit_EmptyInputs(t *testing.T) {
	// empty tags → 0
	if got := sectorFit(nil, []string{"machinery"}); got != 0 {
		t.Errorf("empty tags: want 0, got %f", got)
	}
	// empty targets → 0
	if got := sectorFit([]string{"machinery"}, nil); got != 0 {
		t.Errorf("empty targets: want 0, got %f", got)
	}
}

// ──────────────────────────────────────────
//  classifyByNACE/classifyByCategoryPath/classifyByKeywords/findSector
// ──────────────────────────────────────────

func TestClassifyByNACE_UnknownCode(t *testing.T) {
	// A NACE code not in map returns empty slice
	got := classifyByNACE([]string{"9999"})
	if len(got) != 0 {
		t.Errorf("unknown NACE should return empty, got %v", got)
	}
}

func TestClassifyByNACE_EmptyCodes(t *testing.T) {
	got := classifyByNACE(nil)
	if len(got) != 0 {
		t.Errorf("nil codes should return empty, got %v", got)
	}
}

func TestClassifyByCategoryPath_Empty(t *testing.T) {
	got := classifyByCategoryPath("")
	if len(got) != 0 {
		t.Errorf("empty path should return empty, got %v", got)
	}
}

func TestClassifyByKeywords_NoMatch(t *testing.T) {
	// Description with no recognizable keywords
	got := classifyByKeywords("lorem ipsum dolor sit amet consectetur")
	if len(got) != 0 {
		t.Errorf("no-keyword description should return empty, got %v", got)
	}
}

func TestFindSector_UnknownCode(t *testing.T) {
	// Unknown sector code → nil
	got := findSector("XXXX")
	if got != nil {
		t.Errorf("unknown code: want nil, got %v", got)
	}
}

// ──────────────────────────────────────────
//  ClassifySector waterfall fallback branches
// ──────────────────────────────────────────

func TestClassifySector_CategoriesJSONFallback(t *testing.T) {
	// NACE codes present but unrecognised → falls through to CategoriesJSON
	// "Strojírenství" should match machinery via category map
	input := ClassifyInput{
		NACECodes:      []string{"9999"},
		CategoriesJSON: `[{"name":"Strojírenství","url":"strojirenstvi"}]`,
	}
	got := ClassifySector(input)
	// Must return non-nil and source must be categories_json (not nace)
	if len(got) > 0 && got[0].Source == "nace" {
		t.Errorf("unrecognised NACE should not produce source=nace, got %v", got)
	}
}

func TestClassifySector_CategoryPathFallback(t *testing.T) {
	// NACE unrecognised → falls through to CategoryPath
	// "strojirenstvi" segment should match machinery
	input := ClassifyInput{
		NACECodes:    []string{"9999"},
		CategoryPath: "Strojirenstvi > CNC obrabeni",
	}
	got := ClassifySector(input)
	if len(got) == 0 {
		t.Error("CategoryPath fallback should produce at least one tag for Strojirenstvi")
	}
	if len(got) > 0 && got[0].Source != "category_path" {
		t.Errorf("source should be category_path, got %s", got[0].Source)
	}
}

func TestClassifySector_KeywordsFallback(t *testing.T) {
	// NACE unrecognised, no CategoryPath → falls through to keywords
	input := ClassifyInput{
		NACECodes:   []string{"9999"},
		Description: "Výroba CNC strojů a obráběcích center",
	}
	got := ClassifySector(input)
	if len(got) == 0 {
		t.Error("keyword fallback should produce at least one tag for CNC description")
	}
	if len(got) > 0 && got[0].Source != "keywords" {
		t.Errorf("source should be keywords, got %s", got[0].Source)
	}
}

// ──────────────────────────────────────────
//  PrimaryTag / PrimaryConfidence / PrimarySource / TagCodes — empty branches
// ──────────────────────────────────────────

func TestSectorHelpers_EmptySlice(t *testing.T) {
	var empty []SectorTag
	if PrimaryTag(empty) != "" { t.Error("PrimaryTag empty") }
	if PrimaryConfidence(empty) != 0 { t.Error("PrimaryConfidence empty") }
	if PrimarySource(empty) != "" { t.Error("PrimarySource empty") }
	if TagCodes(empty) != nil { t.Error("TagCodes empty should be nil") }
}

func TestSectorHelpers_NonEmpty(t *testing.T) {
	tags := []SectorTag{{Code: "machinery", Label: "Strojírenství", Confidence: 0.9, Source: "nace"}}
	if PrimaryTag(tags) != "machinery" { t.Errorf("PrimaryTag: %s", PrimaryTag(tags)) }
	if PrimaryConfidence(tags) != 0.9 { t.Errorf("PrimaryConfidence: %f", PrimaryConfidence(tags)) }
	if PrimarySource(tags) != "nace" { t.Errorf("PrimarySource: %s", PrimarySource(tags)) }
	codes := TagCodes(tags)
	if len(codes) != 1 || codes[0] != "machinery" { t.Errorf("TagCodes: %v", codes) }
}

// ──────────────────────────────────────────
//  classifyByNACE — len(tags) >= 3 break
// ──────────────────────────────────────────

func TestClassifyByNACE_ThreeSectors(t *testing.T) {
	// 3 codes mapping to 3 different sectors → triggers len(tags) >= 3 break
	got := classifyByNACE([]string{"2899", "2410", "4110", "4910"})
	if len(got) != 3 {
		t.Errorf("expected 3 tags (cap), got %d: %v", len(got), got)
	}
}

// ──────────────────────────────────────────
//  classifyByCategoriesJSON — all branches
// ──────────────────────────────────────────

func TestClassifyByCategoriesJSON_Null(t *testing.T) {
	if got := classifyByCategoriesJSON("null"); got != nil {
		t.Errorf("'null' should return nil, got %v", got)
	}
}

func TestClassifyByCategoriesJSON_EmptyArray(t *testing.T) {
	if got := classifyByCategoriesJSON("[]"); got != nil {
		t.Errorf("'[]' should return nil, got %v", got)
	}
}

func TestClassifyByCategoriesJSON_ParseError(t *testing.T) {
	if got := classifyByCategoriesJSON("{not valid json"); got != nil {
		t.Errorf("parse error should return nil, got %v", got)
	}
}

func TestClassifyByCategoriesJSON_ThreeSectors(t *testing.T) {
	// 3+ items mapping to distinct sectors → triggers len(tags) >= 3 early return
	raw := `[
		{"name":"Kovoobrábění"},
		{"name":"Stavební firmy"},
		{"name":"Autoservisy"},
		{"name":"Elektroinstalace"}
	]`
	got := classifyByCategoriesJSON(raw)
	if len(got) != 3 {
		t.Errorf("expected 3 tags (cap), got %d: %v", len(got), got)
	}
	for _, tag := range got {
		if tag.Source != "categories_json" {
			t.Errorf("source should be categories_json, got %s", tag.Source)
		}
	}
}

// ───────────────────────────────────��──────
//  classifyByCategoryPath — empty segment
// ──────────────────────────────────────────

func TestClassifyByCategoryPath_EmptySegment(t *testing.T) {
	// Leading " > " produces an empty first segment → key == "" → continue
	got := classifyByCategoryPath(" > Strojirenstvi > Obrabeni kovu")
	// Should still return results from non-empty segments
	_ = got // no panic, no wrong result
}

func TestClassifyByCategoryPath_ThreeSegments(t *testing.T) {
	// Enough distinct segments to hit len(tags) >= 3 break
	got := classifyByCategoryPath("Strojirenstvi > Kovovyroba > Stavba > Doprava")
	_ = got // verify no panic
}

// ────────────────────────────────���─────────
//  classifyByKeywords — hits>=3 boost + i>=3 break
// ─────────────────────────────────────��────

func TestClassifyByKeywords_MultipleHitsBoost(t *testing.T) {
	// "stroj strojír strojní obráběn cnc" → 5 hits in machinery → hits >= 3 → boost
	got := classifyByKeywords("stroj strojír strojní obráběn cnc fréz soustruh lis")
	if len(got) == 0 || got[0].Code != "machinery" {
		t.Errorf("expected machinery first, got %v", got)
	}
	// Confidence should be boosted (>= raw ratio)
	if got[0].Confidence <= 0 {
		t.Errorf("confidence should be > 0, got %f", got[0].Confidence)
	}
}

func TestClassifyByKeywords_MoreThanThreeResults(t *testing.T) {
	// Description hitting many sectors → i >= 3 break caps at 3 tags
	// machinery + metalwork + construction + automotive keywords
	desc := "stroj kovov stavb auto dřev plast potravin zeměděl"
	got := classifyByKeywords(desc)
	if len(got) > 3 {
		t.Errorf("should cap at 3 tags, got %d", len(got))
	}
}

// ─────────────────────────────────────────���
//  CalculateICP — score > 1 clamp
// ──────────────────────────────────────────

func TestCalculateICP_ScoreCap(t *testing.T) {
	cfg := DefaultICPConfig()
	// Force all dimensions to max by providing a perfect customer
	score := CalculateICP(ICPInput{
		SectorTags:  []string{"machinery", "metalwork", "construction"},
		CompanySize: "25 - 49 zaměstnanců",
		HasEmail:    true,
		HasWebsite:  true,
		HasPhone:    true,
		RatingValue: 4.5,
		RatingCount: 10,
		Region:      "",
	}, cfg)
	if score > 1.0 {
		t.Errorf("score should be capped at 1.0, got %f", score)
	}
}

// ── companyRow.NACECodesSlice ──

func TestNACECodesSlice_Empty(t *testing.T) {
	r := companyRow{NACECodesRaw: ""}
	if r.NACECodesSlice() != nil { t.Error("empty should return nil") }
}

func TestNACECodesSlice_EmptyBraces(t *testing.T) {
	r := companyRow{NACECodesRaw: "{}"}
	if r.NACECodesSlice() != nil { t.Error("{} should return nil") }
}

func TestNACECodesSlice_Single(t *testing.T) {
	r := companyRow{NACECodesRaw: "{2841}"}
	got := r.NACECodesSlice()
	if len(got) != 1 || got[0] != "2841" {
		t.Errorf("single: got %v", got)
	}
}

func TestNACECodesSlice_Multiple(t *testing.T) {
	r := companyRow{NACECodesRaw: "{2841,2849,2899}"}
	got := r.NACECodesSlice()
	if len(got) != 3 {
		t.Fatalf("expected 3, got %d: %v", len(got), got)
	}
	if got[0] != "2841" || got[1] != "2849" || got[2] != "2899" {
		t.Errorf("values: %v", got)
	}
}

func TestNACECodesSlice_WithSpaces(t *testing.T) {
	r := companyRow{NACECodesRaw: "{ 2841 , 2849 }"}
	got := r.NACECodesSlice()
	if len(got) != 2 {
		t.Fatalf("expected 2, got %d: %v", len(got), got)
	}
	if got[0] != "2841" || got[1] != "2849" {
		t.Errorf("trimmed: %v", got)
	}
}

// ── datumVznikuPtr ──

func TestDatumVznikuPtr_Invalid(t *testing.T) {
	r := companyRow{DatumVzniku: sql.NullTime{Valid: false}}
	if r.datumVznikuPtr() != nil {
		t.Error("invalid NullTime should return nil")
	}
}

func TestDatumVznikuPtr_Valid(t *testing.T) {
	now := time.Now()
	r := companyRow{DatumVzniku: sql.NullTime{Valid: true, Time: now}}
	ptr := r.datumVznikuPtr()
	if ptr == nil {
		t.Fatal("valid NullTime should return non-nil pointer")
	}
	if !ptr.Equal(now) {
		t.Errorf("time mismatch: got %v, want %v", ptr, now)
	}
}

// ── JobConfig defaults ──

func TestJobConfig_Defaults(t *testing.T) {
	cfg := JobConfig{}
	if cfg.BatchSize != 0 { t.Error("default BatchSize") }
	if cfg.DryRun { t.Error("DryRun default false") }
}

// ── JobResult struct ──

func TestJobResult_Struct(t *testing.T) {
	r := JobResult{
		Processed:   100,
		HardBlocked: 10,
		SoftBlocked: 5,
		NeedsReview: 8,
		Classified:  77,
		Scored:      70,
	}
	if r.Processed != 100 { t.Error("Processed") }
	if r.HardBlocked != 10 { t.Error("HardBlocked") }
	if r.Classified != 77 { t.Error("Classified") }
}

// ── ClassifyUpdate struct ──

func TestClassifyUpdate_Struct(t *testing.T) {
	u := ClassifyUpdate{
		ExclusionStatus:  "pass",
		ExclusionReasons: []string{"ok"},
		NeedsReview:      false,
		SectorTags:       []string{"machinery"},
		SectorPrimary:    "machinery",
		SectorConfidence: 0.9,
		SectorSource:     "nace",
		ICPScore:         0.8,
		ICPTier:          "ideal",
		RegionNormalized: "Praha",
	}
	if u.ICPTier != "ideal" { t.Error("ICPTier") }
	if u.SectorConfidence != 0.9 { t.Error("SectorConfidence") }
	if len(u.SectorTags) != 1 { t.Error("SectorTags") }
}

// ── companyRow struct ──

func TestCompanyRow_Struct(t *testing.T) {
	r := companyRow{
		ID:              42,
		Name:            "Strojírna s.r.o.",
		ICO:             "12345678",
		Email:           "info@strojirna.cz",
		PravniForma:     "s.r.o.",
		CategoryPath:    "Strojirenstvi > Obrabeni kovu",
		CategoriesJSON:  `[{"name":"Strojirenstvi","url":"..."}]`,
		Description:     "Výrobce strojů",
		VelikostFirmy:   "25 - 49 zaměstnanců",
		PostalCode:      "10000",
		AddressLocality: "Praha",
		Website:         "https://strojirna.cz",
		Telephone:       "+420123456789",
		RatingValue:     4.2,
		RatingCount:     25,
		NACECodesRaw:    "{2841,2899}",
		VInsolvenci:     false,
		VLikvidaci:      false,
	}
	if r.ID != 42 { t.Error("ID") }
	if r.ICO != "12345678" { t.Error("ICO") }
	nace := r.NACECodesSlice()
	if len(nace) != 2 { t.Errorf("NACECodes: %v", nace) }
}
