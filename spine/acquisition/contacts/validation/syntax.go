package validation

import (
	"context"
	"net/mail"
	"strings"
)

// SyntaxValidator checks email format per RFC 5322.
type SyntaxValidator struct{}

func (v *SyntaxValidator) Name() string { return "syntax" }

func (v *SyntaxValidator) Validate(ctx context.Context, email string) (bool, string, error) {
	email = strings.TrimSpace(email)

	if email == "" {
		return false, "empty email", nil
	}

	// Basic structure check
	at := strings.LastIndex(email, "@")
	if at < 1 || at >= len(email)-1 {
		return false, "missing or misplaced @", nil
	}

	// Control characters
	if strings.ContainsAny(email, "\r\n\t\x00") {
		return false, "contains control characters", nil
	}

	// Domain part
	domain := email[at+1:]
	if !strings.Contains(domain, ".") {
		return false, "domain has no TLD", nil
	}
	if strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") {
		return false, "domain starts/ends with dot", nil
	}

	// RFC 5322 parse
	_, err := mail.ParseAddress(email)
	if err != nil {
		return false, "RFC 5322 parse failed: " + err.Error(), nil
	}

	return true, "valid", nil
}
