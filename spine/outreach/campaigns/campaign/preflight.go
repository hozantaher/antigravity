package campaign

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"campaigns/content"
	"common/sqlsuppression"
)

// KT-A5 — Pre-flight checks.
//
// Before the operator activates the staircase (see staircase.go) the
// runner must be able to answer "would this campaign even succeed if I
// hit Send right now?" Pre-flight is the cheap dry-check: every
// failable boundary surface gets probed in isolation and the operator
// sees which gates are green/red BEFORE any email leaves the system.
//
// Probes implemented (≥ 5 — required scope):
//   1. Mailbox passwords present (db lookup; no SMTP login attempt).
//   2. Suppression UNION query reachable (Schema A + Schema B).
//   3. Templates render without spintax error (calls content.Engine).
//   4. Privacy URL HEAD request, 5s timeout.
//   5. DNS resolves for sending domain(s).
//
// HARD-RULE alignment (memory feedback_campaign_send): NONE of these
// probes invoke sender.Engine.Send(). They only read DB state and do
// HEAD/DNS checks. The mailbox-password probe deliberately does NOT
// open SMTP because a failed AUTH would burn reputation on the SMTP
// provider's side; "is the password column non-empty?" is the cheap
// surrogate.

// CheckResult captures the outcome of one pre-flight probe. The shape
// is JSON-friendly so the BFF can forward it verbatim to the operator
// UI without a translation layer.
type CheckResult struct {
	// Name is the stable identifier ("mailbox_passwords", "dns",
	// "suppression_union", "templates", "privacy_url"). The dashboard
	// renders a localized label keyed off this name.
	Name string `json:"name"`

	// OK indicates the probe passed. False = blocking gate; the
	// operator must resolve before activation.
	OK bool `json:"ok"`

	// Detail is a short Czech sentence explaining the outcome (success
	// summary or root-cause hint). Always populated. Plain text — the
	// dashboard renders verbatim.
	Detail string `json:"detail"`

	// DurationMS is the wall-clock cost of the probe (operator visibility
	// into slow checks). 0 if not measured.
	DurationMS int64 `json:"duration_ms,omitempty"`
}

// PreflightReport aggregates every probe outcome plus a top-level
// "OK" computed as the AND of all sub-checks.
type PreflightReport struct {
	OK     bool          `json:"ok"`
	Checks []CheckResult `json:"checks"`
}

// HTTPClient lets tests inject a stub for the privacy-URL probe
// without dragging in net/http/httptest plumbing on the call site.
// http.Client satisfies it.
type HTTPClient interface {
	Do(req *http.Request) (*http.Response, error)
}

// DNSResolver lets tests stub net.LookupHost. Production wires the
// stdlib resolver; tests pass a fixed-result stub.
type DNSResolver interface {
	LookupHost(ctx context.Context, host string) ([]string, error)
}

// stdResolver wraps net.DefaultResolver to satisfy DNSResolver.
type stdResolver struct{}

func (stdResolver) LookupHost(ctx context.Context, host string) ([]string, error) {
	return net.DefaultResolver.LookupHost(ctx, host)
}

// PreflightOptions configures the probes. All zero-value fields fall
// back to safe production defaults.
type PreflightOptions struct {
	// PrivacyURL is the published Privacy Notice URL referenced from
	// every campaign template. Empty = skip the probe (returns
	// "skipped, not configured" with OK=true so the gate doesn't false-
	// positive in dev).
	PrivacyURL string

	// SendingDomains is the list of domains the campaign will Mail-From.
	// Pulled from outreach_mailboxes.from_address (caller decides which
	// mailboxes are eligible). Empty = skip DNS probe.
	SendingDomains []string

	// TemplateNames is the list of template files the campaign uses
	// (campaigns.sequence_config[].template). Empty = skip template
	// probe.
	TemplateNames []string

	// HTTPTimeout is the budget for the privacy-URL HEAD. Default 5s.
	HTTPTimeout time.Duration

	// HTTPClient overrides http.DefaultClient for tests. Optional.
	HTTPClient HTTPClient

	// Resolver overrides net.DefaultResolver for tests. Optional.
	Resolver DNSResolver

	// ContentEngine renders templates for the spintax probe. May be nil
	// (probe reports "skipped, no engine wired" with OK=true).
	ContentEngine *content.Engine
}

