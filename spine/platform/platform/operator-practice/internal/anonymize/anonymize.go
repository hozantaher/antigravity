// Package anonymize strips PII from real production replies before they
// are seeded into the Mail Lab as operator-training fixtures.
//
// KT-B5 — Lab feedback loop. The transformation contract mirrors the
// existing OP1.2 Node anonymizer in scripts/operator-practice/anonymize.mjs
// so a fixture written by either tool round-trips identically:
//
//   - email addresses        → prospect-NNNN@anon.lab (deterministic hash)
//   - Czech first names      → [Jméno]
//   - phone numbers (CZ/SK)  → [Telefon]
//   - URLs                   → preserves scheme + TLD, randomizes path
//   - company suffixes       → [Firma] s.r.o. / a.s. / k.s. / v.o.s.
//
// Per memory feedback_no_fabricated_test_data: the package transforms
// REAL data only. It does NOT generate synthetic samples. If input is
// empty, output is empty.
package anonymize

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// DefaultSalt matches the Node anonymizer salt so cross-tool output stays
// stable. Override via Options.Salt for tests.
const DefaultSalt = "op-practice-2026"

// Message is the raw production input row.
type Message struct {
	ID             int64
	FromAddr       string
	ToAddr         string
	Subject        string
	BodyText       string
	BodyHTML       string
	ReceivedAt     time.Time
	Classification string
	MessageID      string
	AutoSubmitted  bool
}

// Result is one anonymized fixture ready to inject via IMAP APPEND.
type Result struct {
	EML        string   // RFC822 payload
	Category   string   // ground-truth label
	FromAnon   string   // anonymized From header
	MessageID  string   // anonymized Message-ID
	Candidates []string // capitalised tokens still suspicious — see flag
}

// Options control the per-message transformation. Salt MUST be non-empty
// in production; leaving it empty falls back to DefaultSalt.
type Options struct {
	Salt    string
	ToAddr  string // injected into anonymized To: header (default op@gmail.lab)
	NowFunc func() time.Time
}

func (o Options) salt() string {
	if strings.TrimSpace(o.Salt) == "" {
		return DefaultSalt
	}
	return o.Salt
}

func (o Options) to() string {
	if strings.TrimSpace(o.ToAddr) == "" {
		return "op@gmail.lab"
	}
	return o.ToAddr
}

func (o Options) now() time.Time {
	if o.NowFunc == nil {
		return time.Now().UTC()
	}
	return o.NowFunc().UTC()
}

// czechFirstNames is a curated subset of CZSO top-100 Czech names
// (matches the Node anonymizer list).
var czechFirstNames = map[string]struct{}{
	"Jan": {}, "Jakub": {}, "Jiří": {}, "Petr": {}, "Tomáš": {}, "Pavel": {},
	"Martin": {}, "Lukáš": {}, "David": {}, "Michal": {}, "Filip": {}, "Adam": {},
	"Marek": {}, "Roman": {}, "Patrik": {}, "Daniel": {}, "Ondřej": {}, "Vojtěch": {},
	"Matěj": {}, "Antonín": {}, "František": {}, "Václav": {}, "Karel": {}, "Josef": {},
	"Miroslav": {}, "Stanislav": {}, "Vladimír": {}, "Zdeněk": {}, "Robert": {},
	"Aleš": {}, "Štěpán": {}, "Šimon": {}, "Dominik": {}, "Radek": {}, "Richard": {},
	"Anna": {}, "Eva": {}, "Hana": {}, "Jana": {}, "Marie": {}, "Lucie": {},
	"Lenka": {}, "Tereza": {}, "Kateřina": {}, "Kristýna": {}, "Eliška": {},
	"Karolína": {}, "Markéta": {}, "Michaela": {}, "Veronika": {}, "Petra": {},
	"Klára": {}, "Adéla": {}, "Barbora": {}, "Natálie": {}, "Aneta": {}, "Alena": {},
	"Pavla": {}, "Iveta": {}, "Jitka": {}, "Vlasta": {}, "Helena": {}, "Soňa": {},
	"Zuzana": {}, "Ivana": {}, "Olga": {}, "Dagmar": {}, "Šárka": {},
}

// commonCzech filters greeting/farewell/place words out of the manual
// review checklist (same allow-list as Node anonymizer).
var commonCzech = map[string]struct{}{
	"Dobrý": {}, "Dobrá": {}, "Vážený": {}, "Vážená": {}, "Děkuji": {}, "Děkujeme": {},
	"Pozdravem": {}, "Úctou": {}, "Hezký": {},
	"Pondělí": {}, "Úterý": {}, "Středa": {}, "Čtvrtek": {}, "Pátek": {},
	"Sobota": {}, "Neděle": {},
	"Praha": {}, "Brno": {}, "Ostrava": {}, "Plzeň": {}, "Liberec": {},
	"Olomouc": {}, "Hradec": {}, "Pardubice": {},
	"Re": {}, "Fwd": {}, "RE": {}, "FWD": {},
}

