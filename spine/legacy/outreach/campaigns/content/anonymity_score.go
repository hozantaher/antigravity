// Package content — anonymity scoring for Sprint S3.
//
// ScoreAnonymity applies four rule groups (L1–L4) to a harvested inbound
// message and returns a composite 0–100 score plus per-leak evidence.
//
// Rule weights:
//
//	L1 IP leakage      — 50 pts
//	L2 Header FP       — 20 pts
//	L3 Envelope match  — 10 pts
//	L4 DKIM/SPF/DMARC  — 20 pts
//
// Total is capped to [0, 100].
package content

import (
	"fmt"
	"net"
	"regexp"
	"strings"
)

// ──────────────────────────────────────────────────────────────────────────────
// Seznam SMTP IP ranges
//
// TODO: verify these against `dig smtp.seznam.cz` and cross-check current
// MX/A records before running against production. These ranges were
// current as of 2024; Seznam may have expanded them.
// Primary source: reverse PTR lookup on mail.seznam.cz SMTP banners.
// ──────────────────────────────────────────────────────────────────────────────

var seznamIPNets = mustParseNets([]string{
	"185.146.213.0/24", // smtp.seznam.cz primary range (historically confirmed)
	"77.75.72.0/22",    // seznam.cz broader infra range (covers 77.75.72–75.x)
})

func mustParseNets(cidrs []string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, cidr := range cidrs {
		_, ipNet, err := net.ParseCIDR(cidr)
		if err != nil {
			panic(fmt.Sprintf("anonymity_score: bad CIDR %q: %v", cidr, err))
		}
		out = append(out, ipNet)
	}
	return out
}

// ──────────────────────────────────────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────────────────────────────────────

// AnonymityMessage is the input to ScoreAnonymity.
// Fields map directly to columns in anonymity_test_messages.
type AnonymityMessage struct {
	// RawHeaders is the full decoded header map (header-name → value list).
	// Header names are expected to be in their original casing; lookups are
	// case-insensitive inside the scorer.
	RawHeaders    map[string][]string
	ReceivedChain []string // Received headers in arrival order (most recent first)
	MessageID     string
	FromAddr      string
	ReturnPath    string
	DKIMResult    *string // nil when header absent
	SPFResult     *string
	DMARCResult   *string
}

// AnonymityScore holds the composite result.
type AnonymityScore struct {
	Total      int    // 0–100 composite
	L1IPLeak   int    // 0–50 — IP leakage rule
	L2HeaderFP int    // 0–20 — header fingerprint rule
	L3Envelope int    // 0–10 — return-path == from
	L4Auth     int    // 0–20 — DKIM/SPF/DMARC
	Leaks      []Leak // concrete failure evidence
}

// Leak describes a single anonymity failure.
type Leak struct {
	Rule     string // e.g. "L1_external_ip_in_received"
	Severity string // "critical" | "warn" | "info"
	Evidence string // the actual header value or regex match
}

// ──────────────────────────────────────────────────────────────────────────────
// Header-fingerprint regexes
// ──────────────────────────────────────────────────────────────────────────────

var (
	xMailerLeakRe    = regexp.MustCompile(`(?i)go-mail|outreach|mailer-bot`)
	messageIDGoodRe  = regexp.MustCompile(`^<\w+@email\.cz>$`)
	automationXHdrRe = regexp.MustCompile(`(?i)automation`)

	// receivedIPRe extracts IPv4 addresses from a Received: header.
	// Matches [x.x.x.x] or (x.x.x.x) or the bare-IP-in-from form.
	receivedIPv4Re = regexp.MustCompile(`(?:\[|from\s+)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})`)
)

// ──────────────────────────────────────────────────────────────────────────────
// ScoreAnonymity — main entry point
// ──────────────────────────────────────────────────────────────────────────────

