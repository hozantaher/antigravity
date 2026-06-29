package profile

import (
	"testing"
	"time"
)

// ════════════════════════════════════════════════════════════════════════
// Brutal coverage for ML3.3 — combined evaluation pipeline.
// ════════════════════════════════════════════════════════════════════════

// 1. Empty/normal request on gmail = accept (no greylist, under limit, normal msg).
func TestS33_Evaluate_HappyAccept(t *testing.T) {
	r := loadedRegistry(t)
	res, err := r.Evaluate("gmail.lab", EvaluateRequest{
		SenderMailbox: "a@gmail.lab",
		SenderIP:      "1.2.3.4",
		SenderAddr:    "s@x",
		RecipientAddr: "r@gmail.lab",
		SizeBytes:     1000,
	})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if res.Decision != "accept" {
		t.Errorf("decision %q, want accept (fired_by=%s reason=%q)", res.Decision, res.FiredBy, res.Reason)
	}
	if res.FiredBy != "static" {
		t.Errorf("fired_by %q, want static", res.FiredBy)
	}
}

// 2. Greylist fires first on outlook (greylist_unknown_sender=true).
func TestS33_Evaluate_GreylistFiresFirst(t *testing.T) {
	r := loadedRegistry(t)
	res, _ := r.Evaluate("outlook.lab", EvaluateRequest{
		SenderMailbox: "a@outlook.lab",
		SenderIP:      "1.2.3.4",
		SenderAddr:    "s@x",
		RecipientAddr: "r@outlook.lab",
	})
	if res.Decision != "greylist" {
		t.Errorf("decision %q, want greylist", res.Decision)
	}
	if res.FiredBy != "greylist" {
		t.Errorf("fired_by %q, want greylist", res.FiredBy)
	}
}

// 3. After greylist passes, rate limit fires when over.
func TestS33_Evaluate_RateLimitFires(t *testing.T) {
	r := loadedRegistry(t)
	// outlook limit=30; saturate.
	for i := 0; i < 30; i++ {
		r.tracker.Record("a@outlook.lab")
	}
	// Skip greylist by graduating the triplet.
	now := time.Now()
	clock := now
	r.SetGreylistClock(func() time.Time { return clock })
	r.GreylistAllow("outlook.lab", "1.2.3.4", "s@x", "r@outlook.lab")
	clock = now.Add(6 * time.Minute)
	r.GreylistAllow("outlook.lab", "1.2.3.4", "s@x", "r@outlook.lab")

	res, _ := r.Evaluate("outlook.lab", EvaluateRequest{
		SenderMailbox: "a@outlook.lab",
		SenderIP:      "1.2.3.4",
		SenderAddr:    "s@x",
		RecipientAddr: "r@outlook.lab",
		HasDkim:       true,
	})
	if res.Decision != "reject" {
		t.Errorf("decision %q, want reject (fired_by=%s)", res.Decision, res.FiredBy)
	}
	if res.FiredBy != "rate_limit" {
		t.Errorf("fired_by %q, want rate_limit", res.FiredBy)
	}
	if res.RateCount != 30 || res.RateLimit != 30 {
		t.Errorf("count=%d limit=%d, want 30/30", res.RateCount, res.RateLimit)
	}
}

// 4. Static rules fire when greylist + rate pass (size over).
func TestS33_Evaluate_StaticRejectSize(t *testing.T) {
	r := loadedRegistry(t)
	res, _ := r.Evaluate("gmail.lab", EvaluateRequest{
		SenderMailbox: "a@gmail.lab",
		SenderIP:      "1.2.3.4",
		SenderAddr:    "s@x",
		RecipientAddr: "r@gmail.lab",
		SizeBytes:     99999999, // > 25MB
	})
	if res.Decision != "reject" {
		t.Errorf("decision %q, want reject", res.Decision)
	}
	if res.FiredBy != "static" {
		t.Errorf("fired_by %q, want static", res.FiredBy)
	}
}

// 5. RecordRate=true advances tracker; RecordRate=false does not.
func TestS33_Evaluate_RecordRateFlag(t *testing.T) {
	r := loadedRegistry(t)
	// 1st: don't record
	r.Evaluate("gmail.lab", EvaluateRequest{
		SenderMailbox: "a@gmail.lab",
		SenderAddr:    "s@x",
		RecipientAddr: "r@gmail.lab",
		HasDkim:       true,
		RecordRate:    false,
	})
	if c := r.tracker.Count("a@gmail.lab"); c != 0 {
		t.Errorf("count after no-record = %d, want 0", c)
	}
	// 2nd: do record
	r.Evaluate("gmail.lab", EvaluateRequest{
		SenderMailbox: "a@gmail.lab",
		SenderAddr:    "s@x",
		RecipientAddr: "r@gmail.lab",
		HasDkim:       true,
		RecordRate:    true,
	})
	if c := r.tracker.Count("a@gmail.lab"); c != 1 {
		t.Errorf("count after record = %d, want 1", c)
	}
}

// 6. Unknown domain → ErrUnknownDomain.
func TestS33_Evaluate_Unknown_Errors(t *testing.T) {
	r := loadedRegistry(t)
	_, err := r.Evaluate("never.lab", EvaluateRequest{})
	if err != ErrUnknownDomain {
		t.Errorf("got %v, want ErrUnknownDomain", err)
	}
}

