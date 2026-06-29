package validation

import (
	"context"
	"database/sql"
	"errors"
	"net"
	"os"
	"testing"
	"time"
)

// ── Syntax ──

func TestSyntaxValid(t *testing.T) {
	v := &SyntaxValidator{}
	ctx := context.Background()
	valid := []string{"user@example.com", "a@b.co", "test+tag@domain.org", "jan.novak@firma.cz", "x@y.museum", "a.b.c@d.e.com"}
	for _, email := range valid {
		ok, _, _ := v.Validate(ctx, email)
		if !ok { t.Errorf("expected valid: %s", email) }
	}
}

func TestSyntaxInvalid(t *testing.T) {
	v := &SyntaxValidator{}
	ctx := context.Background()
	invalid := []string{
		"", "nodomain", "@nodomain.com", "user@", "user@noext",
		"user\n@example.com", "user @example.com", " @x.com",
		// domain starts/ends with dot
		"user@.example.com", "user@example.",
		// control chars
		"user\x00@example.com", "user\r@example.com", "user\t@example.com",
	}
	for _, email := range invalid {
		ok, _, _ := v.Validate(ctx, email)
		if ok { t.Errorf("expected invalid: %q", email) }
	}
}

func TestSyntaxName(t *testing.T) {
	v := &SyntaxValidator{}
	if v.Name() != "syntax" { t.Errorf("expected 'syntax', got %q", v.Name()) }
}

// ── MX ──

func TestMXValidStubbedLookup(t *testing.T) {
	v := &MXValidator{
		LookupMX: func(ctx context.Context, domain string) ([]*net.MX, error) {
			if domain != "example.com" {
				t.Fatalf("unexpected domain: %s", domain)
			}
			return []*net.MX{{Host: "mx.example.com."}}, nil
		},
		LookupHost: func(ctx context.Context, host string) ([]string, error) {
			t.Fatalf("LookupHost should not be called for domain with MX")
			return nil, nil
		},
	}
	ok, detail, err := v.Validate(context.Background(), "test@example.com")
	if err != nil { t.Fatalf("error: %v", err) }
	if !ok { t.Fatalf("example.com should have MX: %s", detail) }
}

func TestMXFallsBackToHostLookup(t *testing.T) {
	v := &MXValidator{
		LookupMX: func(ctx context.Context, domain string) ([]*net.MX, error) {
			return nil, errors.New("no mx")
		},
		LookupHost: func(ctx context.Context, host string) ([]string, error) {
			if host != "example.com" {
				t.Fatalf("unexpected host: %s", host)
			}
			return []string{"203.0.113.10"}, nil
		},
	}
	ok, detail, err := v.Validate(context.Background(), "test@example.com")
	if err != nil { t.Fatalf("error: %v", err) }
	if !ok { t.Fatalf("example.com should pass via A record: %s", detail) }
}

func TestMXValidRealDomainIntegration(t *testing.T) {
	if os.Getenv("VALIDATION_LIVE_DNS") != "1" {
		t.Skip("set VALIDATION_LIVE_DNS=1 to run live DNS MX check")
	}
	v := &MXValidator{}
	ok, detail, err := v.Validate(context.Background(), "test@gmail.com")
	if err != nil { t.Fatalf("error: %v", err) }
	if !ok { t.Fatalf("gmail should have MX: %s", detail) }
}

func TestMXInvalidDomain(t *testing.T) {
	v := &MXValidator{}
	ok, _, _ := v.Validate(context.Background(), "test@thisdomain-does-not-exist-xyz123.com")
	if ok { t.Error("non-existent domain should fail MX") }
}

func TestMXName(t *testing.T) {
	v := &MXValidator{}
	if v.Name() != "mx" { t.Errorf("expected 'mx', got %q", v.Name()) }
}

func TestMXNoDomain(t *testing.T) {
	v := &MXValidator{}
	ok, _, _ := v.Validate(context.Background(), "nodomain")
	if ok { t.Error("no domain should fail") }
}

func TestDomainFromEmail(t *testing.T) {
	tests := []struct{ in, expected string }{
		{"user@example.com", "example.com"},
		{"a@b.cz", "b.cz"},
		{"nodomain", ""},
		{"", ""},
	}
	for _, tt := range tests {
		if r := domainFromEmail(tt.in); r != tt.expected {
			t.Errorf("domainFromEmail(%q) = %q, want %q", tt.in, r, tt.expected)
		}
	}
}

// ── Disposable ──

func TestDisposableDetection(t *testing.T) {
	v := &DisposableValidator{}
	ctx := context.Background()

	disposable := []string{"user@mailinator.com", "user@guerrillamail.com", "user@tempmail.com", "user@throwaway.email"}
	for _, email := range disposable {
		ok, _, _ := v.Validate(ctx, email)
		if ok { t.Errorf("should detect disposable: %s", email) }
	}

	ok, _, _ := v.Validate(ctx, "user@gmail.com")
	if !ok { t.Error("gmail should not be disposable") }
}

