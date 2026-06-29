package classify

// CategoryPathMap maps normalized firmy.cz category_path segments to sector codes.
//
// Normalization: lowercase the segment, replace hyphens with spaces.
// e.g. "Obrabeni-kovu" → "obrabeni kovu"
//
// The classifier splits the full path on " > ", normalizes each segment,
// and does an exact lookup here. More-specific segments (leaf nodes) naturally
// provide higher signal — the map only contains segments that are unambiguous.
var CategoryPathMap = map[string]string{
	// ── Machinery / Strojírenství ───────────────────────────────────────────
	"strojirenstvi":                           "machinery",
	"projektove prace ve strojirenstvi":       "machinery",
	"vyroba prumyslovych stroju a vybaveni":   "machinery",
	"vyrobci stroju pro vyrobu":               "machinery",
	"vyroba strojnich soucasti a komponentu":  "machinery",
	"nastrojarny":                             "machinery",
	"obrabecstvi":                             "machinery",
	"obrabeni kovu":                           "machinery",
	"frezovani":                               "machinery",
	"paleni kovu":                             "machinery",
	"vyrobci hydraulicke techniky":            "machinery",
	"vyrobci pneumaticke techniky":            "machinery",
	"vyrobci ridici a automatizacni techniky": "machinery",
	"vyrobci forem":                           "machinery",
	"servis prumyslovych stroju a vybaveni":   "machinery",
	"opravny prumyslovych stroju a vybaveni":  "machinery",
	"prumyslovy design":                       "machinery",

	// ── Metalwork / Kovovýroba ──────────────────────────────────────────────
	"kovovyroba":                    "metalwork",
	"kovarstvi":                     "metalwork",
	"svarovani":                     "metalwork",
	"hutnictvi":                     "metalwork",
	"vyrobci hutnickych vyrobku":    "metalwork",
	"slevarny":                      "metalwork",
	"vyrobci kovovych polotovaru":   "metalwork",
	"vyrobci kovovych soucastek":    "metalwork",
	"ocelove konstrukce":            "metalwork",
	"nerez":                         "metalwork",
	"vyrobci armatur":               "metalwork",
	"prumyslove lakovani":           "metalwork",
	"praskove lakovani":             "metalwork",
	"povrchove upravy":              "metalwork",
	"upravy kovu":                   "metalwork",
	"galvanizace":                   "metalwork",
	"dily pro automobilovy prumysl": "automotive",

	// ── Woodwork / Dřevozpracování ──────────────────────────────────────────
	"truhlarstvi":                "woodwork",
	"vyroba zakazkoveho nabytku": "woodwork",
	"bednarstvi":                 "woodwork",
	"tesarstvi":                  "woodwork",
	"drevenych polotovaru":       "woodwork",
	"drevoobrabecich stroju":     "woodwork",

	// ── Plastics / Plasty ───────────────────────────────────────────────────
	"vstrikovani plastu": "plastics",
	"vyroba plastu":      "plastics",
	"gumovani":           "plastics",
	"plasticke hmoty":    "plastics",

	// ── Construction / Stavebnictví ─────────────────────────────────────────
	"stavebni firmy":                       "construction",
	"stavebni sluzby":                      "construction",
	"pozemni a vykopove prace":             "construction",
	"zednicke prace":                       "construction",
	"prumyslove stavby":                    "construction",
	"novostavby":                           "construction",
	"zateplovaci systemy":                  "construction",
	"instalaterske prace":                  "construction",
	"instalaterstvi a topenarstvi":         "construction",
	"tesarstvi pokryvacstvi a klempirstvi": "construction",
	"pokryvacstvi":                         "construction",
	"klempirstvi":                          "construction",
	"projektove prace":                     "construction",

	// ── Energy / Energetika ─────────────────────────────────────────────────
	"fotovoltaicke systemy":                    "energy",
	"tepelna cerpadla":                         "energy",
	"rozvody a vyrobci elektriny plynu a vody": "energy",
	"elektrikarstvi":                           "energy",
	"vyroba vzduchotechniky":                   "energy",
	"kotelny":                                  "energy",

	// ── Electronics / Elektronika ───────────────────────────────────────────
	"elektroservisy": "electronics",
	"prodejci elektrotechnickych zarizeni a pristroju": "electronics",
	"prodejci merici techniky":                         "electronics",

	// ── IT ──────────────────────────────────────────────────────────────────
	"pocitacove a internetove sluzby": "it",
	"webdesignove sluzby":             "it",
	"vyvoj softwaru":                  "it",
	"it podpora":                      "it",
	"prodejci hardwaru":               "it",
	"prodej softwaru":                 "it",

	// ── Transport / Doprava ─────────────────────────────────────────────────
	"nakladni silnicni preprava":       "transport",
	"nakladni doprava":                 "transport",
	"spedicni sluzby":                  "transport",
	"logisticke centrum":               "transport",
	"skladovaci sluzby":                "transport",
	"postovni a dorucovatelske sluzby": "transport",

	// ── Agriculture / Zemědělství ───────────────────────────────────────────
	"vyrobci zemedelskych komodit": "agriculture",
	"zemedelske farmy":             "agriculture",
	"lesnictvi":                    "agriculture",
	"rostlinna vyroba":             "agriculture",
	"zivocisna vyroba":             "agriculture",
	"rybareni":                     "agriculture",

	// ── Food Processing / Potravinářství ────────────────────────────────────
	"vyrobci potravin": "food_processing",
	"pekarenstvi":      "food_processing",
	"mlekarna":         "food_processing",
	"masna vyroba":     "food_processing",
	"lihovary":         "food_processing",
	"vinarstvi":        "food_processing",

	// ── Chemicals / Chemie ──────────────────────────────────────────────────
	"vyrobci chemie a drogerie": "chemicals",
	"chemicka vyroba":           "chemicals",
	"laky a barvy":              "chemicals",

	// ── Waste / Odpady ──────────────────────────────────────────────────────
	"sber a zpracovani odpadu": "waste",
	"recyklace":                "waste",
	"svoz odpadu":              "waste",

	// ── Printing / Tisk ─────────────────────────────────────────────────────
	"polygraficke sluzby": "printing",
	"tiskarny":            "printing",

	// ── Automotive ──────────────────────────────────────────────────────────
	"autoservisy": "automotive",
	"pneuservisy": "automotive",
	"autolakovny": "automotive",

	// ── Health / Zdravotnictví ──────────────────────────────────────────────
	"zdravotnicke sluzby": "health",
	"lekarske ordinace":   "health",
	"lekarny":             "health",

	// ── Education / Vzdělávání ──────────────────────────────────────────────
	"vzdelavaci instituce": "education",
	"vyukove sluzby":       "education",

	// ── Finance ─────────────────────────────────────────────────────────────
	"bankovni a sporitelni sluzby": "finance",
	"ucetni sluzby":                "finance",
	"pojistovaci sluzby":           "finance",
	"financni poradenstvi":         "finance",

	// ── Real Estate / Nemovitosti ───────────────────────────────────────────
	"realitni kancelare": "real_estate",
	"reality":            "real_estate",

	// ── Hospitality ─────────────────────────────────────────────────────────
	"restaurace":         "hospitality",
	"hospody a hostince": "hospitality",
	"kavarny":            "hospitality",
	"bary":               "hospitality",
	"penziony":           "hospitality",
	"ubytovaci sluzby":   "hospitality",
	// Additional firmy.cz hospitality slugs
	"restauracni a pohostinske sluzby": "hospitality",

	// ── Textiles ────────────────────────────────────────────────────────────
	"vyrobci textilu odevu a obuvi": "textiles",
	"prodejci obleceni":             "textiles",

	// ── Adult (anti-target) ─────────────────────────────────────────────────
	// firmy.cz uses both hyphenated and underscored variants of this slug.
	// normalizeCategorySegment replaces hyphens with spaces, so "eroticke-firmy"
	// becomes "eroticke firmy"; underscores are preserved so "eroticke_firmy"
	// stays literal.
	"eroticke firmy": "adult",
	"eroticke_firmy": "adult",
	"erotika":        "adult",

	// ── Tourism (anti-target) ───────────────────────────────────────────────
	"cestovni sluzby":    "tourism",
	"cestovni kancelare": "tourism",
	"cestovni agentury":  "tourism",

	// ── Personal services (anti-target) ─────────────────────────────────────
	"kadernictvi":             "personal_services",
	"kadernictvi a kosmetika": "personal_services",
	"kosmeticke sluzby":       "personal_services",

	// ── Professional services (anti-target for machinery dealer) ────────────
	"advokatni kancelare": "professional",
	"pravni sluzby":       "professional",
	// Note: "ucetni sluzby" → "finance" is declared earlier in this map.
	// Machinery dealers treat both "finance" and "professional" as anti-target,
	// so the existing mapping already produces the correct tier cap.

	// ── Retail (anti-target) ────────────────────────────────────────────────
	"obchody a obchudky": "retail",
	"e shop":             "retail",
	"eshop":              "retail",

	// ── Real estate (anti-target) ───────────────────────────────────────────
	"realitni sluzby": "real_estate",
}
