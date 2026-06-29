package validation

import (
	"context"
	"strings"
)

// DisposableValidator checks against known disposable email domains.
type DisposableValidator struct{}

func (v *DisposableValidator) Name() string { return "disposable" }

func (v *DisposableValidator) Validate(ctx context.Context, email string) (bool, string, error) {
	domain := domainFromEmail(email)
	if domain == "" {
		return false, "no domain", nil
	}

	for _, d := range disposableDomains {
		if strings.EqualFold(domain, d) {
			return false, "disposable domain: " + domain, nil
		}
	}

	return true, "not disposable", nil
}

// Common disposable email domains
var disposableDomains = []string{
	"mailinator.com", "guerrillamail.com", "tempmail.com", "throwaway.email",
	"yopmail.com", "10minutemail.com", "trashmail.com", "fakeinbox.com",
	"sharklasers.com", "guerrillamailblock.com", "grr.la", "dispostable.com",
	"mailnesia.com", "maildrop.cc", "discard.email", "temp-mail.org",
	"getnada.com", "emailondeck.com", "33mail.com", "mytemp.email",
	"mohmal.com", "burnermail.io", "tempail.com", "tempr.email",
}

// DuplicateValidator tracks seen emails and rejects duplicates.
type DuplicateValidator struct {
	seen map[string]bool
}

func (v *DuplicateValidator) Name() string { return "duplicate" }

func (v *DuplicateValidator) Validate(ctx context.Context, email string) (bool, string, error) {
	lower := strings.ToLower(strings.TrimSpace(email))
	if v.seen[lower] {
		return false, "duplicate", nil
	}
	v.seen[lower] = true
	return true, "unique", nil
}