func TestDisposableName(t *testing.T) {
	v := &DisposableValidator{}
	if v.Name() != "disposable" { t.Errorf("expected 'disposable', got %q", v.Name()) }
}

// ── Duplicate ──

func TestDuplicateDetection(t *testing.T) {
	v := &DuplicateValidator{seen: make(map[string]bool)}
	ctx := context.Background()

	ok1, _, _ := v.Validate(ctx, "user@example.com")
	if !ok1 { t.Error("first should pass") }

	ok2, _, _ := v.Validate(ctx, "user@example.com")
	if ok2 { t.Error("duplicate should fail") }

	ok3, _, _ := v.Validate(ctx, "USER@EXAMPLE.COM")
	if ok3 { t.Error("case-insensitive duplicate should fail") }
}

func TestDuplicateName(t *testing.T) {
	v := &DuplicateValidator{seen: make(map[string]bool)}
	if v.Name() != "duplicate" { t.Errorf("expected 'duplicate', got %q", v.Name()) }
}

// ── SMTP Probe (unit tests only — no network) ──

func TestSMTPProbeName(t *testing.T) {
	v := &SMTPProbeValidator{}
	if v.Name() != "smtp_probe" { t.Errorf("expected 'smtp_probe', got %q", v.Name()) }
}

func TestSMTPProbeNoDomain(t *testing.T) {
	v := &SMTPProbeValidator{FromDomain: "test.local"}
	ok, detail, _ := v.Validate(context.Background(), "nodomain")
	if ok { t.Error("should fail for no domain") }
	if detail != "no domain" { t.Errorf("expected 'no domain', got %q", detail) }
}

func TestSMTPProbeInvalidDomain(t *testing.T) {
	v := &SMTPProbeValidator{FromDomain: "test.local"}
	ok, _, _ := v.Validate(context.Background(), "user@nonexistent-domain-xyz123.com")
	if ok { t.Error("should fail for non-existent domain") }
}

func TestCatchAllName(t *testing.T) {
	v := &CatchAllValidator{}
	if v.Name() != "catchall" { t.Errorf("expected 'catchall', got %q", v.Name()) }
}

func TestCatchAllNoDomain(t *testing.T) {
	v := &CatchAllValidator{FromDomain: "test.local"}
	ok, _, _ := v.Validate(context.Background(), "nodomain")
	if !ok { t.Error("no domain should pass (assume not catch-all)") }
}

// ── Pipeline ──

func TestPipelineBasic(t *testing.T) {
	p := &Pipeline{
		validators: []Validator{
			&SyntaxValidator{},
			&DuplicateValidator{seen: make(map[string]bool)},
			&DisposableValidator{},
			&MXValidator{
				LookupMX: func(ctx context.Context, domain string) ([]*net.MX, error) {
					if domain != "gmail.com" {
						t.Fatalf("unexpected domain: %s", domain)
					}
					return []*net.MX{{Host: "gmail-smtp-in.l.google.com."}}, nil
				},
			},
		},
	}
	result := p.Run(context.Background(), "user@gmail.com")
	if !result.SyntaxValid { t.Error("gmail should have valid syntax") }
	if !result.MXExists { t.Error("gmail should have MX") }
	if result.IsDisposable { t.Error("gmail should not be disposable") }
	if result.RiskLevel != "low" { t.Errorf("gmail should be low risk, got %s", result.RiskLevel) }
}

func TestPipelineInvalid(t *testing.T) {
	p := NewPipeline()
	result := p.Run(context.Background(), "not-an-email")
	if result.SyntaxValid { t.Error("invalid email should fail syntax") }
	if result.RiskLevel != "high" { t.Errorf("expected high risk, got %s", result.RiskLevel) }
}

func TestPipelineDisposable(t *testing.T) {
	p := NewPipeline()
	result := p.Run(context.Background(), "user@mailinator.com")
	if result.SyntaxValid && !result.IsDisposable {
		t.Error("mailinator should be detected as disposable")
	}
}

func TestPipelineNoMX(t *testing.T) {
	p := NewPipeline()
	result := p.Run(context.Background(), "user@nonexistent-domain-xyz987.com")
	if result.MXExists { t.Error("non-existent domain should fail MX") }
}

// ── DisposableValidator — no domain edge case ──

func TestDisposableValidator_NoDomain(t *testing.T) {
	v := &DisposableValidator{}
	ok, reason, err := v.Validate(context.Background(), "notanemail")
	if err != nil { t.Fatal(err) }
	if ok { t.Error("should reject: no domain") }
	if reason != "no domain" { t.Errorf("reason = %q", reason) }
}

