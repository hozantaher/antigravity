package probe

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"strings"
	"time"
)

// --------------------------------------------------------------------
// L3 probe: spf_dmarc — per-domain DNS correctness check
//
// For each sending domain the probe verifies:
//   - An SPF TXT record exists on the apex (v=spf1 ... ~all or -all)
//   - A DMARC TXT record exists at _dmarc.<domain> with p=quarantine
//     or p=reject (p=none is accepted as warn — better than missing)
//
// Cadence: 15m (DNS TTL is typically 3600s so more frequent makes
// little sense, but we want to catch propagation regressions quickly
// after a DNS change).
// --------------------------------------------------------------------

// Resolver abstracts net.LookupTXT for test injection.
type Resolver interface {
	LookupTXT(ctx context.Context, name string) ([]string, error)
}

type netResolver struct{ r *net.Resolver }

func (n *netResolver) LookupTXT(ctx context.Context, name string) ([]string, error) {
	return n.r.LookupTXT(ctx, name)
}

var defaultResolver Resolver = &netResolver{r: net.DefaultResolver}

type SpfDmarcL3 struct {
	Domains  []string // sending domains, e.g. ["example.com"]
	Resolver Resolver  // nil → DefaultResolver
	Cadence  time.Duration
}

func NewSpfDmarcL3(domains []string, cadence time.Duration) *SpfDmarcL3 {
	return &SpfDmarcL3{Domains: domains, Cadence: cadence}
}

func (p *SpfDmarcL3) Layer() string { return "spf_dmarc" }
func (p *SpfDmarcL3) Level() Level  { return LevelCorrect }
func (p *SpfDmarcL3) Interval() time.Duration {
	if p.Cadence <= 0 {
		return 15 * time.Minute
	}
	return p.Cadence
}

func (p *SpfDmarcL3) Run(ctx context.Context) Result {
	if len(p.Domains) == 0 {
		return Result{Status: StatusSkip, Detail: "no sending domains configured (SENDING_DOMAINS)"}
	}
	res := p.Resolver
	if res == nil {
		res = defaultResolver
	}

	start := time.Now()
	expected := map[string]any{}
	actual := map[string]any{}
	overall := StatusOK

	for _, domain := range p.Domains {
		spfStatus, spfDetail := checkSPF(ctx, res, domain)
		dmarcStatus, dmarcDetail := checkDMARC(ctx, res, domain)

		expected["spf_"+domain] = "v=spf1 ... ~all or -all"
		expected["dmarc_"+domain] = "p=quarantine or p=reject"
		actual["spf_"+domain] = spfDetail
		actual["dmarc_"+domain] = dmarcDetail

		if spfStatus == StatusErr || dmarcStatus == StatusErr {
			overall = StatusErr
		} else if (spfStatus == StatusWarn || dmarcStatus == StatusWarn) && overall != StatusErr {
			overall = StatusWarn
		}
	}

	detail := ""
	if overall != StatusOK {
		parts := []string{}
		for k, v := range actual {
			if s, ok := v.(string); ok && strings.HasPrefix(s, "ERR") || strings.HasPrefix(s, "WARN") {
				parts = append(parts, fmt.Sprintf("%s: %s", k, v))
			}
		}
		detail = strings.Join(parts, "; ")
	}

	return Result{
		Status:   overall,
		Detail:   detail,
		Latency:  time.Since(start),
		Expected: expected,
		Actual:   actual,
	}
}

func checkSPF(ctx context.Context, res Resolver, domain string) (Status, string) {
	txts, err := res.LookupTXT(ctx, domain)
	if err != nil {
		return StatusErr, fmt.Sprintf("ERR lookup: %v", err)
	}
	for _, txt := range txts {
		if strings.HasPrefix(txt, "v=spf1") {
			if strings.Contains(txt, "-all") || strings.Contains(txt, "~all") {
				return StatusOK, txt
			}
			return StatusWarn, fmt.Sprintf("WARN: SPF has no -all/~all: %q", txt)
		}
	}
	return StatusErr, "ERR: no SPF TXT record found"
}

