// Package honeypot_test measures the false positive and false negative rates of
// the honeypot detection logic in internal/enrich against a labelled synthetic
// dataset representative of real Czech B2B contact patterns.
//
// Goals:
//   - Cover every detection rule (typo_domain, role_based, suspicious_pattern)
//   - Measure FPR and FNR over labelled cases
//   - Assert acceptable thresholds: FPR=0%, FNR=0%
package honeypot_test

import (
	"fmt"
	"strings"
	"testing"

	"contacts/enrichment"
)

// ─────────────────────────────────────────────
//  Labelled dataset
// ─────────────────────────────────────────────

type emailCase struct {
	email        string
	wantDetected bool   // true = expect ≥1 signal, false = expect clean
	note         string // short explanation
}

// cleanCases — legitimate Czech B2B contact emails.
// A false positive is any case here that DetectHoneypot returns signals for.
var cleanCases = []emailCase{
	// Standard name.surname@corporate pattern
	{email: "jan.novak@stroje.cz", wantDetected: false, note: "standard Czech name"},
	{email: "petra.svobodova@kovarna.cz", wantDetected: false, note: "Czech female name"},
	{email: "tomas.prochazka@plasty.cz", wantDetected: false, note: "common Czech name"},
	{email: "martin.cerny@strojarna.cz", wantDetected: false, note: "common Czech surname"},
	{email: "eva.novotna@techno.cz", wantDetected: false, note: "Czech female name"},
	{email: "jakub.kral@autodily.cz", wantDetected: false, note: "Czech male name"},
	{email: "lucie.horakova@potravinyzavod.cz", wantDetected: false, note: "Czech female name, long domain"},
	{email: "milan.dostal@cncvyroba.cz", wantDetected: false, note: "Czech male name"},
	{email: "radek.hruza@truhlarna.cz", wantDetected: false, note: "Czech male name"},
	{email: "katerina.hajkova@textil.cz", wantDetected: false, note: "Czech female name"},
	{email: "ondrej.blaha@nakladni.cz", wantDetected: false, note: "Czech male name"},
	{email: "renata.kucerova@kovo.cz", wantDetected: false, note: "Czech female name"},
	{email: "stanislav.horak@lisovna.cz", wantDetected: false, note: "Czech male name"},
	{email: "miroslava.sedlakova@guma.cz", wantDetected: false, note: "Czech female name"},
	{email: "frantisek.blecha@drevo.cz", wantDetected: false, note: "Czech male name"},

	// Initial + surname patterns
	{email: "m.kratochvil@strojirna.cz", wantDetected: false, note: "initial.surname"},
	{email: "p.dvorak@montaz.cz", wantDetected: false, note: "initial.surname"},
	{email: "j.horacek@stavba.cz", wantDetected: false, note: "initial.surname — local len=1 is not flagged when combined with suffix"},

	// Mixed alphanumeric (not all-numeric)
	{email: "jan2@firma.cz", wantDetected: false, note: "name + digit suffix, not all-numeric"},
	{email: "novak1975@firma.cz", wantDetected: false, note: "name + year, not all-numeric"},
	{email: "martin.kral2@strojarna.cz", wantDetected: false, note: "name + digit, not all-numeric"},

	// Functional mailboxes that are NOT in the role-based list
	{email: "info@firma.cz", wantDetected: false, note: "info is not a role-based prefix"},
	{email: "obchod@firma.cz", wantDetected: false, note: "obchod (sales) is not role-based"},
	{email: "vedeni@firma.cz", wantDetected: false, note: "vedeni (management) not role-based"},
	{email: "servis@firma.cz", wantDetected: false, note: "servis (service) not role-based"},
	{email: "export@firma.cz", wantDetected: false, note: "export department, not role-based"},
	{email: "nakup@firma.cz", wantDetected: false, note: "nakup (purchasing) not role-based"},
	{email: "reditele@firma.cz", wantDetected: false, note: "director inbox, not role-based"},

	// Legitimate corporate domains (not typo domains)
	{email: "jan.novak@gmail.com", wantDetected: false, note: "gmail.com is a valid freemail, not a typo"},
	{email: "jan.novak@seznam.cz", wantDetected: false, note: "seznam.cz is a valid freemail"},
	{email: "jan.novak@hotmail.com", wantDetected: false, note: "hotmail.com is a valid freemail"},
	{email: "jan.novak@outlook.com", wantDetected: false, note: "outlook.com is valid"},
}