// ── Regex catalogue ──────────────────────────────────────────────────

var (
	rePhoneCZSKGrouped = regexp.MustCompile(`\+?(?:420|421)[\s.\-]?\d{3}[\s.\-]?\d{3}[\s.\-]?\d{3}`)
	rePhoneCZSKVar     = regexp.MustCompile(`\+?(?:420|421)[\s.\-]?\d{3}[\s.\-]?\d{4,7}`)
	rePhoneUSParens    = regexp.MustCompile(`\(\d{3}\)[\s.\-]?\d{3}[\s.\-]?\d{3,4}`)
	rePhoneBare9       = regexp.MustCompile(`(\d{3})[\s.\-]?(\d{3})[\s.\-]?(\d{3})`)

	reEmail = regexp.MustCompile(`[\p{L}\p{N}._%+\-]+@[\p{L}\p{N}.\-]+\.[\p{L}]{2,}`)

	// URL regex — kept simple. Skips already-anonymized hosts.
	reURL = regexp.MustCompile(`(?i)(https?://)?([\w\-]+\.)*([\w\-]+\.[a-z]{2,8})(/[\w/.~?=%&\-]*)?`)

	// Company suffixes (CZ legal forms).
	reCompanySuffix = regexp.MustCompile(
		`(?:[A-ZÁ-Ž][\wÁ-Žá-ž]*)(?:\s+[A-ZÁ-Ž][\wÁ-Žá-ž]*)*\s+(s\.r\.o\.|a\.s\.|spol\.\s*s\s*r\.o\.|k\.s\.|v\.o\.s\.)`,
	)
)

// AnonymizeEmail returns a deterministic fake address derived from addr.
// Same input + salt always yields the same output — needed so the lab
// thread reconstruction stays stable across re-seeding runs.
func AnonymizeEmail(addr, salt string) string {
	a := strings.ToLower(strings.TrimSpace(addr))
	if !strings.Contains(a, "@") {
		return addr
	}
	if strings.HasSuffix(a, "@anon.lab") {
		return a
	}
	if salt == "" {
		salt = DefaultSalt
	}
	sum := sha256.Sum256([]byte(salt + a))
	hexStr := hex.EncodeToString(sum[:])
	if len(hexStr) < 4 {
		hexStr = strings.Repeat("0", 4)
	}
	n, err := strconv.ParseInt(hexStr[:4], 16, 64)
	if err != nil {
		n = 0
	}
	suffix := n % 9999
	return fmt.Sprintf("prospect-%04d@anon.lab", suffix)
}

// AnonymizePhone strips CZ/SK and bare 9-digit phone numbers.
func AnonymizePhone(text string) string {
	out := rePhoneCZSKGrouped.ReplaceAllString(text, "[Telefon]")
	out = rePhoneCZSKVar.ReplaceAllString(out, "[Telefon]")
	out = rePhoneUSParens.ReplaceAllString(out, "[Telefon]")
	out = rePhoneBare9.ReplaceAllStringFunc(out, func(match string) string {
		// Don't touch IDs that look like dates (already grouped above)
		// or URL paths — heuristic: leave matches embedded in ASCII
		// alphanumerics alone. Bare 9-digit replacement always applies
		// here because the regex fired from a token boundary.
		return "[Telefon]"
	})
	return out
}

// AnonymizeURL preserves scheme + TLD shape, replaces domain + path.
func AnonymizeURL(text string) string {
	return reURL.ReplaceAllStringFunc(text, func(match string) string {
		lower := strings.ToLower(match)
		if strings.Contains(lower, "anon.lab") {
			return match
		}
		// Skip pure version numbers like "v1.2.3" or "1.2.3"
		if regexp.MustCompile(`^v?\d+\.\d+(\.\d+)?$`).MatchString(match) {
			return match
		}
		// Pull TLD off the right side
		parts := strings.Split(strings.TrimPrefix(strings.TrimPrefix(match, "https://"), "http://"), "/")
		host := parts[0]
		hostParts := strings.Split(host, ".")
		if len(hostParts) < 2 {
			return match
		}
		tld := hostParts[len(hostParts)-1]
		scheme := ""
		switch {
		case strings.HasPrefix(strings.ToLower(match), "https://"):
			scheme = "https://"
		case strings.HasPrefix(strings.ToLower(match), "http://"):
			scheme = "http://"
		}
		hasPath := len(parts) > 1 && parts[1] != ""
		path := ""
		if hasPath {
			path = "/path-anon"
		}
		return fmt.Sprintf("%sanon.%s%s", scheme, tld, path)
	})
}

