package profile

import (
	"sync"
	"testing"
)

// ════════════════════════════════════════════════════════════════════════
// Brutal coverage for ML2.3 — message verdict per profile.
// ════════════════════════════════════════════════════════════════════════

func loadedRegistry(t *testing.T) *Registry {
	t.Helper()
	r := NewRegistry()
	if _, err := r.LoadEmbedded(); err != nil {
		t.Fatalf("load embedded: %v", err)
	}
	return r
}

// 1. Nil profile defaults to accept (no-op safety).
func TestS23_Verdict_NilProfile_Accepts(t *testing.T) {
	d, _ := Verdict(nil, MessageContext{})
	if d != DecisionAccept {
		t.Errorf("nil profile got %q, want accept", d)
	}
}

// 2. Empty context against a non-strict profile = accept (gmail).
func TestS23_Verdict_EmptyContext_Accepts(t *testing.T) {
	r := loadedRegistry(t)
	got, _ := r.Get("gmail.lab")
	p := got.(*Profile)
	d, reason := Verdict(p, MessageContext{})
	if d != DecisionAccept {
		t.Errorf("empty ctx got %q (%q), want accept", d, reason)
	}
}

// 3. Oversized message rejects (per-provider).
func TestS23_Verdict_SizeOver_Rejects(t *testing.T) {
	r := loadedRegistry(t)
	cases := []struct {
		domain string
		size   int64 // a hair over MaxMessageSizeBytes
	}{
		{"seznam.lab", 31457281},  // > 30MB
		{"gmail.lab", 26214401},   // > 25MB
		{"outlook.lab", 36700161}, // > 35MB
	}
	for _, c := range cases {
		got, _ := r.Get(c.domain)
		p := got.(*Profile)
		d, reason := Verdict(p, MessageContext{SizeBytes: c.size, HasDkim: true})
		if d != DecisionReject {
			t.Errorf("%s size %d got %q (%q), want reject", c.domain, c.size, d, reason)
		}
	}
}

// 4. Message exactly at the cap accepts (off-by-one boundary).
func TestS23_Verdict_SizeAtCap_Accepts(t *testing.T) {
	r := loadedRegistry(t)
	got, _ := r.Get("seznam.lab")
	p := got.(*Profile)
	d, _ := Verdict(p, MessageContext{
		SizeBytes:           p.MaxMessageSizeBytes,
		HasDkim:             true,
		SenderOriginCountry: "CZ",
	})
	if d != DecisionAccept {
		t.Errorf("at-cap got %q, want accept", d)
	}
}

// 5. CIDR match rejects (Mullvad IP against seznam).
func TestS23_Verdict_ProxyCIDR_Rejects(t *testing.T) {
	r := loadedRegistry(t)
	got, _ := r.Get("seznam.lab")
	p := got.(*Profile)
	d, reason := Verdict(p, MessageContext{
		SenderIP:            "194.242.45.99", // inside 194.242.0.0/16
		HasDkim:             true,
		SenderOriginCountry: "CZ",
	})
	if d != DecisionReject {
		t.Errorf("Mullvad IP got %q (%q), want reject", d, reason)
	}
}

// 6. Outside-CIDR IP accepts (boundary).
func TestS23_Verdict_NonProxyIP_Accepts(t *testing.T) {
	r := loadedRegistry(t)
	got, _ := r.Get("seznam.lab")
	p := got.(*Profile)
	d, _ := Verdict(p, MessageContext{
		SenderIP:            "8.8.8.8", // not in any reject CIDR
		HasDkim:             true,
		SenderOriginCountry: "CZ",
	})
	if d != DecisionAccept {
		t.Errorf("non-proxy IP got %q, want accept", d)
	}
}

// 7. DKIM strict rejects when missing (seznam.lab is strict).
func TestS23_Verdict_DkimStrict_Rejects(t *testing.T) {
	r := loadedRegistry(t)
	got, _ := r.Get("seznam.lab")
	p := got.(*Profile)
	d, reason := Verdict(p, MessageContext{HasDkim: false, SenderOriginCountry: "CZ"})
	if d != DecisionReject {
		t.Errorf("no DKIM got %q (%q), want reject", d, reason)
	}
}

// 8. DKIM strict accepts when present.
func TestS23_Verdict_DkimStrictPresent_Accepts(t *testing.T) {
	r := loadedRegistry(t)
	got, _ := r.Get("seznam.lab")
	p := got.(*Profile)
	d, _ := Verdict(p, MessageContext{HasDkim: true, SenderOriginCountry: "CZ"})
	if d != DecisionAccept {
		t.Errorf("DKIM ok got %q, want accept", d)
	}
}

// 9. Non-CZ origin rejects on seznam (RejectNonCzOrigin=true).
func TestS23_Verdict_NonCzOrigin_RejectsOnSeznam(t *testing.T) {
	r := loadedRegistry(t)
	got, _ := r.Get("seznam.lab")
	p := got.(*Profile)
	d, reason := Verdict(p, MessageContext{
		HasDkim:             true,
		SenderOriginCountry: "RU",
	})
	if d != DecisionReject {
		t.Errorf("RU origin got %q (%q), want reject", d, reason)
	}
}

