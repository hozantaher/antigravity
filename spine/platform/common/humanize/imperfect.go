package humanize

import (
	"strings"
	"unicode/utf8"
)

// ImperfectEngine introduces realistic Czech writing imperfections.
// Models the diacritics gradient, common typos, and forgotten attachments.
type ImperfectEngine struct {
	diacriticsSubjectProb  float64
	diacriticsGreetingProb float64
	diacriticsBodyProb     float64
	typoCountMin           int
	typoCountMax           int
	forgottenAttachProb    float64
}

// NewImperfectEngine creates an imperfection engine with realistic defaults.
func NewImperfectEngine() *ImperfectEngine {
	return &ImperfectEngine{
		diacriticsSubjectProb:  0.40,
		diacriticsGreetingProb: 0.85,
		diacriticsBodyProb:     0.70,
		typoCountMin:           0,
		typoCountMax:           3,
		forgottenAttachProb:    0.05,
	}
}

// NewImperfectEngineSAFE returns a profile that preserves diacritics
// verbatim (keepProb=1.0 across subject/greeting/body) and skips typo
// injection. Used by the SAFE profile that ships when Seznam-class
// recipient SMTP servers reject the default fingerprint as machine-
// translation spam (J3 audit + I4 sprint, 2026-05-04).
//
// degradeDiacritics with keepProb=1.0 is a no-op — every rune is kept.
// Forgotten-attachment metadata still active (does not affect body bytes).
func NewImperfectEngineSAFE() *ImperfectEngine {
	return &ImperfectEngine{
		diacriticsSubjectProb:  1.0,
		diacriticsGreetingProb: 1.0,
		diacriticsBodyProb:     1.0,
		typoCountMin:           0,
		typoCountMax:           0,
		forgottenAttachProb:    0.05,
	}
}

// ApplyToSubject applies imperfections to subject line (most aggressive).
func (e *ImperfectEngine) ApplyToSubject(subject string) string {
	return e.degradeDiacritics(subject, e.diacriticsSubjectProb)
}

// ApplyToGreeting applies mild imperfections to greeting.
func (e *ImperfectEngine) ApplyToGreeting(greeting string) string {
	return e.degradeDiacritics(greeting, e.diacriticsGreetingProb)
}

// ApplyToBody applies imperfections to body text.
// Diacritics degrade progressively from start to end.
// When diacriticsBodyProb >= 1.0 the per-line descent is skipped entirely
// — required by the SAFE profile so trailing lines aren't silently
// degraded by the bodyProb-0.3 descent floor.
func (e *ImperfectEngine) ApplyToBody(body string) string {
	if e.diacriticsBodyProb < 1.0 {
		lines := strings.Split(body, "\n")
		totalLines := len(lines)

		for i, line := range lines {
			// Diacritics probability decreases through the email
			progress := float64(i) / float64(max(totalLines, 1))
			prob := e.diacriticsBodyProb - (progress * 0.3) // 0.70 -> 0.40
			if prob < 0.30 {
				prob = 0.30
			}
			lines[i] = e.degradeDiacritics(line, prob)
		}

		body = strings.Join(lines, "\n")
	}

	// Apply typos
	typoCount := randMinute(e.typoCountMin, e.typoCountMax+1)
	for t := 0; t < typoCount; t++ {
		body = e.injectTypo(body)
	}

	return body
}

// ShouldForgetAttachment returns true if we should "forget" the attachment.
func (e *ImperfectEngine) ShouldForgetAttachment() bool {
	return cryptoRandFloat() < e.forgottenAttachProb
}

// MentionsAttachment checks if the text references an attachment.
func (e *ImperfectEngine) MentionsAttachment(text string) bool {
	lower := strings.ToLower(text)
	keywords := []string{"příloha", "priloha", "přikládám", "prikladam", "v příloze", "v priloze"}
	for _, kw := range keywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}

// degradeDiacritics randomly removes diacritics based on probability.
// keepProb >= 1.0 short-circuits the loop and returns the input
// unchanged — required by the SAFE profile so ApplyToBody's progressive
// descent (bodyProb → bodyProb-0.3) cannot accidentally degrade trailing
// lines when the caller asked for verbatim output.
func (e *ImperfectEngine) degradeDiacritics(text string, keepProb float64) string {
	if keepProb >= 1.0 {
		return text
	}
	var result strings.Builder
	for _, r := range text {
		if cryptoRandFloat() > keepProb {
			result.WriteRune(removeDiacritic(r))
		} else {
			result.WriteRune(r)
		}
	}
	return result.String()
}

// injectTypo introduces one realistic Czech typo.
func (e *ImperfectEngine) injectTypo(text string) string {
	typos := []func(string) string{
		e.removeCommaBeforeConjunction,
		e.removeTrailingPeriod,
	}

	if len(typos) == 0 {
		return text
	}

	idx := randMinute(0, len(typos))
	return typos[idx](text)
}

// removeCommaBeforeConjunction removes comma before že, který, aby, protože.
func (e *ImperfectEngine) removeCommaBeforeConjunction(text string) string {
	conjunctions := []string{", že ", ", který ", ", aby ", ", protože ", ", ale ", ", když "}
	for _, conj := range conjunctions {
		if strings.Contains(text, conj) {
			without := strings.Replace(conj, ", ", " ", 1)
			// Only replace first occurrence
			return strings.Replace(text, conj, without, 1)
		}
	}
	return text
}

// removeTrailingPeriod removes the period from the last sentence.
func (e *ImperfectEngine) removeTrailingPeriod(text string) string {
	trimmed := strings.TrimSpace(text)
	if len(trimmed) > 0 && trimmed[len(trimmed)-1] == '.' {
		return trimmed[:len(trimmed)-1]
	}
	return text
}

var diacriticMap = map[rune]rune{
	'á': 'a', 'č': 'c', 'ď': 'd', 'é': 'e', 'ě': 'e',
	'í': 'i', 'ň': 'n', 'ó': 'o', 'ř': 'r', 'š': 's',
	'ť': 't', 'ú': 'u', 'ů': 'u', 'ý': 'y', 'ž': 'z',
	'Á': 'A', 'Č': 'C', 'Ď': 'D', 'É': 'E', 'Ě': 'E',
	'Í': 'I', 'Ň': 'N', 'Ó': 'O', 'Ř': 'R', 'Š': 'S',
	'Ť': 'T', 'Ú': 'U', 'Ů': 'U', 'Ý': 'Y', 'Ž': 'Z',
}

func removeDiacritic(r rune) rune {
	if replacement, ok := diacriticMap[r]; ok {
		return replacement
	}
	return r
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// Used to satisfy compiler for utf8 import
var _ = utf8.RuneLen
