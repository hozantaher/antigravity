package prodlike

import (
	"strings"
	"time"
)

// EdgeCaseDraft is an email address crafted to trigger a specific
// enrichment code path: one of the seven honeypot rules, an empty
// email that fails the prospect filter, or a freemail penalty case.
//
// Each draft carries the expected signal metadata so the seed
// orchestrator can populate outreach_honeypot_signals without
// re-running the live detector — important because some rules are
// bound to real-typo domains (e.g. gmial.com) that we cannot use in
// a .test-only dataset.
type EdgeCaseDraft struct {
	// Email is the address used for the contact row. May be empty to
	// exercise the "no_email" skip path in enrichment.
	Email string

	// Category is a short label used for log lines and to group the
	// generated contacts by which code path they exercise.
	Category string

	// Signals are the HoneypotSignals the live detector WOULD emit if
	// it saw this address. The seed writes them verbatim into
	// outreach_honeypot_signals so downstream code (dashboard tiles,
	// intelligence loop) sees representative data.
	//
	// Empty for categories that are skip-path only (empty email,
	// invalid format — those never reach InsertHoneypotSignals in
	// production because the prospect filter strips them first).
	Signals []EdgeCaseSignal

	// ExpectBlocked flags rows whose targeting score should end up at the
	// "block" tier (< 0.2) after all signals apply. Used by scenario
	// tests that verify the suppression pipeline.
	ExpectBlocked bool
}

// EdgeCaseSignal mirrors the shape of enrich.HoneypotSignal so it can
// be inserted directly into outreach_honeypot_signals. The prodlike
// package does not depend on the enrich package to avoid import cycles
// through the wider seed module.
type EdgeCaseSignal struct {
	Type     string // "typo_domain", "role_based", "suspicious_pattern"
	Severity string // "low", "medium", "high"
	Details  string // human-readable diagnostic
	Fix      string // suggested correction (typo domain only)
}