// honeypotCases — emails that SHOULD be detected.
// A false negative is any case here that DetectHoneypot returns 0 signals for.
var honeypotCases = []emailCase{
	// ── Typo domains ──
	{email: "jan@gmial.com", wantDetected: true, note: "gmial.com typo of gmail.com"},
	{email: "jan@gmal.com", wantDetected: true, note: "gmal.com typo"},
	{email: "jan@gamil.com", wantDetected: true, note: "gamil.com typo"},
	{email: "jan@gnail.com", wantDetected: true, note: "gnail.com typo"},
	{email: "jan@sezanm.cz", wantDetected: true, note: "sezanm.cz typo of seznam.cz"},
	{email: "jan@seznma.cz", wantDetected: true, note: "seznma.cz typo"},
	{email: "jan@szenam.cz", wantDetected: true, note: "szenam.cz typo"},
	{email: "jan@volni.cz", wantDetected: true, note: "volni.cz typo of volny.cz"},
	{email: "jan@centrun.cz", wantDetected: true, note: "centrun.cz typo of centrum.cz"},
	{email: "jan@cetrum.cz", wantDetected: true, note: "cetrum.cz typo"},
	{email: "jan@hotmal.com", wantDetected: true, note: "hotmal.com typo of hotmail.com"},
	{email: "jan@hotnail.com", wantDetected: true, note: "hotnail.com typo"},
	{email: "jan@outloo.com", wantDetected: true, note: "outloo.com typo of outlook.com"},
	{email: "jan@yahooo.com", wantDetected: true, note: "yahooo.com typo of yahoo.com"},

	// ── Role-based prefixes ──
	{email: "abuse@firma.cz", wantDetected: true, note: "abuse is role-based"},
	{email: "postmaster@firma.cz", wantDetected: true, note: "postmaster is role-based"},
	{email: "mailer-daemon@firma.cz", wantDetected: true, note: "mailer-daemon is role-based"},
	{email: "noreply@firma.cz", wantDetected: true, note: "noreply is role-based"},
	{email: "no-reply@firma.cz", wantDetected: true, note: "no-reply is role-based"},
	{email: "donotreply@firma.cz", wantDetected: true, note: "donotreply is role-based"},
	{email: "hostmaster@firma.cz", wantDetected: true, note: "hostmaster is role-based"},
	{email: "webmaster@firma.cz", wantDetected: true, note: "webmaster is role-based"},
	{email: "admin@firma.cz", wantDetected: true, note: "admin is role-based"},
	{email: "root@firma.cz", wantDetected: true, note: "root is role-based"},
	{email: "support@firma.cz", wantDetected: true, note: "support is role-based"},
	{email: "spam@firma.cz", wantDetected: true, note: "spam is role-based"},
	{email: "bounce@firma.cz", wantDetected: true, note: "bounce is role-based"},
	{email: "newsletter@firma.cz", wantDetected: true, note: "newsletter is role-based"},
	{email: "unsubscribe@firma.cz", wantDetected: true, note: "unsubscribe is role-based"},

	// ── Suspicious local parts ──
	{email: "test@firma.cz", wantDetected: true, note: "local == 'test'"},
	{email: "asdf@firma.cz", wantDetected: true, note: "local == 'asdf'"},
	{email: "qwerty@firma.cz", wantDetected: true, note: "local == 'qwerty'"},
	{email: "xxx@firma.cz", wantDetected: true, note: "local == 'xxx'"},
	{email: "aaa@firma.cz", wantDetected: true, note: "local == 'aaa'"},
	{email: "zzz@firma.cz", wantDetected: true, note: "local == 'zzz'"},
	{email: "temp@firma.cz", wantDetected: true, note: "local == 'temp'"},
	{email: "tmp@firma.cz", wantDetected: true, note: "local == 'tmp'"},
	{email: "fake@firma.cz", wantDetected: true, note: "local == 'fake'"},
	{email: "null@firma.cz", wantDetected: true, note: "local == 'null'"},
	{email: "example@firma.cz", wantDetected: true, note: "local == 'example'"},
	{email: "sample@firma.cz", wantDetected: true, note: "local == 'sample'"},
	{email: "demo@firma.cz", wantDetected: true, note: "local == 'demo'"},
	// Prefix variants (pattern + "." or pattern + "_")
	{email: "test.user@firma.cz", wantDetected: true, note: "starts with 'test.'"},
	{email: "temp_kontakt@firma.cz", wantDetected: true, note: "starts with 'temp_'"},
	{email: "demo.uzivatel@firma.cz", wantDetected: true, note: "starts with 'demo.'"},

	// ── All-numeric local part ──
	{email: "123456@firma.cz", wantDetected: true, note: "all-numeric local (>2 chars)"},
	{email: "999@firma.cz", wantDetected: true, note: "all-numeric, 3 digits"},
	{email: "00001@firma.cz", wantDetected: true, note: "all-numeric, zero-padded"},

	// ── RFC violations: consecutive dots ──
	{email: "jan..novak@firma.cz", wantDetected: true, note: "consecutive dots in local part"},
	{email: "jan...novak@firma.cz", wantDetected: true, note: "triple consecutive dots"},

	// ── Single character local part ──
	{email: "x@firma.cz", wantDetected: true, note: "single char local part"},
	{email: "a@firma.cz", wantDetected: true, note: "single char local part"},

	// ── Very long local part (>64 chars per RFC 5321) ──
	{email: "averylonglocalpartthatexceedssixtyfourcharacterswhichisnotvalidperrfc@firma.cz",
		wantDetected: true, note: "local part >64 chars"},
}