func checkDMARC(ctx context.Context, res Resolver, domain string) (Status, string) {
	txts, err := res.LookupTXT(ctx, "_dmarc."+domain)
	if err != nil {
		return StatusErr, fmt.Sprintf("ERR lookup: %v", err)
	}
	for _, txt := range txts {
		if strings.HasPrefix(txt, "v=DMARC1") {
			if strings.Contains(txt, "p=reject") {
				return StatusOK, txt
			}
			if strings.Contains(txt, "p=quarantine") {
				return StatusOK, txt
			}
			if strings.Contains(txt, "p=none") {
				return StatusWarn, fmt.Sprintf("WARN: DMARC p=none (no enforcement): %q", txt)
			}
			return StatusWarn, fmt.Sprintf("WARN: DMARC policy unrecognised: %q", txt)
		}
	}
	return StatusErr, "ERR: no DMARC TXT record found"
}

// --------------------------------------------------------------------
// L3 probe: watchdog meta — cadence completeness check
//
// WatchdogL2 checks: "was there a watchdog event in the last 15 min?"
// WatchdogMetaL3 checks: "over the last 24 h, did the watchdog run at
// least once per 6-hour window?" — this catches a watchdog that fires
// once (clearing the L2 alarm) but then silently dies for hours.
//
// Expected: at least 4 events in the last 24h (one per 6h window).
// Cadence: 30m.
// --------------------------------------------------------------------

type WatchdogMetaL3 struct {
	DB      *sql.DB
	Windows int // expected windows in 24h; default 4
	Cadence time.Duration
}

func NewWatchdogMetaL3(db *sql.DB, cadence time.Duration) *WatchdogMetaL3 {
	return &WatchdogMetaL3{DB: db, Windows: 4, Cadence: cadence}
}

func (p *WatchdogMetaL3) Layer() string { return "watchdog" }
func (p *WatchdogMetaL3) Level() Level  { return LevelCorrect }
func (p *WatchdogMetaL3) Interval() time.Duration {
	if p.Cadence <= 0 {
		return 30 * time.Minute
	}
	return p.Cadence
}

func (p *WatchdogMetaL3) Run(ctx context.Context) Result {
	if p.DB == nil {
		return Result{Status: StatusSkip, Detail: "db not configured"}
	}
	windows := p.Windows
	if windows <= 0 {
		windows = 4
	}
	start := time.Now()
	expected := map[string]any{
		"events_per_window_count": windows,
		"window_hours":            6,
		"lookback_hours":          24,
	}
	actual := map[string]any{}

	// Count how many distinct 6-hour windows in the last 24h have at least
	// one watchdog_events row. Use date_trunc style bucketing.
	var windowsHit int
	var earliestAgeSeconds sql.NullFloat64
	err := p.DB.QueryRowContext(ctx, `
		SELECT
		  COUNT(DISTINCT floor(extract(epoch FROM created_at) / 21600))
		    FILTER (WHERE created_at >= now() - interval '24 hours'),
		  EXTRACT(EPOCH FROM (now() - MIN(created_at)))
		FROM watchdog_events`).Scan(&windowsHit, &earliestAgeSeconds)
	if err != nil {
		return Result{
			Status:   StatusErr,
			Detail:   fmt.Sprintf("query watchdog_events: %v", err),
			Latency:  time.Since(start),
			Expected: expected,
		}
	}
	actual["windows_with_events"] = windowsHit

	// If the watchdog table is younger than the 24h lookback, the probe
	// can't assert 4×6h coverage yet. Expect `windowsHit` to at least
	// match the number of 6h buckets that have elapsed since the first
	// event — partial coverage is not intermittency.
	if earliestAgeSeconds.Valid {
		elapsedWindows := int(earliestAgeSeconds.Float64/21600) + 1
		if elapsedWindows < windows {
			windows = elapsedWindows
			actual["effective_windows"] = windows
			actual["first_event_age_s"] = int(earliestAgeSeconds.Float64)
		}
	}

	latency := time.Since(start)
	if windowsHit == 0 {
		return Result{
			Status:   StatusErr,
			Detail:   "no watchdog events in last 24h — watchdog may be down",
			Latency:  latency,
			Expected: expected,
			Actual:   actual,
		}
	}
	if windowsHit < windows {
		return Result{
			Status:   StatusWarn,
			Detail:   fmt.Sprintf("only %d/%d 6h windows have events — watchdog may be intermittent", windowsHit, windows),
			Latency:  latency,
			Expected: expected,
			Actual:   actual,
		}
	}
	return Result{Status: StatusOK, Latency: latency, Expected: expected, Actual: actual}
}
