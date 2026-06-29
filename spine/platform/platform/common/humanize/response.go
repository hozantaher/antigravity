package humanize

import (
	"math"
	"strings"
	"time"
)

// ResponseEngine models realistic reply behavior.
type ResponseEngine struct{}

// NewResponseEngine creates a response engine.
func NewResponseEngine() *ResponseEngine {
	return &ResponseEngine{}
}

// ReplyType classifies the prospect's response.
type ReplyType int

const (
	ReplyInterested   ReplyType = iota // "Tell me more"
	ReplyMeeting                        // "Let's schedule a call"
	ReplyLater                          // "Not now, maybe later"
	ReplyObjection                      // Pushback
	ReplyNegative                       // "Not interested" / "Unsubscribe"
	ReplyAutoOOO                        // Out of office
)

// ReplyDelay returns the realistic delay before responding to a reply.
// Uses log-normal distribution matching real human behavior.
func (r *ResponseEngine) ReplyDelay(replyType ReplyType) time.Duration {
	var meanMinutes float64

	switch replyType {
	case ReplyInterested:
		meanMinutes = 45 // 15-90 min
	case ReplyMeeting:
		meanMinutes = 15 // 5-30 min
	case ReplyLater:
		meanMinutes = 240 // 2-8 hours
	case ReplyObjection:
		meanMinutes = 120 // 1-4 hours
	case ReplyNegative:
		meanMinutes = 480 // 4-24 hours
	case ReplyAutoOOO:
		return 0 // No reply to OOO
	}

	// Log-normal distribution for realistic variance
	logMean := math.Log(meanMinutes)
	logStd := 0.5

	sample := math.Exp(logMean + logStd*normalRand())
	if sample < 5 {
		sample = 5
	}
	if sample > 1440 { // cap at 24 hours
		sample = 1440
	}

	return time.Duration(sample) * time.Minute
}

// ShouldMirrorTone returns true if we should match the prospect's formality.
func (r *ResponseEngine) ShouldMirrorTone() bool {
	return true // Always mirror -- this is human nature
}

// ClassifyReply attempts to classify a reply based on keywords.
//
// Normalisation: input is lowered AND non-breaking-space variants are
// converted to regular ASCII space before keyword matching. Without this,
// a recipient typing "nemáme zájem" with a non-breaking space (NBSP, U+00A0)
// — which Outlook/Word/macOS auto-correct often produces between Czech
// words — would silently evade the negative classifier and get treated
// as ReplyInterested. Same for narrow no-break (U+202F), figure space
// (U+2007), and zero-width chars used for typography or evasion.
func (r *ResponseEngine) ClassifyReply(text string) ReplyType {
	lower := normaliseWhitespace(toLower(text))

	// OOO detection — both Czech + English vacation/leave variants because
	// recipients frequently set up English-language auto-replies even when
	// the original message is Czech.
	// "dovolen" stem matches dovolená/dovolené/dovolenou; "nepřítomn" same.
	oooKeywords := []string{
		"mimo kancelář", "out of office", "dovolen", "nepřítomn",
		"on vacation", "on holiday", "annual leave", "auto-reply",
		"automatic reply",
	}
	for _, kw := range oooKeywords {
		if containsStr(lower, kw) {
			return ReplyAutoOOO
		}
	}

	// Negative — singular ("nemám zájem", "nezajímá") in addition to plural
	// ("nemáme zájem"). Czech B2B replies very often use 1st person singular
	// ("Nemám zájem", "Nezajímá mě to") which previously evaded the keyword.
	negKeywords := []string{
		"nemáme zájem", "nemám zájem", "nezájem", "nezajímá",
		"odhlásit", "neobtěžujte", "nechci", "spam", "neposílejte",
		"unsubscribe", "remove me", "not interested",
	}
	for _, kw := range negKeywords {
		if containsStr(lower, kw) {
			return ReplyNegative
		}
	}

	// Meeting
	meetKeywords := []string{"zavolej", "sejděme se", "schůzk", "termín", "hovor", "call"}
	for _, kw := range meetKeywords {
		if containsStr(lower, kw) {
			return ReplyMeeting
		}
	}

	// Objection — pushback proti ceně, konkurenci, integraci, rozpočtu.
	// Musí běžet PŘED Interested, protože "cena vysoká" by jinak spadla
	// do posKeywords (klíč "cena") jako Interested. Reálné B2B objekce
	// mají specifické keywords (drahé, rozpočet, konkurence, integrace,
	// už máme), které nejsou v posKeywords. Source: B-2 retrospective
	// PR #389 (closed) — humanize.ClassifyReply chyběla objection větev,
	// všechny pushback bodies šly do ReplyInterested.
	objKeywords := []string{
		"vysoká", "vysoke", "drahé", "drahy", "drahá",
		"rozpočet", "rozpocet", "není v rozpočtu",
		"konkurenc", "podobné řešení", "podobny", "už máme", "uz mame",
		"integrac", "kompatibilita", "neumí", "neumi",
	}
	for _, kw := range objKeywords {
		if containsStr(lower, kw) {
			return ReplyObjection
		}
	}

	// Interested
	posKeywords := []string{"zájem", "řekněte víc", "pošlete", "nabíd", "kolik", "cena", "ceník"}
	for _, kw := range posKeywords {
		if containsStr(lower, kw) {
			return ReplyInterested
		}
	}

	// Later
	laterKeywords := []string{"později", "příště", "teď ne", "momentálně", "za měsíc", "na podzim"}
	for _, kw := range laterKeywords {
		if containsStr(lower, kw) {
			return ReplyLater
		}
	}

	// Default to interested (better to respond fast than slow)
	return ReplyInterested
}