// ambiguousCases documents edge cases that are debatable.
// These are NOT included in FP/FN metrics but serve as regression anchors.
var ambiguousCases = []struct {
	email  string
	reason string
}{
	// "test_name" starts with "test_" → flagged but could be a real auto-generated address.
	{email: "test_novak@firma.cz", reason: "starts with 'test_'; auto-generated vs. real person"},
	// "12" is only 2 chars → all-numeric check requires >2 so NOT flagged; documented here.
	{email: "12@firma.cz", reason: "2-digit numeric local: below threshold, NOT flagged by design"},
}

// ─────────────────────────────────────────────
//  Individual rule tests
// ─────────────────────────────────────────────

func TestHoneypot_TypoDomain_AllEntries(t *testing.T) {
	for _, tc := range honeypotCases {
		if !strings.Contains(tc.note, "typo") {
			continue
		}
		tc := tc
		t.Run(tc.email, func(t *testing.T) {
			signals := enrich.DetectHoneypot(tc.email)
			found := false
			for _, s := range signals {
				if s.Type == "typo_domain" {
					found = true
				}
			}
			if !found {
				t.Errorf("%s (%s): expected typo_domain signal, got %v", tc.email, tc.note, signals)
			}
		})
	}
}

func TestHoneypot_SignalType_TypoDomain(t *testing.T) {
	cases := []struct{ email, corrected string }{
		{"jan@gmial.com", "gmail.com"},
		{"jan@sezanm.cz", "seznam.cz"},
		{"jan@volni.cz", "volny.cz"},
		{"jan@centrun.cz", "centrum.cz"},
		{"jan@hotmal.com", "hotmail.com"},
		{"jan@outloo.com", "outlook.com"},
	}
	for _, tc := range cases {
		t.Run(tc.email, func(t *testing.T) {
			signals := enrich.DetectHoneypot(tc.email)
			var found bool
			for _, s := range signals {
				if s.Type == "typo_domain" {
					found = true
					if s.Fix == "" {
						t.Errorf("typo_domain signal for %s has empty Fix", tc.email)
					}
				}
			}
			if !found {
				t.Errorf("%s: expected typo_domain signal, got %v", tc.email, signals)
			}
		})
	}
}

