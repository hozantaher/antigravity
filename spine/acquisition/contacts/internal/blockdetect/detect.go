// Package blockdetect identifies semantic block responses from upstream
// scrapers (ARES, firmy.cz). Transports answer with success/failure on the
// wire layer; this package answers with success/failure on the content
// layer — e.g. an HTTP 200 carrying a Cloudflare challenge page is a block
// even though the transport call succeeded.
//
// The detector is intentionally conservative. It prefers false negatives
// (a block we missed → KT-A7 health monitor still degrades the source on
// repeated empty parses) over false positives (a valid response we throw
// away). Only well-known signatures (Cloudflare cf-ray, reCAPTCHA widgets,
// 429 Retry-After) trigger a positive classification.
//
// See docs/initiatives/2026-04-30-kt-a8-block-detection-design.md.
package blockdetect

import (
	"bytes"
	"net/http"
	"strings"
)

// BlockType enumerates the semantic block classes recognised by DetectBlock.
//
// The string form matches the wire value persisted in the healing_log table
// and the slog `block_type` field — keep them in sync with migration 008.
type BlockType int

const (
	// BlockTypeNone means the response is content-valid (no block detected).
	BlockTypeNone BlockType = iota
	// BlockTypeRateLimit means the upstream signalled a rate-limit:
	// HTTP 429, HTTP 503 + Retry-After, or a body marker like
	// "rate limit exceeded".
	BlockTypeRateLimit
	// BlockTypeCaptcha means the upstream returned a CAPTCHA challenge
	// (reCAPTCHA, hCaptcha, Turnstile, or a captcha form action).
	BlockTypeCaptcha
	// BlockTypeCloudflare means the response carries a Cloudflare
	// challenge / managed-block signature (cf-ray + "Just a moment",
	// cf-mitigated header, or 403 + Server: cloudflare).
	BlockTypeCloudflare
	// BlockTypeForbidden is a plain 401/403 without a Cloudflare or
	// CAPTCHA signature — typical IP block / banned User-Agent.
	BlockTypeForbidden
)

// String returns the wire form used in healing_log + slog tags.
func (b BlockType) String() string {
	switch b {
	case BlockTypeRateLimit:
		return "rate_limit"
	case BlockTypeCaptcha:
		return "captcha"
	case BlockTypeCloudflare:
		return "cloudflare"
	case BlockTypeForbidden:
		return "forbidden"
	default:
		return "none"
	}
}

// maxBodyPrefix is the largest slice of the response body inspected by
// DetectBlock. Cloudflare challenges + reCAPTCHA widgets always sit in
// the first ~2 kB; 4 kB gives a safety margin without bloating per-request
// memory under concurrent fetches.
const maxBodyPrefix = 4 * 1024

// Body markers — case-insensitive substring search via bytes.Contains on a
// lower-cased prefix. Keep entries short (signature-grade) to minimise
// false-positive risk on legitimate copy.
var (
	captchaMarkers = [][]byte{
		[]byte("g-recaptcha"),
		[]byte("h-captcha"),
		[]byte("cf-turnstile"),
		[]byte(`action="/check-captcha"`),
		[]byte(`action="captcha"`),
		[]byte(`action="/captcha"`),
	}
	cloudflareMarkers = [][]byte{
		[]byte("just a moment..."),
		[]byte("checking your browser"),
		[]byte("cf-browser-verification"),
		[]byte("cf-challenge-running"),
	}
	rateLimitBodyMarkers = [][]byte{
		[]byte("rate limit exceeded"),
		[]byte("too many requests"),
	}
)

// DetectBlock inspects the response triple (status, headers, bodyPrefix)
// and returns the BlockType, or BlockTypeNone if no block signature is
// detected.
//
// Only the first maxBodyPrefix bytes of bodyPrefix are scanned; the caller
// is expected to truncate large bodies before invoking DetectBlock to keep
// per-request memory bounded under concurrent scrape workloads.
//
// Header lookups are case-insensitive (canonical mime headers are tried
// first, then a manual lowercase fallback to handle non-canonical inputs
// produced by some test transports).
func DetectBlock(status int, headers http.Header, body []byte) BlockType {
	// Header-first detection (deterministic, no body-substring noise).
	if t := classifyByHeaders(status, headers); t != BlockTypeNone {
		// 403 + Cloudflare signature wins over plain forbidden.
		return t
	}

	// Body-second detection.
	prefix := bodyPrefix(body)
	if len(prefix) > 0 {
		lower := bytes.ToLower(prefix)

		if containsAny(lower, cloudflareMarkers) {
			return BlockTypeCloudflare
		}
		if containsAny(lower, captchaMarkers) {
			return BlockTypeCaptcha
		}
		if containsAny(lower, rateLimitBodyMarkers) {
			return BlockTypeRateLimit
		}
	}

	// Status-based fallback for cases the header pass already filtered:
	// 401/403 with no Cloudflare evidence → forbidden.
	if status == http.StatusForbidden || status == http.StatusUnauthorized {
		return BlockTypeForbidden
	}
	return BlockTypeNone
}

// classifyByHeaders performs the header-first dispatch. Returns
// BlockTypeNone if no header-level signature matched — the caller will
// then look at the body and finally fall back on raw status.
func classifyByHeaders(status int, headers http.Header) BlockType {
	// Cloudflare wins regardless of status: cf-ray + cf-mitigated.
	if hasHeader(headers, "Cf-Mitigated") {
		return BlockTypeCloudflare
	}
	if status == http.StatusForbidden && headerEqualsLower(headers, "Server", "cloudflare") {
		return BlockTypeCloudflare
	}

	// Rate limit by status.
	if status == http.StatusTooManyRequests {
		return BlockTypeRateLimit
	}
	if status == http.StatusServiceUnavailable && hasHeader(headers, "Retry-After") {
		return BlockTypeRateLimit
	}
	return BlockTypeNone
}

// bodyPrefix caps the inspection slice. Returns nil for empty / nil input.
func bodyPrefix(body []byte) []byte {
	if len(body) == 0 {
		return nil
	}
	if len(body) > maxBodyPrefix {
		return body[:maxBodyPrefix]
	}
	return body
}

func containsAny(haystack []byte, needles [][]byte) bool {
	for _, n := range needles {
		if bytes.Contains(haystack, n) {
			return true
		}
	}
	return false
}

// hasHeader returns true if the named header is present (canonical OR
// lowercase). net/http canonicalises on Set, but tests + non-stdlib
// transports may pass lowercase keys.
func hasHeader(headers http.Header, name string) bool {
	if headers == nil {
		return false
	}
	if v := headers.Get(name); v != "" {
		return true
	}
	for k, vv := range headers {
		if strings.EqualFold(k, name) && len(vv) > 0 && vv[0] != "" {
			return true
		}
	}
	return false
}

// headerEqualsLower returns true if headers[name] equals want
// (case-insensitive). Used for "Server: cloudflare" matching.
func headerEqualsLower(headers http.Header, name, want string) bool {
	if headers == nil {
		return false
	}
	if v := headers.Get(name); v != "" {
		return strings.EqualFold(v, want)
	}
	for k, vv := range headers {
		if strings.EqualFold(k, name) && len(vv) > 0 {
			return strings.EqualFold(vv[0], want)
		}
	}
	return false
}