// normalRand returns a normally distributed random value (Box-Muller).
func normalRand() float64 {
	u1 := cryptoRandFloat()
	u2 := cryptoRandFloat()
	if u1 < 1e-10 {
		u1 = 1e-10
	}
	return math.Sqrt(-2*math.Log(u1)) * math.Cos(2*math.Pi*u2)
}

func toLower(s string) string {
	return strings.ToLower(s)
}

// normaliseWhitespace replaces unicode whitespace variants with regular
// ASCII spaces so multi-word keyword lookups don't break when the source
// uses NBSP, narrow no-break, figure space, etc. — typically inserted
// by Outlook/Word/macOS auto-typography or as a deliberate evasion.
//
// Replacements applied (in order):
//   U+00A0 NO-BREAK SPACE         (0xC2 0xA0)
//   U+202F NARROW NO-BREAK SPACE  (0xE2 0x80 0xAF)
//   U+2007 FIGURE SPACE           (0xE2 0x80 0x87)
//   U+2009 THIN SPACE             (0xE2 0x80 0x89)
//   U+200B ZERO WIDTH SPACE       (0xE2 0x80 0x8B)
//   U+FEFF ZERO WIDTH NO-BREAK    (0xEF 0xBB 0xBF — also UTF-8 BOM)
//   tabs                          (0x09)
//
// All collapse to ASCII space (0x20). Multiple consecutive spaces are
// deliberately left alone because keyword strings already contain single
// spaces and "  " inside a word still passes single-space lookups.
func normaliseWhitespace(s string) string {
	r := strings.NewReplacer(
		"\u00a0", " ", // NO-BREAK SPACE (NBSP)
		"\u202f", " ", // NARROW NO-BREAK SPACE
		"\u2007", " ", // FIGURE SPACE
		"\u2009", " ", // THIN SPACE
		"\u200b", " ", // ZERO WIDTH SPACE
		"\ufeff", " ", // ZERO WIDTH NO-BREAK / UTF-8 BOM
		"\t", " ",
	)
	return r.Replace(s)
}

func containsStr(s, substr string) bool {
	return len(s) >= len(substr) && searchStr(s, substr) >= 0
}

func searchStr(s, substr string) int {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}