func TestHoneypot_SignalType_RoleBased(t *testing.T) {
	roles := []string{
		"abuse", "postmaster", "mailer-daemon", "noreply", "no-reply",
		"donotreply", "hostmaster", "webmaster", "admin", "root",
		"support", "spam", "bounce", "newsletter", "unsubscribe",
	}
	for _, prefix := range roles {
		t.Run(prefix, func(t *testing.T) {
			email := prefix + "@firma.cz"
			signals := enrich.DetectHoneypot(email)
			var found bool
			for _, s := range signals {
				if s.Type == "role_based" {
					found = true
				}
			}
			if !found {
				t.Errorf("%s: expected role_based signal, got %v", email, signals)
			}
		})
	}
}

func TestHoneypot_SignalType_SuspiciousExact(t *testing.T) {
	patterns := []string{"test", "asdf", "qwerty", "xxx", "aaa", "zzz",
		"temp", "tmp", "fake", "null", "void", "none", "example", "sample", "demo"}
	for _, p := range patterns {
		t.Run(p, func(t *testing.T) {
			email := p + "@firma.cz"
			signals := enrich.DetectHoneypot(email)
			var found bool
			for _, s := range signals {
				if s.Type == "suspicious_pattern" {
					found = true
				}
			}
			if !found {
				t.Errorf("%s: expected suspicious_pattern signal, got %v", email, signals)
			}
		})
	}
}

func TestHoneypot_SignalType_SuspiciousPrefixDot(t *testing.T) {
	cases := []string{"test.user@firma.cz", "demo.uzivatel@firma.cz", "sample.account@firma.cz"}
	for _, email := range cases {
		t.Run(email, func(t *testing.T) {
			signals := enrich.DetectHoneypot(email)
			var found bool
			for _, s := range signals {
				if s.Type == "suspicious_pattern" {
					found = true
				}
			}
			if !found {
				t.Errorf("%s: expected suspicious_pattern (dot prefix), got %v", email, signals)
			}
		})
	}
}

func TestHoneypot_SignalType_SuspiciousPrefixUnderscore(t *testing.T) {
	signals := enrich.DetectHoneypot("temp_kontakt@firma.cz")
	var found bool
	for _, s := range signals {
		if s.Type == "suspicious_pattern" {
			found = true
		}
	}
	if !found {
		t.Error("temp_kontakt@firma.cz: expected suspicious_pattern (_prefix)")
	}
}

func TestHoneypot_SignalType_AllNumeric(t *testing.T) {
	cases := []string{"123456@firma.cz", "999@firma.cz", "00001@firma.cz"}
	for _, email := range cases {
		t.Run(email, func(t *testing.T) {
			signals := enrich.DetectHoneypot(email)
			var found bool
			for _, s := range signals {
				if s.Type == "suspicious_pattern" {
					found = true
				}
			}
			if !found {
				t.Errorf("%s: expected suspicious_pattern (all-numeric), got %v", email, signals)
			}
		})
	}
}

func TestHoneypot_AllNumeric_BelowThreshold(t *testing.T) {
	// 2-digit numeric local parts are NOT flagged (threshold is >2 chars).
	signals := enrich.DetectHoneypot("12@firma.cz")
	for _, s := range signals {
		if s.Type == "suspicious_pattern" && s.Details == "all-numeric local part: 12" {
			t.Error("12 (2 digits) should not trigger all-numeric check (threshold >2)")
		}
	}
}

