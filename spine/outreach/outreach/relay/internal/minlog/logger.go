package minlog

import (
	"fmt"
	"log"
	"regexp"
	"strings"
	"time"
)

// Field is a key-value pair for structured logging.
type Field struct {
	Key   string
	Value string
}

// F creates a field. Values that look like IPs, emails, or content are rejected.
//
// Special case: when key == "error", we keep the value but apply a regex-mask
// to email-shaped substrings ("user@host.tld" → "u***@h***.tld") and IP-shaped
// substrings ("1.2.3.4" → "1.2.x.x"). Upstream MTA error messages frequently
// embed the recipient address ("550 5.7.1 <info@example.com>: …"); blanket-
// redacting them as the original isForbidden heuristic did made operator RCA
// effectively impossible. The mask preserves the SMTP code/text we need.
func F(key, value string) Field {
	if strings.EqualFold(key, "error") {
		return Field{Key: key, Value: maskPII(value)}
	}
	if isForbidden(key, value) {
		return Field{Key: key, Value: "[REDACTED]"}
	}
	return Field{Key: key, Value: value}
}

// BucketedTime creates a time field truncated to 15-minute boundaries.
func BucketedTime(key string, t time.Time) Field {
	bucketed := t.Truncate(15 * time.Minute)
	return Field{Key: key, Value: bucketed.UTC().Format(time.RFC3339)}
}

// Logger provides minimal logging that refuses to log content, IPs, or identities.
type Logger struct {
	prefix string
}

// New creates a logger with the given prefix.
func New(prefix string) *Logger {
	return &Logger{prefix: prefix}
}

// Info logs an informational message.
func (l *Logger) Info(msg string, fields ...Field) {
	l.emit("INFO", msg, fields)
}

// Error logs an error message.
func (l *Logger) Error(msg string, fields ...Field) {
	l.emit("ERROR", msg, fields)
}

func (l *Logger) emit(level, msg string, fields []Field) {
	parts := make([]string, 0, len(fields)+2)
	parts = append(parts, fmt.Sprintf("[%s] %s: %s", level, l.prefix, msg))
	for _, f := range fields {
		parts = append(parts, fmt.Sprintf("%s=%s", f.Key, f.Value))
	}
	log.Println(strings.Join(parts, " "))
}

// isForbidden checks if a key or value looks like it contains sensitive data.
func isForbidden(key, value string) bool {
	lk := strings.ToLower(key)
	forbiddenKeys := []string{
		"ip", "addr", "address", "remote", "x-forwarded",
		"email", "identity", "real_identity", "content", "body",
		"subject", "password", "secret", "token", "key",
	}
	for _, fk := range forbiddenKeys {
		if strings.Contains(lk, fk) {
			return true
		}
	}
	if strings.Contains(value, "@") && strings.Contains(value, ".") {
		return true
	}
	if looksLikeIP(value) {
		return true
	}
	return false
}

func looksLikeIP(s string) bool {
	parts := strings.Split(s, ".")
	if len(parts) == 4 {
		allDigits := true
		for _, p := range parts {
			if len(p) == 0 || len(p) > 3 {
				allDigits = false
				break
			}
			for _, c := range p {
				if c < '0' || c > '9' {
					allDigits = false
					break
				}
			}
		}
		if allDigits {
			return true
		}
	}
	if strings.Contains(s, "::") || strings.Count(s, ":") >= 2 {
		return true
	}
	return false
}

// maskPII redacts email and IP shapes within a free-form string while
// keeping surrounding text. Used by F(key="error", ...) so SMTP error
// messages remain triagable without leaking recipient identity or source IP.
func maskPII(s string) string {
	// Email: "user@host.tld" → "u***@h***.tld"
	emailRE := regexp.MustCompile(`([A-Za-z0-9._%+\-])([A-Za-z0-9._%+\-]*)@([A-Za-z0-9])([A-Za-z0-9.\-]*)\.([A-Za-z]{2,})`)
	s = emailRE.ReplaceAllString(s, "$1***@$3***.$5")
	// IPv4: "1.2.3.4" → "1.2.x.x"
	ipv4RE := regexp.MustCompile(`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`)
	s = ipv4RE.ReplaceAllString(s, "$1.$2.x.x")
	return s
}