// RunPreflight executes every applicable probe against the supplied
// DB + options. Probes run sequentially (5 probes × low-millisecond
// latency each = no benefit from goroutines, plus deterministic order
// is operator-friendly).
//
// The function never errors — a probe failure becomes a CheckResult
// with OK=false. The boolean on the returned report tells the caller
// whether the campaign is preflight-clean.
func RunPreflight(ctx context.Context, db DB, opts PreflightOptions) PreflightReport {
	checks := make([]CheckResult, 0, 5)

	checks = append(checks, checkMailboxPasswords(ctx, db))
	checks = append(checks, checkSuppressionUnion(ctx, db))
	checks = append(checks, checkTemplates(opts.TemplateNames, opts.ContentEngine))
	checks = append(checks, checkPrivacyURL(ctx, opts))
	checks = append(checks, checkDNS(ctx, opts))

	allOK := true
	for _, c := range checks {
		if !c.OK {
			allOK = false
			break
		}
	}
	return PreflightReport{OK: allOK, Checks: checks}
}

// ── individual probes ───────────────────────────────────────────────

// checkMailboxPasswords verifies every active mailbox has a non-empty
// password column. We deliberately read length(password)>0, not the
// password itself — this stays operator-readable in slow query logs
// without leaking secrets.
func checkMailboxPasswords(ctx context.Context, db DB) CheckResult {
	start := time.Now()
	out := CheckResult{Name: "mailbox_passwords"}
	defer func() { out.DurationMS = time.Since(start).Milliseconds() }()

	if db == nil {
		out.Detail = "DB nepřipojeno – probe vynechán"
		out.OK = true
		return out
	}
	var total, withPwd int
	err := db.QueryRowContext(ctx, `
		SELECT COUNT(*)::int, COUNT(*) FILTER (WHERE length(password) > 0)::int
		FROM outreach_mailboxes
		WHERE status = 'active' AND environment = 'production'
	`).Scan(&total, &withPwd)
	if err != nil {
		out.OK = false
		out.Detail = fmt.Sprintf("dotaz na schránky selhal: %v", err)
		return out
	}
	if total == 0 {
		out.OK = false
		out.Detail = "žádná aktivní schránka v outreach_mailboxes"
		return out
	}
	if withPwd < total {
		out.OK = false
		out.Detail = fmt.Sprintf("%d/%d aktivních schránek bez hesla", total-withPwd, total)
		return out
	}
	out.OK = true
	out.Detail = fmt.Sprintf("%d aktivních schránek má heslo", total)
	return out
}

// checkSuppressionUnion confirms the canonical NOT-IN UNION query
// (see suppressionFilterSQL in runner.go) executes against both
// suppression tables. We don't require ANY rows to exist — empty
// suppression list is a legitimate state at first launch.
func checkSuppressionUnion(ctx context.Context, db DB) CheckResult {
	start := time.Now()
	out := CheckResult{Name: "suppression_union"}
	defer func() { out.DurationMS = time.Since(start).Milliseconds() }()

	if db == nil {
		out.Detail = "DB nepřipojeno – probe vynechán"
		out.OK = true
		return out
	}
	var cnt int
	err := db.QueryRowContext(ctx, sqlsuppression.CountUnionSQL).Scan(&cnt)
	if err != nil {
		out.OK = false
		out.Detail = fmt.Sprintf("UNION dotaz selhal: %v", err)
		return out
	}
	out.OK = true
	out.Detail = fmt.Sprintf("UNION dostupný – %d záznamů", cnt)
	return out
}

// checkTemplates renders every named template with neutral test vars
// to surface spintax/regex/templating errors before they explode in
// the runner hot-path.
func checkTemplates(names []string, eng *content.Engine) CheckResult {
	start := time.Now()
	out := CheckResult{Name: "templates"}
	defer func() { out.DurationMS = time.Since(start).Milliseconds() }()

	if len(names) == 0 {
		out.OK = true
		out.Detail = "žádné šablony k ověření"
		return out
	}
	if eng == nil {
		out.OK = true
		out.Detail = "content engine nezapojen – probe vynechán"
		return out
	}
	vars := content.TemplateVars{
		Firma:    "Testovací firma s.r.o.",
		Jmeno:    "Test",
		Prijmeni: "Operátor",
		Region:   "Praha",
		ICO:      "00000000",
		UnsubURL: "https://example.invalid/unsubscribe?t=preflight",
	}
	bad := make([]string, 0)
	for _, name := range names {
		if name == "" {
			continue
		}
		if _, err := eng.Render(name, vars, 1, 0); err != nil {
			bad = append(bad, fmt.Sprintf("%s: %v", name, err))
		}
	}
	if len(bad) > 0 {
		out.OK = false
		out.Detail = "render selhal: " + strings.Join(bad, "; ")
		return out
	}
	out.OK = true
	out.Detail = fmt.Sprintf("%d šablon vykresleno bez chyby", len(names))
	return out
}