// 10. Non-CZ origin accepts on gmail (RejectNonCzOrigin=false).
func TestS23_Verdict_NonCzOrigin_AcceptsOnGmail(t *testing.T) {
	r := loadedRegistry(t)
	got, _ := r.Get("gmail.lab")
	p := got.(*Profile)
	d, _ := Verdict(p, MessageContext{
		HasDkim:             false, // gmail not strict
		SenderOriginCountry: "RU",
	})
	if d != DecisionAccept {
		t.Errorf("gmail RU got %q, want accept", d)
	}
}

// 11. Greylist on outlook for unknown sender.
func TestS23_Verdict_Greylist_Outlook(t *testing.T) {
	r := loadedRegistry(t)
	got, _ := r.Get("outlook.lab")
	p := got.(*Profile)
	d, reason := Verdict(p, MessageContext{
		HasDkim:     true,
		KnownSender: false,
	})
	if d != DecisionGreylist {
		t.Errorf("outlook unknown got %q (%q), want greylist", d, reason)
	}
}

// 12. Known sender bypasses greylist on outlook.
func TestS23_Verdict_KnownSender_BypassesGreylist(t *testing.T) {
	r := loadedRegistry(t)
	got, _ := r.Get("outlook.lab")
	p := got.(*Profile)
	d, _ := Verdict(p, MessageContext{
		HasDkim:     true,
		KnownSender: true,
	})
	if d != DecisionAccept {
		t.Errorf("outlook known got %q, want accept", d)
	}
}

// 13. Spam classification when LinkRatio > threshold.
func TestS23_Verdict_HighLinkRatio_Spam(t *testing.T) {
	r := loadedRegistry(t)
	got, _ := r.Get("gmail.lab")
	p := got.(*Profile)
	d, reason := Verdict(p, MessageContext{
		HasDkim:   false,
		LinkRatio: 0.8, // > gmail's 0.3
	})
	if d != DecisionSpam {
		t.Errorf("high link got %q (%q), want spam", d, reason)
	}
}

// 14. LinkRatio at threshold accepts (strict-greater boundary).
func TestS23_Verdict_LinkRatioAtThreshold_Accepts(t *testing.T) {
	r := loadedRegistry(t)
	got, _ := r.Get("gmail.lab")
	p := got.(*Profile)
	d, _ := Verdict(p, MessageContext{
		HasDkim:   false,
		LinkRatio: 0.3, // == threshold, not greater
	})
	if d != DecisionAccept {
		t.Errorf("at-threshold got %q, want accept", d)
	}
}

// 15. Reject ordering: oversized + proxy IP → size wins (deterministic).
func TestS23_Verdict_RejectOrdering_SizeFirst(t *testing.T) {
	r := loadedRegistry(t)
	got, _ := r.Get("seznam.lab")
	p := got.(*Profile)
	_, reason := Verdict(p, MessageContext{
		SizeBytes: 99999999,
		SenderIP:  "194.242.45.99",
		HasDkim:   true,
	})
	if reason == "" || reason == "sender IP in reject_proxy_ips_cidr" {
		t.Errorf("expected size reason first, got %q", reason)
	}
}

// 16. Malformed sender IP is treated as no-IP (not a panic).
func TestS23_Verdict_MalformedIP_NoMatch(t *testing.T) {
	r := loadedRegistry(t)
	got, _ := r.Get("seznam.lab")
	p := got.(*Profile)
	d, _ := Verdict(p, MessageContext{
		SenderIP:            "not-an-ip",
		HasDkim:             true,
		SenderOriginCountry: "CZ",
	})
	if d != DecisionAccept {
		t.Errorf("malformed IP got %q, want accept", d)
	}
}

// 17. Registry.Check delegates correctly via JSON map.
func TestS23_Check_RoundtripJSONMap(t *testing.T) {
	r := loadedRegistry(t)
	d, _, err := r.Check("seznam.lab", map[string]interface{}{
		"size_bytes":            100.0, // JSON numbers come in as float64
		"has_dkim":              true,
		"sender_origin_country": "CZ",
	})
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if d != string(DecisionAccept) {
		t.Errorf("check ok got %q, want accept", d)
	}
}

// 18. Registry.Check on unknown domain errors.
func TestS23_Check_UnknownDomain_Errors(t *testing.T) {
	r := loadedRegistry(t)
	_, _, err := r.Check("never.lab", map[string]interface{}{})
	if err != ErrUnknownDomain {
		t.Errorf("got %v, want ErrUnknownDomain", err)
	}
}

// 19. Registry.Check is concurrency-safe.
func TestS23_Check_ConcurrentSafe(t *testing.T) {
	r := loadedRegistry(t)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _, _ = r.Check("gmail.lab", map[string]interface{}{
				"size_bytes": float64(i * 1024),
				"link_ratio": 0.1,
			})
		}(i)
	}
	wg.Wait()
}

// 20. Decision values are stable strings (API contract).
func TestS23_Decision_StableValues(t *testing.T) {
	for _, want := range []struct {
		d Decision
		s string
	}{
		{DecisionAccept, "accept"},
		{DecisionReject, "reject"},
		{DecisionGreylist, "greylist"},
		{DecisionSpam, "spam"},
	} {
		if string(want.d) != want.s {
			t.Errorf("Decision %q drifted, want %q", want.d, want.s)
		}
	}
}
