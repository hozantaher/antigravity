package content

import (
	"testing"
)

// ptr is a helper to take a pointer to a string literal.
func ptr(s string) *string { return &s }

// ──────────────────────────────────────────────────────────────────────────────
// L1 — IP leakage tests
// ──────────────────────────────────────────────────────────────────────────────

// Test 1: All-Seznam Received chain → L1 = 50.
func TestL1_AllSeznamIPs(t *testing.T) {
	chain := []string{
		"from smtp1.seznam.cz ([185.146.213.10]) by mx.email.cz",
		"from mx.seznam.cz ([77.75.72.5]) by smtp.seznam.cz",
	}
	score, leaks := scoreL1IPLeak(chain)
	if score != 50 {
		t.Errorf("expected L1=50, got %d", score)
	}
	if len(leaks) != 0 {
		t.Errorf("expected 0 leaks, got %d: %+v", len(leaks), leaks)
	}
}

// Test 2: One Mullvad-exit IP in chain → L1 = 40, leak emitted.
func TestL1_OneMullvadExitIP(t *testing.T) {
	chain := []string{
		"from vpn.mullvad.net ([193.32.127.55]) by mx.email.cz",
		"from smtp.seznam.cz ([185.146.213.20]) by mx.email.cz",
	}
	score, leaks := scoreL1IPLeak(chain)
	if score != 40 {
		t.Errorf("expected L1=40, got %d", score)
	}
	if len(leaks) != 1 {
		t.Errorf("expected 1 leak, got %d", len(leaks))
	}
	if leaks[0].Rule != "L1_external_ip_in_received" {
		t.Errorf("wrong rule: %q", leaks[0].Rule)
	}
}

// Test 3: Two non-Seznam IPs → L1 = 30.
func TestL1_TwoNonSeznamIPs(t *testing.T) {
	chain := []string{
		"from host1.example.com ([203.0.113.1]) by mx.email.cz",
		"from host2.example.com ([198.51.100.5]) by smtp.seznam.cz",
		"from smtp.seznam.cz ([185.146.213.50]) by mx.seznam.cz",
	}
	score, leaks := scoreL1IPLeak(chain)
	if score != 30 {
		t.Errorf("expected L1=30, got %d", score)
	}
	if len(leaks) != 2 {
		t.Errorf("expected 2 leaks, got %d", len(leaks))
	}
}

// Test 4: ≥5 non-Seznam IPs → L1 = 0 (capped, not negative).
func TestL1_FiveNonSeznamIPs_Capped(t *testing.T) {
	chain := []string{
		"from h1 ([203.0.113.1]) by mx",
		"from h2 ([198.51.100.2]) by mx",
		"from h3 ([198.51.100.3]) by mx",
		"from h4 ([198.51.100.4]) by mx",
		"from h5 ([198.51.100.5]) by mx",
	}
	score, _ := scoreL1IPLeak(chain)
	if score != 0 {
		t.Errorf("expected L1=0 (capped), got %d", score)
	}
}

