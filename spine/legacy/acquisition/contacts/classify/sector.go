package classify

import (
	"encoding/json"
	"math"
	"strings"
)

// SectorTag represents a classified sector with confidence.
type SectorTag struct {
	Code       string
	Label      string
	Confidence float64
	Source     string // "nace", "category_path", "keywords"
}

// ClassifyInput contains all signals for sector classification.
type ClassifyInput struct {
	NACECodes      []string
	CategoryPath   string
	CategoriesJSON string // raw JSON: [{"name":"Kovovýroba","url":"..."}]
	Description    string
}

// ClassifySector runs the waterfall: NACE → categories_json → category_path → keywords.
func ClassifySector(input ClassifyInput) []SectorTag {
	if len(input.NACECodes) > 0 {
		tags := classifyByNACE(input.NACECodes)
		if len(tags) > 0 {
			return tags
		}
	}

	// Czech human-readable names (categories_json) are more specific than URL slugs.
	if input.CategoriesJSON != "" {
		tags := classifyByCategoriesJSON(input.CategoriesJSON)
		if len(tags) > 0 {
			return tags
		}
	}

	if input.CategoryPath != "" {
		tags := classifyByCategoryPath(input.CategoryPath)
		if len(tags) > 0 {
			return tags
		}
	}

	if input.Description != "" {
		return classifyByKeywords(input.Description)
	}

	return nil
}

// PrimaryTag returns the highest-confidence tag code, or "".
func PrimaryTag(tags []SectorTag) string {
	if len(tags) == 0 {
		return ""
	}
	return tags[0].Code
}

// PrimaryConfidence returns the highest confidence, or 0.
func PrimaryConfidence(tags []SectorTag) float64 {
	if len(tags) == 0 {
		return 0
	}
	return tags[0].Confidence
}

// PrimarySource returns the source of the primary tag, or "".
func PrimarySource(tags []SectorTag) string {
	if len(tags) == 0 {
		return ""
	}
	return tags[0].Source
}

// TagCodes extracts codes from SectorTag slice.
func TagCodes(tags []SectorTag) []string {
	if len(tags) == 0 {
		return nil
	}
	codes := make([]string, len(tags))
	for i, t := range tags {
		codes[i] = t.Code
	}
	return codes
}

func classifyByNACE(codes []string) []SectorTag {
	seen := map[string]bool{}
	var tags []SectorTag
	for _, code := range codes {
		for _, s := range Sectors {
			if seen[s.Code] {
				continue
			}
			for _, prefix := range s.NACEPrefix {
				if strings.HasPrefix(code, prefix) {
					tags = append(tags, SectorTag{
						Code: s.Code, Label: s.Label,
						Confidence: 1.0, Source: "nace",
					})
					seen[s.Code] = true
					break
				}
			}
		}
		if len(tags) >= 3 {
			break
		}
	}
	return tags
}

