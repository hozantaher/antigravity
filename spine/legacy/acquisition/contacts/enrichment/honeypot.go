package enrich

import "strings"

// HoneypotSignal represents a detected suspicious pattern.
type HoneypotSignal struct {
	Type     string // typo_domain, role_based, suspicious_pattern, disposable
	Severity string // low, medium, high, critical
	Details  string
	Fix      string // suggested correction (e.g., corrected domain)
}

// Typo domain corrections (Czech-specific).
var typoDomains = map[string]string{
	// Czech freemails
	"sezanm.cz": "seznam.cz", "seznma.cz": "seznam.cz",
	"senam.cz": "seznam.cz", "seznamcz.cz": "seznam.cz",
	"senzam.cz": "seznam.cz", "seynam.cz": "seznam.cz",
	"szenam.cz": "seznam.cz", "seznan.cz": "seznam.cz",
	"emial.cz": "email.cz", "emal.cz": "email.cz",
	"emali.cz": "email.cz", "emaul.cz": "email.cz",
	"centrun.cz": "centrum.cz", "cetnrum.cz": "centrum.cz",
	"cetrum.cz": "centrum.cz", "centrim.cz": "centrum.cz",
	"volni.cz": "volny.cz", "volnycz.cz": "volny.cz",
	// Global freemails
	"gmial.com": "gmail.com", "gmal.com": "gmail.com",
	"gamil.com": "gmail.com", "gnail.com": "gmail.com",
	"gmaill.com": "gmail.com", "gmali.com": "gmail.com",
	"gmai.com": "gmail.com", "gmil.com": "gmail.com",
	"outloo.com": "outlook.com", "outlok.com": "outlook.com",
	"outllok.com": "outlook.com",
	"hotmal.com": "hotmail.com", "hotnail.com": "hotmail.com",
	"hotmial.com": "hotmail.com", "hotmali.com": "hotmail.com",
	"yahooo.com": "yahoo.com", "yaho.com": "yahoo.com",
	"yhoo.com": "yahoo.com",
}

// Role-based prefixes that suggest non-personal addresses.
var roleBasedPrefixes = map[string]bool{
	"abuse": true, "postmaster": true, "mailer-daemon": true,
	"noreply": true, "no-reply": true, "donotreply": true,
	"hostmaster": true, "webmaster": true, "admin": true,
	"root": true, "support": true, "help": true,
	"security": true, "spam": true, "ftp": true,
	"www": true, "mail": true, "newsletter": true,
	"unsubscribe": true, "bounce": true, "feedback": true,
}

// Suspicious patterns in the local part of the email.
var suspiciousPatterns = []string{
	"test", "asdf", "qwerty", "xxx", "aaa", "zzz",
	"temp", "tmp", "fake", "null", "void", "none",
	"example", "sample", "demo",
}

// DetectHoneypot checks an email for honeypot and spam trap indicators.
func DetectHoneypot(email string) []HoneypotSignal {
	var signals []HoneypotSignal

	parts := strings.SplitN(email, "@", 2)
	if len(parts) != 2 {
		return signals
	}
	local := strings.ToLower(parts[0])
	domain := strings.ToLower(parts[1])

	// 1. Typo domain
	if corrected, ok := typoDomains[domain]; ok {
		signals = append(signals, HoneypotSignal{
			Type:     "typo_domain",
			Severity: "medium",
			Details:  domain + " → " + corrected,
			Fix:      local + "@" + corrected,
		})
	}

	// 2. Role-based prefix
	if roleBasedPrefixes[local] {
		signals = append(signals, HoneypotSignal{
			Type:     "role_based",
			Severity: "low",
			Details:  "role-based prefix: " + local,
		})
	}

	// 3. Suspicious patterns
	for _, pattern := range suspiciousPatterns {
		if local == pattern || strings.HasPrefix(local, pattern+"@") ||
			strings.HasPrefix(local, pattern+".") || strings.HasPrefix(local, pattern+"_") {
			signals = append(signals, HoneypotSignal{
				Type:     "suspicious_pattern",
				Severity: "high",
				Details:  "suspicious local part: " + local,
			})
			break
		}
	}

	// 4. All-numeric local part
	if isAllNumeric(local) && len(local) > 2 {
		signals = append(signals, HoneypotSignal{
			Type:     "suspicious_pattern",
			Severity: "medium",
			Details:  "all-numeric local part: " + local,
		})
	}

	// 5. Very long local part (>64 chars per RFC)
	if len(local) > 64 {
		signals = append(signals, HoneypotSignal{
			Type:     "suspicious_pattern",
			Severity: "high",
			Details:  "local part exceeds 64 chars",
		})
	}

	// 6. Consecutive dots in local part (invalid per RFC 5321)
	if strings.Contains(local, "..") {
		signals = append(signals, HoneypotSignal{
			Type:     "suspicious_pattern",
			Severity: "medium",
			Details:  "consecutive dots in local part",
		})
	}

	// 7. Single character local part (likely auto-generated)
	if len(local) == 1 {
		signals = append(signals, HoneypotSignal{
			Type:     "suspicious_pattern",
			Severity: "medium",
			Details:  "single character local part",
		})
	}

	return signals
}

// IsRoleBasedEmail checks if the email uses a role-based prefix.
func IsRoleBasedEmail(email string) bool {
	parts := strings.SplitN(email, "@", 2)
	if len(parts) != 2 {
		return false
	}
	return roleBasedPrefixes[strings.ToLower(parts[0])]
}

// FixTypoDomain returns the corrected email if the domain is a known typo,
// otherwise returns the original email.
func FixTypoDomain(email string) string {
	parts := strings.SplitN(email, "@", 2)
	if len(parts) != 2 {
		return email
	}
	domain := strings.ToLower(parts[1])
	if corrected, ok := typoDomains[domain]; ok {
		return parts[0] + "@" + corrected
	}
	return email
}

// MaxSeverity returns the highest severity from signals.
func MaxSeverity(signals []HoneypotSignal) string {
	severityRank := map[string]int{"low": 1, "medium": 2, "high": 3, "critical": 4}
	best := ""
	bestRank := 0
	for _, s := range signals {
		if r := severityRank[s.Severity]; r > bestRank {
			bestRank = r
			best = s.Severity
		}
	}
	return best
}

func isAllNumeric(s string) bool {
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return len(s) > 0
}
