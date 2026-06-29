package enrich

import "strings"

// IndustryTag represents a classified industry with confidence.
type IndustryTag struct {
	Tag        string
	Confidence float64
}

// Industry keyword maps — Czech terms for keyword matching against description.
var industryKeywords = map[string][]string{
	"machinery": {
		"stroj", "strojír", "strojní", "obráběn", "cnc", "fréz", "soustruh",
		"lis", "čerpadl", "kompresor", "hydraul", "pneumat", "převodov",
		"řezán", "brusn", "vrtačk", "jeřáb", "zdvihad",
	},
	"construction": {
		"stavb", "staveb", "stavěn", "zednic", "betonár", "fasád", "izolac",
		"zateplen", "střech", "tesař", "pokrývač", "podlah", "obklad",
		"demolič", "bagr", "buldozer", "zemní práce",
	},
	"agriculture": {
		"zeměděl", "agro", "traktor", "kombajn", "sklizeň", "osivo",
		"hnojiv", "postřik", "živočiš", "chov", "rostlin", "farma",
		"lesnict", "dřevař",
	},
	"transport": {
		"doprav", "přeprav", "kamion", "logist", "spedic", "silnič",
		"nákladn", "cistern", "přívěs", "návěs", "tahač",
	},
	"manufacturing": {
		"výrob", "fabrik", "průmysl", "produkc", "séri", "zakázkov",
		"montáž", "komplet",
	},
	"metalwork": {
		"kovov", "svařov", "zámečn", "ocel", "hliník", "plech",
		"pozink", "tryskán", "žárov", "kovoobrábě", "nástrojář",
	},
	"woodwork": {
		"dřev", "truhlář", "pila", "řezivo", "nábytek", "dýh",
		"palety", "euro palety",
	},
	"automotive": {
		"auto", "vozidl", "servis aut", "pneu", "karoser", "autolak",
		"autoelektri", "náhradní díly",
	},
	"energy": {
		"energ", "solár", "fotovolt", "tepeln", "kotel", "vytápěn",
		"klimatizac", "vzduchotechni", "elektroinstal",
	},
	"waste": {
		"odpad", "recykl", "sběrn", "likvidac", "skládk", "třídění",
		"demoliční odpady",
	},
	"food_processing": {
		"potravin", "pekár", "mlékár", "masn", "jateční", "zpracov",
		"konzerv", "balírn", "plnírn", "cukrov",
	},
	"plastics": {
		"plast", "polyethyl", "vstřikov", "extruze", "polypropylen",
		"termoplast", "laminát", "kompozit",
	},
}

// ClassifyIndustry derives industry tags from a Czech business description.
// Returns up to 3 tags sorted by confidence.
func ClassifyIndustry(description string) []IndustryTag {
	if description == "" {
		return nil
	}

	lower := strings.ToLower(description)
	var results []IndustryTag

	for tag, keywords := range industryKeywords {
		hits := 0
		for _, kw := range keywords {
			if strings.Contains(lower, kw) {
				hits++
			}
		}

		if hits == 0 {
			continue
		}

		// Confidence: more keyword hits = higher confidence
		// Normalize by keyword count to avoid bias toward tags with more keywords
		confidence := float64(hits) / float64(len(keywords))
		if confidence > 1.0 {
			confidence = 1.0
		}

		// Boost for multiple hits (compound signal)
		if hits >= 3 {
			confidence = min64(confidence*1.5, 1.0)
		}

		results = append(results, IndustryTag{Tag: tag, Confidence: confidence})
	}

	// Sort by confidence descending
	sortTags(results)

	// Max 3 tags
	if len(results) > 3 {
		results = results[:3]
	}

	return results
}

// TagStrings extracts tag names from IndustryTag slice.
func TagStrings(tags []IndustryTag) []string {
	s := make([]string, len(tags))
	for i, t := range tags {
		s[i] = t.Tag
	}
	return s
}

// MaxConfidence returns the highest confidence from tags.
func MaxConfidence(tags []IndustryTag) float64 {
	best := 0.0
	for _, t := range tags {
		if t.Confidence > best {
			best = t.Confidence
		}
	}
	return best
}

func sortTags(tags []IndustryTag) {
	// Simple insertion sort — max 10 items
	for i := 1; i < len(tags); i++ {
		key := tags[i]
		j := i - 1
		for j >= 0 && tags[j].Confidence < key.Confidence {
			tags[j+1] = tags[j]
			j--
		}
		tags[j+1] = key
	}
}

func min64(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