// ── Pipeline error path ──

// errValidator always returns an error from Validate; used to exercise the
// pipeline's "continue on error" branch.
type errValidator struct{}

func (e *errValidator) Name() string { return "syntax" }
func (e *errValidator) Validate(_ context.Context, _ string) (bool, string, error) {
	return false, "", errors.New("forced error")
}

func TestPipeline_ValidatorError(t *testing.T) {
	p := &Pipeline{validators: []Validator{&errValidator{}}}
	result := p.Run(context.Background(), "user@example.com")
	// error is swallowed; result stays at defaults
	if result.RiskLevel != "low" {
		t.Errorf("validator error should be skipped, risk = %s", result.RiskLevel)
	}
	if result.SyntaxValid {
		t.Error("SyntaxValid should remain false when validator errors")
	}
}

func TestPipeline_DuplicateRejection(t *testing.T) {
	dup := &DuplicateValidator{seen: make(map[string]bool)}
	p := &Pipeline{validators: []Validator{
		&SyntaxValidator{},
		&MXValidator{
			LookupMX: func(_ context.Context, _ string) ([]*net.MX, error) {
				return []*net.MX{{Host: "mx.example.com."}}, nil
			},
		},
		dup,
	}}

	ctx := context.Background()
	// First run passes
	r1 := p.Run(ctx, "user@example.com")
	if r1.RiskLevel != "low" { t.Errorf("first run should be low risk, got %s", r1.RiskLevel) }

	// Second run — duplicate → high risk
	r2 := p.Run(ctx, "user@example.com")
	if r2.RiskLevel != "high" { t.Errorf("duplicate should be high risk, got %s", r2.RiskLevel) }
}

// ── verifier helpers ──

func TestNullString(t *testing.T) {
	ns := nullString("hello")
	if !ns.Valid || ns.String != "hello" { t.Errorf("non-empty: %+v", ns) }

	ns2 := nullString("")
	if ns2.Valid { t.Errorf("empty should be invalid: %+v", ns2) }
}

func TestNullBool(t *testing.T) {
	tr := true
	nb := nullBool(&tr)
	if !nb.Valid || !nb.Bool { t.Errorf("true ptr: %+v", nb) }

	nb2 := nullBool(nil)
	if nb2.Valid { t.Errorf("nil ptr should be invalid: %+v", nb2) }
}

var _ = sql.NullString{} // ensure import used

// ── RoleValidator branches ──

func TestRoleValidator_NoLocalPart(t *testing.T) {
	v := &RoleValidator{}
	ok, detail, err := v.Validate(context.Background(), "notanemail")
	if ok || err != nil { t.Errorf("no local part: ok=%v detail=%q err=%v", ok, detail, err) }
	if detail != "no local part" { t.Errorf("detail: %q", detail) }
}

func TestRoleValidator_DangerousRole(t *testing.T) {
	v := &RoleValidator{}
	ok, detail, err := v.Validate(context.Background(), "abuse@firma.cz")
	if ok || err != nil { t.Errorf("dangerous role: ok=%v err=%v", ok, err) }
	if detail == "" { t.Error("detail should not be empty") }
}

func TestRoleValidator_RiskyRole(t *testing.T) {
	v := &RoleValidator{}
	ok, detail, err := v.Validate(context.Background(), "admin@firma.cz")
	if ok || err != nil { t.Errorf("risky role: ok=%v err=%v", ok, err) }
	if detail == "" { t.Error("detail should not be empty") }
}

func TestRoleValidator_NotRole(t *testing.T) {
	v := &RoleValidator{}
	ok, detail, err := v.Validate(context.Background(), "jan.novak@firma.cz")
	if !ok || err != nil { t.Errorf("normal email: ok=%v detail=%q err=%v", ok, detail, err) }
	if detail != "not role-based" { t.Errorf("detail: %q", detail) }
}

// ── VerifyEmail — early exit branches (no network needed) ──

func newDryRunVerifier() *Verifier {
	return &Verifier{
		DryRun:    true,
		cache:     NewDomainCache(),
		syntax:    &SyntaxValidator{},
		disposable: &DisposableValidator{},
		spamtrap:  &SpamtrapValidator{},
		role:      &RoleValidator{},
		mx:        &MXValidator{},
		lastProbeMX: make(map[string]time.Time),
	}
}

func TestVerifyEmail_EmptyEmail(t *testing.T) {
	v := newDryRunVerifier()
	status, result := v.VerifyEmail(context.Background(), "")
	if status != StatusNoEmail { t.Errorf("empty email: want StatusNoEmail, got %v", status) }
	if result.Detail != "empty email" { t.Errorf("detail: %q", result.Detail) }
}