// checkPrivacyURL HEAD-requests the published Privacy Notice URL with
// a 5-second timeout. A 200/204 = green; any 4xx/5xx = red. The probe
// runs even if HEAD is rejected (some hosts fall back to GET) — we
// retry with GET on a 405 response.
func checkPrivacyURL(ctx context.Context, opts PreflightOptions) CheckResult {
	start := time.Now()
	out := CheckResult{Name: "privacy_url"}
	defer func() { out.DurationMS = time.Since(start).Milliseconds() }()

	if opts.PrivacyURL == "" {
		out.OK = true
		out.Detail = "PRIVACY_URL nenakonfigurován – probe vynechán"
		return out
	}
	parsed, err := url.Parse(opts.PrivacyURL)
	if err != nil || parsed.Host == "" {
		out.OK = false
		out.Detail = fmt.Sprintf("PRIVACY_URL špatně formátováno: %q", opts.PrivacyURL)
		return out
	}

	timeout := opts.HTTPTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	doReq := func(method string) (*http.Response, error) {
		req, err := http.NewRequestWithContext(probeCtx, method, opts.PrivacyURL, nil)
		if err != nil {
			return nil, err
		}
		return client.Do(req)
	}
	resp, err := doReq(http.MethodHead)
	if err != nil {
		out.OK = false
		out.Detail = fmt.Sprintf("HEAD %s selhal: %v", opts.PrivacyURL, err)
		return out
	}
	resp.Body.Close()

	// Some servers return 405 for HEAD — retry with GET before failing.
	if resp.StatusCode == http.StatusMethodNotAllowed {
		resp, err = doReq(http.MethodGet)
		if err != nil {
			out.OK = false
			out.Detail = fmt.Sprintf("GET fallback selhal: %v", err)
			return out
		}
		resp.Body.Close()
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 400 {
		out.OK = true
		out.Detail = fmt.Sprintf("%s → %d", opts.PrivacyURL, resp.StatusCode)
		return out
	}
	out.OK = false
	out.Detail = fmt.Sprintf("%s vrátil %d (očekáváno 2xx/3xx)", opts.PrivacyURL, resp.StatusCode)
	return out
}

// checkDNS resolves every sending domain. A single empty A/AAAA record
// is enough to pass — we're checking "the domain exists", not "the
// domain has working MX records" (MX would require a separate probe
// the operator likely already monitors).
func checkDNS(ctx context.Context, opts PreflightOptions) CheckResult {
	start := time.Now()
	out := CheckResult{Name: "dns"}
	defer func() { out.DurationMS = time.Since(start).Milliseconds() }()

	if len(opts.SendingDomains) == 0 {
		out.OK = true
		out.Detail = "žádná sending domain – probe vynechán"
		return out
	}
	res := opts.Resolver
	if res == nil {
		res = stdResolver{}
	}
	bad := make([]string, 0)
	for _, d := range opts.SendingDomains {
		host := strings.TrimSpace(d)
		if host == "" {
			continue
		}
		// Strip any "user@" prefix accidentally passed in.
		if at := strings.LastIndex(host, "@"); at >= 0 {
			host = host[at+1:]
		}
		addrs, err := res.LookupHost(ctx, host)
		if err != nil {
			bad = append(bad, fmt.Sprintf("%s: %v", host, err))
			continue
		}
		if len(addrs) == 0 {
			bad = append(bad, fmt.Sprintf("%s: žádný A/AAAA záznam", host))
		}
	}
	if len(bad) > 0 {
		out.OK = false
		out.Detail = "DNS chyby: " + strings.Join(bad, "; ")
		return out
	}
	out.OK = true
	out.Detail = fmt.Sprintf("%d domén rozloženo", len(opts.SendingDomains))
	return out
}
