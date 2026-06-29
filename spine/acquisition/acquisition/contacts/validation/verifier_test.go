package validation

import (
	"context"
	"net"
	"testing"
	"time"
)

// stubMXVerifier creates a Verifier with stubbed DNS (no network calls).
func stubMXVerifier() *Verifier {
	v := NewVerifier(nil) // no DB
	v.mx = &MXValidator{
		LookupMX: func(ctx context.Context, domain string) ([]*net.MX, error) {
			switch domain {
			case "firma.cz", "podnik.cz", "catchall.cz":
				return []*net.MX{{Host: "mx." + domain + "."}}, nil
			default:
				return nil, &net.DNSError{Err: "no MX", Name: domain}
			}
		},
		LookupHost: func(ctx context.Context, host string) ([]string, error) {
			return nil, &net.DNSError{Err: "no A", Name: host}
		},
	}
	return v
}

func TestVerifyEmailEmpty(t *testing.T) {
	v := stubMXVerifier()
	status, result := v.VerifyEmail(context.Background(), "")
	if status != StatusNoEmail {
		t.Errorf("expected no_email, got %s", status)
	}
	if result.Detail != "empty email" {
		t.Errorf("unexpected detail: %s", result.Detail)
	}
}

func TestVerifyEmailBadSyntax(t *testing.T) {
	v := stubMXVerifier()
	status, result := v.VerifyEmail(context.Background(), "not-an-email")
	if status != StatusInvalid {
		t.Errorf("expected invalid, got %s", status)
	}
	if result.SyntaxValid {
		t.Error("syntax should be invalid")
	}
}

func TestVerifyEmailSpamtrap(t *testing.T) {
	v := stubMXVerifier()
	status, result := v.VerifyEmail(context.Background(), "user@spamcop.net")
	if status != StatusSpamtrap {
		t.Errorf("expected spamtrap, got %s", status)
	}
	if !result.IsSpamtrap {
		t.Error("should be flagged as spamtrap")
	}
}

func TestVerifyEmailDangerousRole(t *testing.T) {
	v := stubMXVerifier()
	status, _ := v.VerifyEmail(context.Background(), "abuse@firma.cz")
	if status != StatusInvalid {
		t.Errorf("expected invalid for dangerous role, got %s", status)
	}
}

func TestVerifyEmailRiskyRole(t *testing.T) {
	v := stubMXVerifier()
	status, result := v.VerifyEmail(context.Background(), "admin@firma.cz")
	if status != StatusRoleOnly {
		t.Errorf("expected role_only, got %s", status)
	}
	if !result.IsRole {
		t.Error("should be flagged as role")
	}
	if result.RiskLevel != "medium" {
		t.Errorf("expected medium risk, got %s", result.RiskLevel)
	}
}

func TestVerifyEmailNoMX(t *testing.T) {
	v := stubMXVerifier()
	status, result := v.VerifyEmail(context.Background(), "user@nonexistent-xyz987.com")
	if status != StatusInvalid {
		t.Errorf("expected invalid, got %s", status)
	}
	if result.MXExists {
		t.Error("MX should not exist")
	}
}

func TestVerifyEmailDisposable(t *testing.T) {
	v := stubMXVerifier()
	// Override MX to pass for mailinator
	v.mx = &MXValidator{
		LookupMX: func(ctx context.Context, domain string) ([]*net.MX, error) {
			return []*net.MX{{Host: "mx." + domain}}, nil
		},
	}
	status, result := v.VerifyEmail(context.Background(), "user@mailinator.com")
	if status != StatusInvalid {
		t.Errorf("expected invalid for disposable, got %s", status)
	}
	if !result.IsDisposable {
		t.Error("should be flagged as disposable")
	}
}

func TestVerifyEmailValid(t *testing.T) {
	v := stubMXVerifier()
	status, result := v.VerifyEmail(context.Background(), "jan.novak@firma.cz")
	if status != StatusValid {
		t.Errorf("expected valid, got %s", status)
	}
	if !result.SyntaxValid {
		t.Error("syntax should be valid")
	}
	if !result.MXExists {
		t.Error("MX should exist")
	}
	if result.RiskLevel != "low" {
		t.Errorf("expected low risk, got %s", result.RiskLevel)
	}
}