// ScoreAnonymity computes a composite anonymity score for a single harvested
// message. Rules are applied independently; their contributions are summed and
// clamped to [0, 100].
func ScoreAnonymity(msg AnonymityMessage) AnonymityScore {
	var leaks []Leak

	l1, l1Leaks := scoreL1IPLeak(msg.ReceivedChain)
	leaks = append(leaks, l1Leaks...)

	l2, l2Leaks := scoreL2HeaderFP(msg.RawHeaders, msg.MessageID)
	leaks = append(leaks, l2Leaks...)

	l3, l3Leaks := scoreL3EnvelopeMatch(msg.FromAddr, msg.ReturnPath)
	leaks = append(leaks, l3Leaks...)

	l4, l4Leaks := scoreL4Auth(msg.DKIMResult, msg.SPFResult, msg.DMARCResult)
	leaks = append(leaks, l4Leaks...)

	total := l1 + l2 + l3 + l4
	if total < 0 {
		total = 0
	}
	if total > 100 {
		total = 100
	}

	return AnonymityScore{
		Total:      total,
		L1IPLeak:   l1,
		L2HeaderFP: l2,
		L3Envelope: l3,
		L4Auth:     l4,
		Leaks:      leaks,
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// L1 — IP leakage (50 pts)
// ──────────────────────────────────────────────────────────────────────────────

// scoreL1IPLeak inspects the Received chain for non-Seznam IPs.
//
// Algorithm:
//  1. Parse each Received header for IPv4 addresses.
//  2. Skip loopback / private / link-local addresses (neutral).
//  3. Count IPs that fall outside the known Seznam ranges — deduct 10 pts each.
//  4. Cap deduction at 50 (score floor 0).
//  5. If chain is empty or all IPs are loopback, grant full 50.
func scoreL1IPLeak(chain []string) (int, []Leak) {
	const maxScore = 50
	const deductionPerLeak = 10

	score := maxScore
	var leaks []Leak

	for _, hdr := range chain {
		matches := receivedIPv4Re.FindAllStringSubmatch(hdr, -1)
		for _, m := range matches {
			rawIP := m[1]
			ip := net.ParseIP(rawIP)
			if ip == nil {
				continue
			}
			// Neutral: loopback, private, link-local.
			if isNeutralIP(ip) {
				continue
			}
			// Good: inside a known Seznam range.
			if isInSeznamRange(ip) {
				continue
			}
			// Leak: external IP not in Seznam ranges.
			score -= deductionPerLeak
			leaks = append(leaks, Leak{
				Rule:     "L1_external_ip_in_received",
				Severity: "critical",
				Evidence: fmt.Sprintf("IP %s in: %s", rawIP, truncate(hdr, 200)),
			})
		}
	}

	if score < 0 {
		score = 0
	}
	return score, leaks
}

func isNeutralIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

func isInSeznamRange(ip net.IP) bool {
	for _, n := range seznamIPNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// ──────────────────────────────────────────────────────────────────────────────
// L2 — Header fingerprint (20 pts)
// ──────────────────────────────────────────────────────────────────────────────

// scoreL2HeaderFP starts at 20 and deducts for telltale sender headers.
func scoreL2HeaderFP(headers map[string][]string, messageID string) (int, []Leak) {
	score := 20
	var leaks []Leak

	// X-Mailer present and matches known automation patterns → -10 pts.
	for _, v := range headerAll(headers, "x-mailer") {
		if xMailerLeakRe.MatchString(v) {
			score -= 10
			leaks = append(leaks, Leak{
				Rule:     "L2_xmailer_present",
				Severity: "warn",
				Evidence: "X-Mailer: " + truncate(v, 100),
			})
		}
	}

	// User-Agent present (real SMTP submission shouldn't include it) → -5 pts.
	if vals := headerAll(headers, "user-agent"); len(vals) > 0 {
		score -= 5
		leaks = append(leaks, Leak{
			Rule:     "L2_user_agent_present",
			Severity: "warn",
			Evidence: "User-Agent: " + truncate(vals[0], 100),
		})
	}

	// Message-ID not in expected Seznam format → -5 pts.
	if messageID != "" && !messageIDGoodRe.MatchString(strings.TrimSpace(messageID)) {
		score -= 5
		leaks = append(leaks, Leak{
			Rule:     "L2_message_id_non_seznam_format",
			Severity: "info",
			Evidence: "Message-ID: " + truncate(messageID, 100),
		})
	}

	// Any X- header containing "automation" → -10 pts.
	for name, vals := range headers {
		if !strings.HasPrefix(strings.ToLower(name), "x-") {
			continue
		}
		for _, v := range vals {
			if automationXHdrRe.MatchString(v) {
				score -= 10
				leaks = append(leaks, Leak{
					Rule:     "L2_automation_header_present",
					Severity: "warn",
					Evidence: fmt.Sprintf("%s: %s", name, truncate(v, 100)),
				})
				goto doneAutomation
			}
		}
	}
doneAutomation:

	if score < 0 {
		score = 0
	}
	return score, leaks
}

// ──────────────────────────────────────────────────────────────────────────────
// L3 — Envelope match (10 pts)
// ──────────────────────────────────────────────────────────────────────────────

// scoreL3EnvelopeMatch returns 10 if Return-Path == From (bare address,
// case-insensitive), 0 otherwise.
func scoreL3EnvelopeMatch(fromAddr, returnPath string) (int, []Leak) {
	from := strings.ToLower(strings.TrimSpace(bareAddress(fromAddr)))
	rp := strings.ToLower(strings.TrimSpace(bareAddress(returnPath)))

	if from != "" && rp != "" && from == rp {
		return 10, nil
	}

	return 0, []Leak{
		{
			Rule:     "L3_envelope_from_mismatch",
			Severity: "warn",
			Evidence: fmt.Sprintf("From=%q ReturnPath=%q", fromAddr, returnPath),
		},
	}
}

// bareAddress extracts the bare email address from a "Display Name <addr>" form.
func bareAddress(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "<"); i >= 0 {
		if j := strings.Index(s[i:], ">"); j >= 0 {
			return s[i+1 : i+j]
		}
	}
	return s
}

// ──────────────────────────────────────────────────────────────────────────────
// L4 — DKIM/SPF/DMARC (20 pts)
// ──────────────────────────────────────────────────────────────────────────────

// scoreL4Auth awards points per passing authentication result:
//
//	dkim pass  → +8
//	spf  pass  → +6
//	dmarc pass → +6
//
// Missing or non-pass results contribute 0 and emit a Leak.
func scoreL4Auth(dkim, spf, dmarc *string) (int, []Leak) {
	score := 0
	var leaks []Leak

	score, leaks = addAuthPoints(score, leaks, dkim, "dkim", 8, "L4_dkim_not_pass")
	score, leaks = addAuthPoints(score, leaks, spf, "spf", 6, "L4_spf_not_pass")
	score, leaks = addAuthPoints(score, leaks, dmarc, "dmarc", 6, "L4_dmarc_not_pass")

	return score, leaks
}

func addAuthPoints(score int, leaks []Leak, result *string, name string, pts int, rule string) (int, []Leak) {
	if result != nil && strings.EqualFold(strings.TrimSpace(*result), "pass") {
		return score + pts, leaks
	}

	var evidence string
	if result == nil {
		evidence = fmt.Sprintf("%s result: nil (header absent)", name)
	} else {
		evidence = fmt.Sprintf("%s result: %q", name, *result)
	}

	return score, append(leaks, Leak{
		Rule:     rule,
		Severity: "warn",
		Evidence: evidence,
	})
}

// ──────────────────────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────────────────────

// headerAll returns all values for a header name (case-insensitive lookup).
func headerAll(headers map[string][]string, name string) []string {
	nameLower := strings.ToLower(name)
	for k, v := range headers {
		if strings.ToLower(k) == nameLower {
			return v
		}
	}
	return nil
}

// truncate caps a string to maxLen, appending "…" when truncated.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "…"
}
