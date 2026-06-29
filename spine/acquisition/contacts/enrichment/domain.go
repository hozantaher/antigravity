package enrich

import (
	"net"
	"strings"
)

// knownMXProviders maps MX hostname fragments to provider names.
var knownMXProviders = map[string]string{
	"google":     "Google",
	"googlemail": "Google",
	"outlook":    "Microsoft",
	"hotmail":    "Microsoft",
	"microsoft":  "Microsoft",
	"seznam":     "Seznam",
	"forpsi":     "Forpsi",
	"wedos":      "Wedos",
	"active24":   "Active24",
	"smarthost":  "SmartHost",
	"mailgun":    "Mailgun",
	"sendgrid":   "SendGrid",
	"amazonses":  "AWS SES",
	"zoho":       "Zoho",
	"protonmail": "ProtonMail",
}

// MXResult contains the result of an MX lookup.
type MXResult struct {
	Verified bool
	Provider string // e.g. "Google", "Microsoft", "Seznam", or raw MX host if unknown
}

// VerifyDomainMX performs a DNS MX lookup for the given domain.
// Returns MXResult — if lookup fails, Verified=false, Provider="".
func VerifyDomainMX(domain string) MXResult {
	records, err := net.LookupMX(domain)
	if err != nil || len(records) == 0 {
		return MXResult{}
	}

	host := strings.ToLower(records[0].Host)
	for fragment, provider := range knownMXProviders {
		if strings.Contains(host, fragment) {
			return MXResult{Verified: true, Provider: provider}
		}
	}

	// Unknown provider — strip trailing dot and use raw host
	host = strings.TrimSuffix(host, ".")
	return MXResult{Verified: true, Provider: host}
}

// DomainType classifies an email domain.
type DomainType string

const (
	DomainFreemail  DomainType = "freemail"
	DomainCorporate DomainType = "corporate"
	DomainCatchall  DomainType = "catchall"
	DomainGov       DomainType = "gov"
	DomainEdu       DomainType = "edu"
	DomainUnknown   DomainType = "unknown"
)

var freemailDomains = map[string]bool{
	// Czech
	"seznam.cz": true, "email.cz": true, "centrum.cz": true,
	"volny.cz": true, "tiscali.cz": true, "post.cz": true,
	"atlas.cz": true, "quick.cz": true, "iol.cz": true,
	"azet.cz": true, "wo.cz": true, "in.cz": true,
	"mybox.cz": true, "klikni.cz": true,
	// Slovak
	"azet.sk": true, "centrum.sk": true, "pobox.sk": true, "post.sk": true,
	"zoznam.sk": true, "atlas.sk": true,
	// Global
	"gmail.com": true, "googlemail.com": true,
	"outlook.com": true, "hotmail.com": true, "live.com": true, "msn.com": true,
	"outlook.cz": true, "hotmail.cz": true,
	"yahoo.com": true, "yahoo.co.uk": true, "yahoo.de": true,
	"icloud.com": true, "me.com": true, "mac.com": true,
	"protonmail.com": true, "proton.me": true, "pm.me": true,
	"tutanota.com": true, "tuta.io": true,
	"zoho.com": true, "yandex.com": true, "mail.ru": true,
	"aol.com": true, "gmx.com": true, "gmx.de": true, "gmx.net": true,
	"mail.com": true, "inbox.com": true,
}

// ClassifyDomain determines the type of an email domain.
func ClassifyDomain(domain string) DomainType {
	domain = strings.ToLower(strings.TrimSpace(domain))

	if domain == "" {
		return DomainUnknown
	}

	if freemailDomains[domain] {
		return DomainFreemail
	}

	// Czech government
	if strings.HasSuffix(domain, ".gov.cz") || strings.HasSuffix(domain, ".muni.cz") {
		return DomainGov
	}

	// Education
	if strings.HasSuffix(domain, ".edu") || strings.HasSuffix(domain, ".cuni.cz") ||
		strings.HasSuffix(domain, ".cvut.cz") || strings.HasSuffix(domain, ".vutbr.cz") ||
		strings.HasSuffix(domain, ".upol.cz") || strings.HasSuffix(domain, ".muni.cz") {
		return DomainEdu
	}

	return DomainCorporate
}

// IsFreemail returns true if the domain is a known freemail provider.
func IsFreemail(domain string) bool {
	return ClassifyDomain(domain) == DomainFreemail
}

// DomainFromEmail extracts the domain part from an email address.
func DomainFromEmail(email string) string {
	parts := strings.SplitN(email, "@", 2)
	if len(parts) != 2 {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(parts[1]))
}
