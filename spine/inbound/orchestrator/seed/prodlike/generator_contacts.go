package prodlike

import (
	"crypto/sha256"
	"fmt"
	"math/rand/v2"
	"strings"
	"time"
)

// ContactDraft holds the shape of one outreach_contacts row, plus the
// domain key so the orchestrator can resolve it to a domain_id.
type ContactDraft struct {
	Email            string
	EmailHash        string
	Domain           string // foreign key resolved later
	FirstName        string
	LastName         string
	CompanyName      string
	ICO              string
	Phone            string
	Website          string
	Region           string
	IndustryTags     []string // primary tag first
	IndustryConfidence float64
	CompanySize      string
	LegalForm        string
	DescSnippet      string
	TargetingScore     float64
	TargetingFactors   map[string]any
	Status           string // new | active | blocked
	Source           string // SourceTag
	FirmyCzID        int    // maps to a CompanyDraft
	CompanyID        int    // resolved in SQL INSERT RETURNING stage
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// Industry tags that come from the enrichment keyword classifier in
// internal/enrich/industry.go. We only emit tags that the live classifier
// could plausibly produce, so the distribution remains realistic once
// the enrichment pipeline is re-run against this seed.
var contactIndustryWeights = []struct {
	Tag    string
	Weight int
}{
	{"construction", 150},
	{"automotive", 100},
	{"machinery", 90},
	{"agriculture", 85},
	{"transport", 65},
	{"woodwork", 58},
	{"metalwork", 48},
	{"energy", 45},
	{"manufacturing", 40},
	{"food_processing", 30},
	{"plastics", 25},
	{"waste", 12},
}

// GenerateContacts produces n contacts distributed across the supplied
// domain drafts using a Zipf-shaped per-domain count.
//
// Determinism: identical (rng seed, n, domains, r) → identical output.
//
// The email hash uses the same algorithm as internal/seed/seed.go
// (sha256 first 8 bytes) so upserts in outreach_contacts key cleanly.
func GenerateContacts(
	rng *rand.Rand,
	n int,
	companies []CompanyDraft,
	domains []DomainDraft,
	r Ratios,
	now time.Time,
) []ContactDraft {
	if n <= 0 || len(domains) == 0 || len(companies) == 0 {
		return nil
	}

	// Industry tag weighted picker (cached).
	tagWeights := make([]float64, len(contactIndustryWeights))
	for i, t := range contactIndustryWeights {
		tagWeights[i] = float64(t.Weight)
	}
	tagIdx := NewWeightedIndexer(tagWeights)

	consentWeights := []float64{r.ConsentAuto, r.ConsentLow, r.ConsentManual, r.ConsentBlock}
	consentIdx := NewWeightedIndexer(consentWeights)

	cityPick := CachedCityPicker()

	// Contacts-per-domain Zipf. Cap at min(50, domains/2) so the long tail
	// doesn't concentrate everyone on domain 0 when n is small.
	zipfMax := 50
	if len(domains) < 2 {
		zipfMax = 1
	} else if zipfMax > len(domains)/2 {
		zipfMax = len(domains) / 2
		if zipfMax < 1 {
			zipfMax = 1
		}
	}
	zipf := NewZipf(zipfMax, r.ContactsPerDomainAlpha)

	// Shuffle domains so Zipf's first-ranked slot isn't always the same
	// generated corporate domain.
	shuffled := make([]DomainDraft, len(domains))
	copy(shuffled, domains)
	rng.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })

	out := make([]ContactDraft, 0, n)
	usedEmails := make(map[string]struct{}, n)

	// Local helper: produce a realistic local-part (first.last, etc).
	localFor := func(first, last string) string {
		first = strings.ToLower(asciiFold(first))
		last = strings.ToLower(asciiFold(last))
		// Variety: sometimes first initial + lastname, sometimes full.
		pattern := rng.IntN(4)
		switch pattern {
		case 0:
			return first + "." + last
		case 1:
			return first[:1] + "." + last
		case 2:
			return first + last
		default:
			return last + "." + first
		}
	}

	for i := 0; i < n; i++ {
		// Domain by Zipf rank (1-indexed) modulo pool length.
		rank := zipf.Sample(rng)
		d := shuffled[(rank-1)%len(shuffled)]

		// Gender 50/50 decides which first-name pool.
		var first string
		if rng.IntN(2) == 0 {
			first = PickString(rng, MaleFirstNames)
		} else {
			first = PickString(rng, FemaleFirstNames)
		}
		last := PickString(rng, CzechSurnames)

		local := localFor(first, last)
		email := local + "@" + d.Domain

		// Ensure uniqueness — if collision, suffix with index.
		if _, ok := usedEmails[email]; ok {
			email = fmt.Sprintf("%s.%d@%s", local, i, d.Domain)
		}
		usedEmails[email] = struct{}{}

		// Region — Praha-heavy draw.
		region := cityPick(rng)
		if BernoulliCoverage(rng, r.PrahaConcentration) {
			region = "Praha"
		}

		// Industry tag: primary from weighted list; 30 % chance of a
		// second tag to exercise multi-tag paths.
		primary := contactIndustryWeights[tagIdx.Pick(rng)].Tag
		tags := []string{primary}
		if BernoulliCoverage(rng, 0.3) {
			second := contactIndustryWeights[tagIdx.Pick(rng)].Tag
			if second != primary {
				tags = append(tags, second)
			}
		}

		// Consent score — drawn per tier.
		tier := consentIdx.Pick(rng)
		score := TargetingScoreForTier(rng, tier)

		// Link to a company: use (firmyCzID % len(companies))+1 for a
		// roughly even mapping. Companies list is already shuffled across
		// domain types, so this is fine.
		companyIndex := rng.IntN(len(companies))
		company := companies[companyIndex]

		// Phone / website coverage samples.
		phone := ""
		if BernoulliCoverage(rng, r.PhoneCoverage) {
			phone = fmt.Sprintf("+420 999 %03d %03d",
				rng.IntN(1000), rng.IntN(1000))
		}
		website := ""
		if BernoulliCoverage(rng, r.WebsiteCoverage) {
			website = "https://www." + d.Domain
		}

		created := RecentTimestamp(rng, now, r.TemporalRecentDays)
		updated := created.Add(time.Duration(rng.IntN(86400)) * time.Second)

		out = append(out, ContactDraft{
			Email:              email,
			EmailHash:          emailHashForSeed(email),
			Domain:             d.Domain,
			FirstName:          first,
			LastName:           last,
			CompanyName:        company.Name,
			ICO:                company.ICO,
			Phone:              phone,
			Website:            website,
			Region:             region,
			IndustryTags:       tags,
			IndustryConfidence: 0.75 + rng.Float64()*0.20,
			CompanySize:        sampleCompanySize(rng, r, company.VelikostFirmy),
			LegalForm:          company.PravniForma,
			DescSnippet:        company.Description,
			TargetingScore:       score,
			TargetingFactors:     map[string]any{"source": "prodlike", "tier": tier},
			Status:             statusForScore(score),
			Source:             SourceTag,
			FirmyCzID:          company.FirmyCzID,
			CreatedAt:          created,
			UpdatedAt:          updated,
		})
	}
	return out
}

