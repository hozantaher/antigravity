package prodlike

import "fmt"

// FreemailTestDomains mirrors the role of the top Czech freemails in
// prod (seznam.cz, gmail.com, email.cz, centrum.cz, volny.cz, ...)
// but uses .test TLD so these domains can never resolve or accept mail.
//
// The `realName` metadata lets tests verify that the consent-score
// freemail penalty path triggers even when the fake name mirrors a real
// provider's label.
type FreemailAlias struct {
	Domain   string // .test TLD
	RealName string // informational, for diagnostics/logs
}

var FreemailTestDomains = []FreemailAlias{
	{"seznam.test", "seznam.cz"},
	{"gmail.test", "gmail.com"},
	{"email-cz.test", "email.cz"},
	{"centrum.test", "centrum.cz"},
	{"volny.test", "volny.cz"},
	{"tiscali.test", "tiscali.cz"},
	{"post.test", "post.cz"},
	{"atlas.test", "atlas.cz"},
	{"quick.test", "quick.cz"},
	{"iol.test", "iol.cz"},
}

// GovTestDomains are synthetic .test domains that classify as "gov".
// Consent-score code penalises contacts at these domains (-0.3) because
// public-sector outreach is high-risk in a B2B campaign.
var GovTestDomains = []string{
	"praha-gov.test",
	"brno-gov.test",
	"ministerstvo.test",
	"kraj-stredocesky.test",
}

// EduTestDomains classify as "edu" in ClassifyDomain.
var EduTestDomains = []string{
	"cvut.test",
	"cuni.test",
	"muni.test",
	"vutbr.test",
}

// domainRoots is the base vocabulary for generated corporate domains.
// Each root is paired with a numeric suffix to produce up to
// len(domainRoots) * 999 = ~40 000 unique host names.
var domainRoots = []string{
	"strojirna", "kovarna", "stavby", "plasty", "cnc",
	"agro", "svarna", "transport", "kovy", "drevovyroba",
	"technika", "guma", "jerabova", "pila", "obrabeni",
	"logistika", "farma", "hutnictvi", "elektro", "zamecnictvi",
	"konstrukce", "montaze", "servisy", "projekty", "odlevarna",
	"valcovna", "brusirna", "frezarna", "soustruzna", "galvanovna",
	"tvarovani", "obalovna", "baleni", "recyklace", "energie",
	"solar", "automatika", "regulace", "pneumatika", "hydraulika",
}

// GenerateCorporateDomains produces n unique .test corporate domains,
// deterministically named. Called by the generator to populate
// outreach_domains with realistic long-tail coverage.
//
// Layout: "<root>-<num>.test" where num is a zero-padded sequential index.
// For n > len(domainRoots), the generator cycles through roots and
// increments num; for n > 40000 it starts adding a region suffix.
//
// Examples: "strojirna-001.test", "kovarna-042.test".
func GenerateCorporateDomains(n int) []string {
	if n <= 0 {
		return nil
	}
	out := make([]string, 0, n)
	regions := []string{"", "praha", "brno", "ostrava", "plzen", "zlin"}
	roots := len(domainRoots)
	// k indexes the region suffix; we only use regions > 0 once the
	// root×num space (40k) is exhausted. For small n this stays "".
	k := 0
	for i := 0; i < n; i++ {
		root := domainRoots[i%roots]
		num := (i / roots) + 1
		var domain string
		if k == 0 {
			domain = fmt.Sprintf("%s-%03d.test", root, num)
		} else {
			domain = fmt.Sprintf("%s-%s-%03d.test", root, regions[k], num)
		}
		out = append(out, domain)
		// Switch to next region suffix once num overflows 999.
		if num >= 999 && i%roots == roots-1 {
			k++
			if k >= len(regions) {
				k = 1 // wrap; guarantees progress even past 240k
			}
		}
	}
	return out
}

// BusinessTestDomains are a handful of domains meant to classify as
// "business" by ClassifyDomain (reserved non-corporate brands, etc.).
// Production only has ~2 000 of these (0.9 %) but including a few lets
// the classification path get exercised at small scale.
var BusinessTestDomains = []string{
	"alza-eshop.test",
	"cpost-doprava.test",
	"ppl-balik.test",
	"gls-preprava.test",
	"csob-bank.test",
	"kb-bank.test",
	"csas-bank.test",
	"re-max-reality.test",
	"ifortuna-sazky.test",
	"generaliceska-pojisteni.test",
}
