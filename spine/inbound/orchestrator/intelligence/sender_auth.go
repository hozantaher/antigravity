package intelligence

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"net"
	"strings"
)

// SenderAuthResult holds DNS record check results for one sender domain.
type SenderAuthResult struct {
	Domain string
	SPF    SPFResult
	DKIM   DKIMResult
	DMARC  DMARCResult
}

// SPFResult holds the SPF TXT record lookup result.
type SPFResult struct {
	Found   bool
	Record  string
	Problem string // non-empty if absent or malformed
}

// DKIMResult holds per-selector DKIM lookup result.
type DKIMResult struct {
	Found    bool
	Selector string
	Record   string
	Problem  string
}

// DMARCResult holds the DMARC TXT record lookup result.
type DMARCResult struct {
	Found   bool
	Record  string
	Problem string
}

// dnsLookupTXT abstracts net.LookupTXT so tests can inject a mock resolver.
var dnsLookupTXT = func(host string) ([]string, error) {
	return net.LookupTXT(host)
}

// lookupSPF resolves TXT records on the domain and returns the first SPF
// record (starts with "v=spf1"). An absent or malformed record is a problem.
func lookupSPF(domain string) SPFResult {
	txts, err := dnsLookupTXT(domain)
	if err != nil {
		return SPFResult{Found: false, Problem: fmt.Sprintf("dns_error: %s", err)}
	}
	for _, txt := range txts {
		if strings.HasPrefix(strings.TrimSpace(txt), "v=spf1") {
			return SPFResult{Found: true, Record: txt}
		}
	}
	return SPFResult{Found: false, Problem: "no_spf_record"}
}

// lookupDKIM tries a list of selectors and returns the first that resolves.
func lookupDKIM(domain string, selectors []string) DKIMResult {
	for _, sel := range selectors {
		host := fmt.Sprintf("%s._domainkey.%s", sel, domain)
		txts, err := dnsLookupTXT(host)
		if err != nil {
			continue // try next selector
		}
		for _, txt := range txts {
			if strings.Contains(txt, "p=") {
				return DKIMResult{Found: true, Selector: sel, Record: txt}
			}
		}
	}
	return DKIMResult{Found: false, Problem: "no_dkim_record_for_selectors"}
}

// lookupDMARC resolves _dmarc.<domain> and returns the DMARC policy record.
func lookupDMARC(domain string) DMARCResult {
	host := "_dmarc." + domain
	txts, err := dnsLookupTXT(host)
	if err != nil {
		return DMARCResult{Found: false, Problem: fmt.Sprintf("dns_error: %s", err)}
	}
	for _, txt := range txts {
		if strings.HasPrefix(strings.TrimSpace(txt), "v=DMARC1") {
			return DMARCResult{Found: true, Record: txt}
		}
	}
	return DMARCResult{Found: false, Problem: "no_dmarc_record"}
}

// CheckSenderAuth checks SPF, DKIM (selectors: seznam, default, s1, s2), and
// DMARC for a given sender domain. It never returns a hard error — DNS
// failures are captured as Problem strings in each sub-result.
func CheckSenderAuth(domain string) (SenderAuthResult, error) {
	spf := lookupSPF(domain)
	dkim := lookupDKIM(domain, []string{"seznam", "default", "s1", "s2"})
	dmarc := lookupDMARC(domain)
	return SenderAuthResult{
		Domain: domain,
		SPF:    spf,
		DKIM:   dkim,
		DMARC:  dmarc,
	}, nil
}

// RunSenderAuthenticationCheck fetches production mailbox domains from the DB,
// runs CheckSenderAuth for each distinct domain, and logs/Sentry-warns on any
// problem. It is designed to be called by the daily cron.
//
// Per feedback_send_via_seznam_only: outbound is via Seznam; SPF/DKIM/DMARC for
// garaaage.cz is not our domain. We only check to detect if Seznam's own
// authentication infra breaks — we cannot fix it, we can only alert.
func RunSenderAuthenticationCheck(ctx context.Context, db *sql.DB) ([]SenderAuthResult, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT DISTINCT
			split_part(from_address, '@', 2) AS domain
		FROM outreach_mailboxes
		WHERE environment = 'production'
		  AND status NOT IN ('retired', 'auth_locked')
		  AND from_address LIKE '%@%'
	`)
	if err != nil {
		return nil, fmt.Errorf("sender_auth: query mailbox domains: %w", err)
	}
	defer rows.Close()

	var domains []string
	for rows.Next() {
		var d string
		if scanErr := rows.Scan(&d); scanErr != nil {
			slog.Warn("sender_auth: scan error", "op", "intelligence.RunSenderAuthenticationCheck/scan", "error", scanErr)
			continue
		}
		if d != "" {
			domains = append(domains, d)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sender_auth: rows error: %w", err)
	}

	results := make([]SenderAuthResult, 0, len(domains))
	for _, domain := range domains {
		if ctx.Err() != nil {
			break
		}
		r, _ := CheckSenderAuth(domain) // never hard-errors
		results = append(results, r)

		problems := collectProblems(r)
		if len(problems) > 0 {
			slog.Warn("sender_auth: authentication problem detected",
				"op", "intelligence.RunSenderAuthenticationCheck/check",
				"domain", domain,
				"problems", strings.Join(problems, "; "),
			)
		} else {
			slog.Info("sender_auth: ok",
				"op", "intelligence.RunSenderAuthenticationCheck/check",
				"domain", domain,
			)
		}
	}

	return results, nil
}

// collectProblems extracts problem strings from a SenderAuthResult.
func collectProblems(r SenderAuthResult) []string {
	var problems []string
	if r.SPF.Problem != "" {
		problems = append(problems, "spf:"+r.SPF.Problem)
	}
	if r.DKIM.Problem != "" {
		problems = append(problems, "dkim:"+r.DKIM.Problem)
	}
	if r.DMARC.Problem != "" {
		problems = append(problems, "dmarc:"+r.DMARC.Problem)
	}
	return problems
}
