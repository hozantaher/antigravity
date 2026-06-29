// Package audit provides utilities for privacy-safe logging.
package audit

import (
	"crypto/sha256"
	"fmt"
	"strings"
)

// MaskEmail returns a pseudonymised representation of an email address
// suitable for structured log output. The local part is masked, the domain
// is preserved for debugging (MX troubleshooting). The result is not
// reversible but is consistent per address — the same email always produces
// the same mask, enabling log correlation without exposing PII.
//
// Examples:
//
//	jan.novak@example.com  →  j*****k[sha:a3f2]@example.com
//	x@y.cz                 →  x[sha:b7c1]@y.cz
func MaskEmail(email string) string {
	at := strings.LastIndex(email, "@")
	if at < 0 {
		// Not a valid email — return a fixed placeholder
		return "[invalid-email]"
	}

	local := email[:at]
	domain := email[at:] // includes the @

	// 4-char hex fingerprint — enough for log correlation, not enough to reverse
	sum := sha256.Sum256([]byte(email))
	fp := fmt.Sprintf("%x", sum[:2]) // 2 bytes = 4 hex chars

	var masked string
	switch len(local) {
	case 0:
		masked = fmt.Sprintf("[sha:%s]", fp)
	case 1:
		masked = fmt.Sprintf("%s[sha:%s]", local, fp)
	case 2:
		masked = fmt.Sprintf("%s*[sha:%s]", string(local[0]), fp)
	default:
		stars := strings.Repeat("*", len(local)-2)
		masked = fmt.Sprintf("%s%s%s[sha:%s]", string(local[0]), stars, string(local[len(local)-1]), fp)
	}

	return masked + domain
}