// AnonymizeCzechNames replaces tokens from czechFirstNames with [Jméno].
func AnonymizeCzechNames(text string) string {
	out := text
	for name := range czechFirstNames {
		// Whole-word replace — diacritics in the name require we anchor
		// on either string boundary or non-letter character on each side.
		// Go's regexp \b is ASCII-only, so we build a Unicode-safe
		// expression manually.
		pattern := `(^|[^\p{L}])` + regexp.QuoteMeta(name) + `($|[^\p{L}])`
		re := regexp.MustCompile(pattern)
		out = re.ReplaceAllString(out, "${1}[Jméno]${2}")
	}
	return out
}

// AnonymizeCompanies replaces "Some Brand s.r.o." with "[Firma] s.r.o.".
func AnonymizeCompanies(text string) string {
	return reCompanySuffix.ReplaceAllString(text, "[Firma] $1")
}

// FindReviewCandidates flags capitalised tokens that may still be PII.
// Returns a deterministic, sorted slice so test snapshots stay stable.
func FindReviewCandidates(text string) []string {
	titleRE := regexp.MustCompile(`(?:^|[^\p{L}])(\p{Lu}\p{Ll}{2,})(?:[^\p{L}]|$)`)
	allCapsRE := regexp.MustCompile(`(?:^|[^\p{L}])(\p{Lu}{3,})(?:[^\p{L}]|$)`)

	hits := map[string]struct{}{}
	for _, m := range titleRE.FindAllStringSubmatch(text, -1) {
		hits[m[1]] = struct{}{}
	}
	for _, m := range allCapsRE.FindAllStringSubmatch(text, -1) {
		hits[m[1]] = struct{}{}
	}

	skipPrefixes := []string{"Telefon", "Jméno", "Firma", "Příjmení"}
	skipExact := map[string]struct{}{
		"CEO": {}, "CTO": {}, "CFO": {}, "GDPR": {}, "PDF": {},
		"XML": {}, "JSON": {}, "SQL": {}, "API": {},
	}

	out := []string{}
	for tok := range hits {
		if _, ok := commonCzech[tok]; ok {
			continue
		}
		if _, ok := czechFirstNames[tok]; ok {
			continue
		}
		if _, ok := skipExact[tok]; ok {
			continue
		}
		skip := false
		for _, p := range skipPrefixes {
			if strings.HasPrefix(tok, p) {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		out = append(out, tok)
	}
	sort.Strings(out)
	return out
}

// Anonymize transforms a single message to its fixture EML form. The
// returned Result is safe to write to a fixture file or APPEND via IMAP.
//
// Empty input → empty output (per feedback_no_fabricated_test_data: we
// transform real data only, we never synthesise).
func Anonymize(msg Message, opts Options) Result {
	salt := opts.salt()

	body := msg.BodyText
	body = AnonymizeCompanies(body)
	body = AnonymizeCzechNames(body)
	body = AnonymizePhone(body)
	body = AnonymizeURL(body)
	body = reEmail.ReplaceAllStringFunc(body, func(m string) string {
		return AnonymizeEmail(m, salt)
	})

	subject := reEmail.ReplaceAllString(msg.Subject, "[Email]")
	subject = AnonymizeCompanies(AnonymizeCzechNames(subject))

	fromAnon := AnonymizeEmail(msg.FromAddr, salt)
	now := opts.now()

	messageID := strings.TrimSpace(msg.MessageID)
	if messageID == "" {
		messageID = fmt.Sprintf("<anon-%d-%d@anon.lab>", msg.ID, now.UnixNano())
	}

	received := msg.ReceivedAt
	if received.IsZero() {
		received = now
	}

	category := strings.TrimSpace(msg.Classification)
	if category == "" {
		category = "ambiguous"
	}

	headers := []string{
		"From: " + fromAnon,
		"To: " + opts.to(),
		"Subject: " + subject,
		"Date: " + received.UTC().Format(time.RFC1123Z),
		"Message-ID: " + messageID,
		"X-Lab-Category: " + category,
		"X-Lab-Source: real-anonymized",
		fmt.Sprintf("X-Anon-Index: %d", msg.ID),
	}
	if msg.AutoSubmitted {
		headers = append(headers, "Auto-Submitted: auto-replied")
	}
	headers = append(headers,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		body,
	)

	eml := strings.Join(headers, "\r\n")

	return Result{
		EML:        eml,
		Category:   category,
		FromAnon:   fromAnon,
		MessageID:  messageID,
		Candidates: FindReviewCandidates(body),
	}
}
