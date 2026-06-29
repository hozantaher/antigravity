package validation

import (
	"context"
	"net"
	"testing"
	"time"
)

// testDomain is a guaranteed-nonexistent domain (.invalid TLD per RFC 2606).
// DNS lookups for it always fail, so SMTP probes return quickly without
// real network I/O beyond the failed DNS query.
const testSMTPDomain = "nonexistent-outreach-test.invalid"

// ─── testSMTPConnectivity ─────────────────────────────────────────────────────

func TestTestSMTPConnectivity_NoMX_ReturnsFalse(t *testing.T) {
	v := NewVerifier(nil)
	v.SMTPTimeout = 0 // use default inside probe
	v.FromDomain = "test.local"

	// .invalid TLD → DNS lookup fails → probe returns "no MX records"
	// → testSMTPConnectivity returns false
	result := v.testSMTPConnectivity(context.Background(), testSMTPDomain)
	if result {
		t.Error("expected false for domain with no MX")
	}
}

func TestTestSMTPConnectivity_InvalidDomain_NoPanic(t *testing.T) {
	v := NewVerifier(nil)
	v.SMTPTimeout = 0
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("testSMTPConnectivity panicked: %v", r)
		}
	}()
	_ = v.testSMTPConnectivity(context.Background(), "")
}

// ─── checkDomain with EnableSMTP=true ────────────────────────────────────────

// TestCheckDomain_EnableSMTP_NotConnectable exercises the EnableSMTP branch in
// checkDomain. The stubbed MX makes mxExists=true, but testSMTPConnectivity
// uses the real resolver for the domain → no MX in real DNS → not connectable.
func TestCheckDomain_EnableSMTP_NotConnectable(t *testing.T) {
	v := NewVerifier(nil)
	v.EnableSMTP = true
	v.SMTPTimeout = 0
	v.FromDomain = "test.local"

	// Stub v.mx so checkDomain sees mxExists=true for our test domain.
	v.mx = &MXValidator{
		LookupMX: func(ctx context.Context, domain string) ([]*net.MX, error) {
			// Return a fake MX so checkDomain proceeds to SMTP branch.
			return []*net.MX{{Host: "mx." + domain + "."}}, nil
		},
		LookupHost: func(ctx context.Context, host string) ([]string, error) {
			return nil, &net.DNSError{Err: "no A", Name: host}
		},
	}

	// Use .invalid domain — testSMTPConnectivity will fail its own real DNS
	// lookup and return false without actually connecting anywhere.
	entry := v.checkDomain(context.Background(), testSMTPDomain)

	if entry == nil {
		t.Fatal("checkDomain returned nil")
	}
	if !entry.mxExists {
		t.Error("mxExists should be true (stubbed MX)")
	}
	// smtpConnectable set (false) because we entered the SMTP branch
	if entry.smtpConnectable == nil {
		t.Error("smtpConnectable should be set (SMTP branch was entered)")
	}
	if *entry.smtpConnectable {
		t.Error("smtpConnectable should be false (no real MX for .invalid)")
	}
}

func TestCheckDomain_EnableSMTP_DisposableSkipsSMTP(t *testing.T) {
	v := NewVerifier(nil)
	v.EnableSMTP = true
	v.mx = &MXValidator{
		LookupMX: func(ctx context.Context, domain string) ([]*net.MX, error) {
			return []*net.MX{{Host: "mx.mailinator.com."}}, nil
		},
	}

	// mailinator.com is disposable → SMTP branch skipped
	entry := v.checkDomain(context.Background(), "mailinator.com")
	if !entry.isDisposable {
		t.Error("should be disposable")
	}
	if entry.smtpConnectable != nil {
		t.Error("smtpConnectable should be nil when disposable skips SMTP branch")
	}
}

func TestCheckDomain_EnableSMTP_SpamtrapSkipsSMTP(t *testing.T) {
	v := NewVerifier(nil)
	v.EnableSMTP = true
	v.mx = &MXValidator{
		LookupMX: func(ctx context.Context, domain string) ([]*net.MX, error) {
			return nil, &net.DNSError{Err: "no MX"}
		},
		LookupHost: func(ctx context.Context, host string) ([]string, error) {
			return nil, &net.DNSError{Err: "no A"}
		},
	}

	// spamcop.net is spamtrap → mxExists=false → SMTP branch skipped
	entry := v.checkDomain(context.Background(), "spamcop.net")
	if !entry.isSpamtrap {
		t.Error("should be spamtrap")
	}
	if entry.smtpConnectable != nil {
		t.Error("smtpConnectable should be nil when spamtrap skips SMTP branch")
	}
}

func TestCheckDomain_StaleCacheEntry_Rechecks(t *testing.T) {
	v := NewVerifier(nil)
	v.mx = &MXValidator{
		LookupMX: func(ctx context.Context, domain string) ([]*net.MX, error) {
			return []*net.MX{{Host: "mx.fresh.cz."}}, nil
		},
	}

	// Pre-populate cache with checkedAt >30 days ago (beyond domainCacheTTL)
	v.cache.Set("fresh.cz", &domainEntry{
		mxExists:  false, // stale value
		checkedAt: time.Now().Add(-31 * 24 * time.Hour), // 31 days old → stale
	})

	entry := v.checkDomain(context.Background(), "fresh.cz")
	// Should re-check and update mxExists to true
	if !entry.mxExists {
		t.Error("stale cache entry should have been refreshed")
	}
}
