package web

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"time"
)

// dnsResolver abstracts net.LookupTXT for test injection.
type dnsResolver interface {
	LookupTXT(ctx context.Context, name string) ([]string, error)
}

type netDNSResolver struct{ r *net.Resolver }

func (n *netDNSResolver) LookupTXT(ctx context.Context, name string) ([]string, error) {
	return n.r.LookupTXT(ctx, name)
}

var defaultDNSResolver dnsResolver = &netDNSResolver{r: net.DefaultResolver}

// handleDnsAudit returns SPF/DMARC health for each configured sending domain.
// GET /api/dns-audit — API-key protected.
func (s *Server) handleDnsAudit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	domains := s.sendingDomains
	if len(domains) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"status":     "skip",
			"detail":     "no sending domains configured",
			"latency_ms": 0,
			"domains":    map[string]any{},
		})
		return
	}

	res := s.dnsResolver
	if res == nil {
		res = defaultDNSResolver
	}

	start := time.Now()
	overall := "ok"
	domainResults := map[string]any{}

	for _, domain := range domains {
		spfStatus, spfDetail := checkSPFWeb(r.Context(), res, domain)
		dmarcStatus, dmarcDetail := checkDMARCWeb(r.Context(), res, domain)

		domainResults[domain] = map[string]any{
			"spf_status":   spfStatus,
			"spf_detail":   spfDetail,
			"dmarc_status": dmarcStatus,
			"dmarc_detail": dmarcDetail,
		}

		if spfStatus == "err" || dmarcStatus == "err" {
			overall = "err"
		} else if (spfStatus == "warn" || dmarcStatus == "warn") && overall != "err" {
			overall = "warn"
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"status":     overall,
		"latency_ms": time.Since(start).Milliseconds(),
		"domains":    domainResults,
	})
}

func checkSPFWeb(ctx context.Context, res dnsResolver, domain string) (string, string) {
	txts, err := res.LookupTXT(ctx, domain)
	if err != nil {
		return "err", "lookup failed: " + err.Error()
	}
	for _, txt := range txts {
		if strings.HasPrefix(txt, "v=spf1") {
			if strings.Contains(txt, "-all") || strings.Contains(txt, "~all") {
				return "ok", txt
			}
			return "warn", "SPF missing -all/~all: " + txt
		}
	}
	return "err", "no SPF TXT record found"
}

func checkDMARCWeb(ctx context.Context, res dnsResolver, domain string) (string, string) {
	txts, err := res.LookupTXT(ctx, "_dmarc."+domain)
	if err != nil {
		return "err", "lookup failed: " + err.Error()
	}
	for _, txt := range txts {
		if strings.HasPrefix(txt, "v=DMARC1") {
			if strings.Contains(txt, "p=reject") || strings.Contains(txt, "p=quarantine") {
				return "ok", txt
			}
			if strings.Contains(txt, "p=none") {
				return "warn", "DMARC p=none (no enforcement): " + txt
			}
			return "warn", "DMARC policy unrecognised: " + txt
		}
	}
	return "err", "no DMARC TXT record found"
}
