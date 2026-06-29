package humanize

import (
	"strings"
	"unicode"
)

// RestoreDiacritics walks an ASCII Czech string and probabilistically
// restores diacritics on common business-email words (whole-word
// matches only, case preserved). The restorer is the inverse of
// ImperfectEngine.degradeDiacritics — when an upstream layer (template,
// ASCII normalisation, transliteration) strips diacritics, this
// function re-injects them so the outbound body matches the diacritic
// density of authentic Czech business email.
//
// Background: 2026-05-01 brutal humanlike scoring measured 0/36 emails
// containing diacritics — a hard fingerprint signal because real CZ
// business email always contains diacritics. Restorer targets ~125
// high-frequency template words to lift density above the
// "clearly machine-generated" floor without producing unnatural
// over-diacritization.
//
// keepProb in [0.0, 1.0] is the per-occurrence restoration probability.
// 1.0 always restores; 0.0 never restores. Production callers use
// 0.55–0.80.
//
// Restoration is whitespace/punctuation aware: word boundaries are
// detected via Unicode letter classes so "naseho." → "našeho." restores
// only the alpha run.
func RestoreDiacritics(text string, keepProb float64) string {
	if text == "" || keepProb <= 0 {
		return text
	}
	if keepProb > 1 {
		keepProb = 1
	}

	var (
		out  strings.Builder
		word strings.Builder
	)
	out.Grow(len(text))

	flush := func() {
		if word.Len() == 0 {
			return
		}
		w := word.String()
		word.Reset()
		// Idempotency: a word that already contains a diacritic rune is
		// passed through unchanged. Prevents double-substitution.
		if hasDiacriticRune(w) {
			out.WriteString(w)
			return
		}
		lower := strings.ToLower(w)
		if replacement, ok := diacriticsRestoreMap[lower]; ok {
			if cryptoRandFloat() < keepProb {
				out.WriteString(applyCase(w, replacement))
				return
			}
		}
		out.WriteString(w)
	}

	for _, r := range text {
		if unicode.IsLetter(r) {
			word.WriteRune(r)
			continue
		}
		flush()
		out.WriteRune(r)
	}
	flush()
	return out.String()
}

// hasDiacriticRune reports whether s contains any rune outside ASCII.
func hasDiacriticRune(s string) bool {
	for _, r := range s {
		if r > unicode.MaxASCII {
			return true
		}
	}
	return false
}

// applyCase preserves the case shape of the source token when emitting
// the diacritised replacement: all-upper, capitalised first rune, or
// all-lower. Mixed-case falls back to lower-cased dictionary form.
func applyCase(source, replacement string) string {
	if source == "" {
		return replacement
	}
	srcRunes := []rune(source)
	repRunes := []rune(replacement)
	if len(repRunes) == 0 {
		return replacement
	}

	if isAllUpper(srcRunes) {
		return strings.ToUpper(replacement)
	}
	if unicode.IsUpper(srcRunes[0]) && isAllLowerRest(srcRunes) {
		first := unicode.ToUpper(repRunes[0])
		rest := strings.ToLower(string(repRunes[1:]))
		return string(first) + rest
	}
	return strings.ToLower(replacement)
}

func isAllUpper(rs []rune) bool {
	hasLetter := false
	for _, r := range rs {
		if unicode.IsLetter(r) {
			hasLetter = true
			if !unicode.IsUpper(r) {
				return false
			}
		}
	}
	return hasLetter
}

func isAllLowerRest(rs []rune) bool {
	if len(rs) <= 1 {
		return true
	}
	for _, r := range rs[1:] {
		if unicode.IsLetter(r) && !unicode.IsLower(r) {
			return false
		}
	}
	return true
}