// sampleCompanySize picks the per-contact company_size. Prefer the
// company's velikost_firmy when present; otherwise honour the 91 %
// empty ratio from Ratios.VelikostFirmyEmpty.
func sampleCompanySize(rng *rand.Rand, r Ratios, fromCompany string) string {
	if fromCompany != "" {
		return fromCompany
	}
	if BernoulliCoverage(rng, r.VelikostFirmyEmpty) {
		return ""
	}
	weights := make([]float64, len(velikostFirmyBuckets))
	for i, b := range velikostFirmyBuckets {
		weights[i] = float64(b.Weight)
	}
	return velikostFirmyBuckets[WeightedChoice(rng, weights)].Label
}

// statusForScore maps a targeting score to a reasonable status so dashboards
// show a mix of active/blocked/new without needing a separate pipeline run.
func statusForScore(score float64) string {
	switch {
	case score < 0.2:
		return "blacklisted"
	case score < 0.4:
		return "new"
	default:
		return "active"
	}
}

// emailHashForSeed mirrors the hash algorithm used elsewhere in the
// codebase: lowercase the address, SHA256, keep first 8 bytes as hex.
func emailHashForSeed(email string) string {
	h := sha256.Sum256([]byte(strings.ToLower(email)))
	return fmt.Sprintf("%x", h[:8])
}

// asciiFold strips Czech diacritics so email local parts stay within
// the ASCII subset that SMTP and most validators accept.
func asciiFold(s string) string {
	// Table covers the Czech diacritics used in the corpora above.
	rep := strings.NewReplacer(
		"á", "a", "Á", "A",
		"č", "c", "Č", "C",
		"ď", "d", "Ď", "D",
		"é", "e", "É", "E",
		"ě", "e", "Ě", "E",
		"í", "i", "Í", "I",
		"ň", "n", "Ň", "N",
		"ó", "o", "Ó", "O",
		"ř", "r", "Ř", "R",
		"š", "s", "Š", "S",
		"ť", "t", "Ť", "T",
		"ú", "u", "Ú", "U",
		"ů", "u", "Ů", "U",
		"ý", "y", "Ý", "Y",
		"ž", "z", "Ž", "Z",
	)
	return rep.Replace(s)
}