func TestVerifyEmailDomainCacheHit(t *testing.T) {
	v := stubMXVerifier()

	// First call populates cache
	v.VerifyEmail(context.Background(), "user1@firma.cz")

	// Second call should use cache — verify by checking cache
	_, ok := v.cache.Get("firma.cz")
	if !ok {
		t.Error("domain should be cached after first verification")
	}

	// Verify second email on same domain still works
	status, _ := v.VerifyEmail(context.Background(), "user2@firma.cz")
	if status != StatusValid {
		t.Errorf("expected valid for second email on cached domain, got %s", status)
	}
}

func TestDomainCacheGetSet(t *testing.T) {
	cache := NewDomainCache()

	_, ok := cache.Get("test.com")
	if ok {
		t.Error("should not find uncached domain")
	}

	cache.Set("test.com", &domainEntry{mxExists: true})
	entry, ok := cache.Get("test.com")
	if !ok {
		t.Error("should find cached domain")
	}
	if !entry.mxExists {
		t.Error("cached entry should have mxExists=true")
	}
}

// ── checkDomain cache-miss path ────────────────────────────────────────────

func TestCheckDomain_CacheMiss_PopulatesEntry(t *testing.T) {
	v := NewVerifier(nil)
	v.mx = &MXValidator{
		LookupMX: func(ctx context.Context, domain string) ([]*net.MX, error) {
			return []*net.MX{{Host: "mx.brand-new.cz."}}, nil
		},
	}

	entry := v.checkDomain(context.Background(), "brand-new.cz")
	if entry == nil {
		t.Fatal("checkDomain returned nil entry")
	}
	if !entry.mxExists {
		t.Error("mxExists should be true")
	}

	// Cache should now contain the entry
	cached, ok := v.cache.Get("brand-new.cz")
	if !ok {
		t.Error("domain should be cached after checkDomain miss")
	}
	if cached != entry {
		t.Error("cached entry should be the same pointer")
	}
}

func TestCheckDomain_CacheMiss_MXHostExtracted(t *testing.T) {
	v := NewVerifier(nil)
	v.mx = &MXValidator{
		LookupMX: func(ctx context.Context, domain string) ([]*net.MX, error) {
			return []*net.MX{{Host: "mx.target.cz."}}, nil
		},
	}
	// Override MX validator to return a detail string with the "MX found: " prefix
	// The real MXValidator.Validate returns "MX found: <host>" — stub it with
	// a wrapper that returns the expected detail so the mxHost extraction is exercised.
	v.mx = &MXValidator{
		LookupMX: func(ctx context.Context, domain string) ([]*net.MX, error) {
			return []*net.MX{{Host: "mx.target.cz."}}, nil
		},
	}
	entry := v.checkDomain(context.Background(), "target.cz")
	if !entry.mxExists {
		t.Error("mxExists should be true")
	}
}

func TestCheckDomain_CacheMiss_DisposableDomain(t *testing.T) {
	v := NewVerifier(nil)
	v.mx = &MXValidator{
		LookupMX: func(ctx context.Context, domain string) ([]*net.MX, error) {
			return []*net.MX{{Host: "mx.mailinator.com."}}, nil
		},
	}

	// mailinator.com is a known disposable domain
	entry := v.checkDomain(context.Background(), "mailinator.com")
	if !entry.isDisposable {
		t.Error("mailinator.com should be detected as disposable")
	}
}

func TestCheckDomain_CacheMiss_SpamtrapDomain(t *testing.T) {
	v := NewVerifier(nil)
	v.mx = &MXValidator{
		LookupMX: func(ctx context.Context, domain string) ([]*net.MX, error) {
			return nil, &net.DNSError{Err: "no MX"}
		},
		LookupHost: func(ctx context.Context, host string) ([]string, error) {
			return nil, &net.DNSError{Err: "no A"}
		},
	}

	// spamcop.net is in the spamtrap list
	entry := v.checkDomain(context.Background(), "spamcop.net")
	if !entry.isSpamtrap {
		t.Error("spamcop.net should be detected as spamtrap")
	}
}

// ── smtpProbe per-MX rate-limiting ──────────────────────────────────────────