func TestHoneypot_SignalType_ConsecutiveDots(t *testing.T) {
	cases := []string{"jan..novak@firma.cz", "jan...novak@firma.cz"}
	for _, email := range cases {
		t.Run(email, func(t *testing.T) {
			signals := enrich.DetectHoneypot(email)
			var found bool
			for _, s := range signals {
				if s.Details == "consecutive dots in local part" {
					found = true
				}
			}
			if !found {
				t.Errorf("%s: expected consecutive dots signal, got %v", email, signals)
			}
		})
	}
}

func TestHoneypot_SignalType_SingleChar(t *testing.T) {
	for _, email := range []string{"x@firma.cz", "a@firma.cz"} {
		t.Run(email, func(t *testing.T) {
			signals := enrich.DetectHoneypot(email)
			var found bool
			for _, s := range signals {
				if s.Details == "single character local part" {
					found = true
				}
			}
			if !found {
				t.Errorf("%s: expected single-char signal, got %v", email, signals)
			}
		})
	}
}

func TestHoneypot_SignalType_TooLong(t *testing.T) {
	email := "averylonglocalpartthatexceedssixtyfourcharacterswhichisnotvalidperrfc@firma.cz"
	signals := enrich.DetectHoneypot(email)
	var found bool
	for _, s := range signals {
		if s.Details == "local part exceeds 64 chars" {
			found = true
		}
	}
	if !found {
		t.Errorf("oversized local part: expected signal, got %v", signals)
	}
}

func TestHoneypot_CaseInsensitive(t *testing.T) {
	cases := []struct {
		email string
		note  string
	}{
		{"ADMIN@firma.cz", "uppercase role-based"},
		{"Jan@GMIAL.COM", "uppercase typo domain"},
		{"TEST@firma.cz", "uppercase suspicious pattern"},
	}
	for _, tc := range cases {
		t.Run(tc.note, func(t *testing.T) {
			signals := enrich.DetectHoneypot(tc.email)
			if len(signals) == 0 {
				t.Errorf("%s (%s): expected signals, got none", tc.email, tc.note)
			}
		})
	}
}

func TestHoneypot_InvalidEmail(t *testing.T) {
	cases := []string{"notanemail", "", "@nodomain", "nolocal@"}
	for _, email := range cases {
		t.Run(fmt.Sprintf("%q", email), func(t *testing.T) {
			signals := enrich.DetectHoneypot(email)
			if len(signals) != 0 {
				t.Errorf("%q: invalid email should return 0 signals, got %v", email, signals)
			}
		})
	}
}

