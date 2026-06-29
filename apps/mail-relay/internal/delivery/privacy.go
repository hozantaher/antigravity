package delivery

import (
	"crypto/rand"
	"fmt"
	"strings"
)

// privacySensitiveHeaders is the set of headers that leak routing or client
// fingerprint information and must be removed before SMTP delivery.
// x-test-run-id is the internal test correlation header injected by
// cmd/anonymity-test; it must be stripped so real recipients never see it.
var privacySensitiveHeaders = map[string]bool{
	"received":         true,
	"x-originating-ip": true,
	"x-forwarded-for":  true,
	"x-mailer":         true,
	"user-agent":       true,
	"x-test-run-id":    true, // internal test correlation header — must not leak to recipients
}

// fallbackMessageIDDomain is the RFC 5322 §3.6.4 compliant placeholder used
// when no usable sender FQDN is available. The literal "relay" alone is not
// a valid domain (no dot) and triggers Czech webmail anti-spam (Seznam
// silently drops mail with a non-FQDN Message-ID right-hand side after the
// 250 OK on DATA). "mail.local" is a syntactically valid FQDN that does not
// resolve publicly — anonymity intent preserved.
const fallbackMessageIDDomain = "mail.local"

// extractMessageIDDomain returns the domain portion suitable for the
// right-hand side of an anonymized Message-ID. Inputs:
//
//   - bare addresses ("user@example.com")
//   - full RFC 5322 form ("Name <user@example.com>")
//   - empty string
//
// Behaviour:
//
//   - empty / no @ / no domain part → fallbackMessageIDDomain
//   - everything else → lowercase domain after the LAST '@', stripped of
//     angle-brackets and surrounding whitespace, with characters outside
//     [a-z0-9.-] removed defensively (never an opportunity for header
//     injection via a malformed envelope.From)
//
// The function never returns an empty string.
func extractMessageIDDomain(senderFromAddr string) string {
	s := strings.TrimSpace(senderFromAddr)
	if s == "" {
		return fallbackMessageIDDomain
	}
	// Strip a trailing '>' (RFC 5322 "Name <addr>" form) and anything before
	// the first '<'. We also tolerate a bare '<addr>' shape.
	if i := strings.LastIndex(s, "<"); i >= 0 {
		s = s[i+1:]
	}
	s = strings.TrimSuffix(s, ">")
	s = strings.TrimSpace(s)

	at := strings.LastIndex(s, "@")
	if at < 0 || at == len(s)-1 {
		return fallbackMessageIDDomain
	}
	domain := strings.ToLower(strings.TrimSpace(s[at+1:]))
	// Sanitize: stop at the first non-RFC-safe domain char so a malformed
	// envelope.From cannot smuggle header-injection bytes (CRLF + a forged
	// header) past the extractor by hiding behind valid trailing chars.
	var b strings.Builder
	b.Grow(len(domain))
	for _, r := range domain {
		switch {
		case r >= 'a' && r <= 'z',
			r >= '0' && r <= '9',
			r == '.', r == '-':
			b.WriteRune(r)
		default:
			// Hard stop on the first invalid byte — anything after is
			// suspicious (CRLF, space, header-injection payload).
			goto done
		}
	}
done:
	clean := strings.Trim(b.String(), ".-")
	if clean == "" || !strings.Contains(clean, ".") {
		// A single label ("relay") is not a valid FQDN per RFC 5322 §3.6.4
		// in the context of right-hand-side Message-ID identifiers expected
		// by hardened recipient MTAs. Fall back to a syntactically valid
		// FQDN that does not resolve publicly.
		return fallbackMessageIDDomain
	}
	return clean
}

// anonymizeMessageID preserves a caller-supplied Message-ID when it has
// the Engine-emitted HMAC dot-nanos shape (`<{hex}.{digits}@{fqdn}>`),
// otherwise it generates a fresh random identifier on the sender's FQDN.
//
// Why preserve Engine MIDs: services/campaigns/sender BuildMessageIDHeader
// (and its fallback generateMessageID) writes a HMAC-derived ID
// `<HMAC[recipient‖envelopeID][:8].{nanos}@{senderFQDN}>` into the wire
// envelope and into send_events.message_id. The orchestrator matches
// inbound DSN + reply In-Reply-To headers against that column. Silently
// replacing the Message-ID at relay-build time breaks reply correlation
// for every Engine-originated send. The HMAC local part is itself
// anonymous (it leaks nothing about the upstream client because the
// preimage is recipient‖envelopeID hashed under a server-side key), so
// preserving it costs no anonymity.
//
// Why replace everything else: external clients (or future legacy paths)
// may emit identifying Outlook / Mozilla / tracking-style Message-IDs,
// or single-label "domains" like `<x@relay>` that Seznam silently drops.
// Anything that does not match the Engine shape is conservatively
// replaced with a valid `<{32-hex}@{sender-fqdn}>`. The 32-hex local
// part is fresh entropy on every call — uniqueness is preserved for
// callers that submit blank Message-ID maps in a tight loop.
//
// All other headers are copied unchanged into the returned map. The
// input map is never modified.
func anonymizeMessageID(headers map[string]string, senderFromAddr string) map[string]string {
	result := make(map[string]string, len(headers)+1)
	var callerMID string
	for k, v := range headers {
		if strings.EqualFold(k, "message-id") {
			callerMID = v
			continue
		}
		result[k] = v
	}
	if isEngineMessageID(callerMID) {
		result["Message-ID"] = strings.TrimSpace(callerMID)
		return result
	}
	domain := extractMessageIDDomain(senderFromAddr)
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// Fallback: use a fixed sentinel so the caller still gets a valid header.
		result["Message-ID"] = fmt.Sprintf("<00000000000000000000000000000000@%s>", domain)
		return result
	}
	result["Message-ID"] = fmt.Sprintf("<%x@%s>", b, domain)
	return result
}