func TestVerifyEmail_InvalidSyntax(t *testing.T) {
	v := newDryRunVerifier()
	status, result := v.VerifyEmail(context.Background(), "notanemail")
	if status != StatusInvalid { t.Errorf("invalid syntax: want StatusInvalid, got %v", status) }
	if result.SyntaxValid { t.Error("SyntaxValid should be false for invalid email") }
	if result.RiskLevel != "high" { t.Errorf("risk level: %q", result.RiskLevel) }
}

func TestVerifyEmail_SpamtrapDomain(t *testing.T) {
	v := newDryRunVerifier()
	// spamcop.net is in the spamtrap domains list
	status, result := v.VerifyEmail(context.Background(), "jan@spamcop.net")
	if status != StatusSpamtrap { t.Errorf("spamtrap: want StatusSpamtrap, got %v", status) }
	if !result.IsSpamtrap { t.Error("IsSpamtrap should be true") }
}

func TestVerifyEmail_DangerousRoleAddress(t *testing.T) {
	v := newDryRunVerifier()
	// "abuse" is a dangerous role → StatusInvalid
	// Use a domain not in spamtrap list; pre-populate cache with valid MX entry
	validEntry := &domainEntry{mxExists: true}
	v.cache.Set("legit-strojirna.cz", validEntry)
	status, result := v.VerifyEmail(context.Background(), "abuse@legit-strojirna.cz")
	if status != StatusInvalid {
		t.Errorf("dangerous role: want StatusInvalid, got %v (detail: %s)", status, result.Detail)
	}
}

func TestVerifyEmail_RiskyRoleAddress(t *testing.T) {
	v := newDryRunVerifier()
	// "admin" is a risky role → continues processing → StatusRoleOnly
	validEntry := &domainEntry{mxExists: true}
	v.cache.Set("company-test.cz", validEntry)
	status, result := v.VerifyEmail(context.Background(), "admin@company-test.cz")
	if status != StatusRoleOnly {
		t.Errorf("risky role: want StatusRoleOnly, got %v (detail: %s)", status, result.Detail)
	}
}

func TestVerifyEmail_DisposableDomain(t *testing.T) {
	v := newDryRunVerifier()
	// Inject disposable domain entry into cache (bypasses network)
	v.cache.Set("disposable-firma.cz", &domainEntry{isDisposable: true, mxExists: true})
	status, result := v.VerifyEmail(context.Background(), "jan@disposable-firma.cz")
	if status != StatusInvalid {
		t.Errorf("disposable: want StatusInvalid, got %v (detail: %s)", status, result.Detail)
	}
	if !result.IsDisposable { t.Error("IsDisposable should be true") }
}

func TestVerifyEmail_SpamtrapDomainCached(t *testing.T) {
	v := newDryRunVerifier()
	v.cache.Set("spamtrap-cached.cz", &domainEntry{isSpamtrap: true, mxExists: true})
	status, result := v.VerifyEmail(context.Background(), "jan@spamtrap-cached.cz")
	if status != StatusSpamtrap {
		t.Errorf("spamtrap cached: want StatusSpamtrap, got %v (detail: %s)", status, result.Detail)
	}
}

func TestVerifyEmail_NoMX(t *testing.T) {
	v := newDryRunVerifier()
	v.cache.Set("nomx-firma.cz", &domainEntry{mxExists: false})
	status, result := v.VerifyEmail(context.Background(), "jan@nomx-firma.cz")
	if status != StatusInvalid {
		t.Errorf("no MX: want StatusInvalid, got %v (detail: %s)", status, result.Detail)
	}
	if result.RiskLevel != "high" { t.Errorf("risk: %s", result.RiskLevel) }
}

func TestVerifyEmail_CatchAll_NotRole(t *testing.T) {
	v := newDryRunVerifier()
	trueVal := true
	v.cache.Set("catchall-firma.cz", &domainEntry{mxExists: true, isCatchAll: &trueVal})
	status, result := v.VerifyEmail(context.Background(), "jan.novak@catchall-firma.cz")
	if status != StatusCatchAll {
		t.Errorf("catch-all: want StatusCatchAll, got %v (detail: %s)", status, result.Detail)
	}
	if result.RiskLevel != "medium" { t.Errorf("risk: %s", result.RiskLevel) }
}

func TestVerifyEmail_CatchAll_RoleAddress(t *testing.T) {
	v := newDryRunVerifier()
	trueVal := true
	v.cache.Set("catchall-firma.cz", &domainEntry{mxExists: true, isCatchAll: &trueVal})
	// admin is a risky role → IsRole=true → catch-all + role → StatusRoleOnly
	status, result := v.VerifyEmail(context.Background(), "admin@catchall-firma.cz")
	if status != StatusRoleOnly {
		t.Errorf("catch-all role: want StatusRoleOnly, got %v (detail: %s)", status, result.Detail)
	}
}