// diacriticsRestoreMap is a curated dictionary of high-frequency Czech
// business-email words in their ASCII form mapped to the diacritised
// canonical form. ~125 entries covering greetings, pronouns, verbs of
// inquiry, machinery-domain nouns, and closing phrases.
var diacriticsRestoreMap = map[string]string{
	// Greetings (tone.go GreetingForStep set)
	"dobry":    "dobrý",
	"dobre":    "dobré",
	"dobrou":   "dobrou",
	"dobrym":   "dobrým",
	"dobrymi":  "dobrými",
	"vazeny":   "vážený",
	"vazena":   "vážená",
	"vazene":   "vážené",
	"vazeneho": "váženého",
	"zdravim":  "zdravím",
	"prejeme":  "přejeme",
	"preji":    "přeji",
	"preje":    "přeje",
	"krasny":   "krásný",
	"krasne":   "krásné",

	// Pronouns / determiners
	"vas":     "váš",
	"vase":    "vaše",
	"vasi":    "vaši",
	"vaseho":  "vašeho",
	"vasemu":  "vašemu",
	"vasem":   "vašem",
	"vasim":   "vaším",
	"vasimi":  "vašimi",
	"nas":     "náš",
	"nase":    "naše",
	"nasi":    "naši",
	"naseho":  "našeho",
	"nasemu":  "našemu",
	"nasem":   "našem",
	"nasim":   "naším",
	"prosim":  "prosím",
	"prosime": "prosíme",

	// Verbs of inquiry / business intent
	"hledame":    "hledáme",
	"hledam":     "hledám",
	"poptavame":  "poptáváme",
	"poptavam":   "poptávám",
	"nabizime":   "nabízíme",
	"nabizim":    "nabízím",
	"posilam":    "posílám",
	"posilame":   "posíláme",
	"prikladam":  "přikládám",
	"prikladame": "přikládáme",
	"dekuji":     "děkuji",
	"dekujeme":   "děkujeme",
	"dekujem":    "děkujem",
	"tesim":      "těším",
	"tesime":     "těšíme",
	"ozvete":     "ozvěte",
	"ozvu":       "ozvu",
	"reaguji":    "reaguji",
	"navazuji":   "navazuji",
	"odpovidam":  "odpovídám",
	"odpovidame": "odpovídáme",
	"vidim":      "vidím",
	"slysim":     "slyším",

	// Domain nouns
	"poptavka":   "poptávka",
	"poptavku":   "poptávku",
	"poptavky":   "poptávky",
	"zajem":      "zájem",
	"zajmu":      "zájmu",
	"stroju":     "strojů",
	"stroj":      "stroj",
	"stroje":     "stroje",
	"vozidlo":    "vozidlo",
	"vozidel":    "vozidel",
	"prace":      "práce",
	"praci":      "práci",
	"spoluprace": "spolupráce",
	"spolupraci": "spolupráci",
	"odpoved":    "odpověď",
	"odpovedi":   "odpovědi",
	"reseni":     "řešení",
	"resenim":    "řešením",
	"nabidky":    "nabídky",
	"nabidka":    "nabídka",
	"nabidku":    "nabídku",
	"cena":       "cena",
	"ceny":       "ceny",
	"cenu":       "cenu",
	"cenik":      "ceník",
	"ceniku":     "ceníku",
	"cenovou":    "cenovou",

	// Time / planning
	"pristi":   "příští",
	"pristim":  "příštím",
	"pristich": "příštích",
	"prubeh":   "průběh",
	"prubehu":  "průběhu",
	"behem":    "během",
	"tyden":    "týden",
	"tydne":    "týdně",
	"tydnu":    "týdnů",
	"mesic":    "měsíc",
	"mesice":   "měsíce",
	"mesicu":   "měsíců",
	"casu":     "času",
	"cas":      "čas",
	"vcera":    "včera",
	"dnes":     "dnes",
	"zitra":    "zítra",
	"brzy":     "brzy",

	// Closing phrases
	"radi": "rádi",
	// "rad"→"rád" and "rada"→"ráda" removed: homographs. ASCII "rad"/"rada"
	// are far more often the common nouns "rad" (gen. pl. of rada = of
	// councils/advice) and "rada" (council/advice/board) than the closing
	// adverb "rád/ráda" (gladly) — restoring would corrupt valid Czech.
	"ucta":  "úcta",
	"uctou":   "úctou",
	"prejem":  "přejem",
	"loucim":  "loučím",
	"loucime": "loučíme",

	// Misc high-frequency
	"muze":    "může",
	"muzeme":  "můžeme",
	"muzete":  "můžete",
	"chteli":  "chtěli",
	"chtela":  "chtěla",
	"chtel":   "chtěl",
	"chteji":  "chtějí",
	"vime":    "víme",
	"vim":     "vím",
	// "viz"→"víz" removed: corrupts the correct Czech "viz" (= see/cf.,
	// imperative of vidět) into "víz" (= visas, gen. pl.).
	"reknete": "řekněte",
	"rekne":   "řekne",
	"reknu":   "řeknu",
	"vetsi":   "větší",
	"mensi":   "menší",
	"sirsi":   "širší",
	"ulehci":  "ulehčí",
	"snadno":  "snadno",
	"opravdu": "opravdu",
	"urcite":  "určitě",
	"klidne":  "klidně",
	"behu":    "běhu",
	"vcetne":  "včetně",

	// Communication
	"telefon": "telefon",
	"emailu":  "emailu",
	"zpravy":  "zprávy",
	"zpravu":  "zprávu",
	"vzkazem": "vzkazem",
	"vzkaz":   "vzkaz",

	// Quantifiers
	"vice":   "více",
	"mene":   "méně",
	"velmi":  "velmi",
	"trochu": "trochu",
	"jeste":  "ještě",
}