// czCategoryEntry maps a Czech category name substring (lowercase) to a sector code.
// These map the human-readable names from categories_json → firmy.cz onto our sector taxonomy.
// Ordered from most-specific to least-specific within each sector.
// A match on any substring in the category name is sufficient.
var czCategorySubstrings = []struct {
	sub  string
	code string
}{
	// ── machinery ──
	{"kovoobrábění", "machinery"},
	{"obráběčství", "machinery"},
	{"výroba průmyslových strojů", "machinery"},
	{"prodej průmyslových strojů", "machinery"},
	{"průmyslové instalace", "machinery"},
	{"průmyslová automatizace", "machinery"},
	{"výroba čerpadel", "machinery"},
	{"výroba kompresorů", "machinery"},
	{"hydraulika", "machinery"},
	{"pneumatické", "machinery"},
	{"jeřábnická", "machinery"},
	{"zdvihací zařízení", "machinery"},
	{"výroba nástrojů", "machinery"},
	{"servis strojů", "machinery"},
	{"průmyslová zařízení", "machinery"},
	{"obráb", "machinery"}, // short stem catches: obrábění, obrábecí

	// ── metalwork ──
	{"kovovýroba", "metalwork"},
	{"kovoobrábění", "metalwork"}, // also appears above — first match wins in waterfall
	{"zámečnictví", "metalwork"},
	{"svářečství", "metalwork"},
	{"výroba ocelových konstrukcí", "metalwork"},
	{"klempířství", "metalwork"},
	{"výroba kovových konstrukcí", "metalwork"},
	{"kovárna", "metalwork"},
	{"galvanické", "metalwork"},
	{"pokovování", "metalwork"},
	{"plechové výrobky", "metalwork"},
	{"tryskání", "metalwork"},
	{"práškové lakování", "metalwork"},

	// ── construction ──
	{"stavební firmy", "construction"},
	{"stavebnictví", "construction"},
	{"zemní a výkopové práce", "construction"},
	{"zednické práce", "construction"},
	{"projektové práce ve stavebnictví", "construction"},
	{"rekonstrukce a přestavby", "construction"},
	{"stavebně řemeslné práce", "construction"},
	{"zateplování fasád", "construction"},
	{"hydroizolace střech", "construction"},
	{"demolice a sanace", "construction"},
	{"prodej stavebnin", "construction"},
	{"pronájem stavební techniky", "construction"},
	{"stavební dozor", "construction"},
	{"rodinné domy na klíč", "construction"},
	{"izolační a zateplovací", "construction"},
	{"pokladačství a obkladačství", "construction"},
	{"prodej oken a dveří", "construction"},
	{"tesařství", "construction"},
	{"pokrývačství", "construction"},
	{"betonárny", "construction"},
	{"prefabrikované stavby", "construction"},
	{"výroba vrat a bran", "construction"},
	{"geodetické práce", "construction"},

	// ── transport ──
	{"nákladní silniční doprava", "transport"},
	{"vnitrostátní nákladní", "transport"},
	{"mezistátní nákladní", "transport"},
	{"dodávková autodoprava", "transport"},
	{"kontejnerová doprava", "transport"},
	{"autobusová doprava", "transport"},
	{"doprava a přeprava", "transport"},
	{"logistické služby", "transport"},
	{"spediční služby", "transport"},
	{"přeprava nadrozměrných", "transport"},
	{"přeprava nebezpečných", "transport"},
	{"taxi služby", "transport"},
	{"odtahové služby", "transport"},

	// ── agriculture ──
	{"zpracování produktů rostlinné výroby", "agriculture"},
	{"výroba produktů živočišné výroby", "agriculture"},
	{"lesnictví", "agriculture"},
	{"zemědělská výroba", "agriculture"},
	{"prodej produktů rostlinné výroby", "agriculture"},
	{"chov zvířat", "agriculture"},
	{"pěstování zeleniny", "agriculture"},
	{"pěstování ovoce", "agriculture"},
	{"pěstování obilovin", "agriculture"},
	{"agro", "agriculture"},

	// ── woodwork ──
	{"výroba zakázkového nábytku", "woodwork"},
	{"výroba dřevěných konstrukcí", "woodwork"},
	{"prodej dřeva", "woodwork"},
	{"truhlářství", "woodwork"},
	{"výroba kuchyní", "woodwork"},
	{"výroba kuchyní a ložnic", "woodwork"},
	{"pily a řezivo", "woodwork"},
	{"výroba palet", "woodwork"},

	// ── energy ──
	{"fotovoltaické systémy", "energy"},
	{"výroba solárních", "energy"},
	{"tepelná čerpadla", "energy"},
	{"prodej a montáž tepelných čerpadel", "energy"},
	{"výroba elektrické energie", "energy"},
	{"distribuce elektrické energie", "energy"},
	{"nabíjecí stanice pro elektromobily", "energy"},
	{"rychlonabíjecí stanice", "energy"},

	// ── automotive ──
	{"autoservisy", "automotive"},
	{"autolakýrny", "automotive"},
	{"karosárny", "automotive"},
	{"prodej ojetých automobilů", "automotive"},
	{"prodej nových automobilů", "automotive"},
	{"autopůjčovny", "automotive"},
	{"autoklempíři", "automotive"},
	{"prodej náhradních dílů", "automotive"},
	{"autoelektrikáři", "automotive"},
	{"pneuservisy", "automotive"},

	// ── electronics ──
	{"elektromontážní a elektroinstalační", "electronics"},
	{"elektroinstalace", "electronics"},
	{"elektrorevize", "electronics"},
	{"slaboproudé elektromontáže", "electronics"},
	{"elektronické zabezpečovací", "electronics"},
	{"elektroservisy", "electronics"},
}