// GenerateEdgeCases returns ~100 EdgeCaseDrafts covering every
// honeypot detection rule plus the prospect-filter and consent-penalty
// code paths. Counts per category are fixed — this is a curated set,
// not a sampled distribution.
//
// Covered categories:
//
//	typo_domain       15 — synthetic .test domains tagged manually
//	                     (we never use real typo domains so no email
//	                     ever leaves the .test sandbox)
//	role_based        20 — info@, noreply@, support@ …
//	suspicious        10 — test@, null@, asdf@, xxx@ …
//	all_numeric        8 — 12345@domain, 9999999@domain …
//	long_local         3 — 80-char local parts (RFC 5321 violation)
//	double_dots        5 — john..doe@domain
//	single_char        3 — a@domain, b@domain, c@domain
//	invalid_format     4 — missing '@', trailing spaces …
//	empty_email       20 — zero-length email (skip path)
//	freemail_personal 12 — uses a FreemailTestDomain alias
func GenerateEdgeCases() []EdgeCaseDraft {
	var out []EdgeCaseDraft

	// --- 1. typo_domain — 15 drafts ---
	// We model a typo by tagging a synthetic ".test" domain that looks
	// like a common freemail typo. Real typo detection (FixTypoDomain)
	// would not trigger on these, so the signal is injected manually.
	typoPairs := []struct {
		Wrong, Right string
	}{
		{"seznma.test", "seznam.test"}, {"sezanm.test", "seznam.test"},
		{"gmial.test", "gmail.test"}, {"gnail.test", "gmail.test"},
		{"emial.test", "email-cz.test"}, {"email-cz.test", "email-cz.test"},
		{"cetrum.test", "centrum.test"}, {"centrin.test", "centrum.test"},
		{"volni.test", "volny.test"}, {"volnycz.test", "volny.test"},
		{"hotmal.test", "hotmail.test"}, {"hotnail.test", "hotmail.test"},
		{"outlok.test", "outlook.test"}, {"yahooo.test", "yahoo.test"},
		{"yhoo.test", "yahoo.test"},
	}
	firsts := []string{
		"jan.novak", "eva.kralova", "petr.dvorak", "jana.svobodova",
		"martin.horak", "alena.prochazkova", "tomas.novotny", "lenka.vesela",
		"marek.kolar", "petra.fialova", "david.cerny", "michaela.zemanova",
		"pavel.kadlec", "veronika.moravcova", "jakub.urban",
	}
	for i, p := range typoPairs {
		local := firsts[i%len(firsts)]
		out = append(out, EdgeCaseDraft{
			Email:    local + "@" + p.Wrong,
			Category: "typo_domain",
			Signals: []EdgeCaseSignal{{
				Type:     "typo_domain",
				Severity: "medium",
				Details:  p.Wrong + " → " + p.Right,
				Fix:      local + "@" + p.Right,
			}},
		})
	}

	// --- 2. role_based — 20 drafts ---
	roleLocals := []string{
		"info", "noreply", "no-reply", "donotreply", "support",
		"admin", "postmaster", "webmaster", "mailer-daemon",
		"hostmaster", "root", "abuse", "security", "help",
		"newsletter", "unsubscribe", "bounce", "feedback",
		"spam", "mail",
	}
	for i, local := range roleLocals {
		domain := "strojirna-role-" + pad3(i+1) + ".test"
		out = append(out, EdgeCaseDraft{
			Email:    local + "@" + domain,
			Category: "role_based",
			Signals: []EdgeCaseSignal{{
				Type:     "role_based",
				Severity: "low",
				Details:  "role-based prefix: " + local,
			}},
		})
	}

	// --- 3. suspicious — 10 drafts ---
	susp := []string{
		"test", "asdf", "qwerty", "xxx", "aaa",
		"zzz", "temp", "tmp", "fake", "null",
	}
	for i, local := range susp {
		domain := "honeypot-susp-" + pad3(i+1) + ".test"
		out = append(out, EdgeCaseDraft{
			Email:    local + "@" + domain,
			Category: "suspicious",
			Signals: []EdgeCaseSignal{{
				Type:     "suspicious_pattern",
				Severity: "high",
				Details:  "suspicious local part: " + local,
			}},
			ExpectBlocked: true,
		})
	}

	// --- 4. all_numeric — 8 drafts ---
	numericLocals := []string{
		"12345", "99999999", "42", "7777777",
		"000001", "123456789", "314159", "271828",
	}
	for i, local := range numericLocals {
		domain := "numeric-" + pad3(i+1) + ".test"
		out = append(out, EdgeCaseDraft{
			Email:    local + "@" + domain,
			Category: "all_numeric",
			Signals: []EdgeCaseSignal{{
				Type:     "suspicious_pattern",
				Severity: "medium",
				Details:  "all-numeric local part: " + local,
			}},
		})
	}

	// --- 5. long_local — 3 drafts (> 64 chars each) ---
	longLocal := strings.Repeat("longlocalpart", 7) // 13*7 = 91 chars
	out = append(out,
		EdgeCaseDraft{
			Email:    longLocal + "@long-1.test",
			Category: "long_local",
			Signals: []EdgeCaseSignal{{
				Type: "suspicious_pattern", Severity: "high",
				Details: "local part exceeds 64 chars",
			}},
		},
		EdgeCaseDraft{
			Email:    strings.Repeat("a", 80) + "@long-2.test",
			Category: "long_local",
			Signals: []EdgeCaseSignal{{
				Type: "suspicious_pattern", Severity: "high",
				Details: "local part exceeds 64 chars",
			}},
		},
		EdgeCaseDraft{
			Email:    strings.Repeat("x", 65) + "@long-3.test",
			Category: "long_local",
			Signals: []EdgeCaseSignal{{
				Type: "suspicious_pattern", Severity: "high",
				Details: "local part exceeds 64 chars",
			}},
		},
	)

	// --- 6. double_dots — 5 drafts (RFC 5321 violation) ---
	doubleDots := []string{
		"john..doe", "eva..novak", "petr...king",
		"a..b..c", "name..dots",
	}
	for i, local := range doubleDots {
		domain := "dots-" + pad3(i+1) + ".test"
		out = append(out, EdgeCaseDraft{
			Email:    local + "@" + domain,
			Category: "double_dots",
			Signals: []EdgeCaseSignal{{
				Type:     "suspicious_pattern",
				Severity: "medium",
				Details:  "consecutive dots in local part",
			}},
		})
	}

	// --- 7. single_char — 3 drafts ---
	for _, c := range []string{"a", "b", "c"} {
		out = append(out, EdgeCaseDraft{
			Email:    c + "@single-" + c + ".test",
			Category: "single_char",
			Signals: []EdgeCaseSignal{{
				Type:     "suspicious_pattern",
				Severity: "medium",
				Details:  "single character local part",
			}},
		})
	}

	// --- 8. invalid_format — 4 drafts (skip path before enrichment) ---
	out = append(out,
		EdgeCaseDraft{Email: "no-at-sign.test", Category: "invalid_format"},
		EdgeCaseDraft{Email: "@leading-at.test", Category: "invalid_format"},
		EdgeCaseDraft{Email: "trailing-at@", Category: "invalid_format"},
		EdgeCaseDraft{Email: "spaces in@local.test", Category: "invalid_format"},
	)

	// --- 9. empty_email — 20 drafts ---
	// These never make it past the "no_email" guard in the enrichment
	// pipeline but still need to exist as rows so the dashboard can
	// display "missing email" counters correctly. Downstream the
	// orchestrator writes them only into the contacts (Schema A) table
	// which permits empty emails with a distinct source tag.
	for i := 0; i < 20; i++ {
		out = append(out, EdgeCaseDraft{
			Email:    "",
			Category: "empty_email",
		})
	}

	// --- 10. freemail_personal — 12 drafts ---
	// Uses a FreemailTestDomain alias so the consent-score code lowers
	// the contact one tier due to the freemail penalty. No honeypot
	// signal; the coverage is purely on the consent path.
	freemailFirsts := []string{
		"tomas.pokorny", "hana.bartoskova", "lukas.ruzicka",
		"monika.hrubesova", "ivan.mracek", "klara.stehlikova",
		"pavel.drapala", "simona.bulikova", "adam.hajek",
		"tereza.janska", "robert.kucera", "alice.soukupova",
	}
	for i, fn := range freemailFirsts {
		alias := FreemailTestDomains[i%len(FreemailTestDomains)]
		out = append(out, EdgeCaseDraft{
			Email:    fn + "@" + alias.Domain,
			Category: "freemail_personal",
		})
	}

	return out
}