// 7. EvaluateFromMap roundtrips raw JSON map.
func TestS33_EvaluateFromMap_Roundtrip(t *testing.T) {
	r := loadedRegistry(t)
	out, err := r.EvaluateFromMap("gmail.lab", map[string]interface{}{
		"sender_mailbox": "a@gmail.lab",
		"recipient_addr": "r@gmail.lab",
		"size_bytes":     float64(1000),
		"has_dkim":       true,
	})
	if err != nil {
		t.Fatalf("from-map: %v", err)
	}
	res := out.(*EvaluateResult)
	if res.Decision != "accept" {
		t.Errorf("decision %q, want accept", res.Decision)
	}
}

// 8. EvaluateFromMap unknown → ErrUnknownDomain.
func TestS33_EvaluateFromMap_Unknown(t *testing.T) {
	r := loadedRegistry(t)
	_, err := r.EvaluateFromMap("never.lab", nil)
	if err != ErrUnknownDomain {
		t.Errorf("got %v, want ErrUnknownDomain", err)
	}
}

// 9. Static-stage spam classification fires (gmail link_ratio > 0.3).
func TestS33_Evaluate_StaticSpam(t *testing.T) {
	r := loadedRegistry(t)
	res, _ := r.Evaluate("gmail.lab", EvaluateRequest{
		SenderMailbox: "a@gmail.lab",
		RecipientAddr: "r@gmail.lab",
		LinkRatio:     0.9,
	})
	if res.Decision != "spam" {
		t.Errorf("decision %q, want spam", res.Decision)
	}
}

// 10. Static-stage DKIM strict rejects on seznam.
func TestS33_Evaluate_StaticDKIMStrict(t *testing.T) {
	r := loadedRegistry(t)
	res, _ := r.Evaluate("seznam.lab", EvaluateRequest{
		SenderMailbox: "a@seznam.lab",
		RecipientAddr: "r@seznam.lab",
		OriginCountry: "CZ",
		HasDkim:       false,
	})
	if res.Decision != "reject" {
		t.Errorf("decision %q, want reject", res.Decision)
	}
}

// 11. Greylist disabled (gmail) skips greylist stage even with no triplet
// state — fired_by must be static.
func TestS33_Evaluate_GreylistSkippedOnDisabledProfile(t *testing.T) {
	r := loadedRegistry(t)
	res, _ := r.Evaluate("gmail.lab", EvaluateRequest{
		SenderMailbox: "a@gmail.lab",
		RecipientAddr: "r@gmail.lab",
		HasDkim:       true,
	})
	if res.FiredBy == "greylist" {
		t.Errorf("greylist fired on gmail (should be disabled)")
	}
}

// 12. Greylist accept (graduated) lets eval proceed to next stage.
func TestS33_Evaluate_GreylistGraduates(t *testing.T) {
	r := loadedRegistry(t)
	now := time.Now()
	clock := now
	r.SetGreylistClock(func() time.Time { return clock })
	r.GreylistAllow("outlook.lab", "1.2.3.4", "s@x", "r@outlook.lab")
	clock = now.Add(6 * time.Minute)
	res, _ := r.Evaluate("outlook.lab", EvaluateRequest{
		SenderMailbox: "a@outlook.lab",
		SenderIP:      "1.2.3.4",
		SenderAddr:    "s@x",
		RecipientAddr: "r@outlook.lab",
		HasDkim:       true,
	})
	if res.FiredBy == "greylist" {
		t.Errorf("graduated triplet still firing greylist: %+v", res)
	}
}

// 13. Rate fields zeroed out when profile has no rate limit.
func TestS33_Evaluate_NoRateInfoOnZeroLimit(t *testing.T) {
	r := NewRegistry()
	r.profiles["x.lab"] = &Profile{Domain: "x.lab", RateLimitPerHour: 0}
	res, _ := r.Evaluate("x.lab", EvaluateRequest{
		SenderMailbox: "a@x.lab",
		RecipientAddr: "r@x.lab",
	})
	if res.RateLimit != 0 || res.RateCount != 0 {
		t.Errorf("rate fields leaked: %+v", res)
	}
}

// 14. Reason populated on reject (rate_limit case).
func TestS33_Evaluate_RateRejectHasReason(t *testing.T) {
	r := loadedRegistry(t)
	for i := 0; i < 30; i++ {
		r.tracker.Record("spammer@outlook.lab")
	}
	now := time.Now()
	clock := now
	r.SetGreylistClock(func() time.Time { return clock })
	r.GreylistAllow("outlook.lab", "1.2.3.4", "s@x", "r@outlook.lab")
	clock = now.Add(6 * time.Minute)
	r.GreylistAllow("outlook.lab", "1.2.3.4", "s@x", "r@outlook.lab")
	res, _ := r.Evaluate("outlook.lab", EvaluateRequest{
		SenderMailbox: "spammer@outlook.lab",
		SenderIP:      "1.2.3.4",
		SenderAddr:    "s@x",
		RecipientAddr: "r@outlook.lab",
		HasDkim:       true,
	})
	if res.Reason == "" {
		t.Errorf("rate_limit reason empty: %+v", res)
	}
}

// 15. Pipeline ordering deterministic when both greylist + rate would fire.
// Greylist fires first (4xx defer dominates 5xx reject).
func TestS33_Evaluate_OrderingGreylistOverRate(t *testing.T) {
	r := loadedRegistry(t)
	// Fill rate counter
	for i := 0; i < 30; i++ {
		r.tracker.Record("a@outlook.lab")
	}
	// Triplet has never been seen — greylist should fire first.
	res, _ := r.Evaluate("outlook.lab", EvaluateRequest{
		SenderMailbox: "a@outlook.lab",
		SenderIP:      "1.2.3.4",
		SenderAddr:    "s@x",
		RecipientAddr: "r@outlook.lab",
	})
	if res.FiredBy != "greylist" {
		t.Errorf("expected greylist before rate, fired_by=%q", res.FiredBy)
	}
}