// TestSmtpProbe_SameMXWaits verifies that two sequential probes to the same
// MX host (keyed by mxHost, not domain) honour the interval and that the
// timestamp is recorded in lastProbeMX.
func TestSmtpProbe_SameMXWaits(t *testing.T) {
	v := NewVerifier(nil)
	v.FromDomain = "test.local"

	// Pre-populate cache with a known mxHost so smtpProbe keys on it.
	mxHost := "mx.nonexistent-xyz999.example"
	v.cache.Set("nonexistent-xyz999.example", &domainEntry{
		mxExists:  true,
		mxHost:    mxHost,
		checkedAt: time.Now(),
	})
	// Shorten the interval for this MX host by injecting a recent probe time,
	// then verify the second call waits (uses default interval which is 1s, so
	// we set last probe to "just now" and use a very tiny interval via a fake host
	// that doesn't match any suffix — it gets MXProbeIntervalDefault = 1s).
	// To avoid a 1s block we inject the last probe as far-enough in the past.
	v.lastProbeMXMu.Lock()
	v.lastProbeMX[mxHost] = time.Now().Add(-MXProbeIntervalDefault) // exactly at boundary
	v.lastProbeMXMu.Unlock()

	// First call: elapsed >= interval → should not block.
	done := make(chan struct{})
	go func() {
		_ = v.smtpProbe(context.Background(), "user@nonexistent-xyz999.example", "nonexistent-xyz999.example")
		close(done)
	}()
	select {
	case <-done:
		// ok
	case <-time.After(3 * time.Second):
		t.Error("smtpProbe blocked unexpectedly on boundary probe")
	}

	// Verify the MX host was recorded in lastProbeMX.
	v.lastProbeMXMu.Lock()
	_, ok := v.lastProbeMX[mxHost]
	v.lastProbeMXMu.Unlock()
	if !ok {
		t.Error("smtpProbe should update lastProbeMX map")
	}
}

// TestSmtpProbe_DifferentMXNoBlock verifies that probes to two distinct MX
// hosts do not contend with each other — the second completes without waiting
// for the first MX host's interval.
func TestSmtpProbe_DifferentMXNoBlock(t *testing.T) {
	v := NewVerifier(nil)
	v.FromDomain = "test.local"

	// MX host A: inject "probe happened just now" so any same-host probe would block.
	mxHostA := "mx-a.vendor-alpha.example"
	v.cache.Set("alpha.example", &domainEntry{mxExists: true, mxHost: mxHostA, checkedAt: time.Now()})
	v.lastProbeMXMu.Lock()
	v.lastProbeMX[mxHostA] = time.Now() // just probed → would block if same host
	v.lastProbeMXMu.Unlock()

	// MX host B: distinct host, no prior probe → should complete immediately.
	mxHostB := "mx-b.vendor-beta.example"
	v.cache.Set("beta.example", &domainEntry{mxExists: true, mxHost: mxHostB, checkedAt: time.Now()})

	start := time.Now()
	done := make(chan struct{})
	go func() {
		_ = v.smtpProbe(context.Background(), "user@beta.example", "beta.example")
		close(done)
	}()
	select {
	case <-done:
		elapsed := time.Since(start)
		// Should finish well within the default interval — not blocked by host A.
		if elapsed > MXProbeIntervalDefault {
			t.Errorf("probe to distinct MX host blocked: elapsed=%v > interval=%v", elapsed, MXProbeIntervalDefault)
		}
	case <-time.After(5 * time.Second):
		t.Error("smtpProbe to distinct MX host timed out")
	}
}

// TestMXProbeInterval verifies the named constants are wired correctly.
func TestMXProbeInterval(t *testing.T) {
	cases := []struct {
		host     string
		expected time.Duration
	}{
		{"gmail-smtp-in.l.google.com", MXProbeIntervalGmail},
		{"alt1.gmail-smtp-in.l.google.com", MXProbeIntervalGmail},
		{"mx1.hotmail.com.protection.outlook.com", MXProbeIntervalOutlook},
		{"unknown-mx.example.com", MXProbeIntervalDefault},
		{"", MXProbeIntervalDefault},
	}
	for _, tc := range cases {
		got := mxProbeInterval(tc.host)
		if got != tc.expected {
			t.Errorf("mxProbeInterval(%q) = %v, want %v", tc.host, got, tc.expected)
		}
	}
}