// ToContactDraft lifts an EdgeCaseDraft into a ContactDraft suitable
// for the orchestrator's insertContacts path. Values are deliberately
// boring (no randomisation) so the edge-case subset stays stable
// across runs regardless of the RNG seed.
//
// Empty-email drafts return an empty-email ContactDraft; the caller
// must route these separately (Schema A only, skip Schema B).
func (e EdgeCaseDraft) ToContactDraft(domain string, now time.Time) ContactDraft {
	email := e.Email
	hash := ""
	if email != "" {
		hash = emailHashForSeed(email)
	}

	// Derive first name from local part so the row looks like a real
	// person rather than a string of category labels.
	first, last := splitLocalNameGuess(email)

	return ContactDraft{
		Email:              email,
		EmailHash:          hash,
		Domain:             domain,
		FirstName:          first,
		LastName:           last,
		CompanyName:        "Edge-case " + e.Category,
		ICO:                "",
		Region:             "Praha",
		IndustryTags:       []string{"construction"}, // any tag — not the focus
		IndustryConfidence: 0.5,
		TargetingScore:       consentForEdgeCase(e),
		TargetingFactors:     map[string]any{"category": e.Category},
		Status:             statusForScore(consentForEdgeCase(e)),
		Source:             SourceTag + "-edge",
		FirmyCzID:          0, // no company link for edge cases
		CreatedAt:          now,
		UpdatedAt:          now,
	}
}

// consentForEdgeCase gives each category a representative score so
// the tier distribution dashboards show the coverage clearly.
func consentForEdgeCase(e EdgeCaseDraft) float64 {
	switch e.Category {
	case "suspicious", "long_local":
		return 0.1 // block tier — high-severity signals dominate
	case "typo_domain", "all_numeric", "double_dots", "single_char":
		return 0.3 // manual tier — medium signals
	case "role_based":
		return 0.45 // low tier — single low-severity signal
	case "freemail_personal":
		return 0.55 // low tier — freemail penalty keeps it below auto
	case "invalid_format", "empty_email":
		return 0.0 // never scored — skip path
	}
	return 0.5
}

// splitLocalNameGuess returns a best-effort first/last from the local
// part of an email. Pure cosmetic — empty input returns empty names.
func splitLocalNameGuess(email string) (first, last string) {
	if email == "" {
		return "", ""
	}
	at := strings.IndexByte(email, '@')
	if at <= 0 {
		return "", ""
	}
	local := email[:at]
	if dot := strings.IndexByte(local, '.'); dot > 0 {
		return titleCase(local[:dot]), titleCase(local[dot+1:])
	}
	return titleCase(local), ""
}

// titleCase capitalises the first rune of an ASCII-only string. Good
// enough for cosmetic display in the seeded data.
func titleCase(s string) string {
	if s == "" {
		return s
	}
	b := []byte(s)
	if b[0] >= 'a' && b[0] <= 'z' {
		b[0] -= 32
	}
	return string(b)
}

// pad3 formats n as a 3-digit zero-padded decimal ("001", "042", ...).
func pad3(n int) string {
	if n < 10 {
		return "00" + itoaSmall(n)
	}
	if n < 100 {
		return "0" + itoaSmall(n)
	}
	return itoaSmall(n)
}

// itoaSmall is a minimal integer-to-string helper that avoids pulling
// strconv just for pad3 — keeps the edge-case generator free of extra
// dependencies.
func itoaSmall(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}
