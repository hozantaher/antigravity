package exclusion

import "regexp"

// HardBlockForms: entities we NEVER contact.
var HardBlockForms = map[string]bool{
	"Organizační složka státu":            true,
	"Státní podnik":                       true,
	"Státní příspěvková organizace":       true,
	"Územní samosprávný celek":            true,
	"Dobrovolný svazek obcí":              true,
	"Regionální rada regionu soudržnosti": true,
	"Veřejná výzkumná instituce":          true,
	"Fond (veřejnoprávní)":                true,
}

// SoftBlockForms: entities with low B2B relevance.
var SoftBlockForms = map[string]bool{
	"Příspěvková organizace":                true,
	"Spolek":                                true,
	"Zapsaný spolek":                        true,
	"Zapsaný ústav":                         true,
	"Obecně prospěšná společnost":           true,
	"Nadace":                                true,
	"Nadační fond":                          true,
	"Církevní organizace":                   true,
	"Školská právnická osoba":               true,
	"Odborová organizace":                   true,
	"Organizace zaměstnavatelů":             true,
	"Zájmové sdružení právnických osob":     true,
	"Politická strana, politické hnutí":     true,
	"Honební společenstvo":                  true,
	"Společenství vlastníků jednotek":       true,
}

// CommercialForms: commercial entities — NEVER block based on name alone.
var CommercialForms = map[string]bool{
	"Společnost s ručením omezeným":              true,
	"Akciová společnost":                         true,
	"Komanditní společnost":                      true,
	"Veřejná obchodní společnost":                true,
	"Podnikající fyzická osoba":                  true,
	"Družstvo":                                   true,
	"Evropská společnost":                        true,
	"Evropské hospodářské zájmové sdružení":      true,
}

// HardBlockNACE: 4-digit CZ-NACE codes that trigger hard block.
var HardBlockNACE = map[string]bool{
	"8411": true, // Všeobecná veřejná správa
	"8412": true, // Regulace zdravotnictví, vzdělávání, kultury
	"8413": true, // Regulace hospodářské soutěže
	"8421": true, // Zahraniční věci
	"8422": true, // Obrana
	"8423": true, // Justice
	"8424": true, // Veřejný pořádek a bezpečnost
	"8425": true, // Požární ochrana
	"8430": true, // Povinné sociální pojištění
	"9411": true, // Činnosti obchodních komor
	"9420": true, // Odbory
	"9491": true, // Náboženské organizace
	"9900": true, // Exteritoriální organizace
}

// SoftBlockNACE: NACE codes with low B2B relevance.
var SoftBlockNACE = map[string]bool{
	"9412": true, // Profesní organizace
	"9492": true, // Politické organizace
	"9499": true, // Ostatní členské organizace
	"8510": true, // Předškolní vzdělávání
	"8520": true, // Základní vzdělávání
	"8531": true, // Střední všeobecné vzdělávání
	"8541": true, // Postsekundární nevysokoškolské
	"8542": true, // Vysokoškolské
}

// HardBlockDomains: email domains that trigger hard block.
var HardBlockDomains = map[string]bool{
	"justice.cz": true, "army.cz": true, "policie.cz": true,
	"cssz.cz": true, "mfcr.cz": true, "mvcr.cz": true,
	"mpsv.cz": true, "mzp.cz": true, "mmr.cz": true,
	"msmt.cz": true, "mpo.cz": true, "mze.cz": true,
	"mdcr.cz": true, "mzv.cz": true, "mo.cz": true,
	"mkcr.cz": true, "msp.cz": true,
	"uoou.cz": true, "uohs.cz": true, "nku.cz": true,
	"eru.cz": true, "ctu.cz": true, "coi.cz": true,
	"szpi.cz": true, "cuzk.cz": true, "sfrb.cz": true,
	"nukib.cz": true, "avcr.cz": true,
	"vlada.cz": true, "hrad.cz": true, "senat.cz": true,
	"psp.cz": true,
}

// Compiled name patterns — initialized once.
var hardBlockNameRegexps []*regexp.Regexp
var softBlockNameRegexps []*regexp.Regexp

func init() {
	hardPatterns := []string{
		`(?i)^Ministerstvo\b`,
		`(?i)^(Krajský|Okresní|Městský|Obvodní|Vrchní|Nejvyšší)\s+(soud|státní zastupitelství)`,
		`(?i)^Policie\s+České\s+republiky`,
		`(?i)^Hasičský\s+záchranný\s+sbor`,
		`(?i)^Finanční\s+(úřad|ředitelství)`,
		`(?i)^Celní\s+(úřad|správa|ředitelství)`,
		`(?i)^Katastrální\s+(úřad|pracoviště)`,
		`(?i)^Úřad\s+(pro|práce|vlády)`,
		`(?i)^Česká\s+(správa|inspekce|obchodní inspekce)`,
		`(?i)^Státní\s+(fond|pozemkový|ústav|veterinární)`,
		`(?i)^Krajská\s+(hygienická|veterinární)`,
		`(?i)^Generální\s+(ředitelství|inspekce|finanční)`,
		`(?i)^(Věznice|Vazební\s+věznice|Vězeňská\s+služba)`,
		`(?i)^Ústavní\s+soud`,
		`(?i)^Nejvyšší\s+(kontrolní|správní)`,
		`(?i)^Veřejný\s+ochránce\s+práv`,
	}
	for _, p := range hardPatterns {
		hardBlockNameRegexps = append(hardBlockNameRegexps, regexp.MustCompile(p))
	}

	softPatterns := []string{
		`(?i)^(Základní|Mateřská|Střední|Vyšší odborná)\s+škola`,
		`(?i)^(Gymnázium|Konzervatoř)`,
		`(?i)^Fakultní\s+nemocnice`,
		`(?i)^Domov\s+(pro\s+seniory|důchodců|s\s+pečovatelskou)`,
		`(?i)^Dětský\s+domov`,
		`(?i)^(Městská|Obecní)\s+(knihovna|policie|galerie|muzeum)`,
		`(?i)^(Technické\s+služby|Správa\s+a\s+údržba)\s+města`,
	}
	for _, p := range softPatterns {
		softBlockNameRegexps = append(softBlockNameRegexps, regexp.MustCompile(p))
	}
}
