package validation

import (
	"context"
	"strings"
)

// SpamtrapValidator detects known spamtrap patterns and honeypot domains.
// Sending to a spamtrap instantly damages sender reputation.
type SpamtrapValidator struct{}

func (v *SpamtrapValidator) Name() string { return "spamtrap" }

func (v *SpamtrapValidator) Validate(ctx context.Context, email string) (bool, string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	local := localFromEmail(email)
	domain := domainFromEmail(email)

	if domain == "" {
		return false, "no domain", nil
	}

	// Known spamtrap domains
	for _, d := range spamtrapDomains {
		if domain == d {
			return false, "spamtrap domain: " + domain, nil
		}
	}

	// Spamtrap local-part patterns
	for _, pattern := range spamtrapLocalPatterns {
		if strings.Contains(local, pattern) {
			return false, "spamtrap pattern: " + pattern, nil
		}
	}

	// Pristine spamtrap indicators: very long random-looking local parts
	if len(local) > 30 && looksRandom(local) {
		return false, "suspiciously random local part", nil
	}

	return true, "not spamtrap", nil
}

// RoleValidator detects role-based addresses that are risky for cold outreach.
// These addresses often forward to groups or are monitored for abuse.
type RoleValidator struct{}

func (v *RoleValidator) Name() string { return "role" }

func (v *RoleValidator) Validate(ctx context.Context, email string) (bool, string, error) {
	local := localFromEmail(email)
	if local == "" {
		return false, "no local part", nil
	}

	for _, role := range dangerousRoles {
		if local == role {
			return false, "dangerous role address: " + role, nil
		}
	}

	for _, role := range riskyRoles {
		if local == role {
			return false, "risky role address: " + role, nil
		}
	}

	return true, "not role-based", nil
}

func localFromEmail(email string) string {
	parts := strings.SplitN(email, "@", 2)
	if len(parts) != 2 {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(parts[0]))
}

// looksRandom checks if a string appears to be randomly generated
// (high entropy, few vowels relative to length).
func looksRandom(s string) bool {
	if len(s) == 0 {
		return false
	}
	vowels := 0
	digits := 0
	for _, c := range s {
		switch c {
		case 'a', 'e', 'i', 'o', 'u':
			vowels++
		case '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
			digits++
		}
	}
	// Real names/words have ~35-40% vowels; random strings have ~19% (5/26)
	vowelRatio := float64(vowels) / float64(len(s))
	digitRatio := float64(digits) / float64(len(s))
	return vowelRatio < 0.15 || digitRatio > 0.4
}

// Dangerous role addresses — never send cold email to these.
// These are RFC 2142 required or abuse-monitoring addresses.
var dangerousRoles = []string{
	"abuse", "postmaster", "noreply", "no-reply", "noanswer",
	"mailer-daemon", "bounce", "spam", "phishing",
	"unsubscribe", "remove", "blacklist", "whitelist",
	"devnull", "null", "void",
}

// Risky role addresses — high bounce/complaint risk for cold outreach.
// May reach a person but often monitored or shared.
var riskyRoles = []string{
	"admin", "administrator", "webmaster", "hostmaster",
	"security", "compliance", "legal", "privacy",
	"support", "help", "helpdesk", "service",
	"billing", "invoices", "accounting",
	"marketing", "sales", "pr", "press", "media",
	"newsletter", "subscribe", "feedback",
	"root", "sysadmin", "ops", "devops",
	"test", "testing", "demo",
}

// Known spamtrap operator domains.
var spamtrapDomains = []string{
	// Project Honey Pot and known trap networks
	"spamcop.net",
	"spamhaus.org",
	"abuse.net",
	"lashback.com",
	"spamtrap.email",
	"spamtraps.com",
	"trap.email",
	// Common dead/parked domain patterns
	"example.com",
	"example.org",
	"example.net",
	"test.com",
	"invalid.com",
	"localhost.com",
}

// Local-part patterns associated with spamtraps.
var spamtrapLocalPatterns = []string{
	"spamtrap",
	"spam-trap",
	"honeypot",
	"honey-pot",
	"trap-",
	"-trap",
	"antispam",
	"anti-spam",
}
