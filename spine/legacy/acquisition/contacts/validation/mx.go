package validation

import (
	"context"
	"net"
	"strings"
	"time"
)

// MXValidator checks if the email domain has valid MX records.
type MXValidator struct {
	Timeout time.Duration
	LookupMX   func(ctx context.Context, domain string) ([]*net.MX, error)
	LookupHost func(ctx context.Context, host string) ([]string, error)
}

func (v *MXValidator) Name() string { return "mx" }

func (v *MXValidator) Validate(ctx context.Context, email string) (bool, string, error) {
	domain := domainFromEmail(email)
	if domain == "" {
		return false, "no domain", nil
	}

	timeout := v.Timeout
	if timeout == 0 {
		timeout = 5 * time.Second
	}

	lookupCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	lookupMX := v.LookupMX
	if lookupMX == nil {
		resolver := &net.Resolver{}
		lookupMX = resolver.LookupMX
	}
	lookupHost := v.LookupHost
	if lookupHost == nil {
		resolver := &net.Resolver{}
		lookupHost = resolver.LookupHost
	}

	// Try MX records first
	mx, err := lookupMX(lookupCtx, domain)
	if err == nil && len(mx) > 0 {
		return true, "MX found: " + mx[0].Host, nil
	}

	// Fallback: check A record (some domains accept mail without MX)
	addrs, err := lookupHost(lookupCtx, domain)
	if err == nil && len(addrs) > 0 {
		return true, "no MX but A record exists", nil
	}

	return false, "no MX or A record", nil
}

func domainFromEmail(email string) string {
	parts := strings.SplitN(email, "@", 2)
	if len(parts) != 2 {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(parts[1]))
}