// classifyByCategoriesJSON parses the firmy.cz categories_json field and maps
// Czech human-readable category names to sectors.
// Confidence 0.88 — higher than URL-slug matching (0.82), lower than NACE (1.0).
func classifyByCategoriesJSON(rawJSON string) []SectorTag {
	if rawJSON == "" || rawJSON == "null" || rawJSON == "[]" {
		return nil
	}

	var items []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal([]byte(rawJSON), &items); err != nil {
		return nil
	}

	seen := map[string]bool{}
	var tags []SectorTag

	// Walk from last item (most-specific) to first (least-specific).
	for i := len(items) - 1; i >= 0; i-- {
		nameLower := strings.ToLower(items[i].Name)
		for _, entry := range czCategorySubstrings {
			if seen[entry.code] {
				continue
			}
			if strings.Contains(nameLower, entry.sub) {
				sector := findSector(entry.code)
				if sector == nil {
					continue
				}
				tags = append(tags, SectorTag{
					Code: sector.Code, Label: sector.Label,
					Confidence: 0.88, Source: "categories_json",
				})
				seen[entry.code] = true
				if len(tags) >= 3 {
					return tags
				}
				break
			}
		}
	}

	return tags
}

// normalizeCategorySegment converts a firmy.cz slug segment to the lookup key
// used in CategoryPathMap: lowercase + replace hyphens with spaces.
// e.g. "Obrabeni-kovu" → "obrabeni kovu"
func normalizeCategorySegment(seg string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(seg), "-", " "))
}

// categoryPathConfidence returns the confidence score for a match at the given
// segment index. A leaf-segment match carries full confidence (0.82); each step
// toward the root subtracts 0.04, floored at 0.70. This reflects how specific
// the classification signal is: a direct leaf match is more informative than
// inferring from an ancestor segment when the leaf slug is unmapped.
func categoryPathConfidence(matchIdx, lastIdx int) float64 {
	distFromLeaf := lastIdx - matchIdx
	conf := 0.82 - 0.04*float64(distFromLeaf)
	if conf < 0.70 {
		conf = 0.70
	}
	// Round to two decimal places so callers and tests can compare exact values
	// without worrying about binary-float imprecision in the subtraction.
	return math.Round(conf*100) / 100
}

func classifyByCategoryPath(path string) []SectorTag {
	segments := strings.Split(path, " > ")
	seen := map[string]bool{}
	var tags []SectorTag
	lastIdx := len(segments) - 1
	// Walk from most-specific (last) to least-specific (first) so leaf segments win.
	for i := lastIdx; i >= 0; i-- {
		key := normalizeCategorySegment(segments[i])
		if key == "" {
			continue
		}
		code, ok := CategoryPathMap[key]
		if !ok || seen[code] {
			continue
		}
		sector := findSector(code)
		if sector == nil {
			continue
		}
		tags = append(tags, SectorTag{
			Code: sector.Code, Label: sector.Label,
			Confidence: categoryPathConfidence(i, lastIdx), Source: "category_path",
		})
		seen[code] = true
		if len(tags) >= 3 {
			break
		}
	}
	if len(tags) == 0 && strings.TrimSpace(path) != "" {
		recordUnmappedCategoryPath(path)
	}
	return tags
}

func classifyByKeywords(description string) []SectorTag {
	lower := strings.ToLower(description)
	type scored struct {
		code, label string
		hits, total int
	}
	var results []scored
	for _, s := range Sectors {
		kws := SectorKeywords[s.Code]
		if len(kws) == 0 {
			continue
		}
		hits := 0
		for _, kw := range kws {
			if strings.Contains(lower, kw) {
				hits++
			}
		}
		if hits > 0 {
			results = append(results, scored{s.Code, s.Label, hits, len(kws)})
		}
	}
	// Sort by hit ratio descending (insertion sort — small N)
	for i := 1; i < len(results); i++ {
		key := results[i]
		j := i - 1
		for j >= 0 && float64(results[j].hits)/float64(results[j].total) < float64(key.hits)/float64(key.total) {
			results[j+1] = results[j]
			j--
		}
		results[j+1] = key
	}
	var tags []SectorTag
	for i, r := range results {
		if i >= 3 {
			break
		}
		conf := float64(r.hits) / float64(r.total)
		if conf > 0.7 {
			conf = 0.7
		}
		if r.hits >= 3 {
			conf = min64(conf*1.3, 0.7)
		}
		tags = append(tags, SectorTag{
			Code: r.code, Label: r.label,
			Confidence: conf, Source: "keywords",
		})
	}
	return tags
}

func findSector(code string) *Sector {
	for i := range Sectors {
		if Sectors[i].Code == code {
			return &Sectors[i]
		}
	}
	return nil
}

func min64(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