func TestHoneypot_FixTypoDomain_Roundtrip(t *testing.T) {
	cases := []struct{ in, want string }{
		{"jan@gmial.com", "jan@gmail.com"},
		{"jan@sezanm.cz", "jan@seznam.cz"},
		{"jan@volni.cz", "jan@volny.cz"},
		{"jan@firma.cz", "jan@firma.cz"}, // no change
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			if got := enrich.FixTypoDomain(tc.in); got != tc.want {
				t.Errorf("FixTypoDomain(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestHoneypot_MaxSeverity_Ordering(t *testing.T) {
	cases := []struct {
		signals []enrich.HoneypotSignal
		want    string
	}{
		{[]enrich.HoneypotSignal{{Severity: "low"}}, "low"},
		{[]enrich.HoneypotSignal{{Severity: "low"}, {Severity: "medium"}}, "medium"},
		{[]enrich.HoneypotSignal{{Severity: "high"}, {Severity: "low"}}, "high"},
		{[]enrich.HoneypotSignal{{Severity: "critical"}, {Severity: "high"}}, "critical"},
		{nil, ""},
	}
	for _, tc := range cases {
		if got := enrich.MaxSeverity(tc.signals); got != tc.want {
			t.Errorf("MaxSeverity(%v) = %q, want %q", tc.signals, got, tc.want)
		}
	}
}

// ─────────────────────────────────────────────
//  FPR / FNR measurement
// ─────────────────────────────────────────────

// TestHoneypot_FalsePositiveRate measures the false positive rate over the
// cleanCases dataset. Acceptable threshold: FPR = 0%.
func TestHoneypot_FalsePositiveRate(t *testing.T) {
	var fps []string
	for _, tc := range cleanCases {
		signals := enrich.DetectHoneypot(tc.email)
		if len(signals) > 0 {
			fps = append(fps, fmt.Sprintf("%s [%s] → signals: %v", tc.email, tc.note, signals))
		}
	}

	total := len(cleanCases)
	fpr := float64(len(fps)) / float64(total)

	t.Logf("Clean dataset: %d cases", total)
	t.Logf("False positives: %d (FPR=%.1f%%)", len(fps), fpr*100)
	for _, fp := range fps {
		t.Logf("  FP: %s", fp)
	}

	const maxFPR = 0.0 // acceptable threshold: 0%
	if fpr > maxFPR {
		t.Errorf("FPR %.1f%% exceeds threshold %.0f%% — %d false positive(s):",
			fpr*100, maxFPR*100, len(fps))
		for _, fp := range fps {
			t.Errorf("  %s", fp)
		}
	}
}

// TestHoneypot_FalseNegativeRate measures the false negative rate over the
// honeypotCases dataset. Acceptable threshold: FNR = 0%.
func TestHoneypot_FalseNegativeRate(t *testing.T) {
	var fns []string
	for _, tc := range honeypotCases {
		signals := enrich.DetectHoneypot(tc.email)
		if len(signals) == 0 {
			fns = append(fns, fmt.Sprintf("%s [%s]", tc.email, tc.note))
		}
	}

	total := len(honeypotCases)
	fnr := float64(len(fns)) / float64(total)

	t.Logf("Honeypot dataset: %d cases", total)
	t.Logf("False negatives: %d (FNR=%.1f%%)", len(fns), fnr*100)
	for _, fn := range fns {
		t.Logf("  FN: %s", fn)
	}

	const maxFNR = 0.0 // acceptable threshold: 0%
	if fnr > maxFNR {
		t.Errorf("FNR %.1f%% exceeds threshold %.0f%% — %d false negative(s):",
			fnr*100, maxFNR*100, len(fns))
		for _, fn := range fns {
			t.Errorf("  %s", fn)
		}
	}
}

// TestHoneypot_AmbiguousCases documents edge cases that sit on the boundary.
// These are logged only — no assertions — so changes to detection logic that
// affect them produce visible output without failing the suite.
func TestHoneypot_AmbiguousCases(t *testing.T) {
	for _, tc := range ambiguousCases {
		signals := enrich.DetectHoneypot(tc.email)
		detected := len(signals) > 0
		severity := enrich.MaxSeverity(signals)
		t.Logf("AMBIGUOUS %s: detected=%v severity=%q — %s",
			tc.email, detected, severity, tc.reason)
	}
}

// TestHoneypot_Summary prints a full dataset summary for documentation purposes.
func TestHoneypot_Summary(t *testing.T) {
	cleanFPs := 0
	for _, tc := range cleanCases {
		if len(enrich.DetectHoneypot(tc.email)) > 0 {
			cleanFPs++
		}
	}
	honeypotFNs := 0
	for _, tc := range honeypotCases {
		if len(enrich.DetectHoneypot(tc.email)) == 0 {
			honeypotFNs++
		}
	}

	t.Logf("═══════════════════════════════════════")
	t.Logf("Honeypot Validation Summary")
	t.Logf("═══════════════════════════════════════")
	t.Logf("Clean cases:    %3d  FP: %d  FPR: %.1f%%",
		len(cleanCases), cleanFPs, float64(cleanFPs)/float64(len(cleanCases))*100)
	t.Logf("Honeypot cases: %3d  FN: %d  FNR: %.1f%%",
		len(honeypotCases), honeypotFNs, float64(honeypotFNs)/float64(len(honeypotCases))*100)
	t.Logf("Ambiguous:      %3d  (excluded from metrics)", len(ambiguousCases))
	t.Logf("Threshold: FPR ≤ 0%%,  FNR ≤ 0%%")
}