// isEngineMessageID reports whether s is a Message-ID emitted by
// services/campaigns/sender BuildMessageIDHeader (or its fallback
// generateMessageID). Required shape:
//
//   <{hex}.{digits}@{fqdn}>
//
// where:
//   - the local part is split on the FIRST '.' into a hex token and a
//     digit token (both non-empty);
//   - the hex token is 8–32 lowercase or uppercase hex chars (Engine
//     emits 16 from HMAC[:8]; legacy fallback emits 16 from 8 random
//     bytes; we accept up to 32 to tolerate future widening);
//   - the digit token is 1–20 decimal digits (UnixNano timestamp);
//   - the domain is an RFC 5322 §3.6.4 compliant FQDN — at least one
//     dot, no leading/trailing dot, DNS-safe chars only.
//
// External-client Message-IDs (Outlook, Mozilla, tracking IDs) do not
// match this shape and fall through to the random-replace path in
// anonymizeMessageID. Single-label "domains" like `<x@relay>` are
// rejected even when local-part shape matches.
func isEngineMessageID(s string) bool {
	s = strings.TrimSpace(s)
	if len(s) < 7 { // minimum viable: <a.0@b.c>
		return false
	}
	if s[0] != '<' || s[len(s)-1] != '>' {
		return false
	}
	inner := s[1 : len(s)-1]
	at := strings.LastIndex(inner, "@")
	if at <= 0 || at >= len(inner)-1 {
		return false
	}
	local := inner[:at]
	domain := inner[at+1:]
	// Local part: {hex}.{digits} (split on first dot)
	dot := strings.Index(local, ".")
	if dot <= 0 || dot >= len(local)-1 {
		return false
	}
	hexTok := local[:dot]
	digitTok := local[dot+1:]
	if len(hexTok) < 8 || len(hexTok) > 32 {
		return false
	}
	for _, r := range hexTok {
		switch {
		case r >= '0' && r <= '9':
		case r >= 'a' && r <= 'f':
		case r >= 'A' && r <= 'F':
		default:
			return false
		}
	}
	if len(digitTok) < 1 || len(digitTok) > 20 {
		return false
	}
	for _, r := range digitTok {
		if r < '0' || r > '9' {
			return false
		}
	}
	// Reject any control / whitespace / header-injection bytes anywhere.
	for _, r := range inner {
		if r < 33 || r == 127 {
			return false
		}
		switch r {
		case '<', '>', ',', ';', '"', '\\':
			return false
		}
	}
	// Domain must be a real FQDN.
	if !strings.Contains(domain, ".") {
		return false
	}
	if strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") {
		return false
	}
	for _, r := range strings.ToLower(domain) {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '.', r == '-':
		default:
			return false
		}
	}
	return true
}

// stripPrivacyHeaders removes routing and client-fingerprint headers from the
// supplied map.  The check is case-insensitive.  All other headers are
// preserved verbatim.  The input map is never modified.
func stripPrivacyHeaders(headers map[string]string) map[string]string {
	result := make(map[string]string, len(headers))
	for k, v := range headers {
		if !privacySensitiveHeaders[strings.ToLower(k)] {
			result[k] = v
		}
	}
	return result
}

// sanitizeHeaders applies the full privacy pipeline to a header map:
//  1. Strip routing / client-fingerprint headers.
//  2. Anonymize (or inject) the Message-ID, using senderFromAddr's FQDN
//     as the right-hand side so the identifier is RFC 5322 §3.6.4
//     compliant.
//
// The returned map is a fresh copy; the input is not mutated.
func sanitizeHeaders(headers map[string]string, senderFromAddr string) map[string]string {
	return anonymizeMessageID(stripPrivacyHeaders(headers), senderFromAddr)
}