// Test 5: Localhost-only chain → L1 = 50 (neutral, no deduction).
func TestL1_LocalhostOnly(t *testing.T) {
	chain := []string{
		"from localhost ([127.0.0.1]) by mx.email.cz",
		"from ::1 by mx.email.cz",
	}
	score, leaks := scoreL1IPLeak(chain)
	if score != 50 {
		t.Errorf("expected L1=50 (localhost neutral), got %d", score)
	}
	if len(leaks) != 0 {
		t.Errorf("expected 0 leaks for localhost chain, got %d", len(leaks))
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// L2 — Header fingerprint tests
// ──────────────────────────────────────────────────────────────────────────────

// Test 6: X-Mailer "go-mail v1.2" present → L2 = 10, leak emitted.
func TestL2_XMailerGoMail(t *testing.T) {
	headers := map[string][]string{
		"X-Mailer": {"go-mail v1.2"},
	}
	score, leaks := scoreL2HeaderFP(headers, "<abc123@email.cz>")
	if score != 10 {
		t.Errorf("expected L2=10, got %d", score)
	}
	if len(leaks) < 1 {
		t.Fatal("expected at least 1 leak")
	}
	if leaks[0].Rule != "L2_xmailer_present" {
		t.Errorf("expected rule L2_xmailer_present, got %q", leaks[0].Rule)
	}
}

// Test 7: Custom Message-ID `<hash@outreach.local>` → L2 = 15, leak emitted.
func TestL2_NonSeznamMessageID(t *testing.T) {
	headers := map[string][]string{}
	score, leaks := scoreL2HeaderFP(headers, "<hash123@outreach.local>")
	if score != 15 {
		t.Errorf("expected L2=15, got %d", score)
	}
	found := false
	for _, l := range leaks {
		if l.Rule == "L2_message_id_non_seznam_format" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected L2_message_id_non_seznam_format leak, got %+v", leaks)
	}
}

// Test 8: Clean headers + valid Message-ID → L2 = 20, no leaks.
func TestL2_CleanHeaders(t *testing.T) {
	headers := map[string][]string{
		"Subject": {"Hello"},
	}
	score, leaks := scoreL2HeaderFP(headers, "<abc@email.cz>")
	if score != 20 {
		t.Errorf("expected L2=20, got %d", score)
	}
	if len(leaks) != 0 {
		t.Errorf("expected 0 leaks, got %+v", leaks)
	}
}

// Test 9: User-Agent present → deducts 5 pts.
func TestL2_UserAgentPresent(t *testing.T) {
	headers := map[string][]string{
		"User-Agent": {"Thunderbird/102.5"},
	}
	score, leaks := scoreL2HeaderFP(headers, "<abc@email.cz>")
	if score != 15 {
		t.Errorf("expected L2=15, got %d", score)
	}
	found := false
	for _, l := range leaks {
		if l.Rule == "L2_user_agent_present" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected L2_user_agent_present leak")
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// L3 — Envelope match tests
// ──────────────────────────────────────────────────────────────────────────────

// Test 10: Return-Path == From → L3 = 10.
func TestL3_ReturnPathMatchesFrom(t *testing.T) {
	score, leaks := scoreL3EnvelopeMatch("sender@email.cz", "<sender@email.cz>")
	if score != 10 {
		t.Errorf("expected L3=10, got %d", score)
	}
	if len(leaks) != 0 {
		t.Errorf("expected 0 leaks, got %+v", leaks)
	}
}

// Test 11: Return-Path != From → L3 = 0, leak emitted.
func TestL3_ReturnPathMismatch(t *testing.T) {
	score, leaks := scoreL3EnvelopeMatch("sender@email.cz", "bounce+123@bouncehandler.com")
	if score != 0 {
		t.Errorf("expected L3=0, got %d", score)
	}
	if len(leaks) != 1 {
		t.Errorf("expected 1 leak, got %d", len(leaks))
	}
	if leaks[0].Rule != "L3_envelope_from_mismatch" {
		t.Errorf("wrong rule: %q", leaks[0].Rule)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// L4 — DKIM/SPF/DMARC tests
// ──────────────────────────────────────────────────────────────────────────────

// Test 12: dkim + spf + dmarc all pass → L4 = 20.
func TestL4_AllPass(t *testing.T) {
	score, leaks := scoreL4Auth(ptr("pass"), ptr("pass"), ptr("pass"))
	if score != 20 {
		t.Errorf("expected L4=20, got %d", score)
	}
	if len(leaks) != 0 {
		t.Errorf("expected 0 leaks, got %+v", leaks)
	}
}

// Test 13: dkim fail, spf pass, dmarc missing → L4 = 6.
func TestL4_DKIMFailSPFPassDMARCMissing(t *testing.T) {
	score, leaks := scoreL4Auth(ptr("fail"), ptr("pass"), nil)
	if score != 6 {
		t.Errorf("expected L4=6 (spf only), got %d", score)
	}
	if len(leaks) != 2 {
		t.Errorf("expected 2 leaks (dkim fail + dmarc nil), got %d: %+v", len(leaks), leaks)
	}
}

// Test 14: All NULL auth results → L4 = 0.
func TestL4_AllNil(t *testing.T) {
	score, leaks := scoreL4Auth(nil, nil, nil)
	if score != 0 {
		t.Errorf("expected L4=0, got %d", score)
	}
	if len(leaks) != 3 {
		t.Errorf("expected 3 leaks, got %d", len(leaks))
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Total score boundary tests
// ──────────────────────────────────────────────────────────────────────────────

// Test 15: Synthetic worst case → total score = 0 (never negative).
func TestTotal_WorstCase_NotNegative(t *testing.T) {
	msg := AnonymityMessage{
		// 6 external IPs → L1 would be −10 but clamped to 0
		ReceivedChain: []string{
			"from h1 ([203.0.113.1]) by mx",
			"from h2 ([198.51.100.2]) by mx",
			"from h3 ([198.51.100.3]) by mx",
			"from h4 ([198.51.100.4]) by mx",
			"from h5 ([198.51.100.5]) by mx",
			"from h6 ([198.51.100.6]) by mx",
		},
		RawHeaders: map[string][]string{
			"X-Mailer":   {"outreach v2.0"},
			"User-Agent": {"BotMailer/1.0"},
			"X-Auto":     {"automation=true"},
		},
		MessageID:  "<hash@outreach.local>",
		FromAddr:   "sender@email.cz",
		ReturnPath: "bounce@other.com",
		DKIMResult: ptr("fail"),
		SPFResult:  ptr("fail"),
		DMARCResult: nil,
	}
	score := ScoreAnonymity(msg)
	if score.Total < 0 {
		t.Errorf("total score must not be negative, got %d", score.Total)
	}
	if score.Total != 0 {
		t.Logf("total=%d (L1=%d L2=%d L3=%d L4=%d)", score.Total, score.L1IPLeak, score.L2HeaderFP, score.L3Envelope, score.L4Auth)
		t.Errorf("expected total=0 for worst case, got %d", score.Total)
	}
}

// Test 16: Best-case message → total score = 100.
func TestTotal_BestCase_100(t *testing.T) {
	msg := AnonymityMessage{
		ReceivedChain: []string{
			"from smtp.seznam.cz ([185.146.213.10]) by mx.email.cz",
		},
		RawHeaders:  map[string][]string{},
		MessageID:   "<randomhash@email.cz>",
		FromAddr:    "sender@email.cz",
		ReturnPath:  "sender@email.cz",
		DKIMResult:  ptr("pass"),
		SPFResult:   ptr("pass"),
		DMARCResult: ptr("pass"),
	}
	score := ScoreAnonymity(msg)
	if score.Total != 100 {
		t.Errorf("expected total=100 for best case, got %d (L1=%d L2=%d L3=%d L4=%d; leaks=%+v)",
			score.Total, score.L1IPLeak, score.L2HeaderFP, score.L3Envelope, score.L4Auth, score.Leaks)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────────────────────────────────────

// Test 17: Empty chain → L1 = 50 (no IPs to penalise).
func TestL1_EmptyChain(t *testing.T) {
	score, leaks := scoreL1IPLeak(nil)
	if score != 50 {
		t.Errorf("expected L1=50 for empty chain, got %d", score)
	}
	if len(leaks) != 0 {
		t.Errorf("expected 0 leaks for empty chain, got %+v", leaks)
	}
}

// Test 18: X-Generated-By with automation content → deducts 10 from L2.
func TestL2_AutomationXHeader(t *testing.T) {
	headers := map[string][]string{
		"X-Generated-By": {"automation-pipeline v3"},
	}
	score, leaks := scoreL2HeaderFP(headers, "<abc@email.cz>")
	if score != 10 {
		t.Errorf("expected L2=10, got %d", score)
	}
	found := false
	for _, l := range leaks {
		if l.Rule == "L2_automation_header_present" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected L2_automation_header_present leak")
	}
}

// Test 19: Severity fields are set correctly for critical leak.
func TestLeakSeverity_L1Critical(t *testing.T) {
	chain := []string{"from h1 ([203.0.113.1]) by mx"}
	_, leaks := scoreL1IPLeak(chain)
	if len(leaks) == 0 {
		t.Fatal("expected leak")
	}
	if leaks[0].Severity != "critical" {
		t.Errorf("expected severity=critical, got %q", leaks[0].Severity)
	}
}

// Test 20: Private IP (RFC 1918) is neutral and doesn't create a leak.
func TestL1_PrivateIPNeutral(t *testing.T) {
	chain := []string{
		"from internal ([10.0.0.5]) by relay.seznam.cz",
		"from smtp.seznam.cz ([185.146.213.1]) by mx.email.cz",
	}
	score, leaks := scoreL1IPLeak(chain)
	if score != 50 {
		t.Errorf("expected L1=50 (private IP neutral), got %d", score)
	}
	if len(leaks) != 0 {
		t.Errorf("expected 0 leaks, got %+v", leaks)
	}
}
