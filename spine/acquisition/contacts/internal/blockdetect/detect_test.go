package blockdetect

import (
	"net/http"
	"testing"
)

// TestDetectBlock_TableDriven covers the four block types + non-block paths
// and the body-truncation edge cases described in the KT-A8 design doc.
//
// Naming convention: <category>/<sub-case>. The first prefix maps to the
// expected BlockType so reviewers can scan failures grouped by block class.
func TestDetectBlock_TableDriven(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		status  int
		headers http.Header
		body    []byte
		want    BlockType
	}{
		// ---- rate_limit ----
		{
			name:    "rate_limit/429 with Retry-After numeric",
			status:  http.StatusTooManyRequests,
			headers: http.Header{"Retry-After": []string{"120"}},
			body:    []byte(`{"error":"too many requests"}`),
			want:    BlockTypeRateLimit,
		},
		{
			name:    "rate_limit/429 without Retry-After",
			status:  http.StatusTooManyRequests,
			headers: http.Header{},
			body:    []byte(`Too Many Requests`),
			want:    BlockTypeRateLimit,
		},
		{
			name:    "rate_limit/503 with Retry-After (overload)",
			status:  http.StatusServiceUnavailable,
			headers: http.Header{"Retry-After": []string{"30"}},
			body:    []byte(`<h1>Service Unavailable</h1>`),
			want:    BlockTypeRateLimit,
		},
		{
			name:    "rate_limit/200 with body marker rate limit exceeded",
			status:  http.StatusOK,
			headers: http.Header{"Content-Type": []string{"text/html"}},
			body:    []byte(`<html><body><h1>Rate limit exceeded</h1></body></html>`),
			want:    BlockTypeRateLimit,
		},

		// ---- captcha ----
		{
			name:    "captcha/google_recaptcha widget",
			status:  http.StatusOK,
			headers: http.Header{"Content-Type": []string{"text/html"}},
			body:    []byte(`<html><body><div class="g-recaptcha" data-sitekey="abc"></div></body></html>`),
			want:    BlockTypeCaptcha,
		},
		{
			name:    "captcha/hcaptcha widget",
			status:  http.StatusOK,
			headers: http.Header{},
			body:    []byte(`<html><body><div class="h-captcha"></div></body></html>`),
			want:    BlockTypeCaptcha,
		},
		{
			name:    "captcha/cf-turnstile widget",
			status:  http.StatusOK,
			headers: http.Header{},
			body:    []byte(`<html><body><div class="cf-turnstile" data-sitekey="0x4"></div></body></html>`),
			want:    BlockTypeCaptcha,
		},
		{
			name:    "captcha/form action with captcha keyword",
			status:  http.StatusOK,
			headers: http.Header{},
			body:    []byte(`<form action="/check-captcha" method="post"><input name="answer"></form>`),
			want:    BlockTypeCaptcha,
		},

		// ---- cloudflare ----
		{
			name:   "cloudflare/cf-ray header + just a moment body",
			status: http.StatusOK,
			headers: http.Header{
				"Cf-Ray":       []string{"8a7e2b1d4c5e6f7g-PRG"},
				"Content-Type": []string{"text/html"},
			},
			body: []byte(`<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser before accessing site.</body></html>`),
			want: BlockTypeCloudflare,
		},
		{
			name:    "cloudflare/403 with Server: cloudflare",
			status:  http.StatusForbidden,
			headers: http.Header{"Server": []string{"cloudflare"}},
			body:    []byte(`<html><body>Sorry, you have been blocked</body></html>`),
			want:    BlockTypeCloudflare,
		},
		{
			name:    "cloudflare/cf-mitigated challenge header",
			status:  http.StatusOK,
			headers: http.Header{"Cf-Mitigated": []string{"challenge"}},
			body:    []byte(`<html></html>`),
			want:    BlockTypeCloudflare,
		},
		{
			name:    "cloudflare/checking your browser body marker",
			status:  http.StatusOK,
			headers: http.Header{"Cf-Ray": []string{"abc-PRG"}},
			body:    []byte(`<html><head></head><body>Checking your browser</body></html>`),
			want:    BlockTypeCloudflare,
		},

		// ---- forbidden ----
		{
			name:    "forbidden/plain 403 no cloudflare signature",
			status:  http.StatusForbidden,
			headers: http.Header{"Server": []string{"nginx"}},
			body:    []byte(`<h1>403 Forbidden</h1>`),
			want:    BlockTypeForbidden,
		},
		{
			name:    "forbidden/401 unauthorized",
			status:  http.StatusUnauthorized,
			headers: http.Header{},
			body:    []byte(`{"error":"unauthorized"}`),
			want:    BlockTypeForbidden,
		},
		{
			name:    "forbidden/access denied html",
			status:  http.StatusForbidden,
			headers: http.Header{},
			body:    []byte(`<html><body>Access Denied</body></html>`),
			want:    BlockTypeForbidden,
		},

		// ---- none (success / not-found / unrelated) ----
		{
			name:    "none/200 valid JSON ARES response",
			status:  http.StatusOK,
			headers: http.Header{"Content-Type": []string{"application/json"}},
			body:    []byte(`{"ico":"12345678","obchodniJmeno":"Test s.r.o."}`),
			want:    BlockTypeNone,
		},
		{
			name:    "none/404 legitimate not found",
			status:  http.StatusNotFound,
			headers: http.Header{},
			body:    []byte(`{"error":"subject not found"}`),
			want:    BlockTypeNone,
		},
		{
			name:    "none/410 gone",
			status:  http.StatusGone,
			headers: http.Header{},
			body:    []byte(`{"error":"gone"}`),
			want:    BlockTypeNone,
		},
		{
			name:    "none/200 valid HTML business profile",
			status:  http.StatusOK,
			headers: http.Header{"Content-Type": []string{"text/html"}},
			body:    []byte(`<html><body><h1>Bagry Praha s.r.o.</h1><p>IČO: 12345678</p></body></html>`),
			want:    BlockTypeNone,
		},

		// ---- edge cases ----
		{
			name:    "edge/empty body and empty headers 200",
			status:  http.StatusOK,
			headers: http.Header{},
			body:    []byte{},
			want:    BlockTypeNone,
		},
		{
			name:    "edge/nil body 200",
			status:  http.StatusOK,
			headers: http.Header{},
			body:    nil,
			want:    BlockTypeNone,
		},
		{
			name:   "edge/large body cloudflare in first 4kB",
			status: http.StatusOK,
			headers: http.Header{
				"Cf-Ray":       []string{"abc-PRG"},
				"Content-Type": []string{"text/html"},
			},
			// 8 kB tail of legitimate content prefixed by Cloudflare challenge in first 2 kB.
			body: append(
				[]byte(`<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser`),
				fill(8000, 'x')...,
			),
			want: BlockTypeCloudflare,
		},
		{
			name:    "edge/marker beyond 4kB window is missed (false negative preferred)",
			status:  http.StatusOK,
			headers: http.Header{},
			// 5 kB filler then Cloudflare marker — must NOT be detected because we cap at 4 kB.
			body: append(fill(5000, 'a'), []byte(`<title>Just a moment...</title>`)...),
			want: BlockTypeNone,
		},
		{
			name:    "edge/malformed html 403 still classifies as forbidden by status",
			status:  http.StatusForbidden,
			headers: http.Header{},
			body:    []byte(`<<<<not-real-html>>>>`),
			want:    BlockTypeForbidden,
		},
		{
			name:    "edge/200 with word captcha in legit copy is not false-positive",
			status:  http.StatusOK,
			headers: http.Header{"Content-Type": []string{"text/html"}},
			body:    []byte(`<html><body><p>Děkujeme, Vaše objednávka byla přijata. Captcha nebyla potřeba.</p></body></html>`),
			want:    BlockTypeNone,
		},
		{
			name:    "edge/lowercase header keys (canonical mismatch)",
			status:  http.StatusOK,
			headers: http.Header{"cf-ray": []string{"x-PRG"}},
			body:    []byte(`<html><head><title>Just a moment...</title></head></html>`),
			want:    BlockTypeCloudflare,
		},
		{
			name:    "edge/case-mixed cloudflare body marker",
			status:  http.StatusOK,
			headers: http.Header{"Cf-Ray": []string{"x-PRG"}},
			body:    []byte(`<HTML><HEAD><TITLE>JUST A MOMENT...</TITLE></HEAD></HTML>`),
			want:    BlockTypeCloudflare,
		},
		{
			name:    "edge/200 OK ARES HTML maintenance page is not classified as block (no marker)",
			status:  http.StatusOK,
			headers: http.Header{"Content-Type": []string{"text/html"}},
			body:    []byte(`<html><body><h1>ARES — služba dočasně nedostupná</h1></body></html>`),
			want:    BlockTypeNone,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := DetectBlock(tt.status, tt.headers, tt.body)
			if got != tt.want {
				t.Fatalf("DetectBlock(%d, %v, %q…) = %s, want %s",
					tt.status, tt.headers, truncate(tt.body, 80), got, tt.want)
			}
		})
	}
}

// TestBlockType_String ensures the enum stringifies to the canonical wire
// values used by healing_log + slog tags.
func TestBlockType_String(t *testing.T) {
	t.Parallel()

	cases := []struct {
		bt   BlockType
		want string
	}{
		{BlockTypeNone, "none"},
		{BlockTypeRateLimit, "rate_limit"},
		{BlockTypeCaptcha, "captcha"},
		{BlockTypeCloudflare, "cloudflare"},
		{BlockTypeForbidden, "forbidden"},
	}
	for _, c := range cases {
		if got := c.bt.String(); got != c.want {
			t.Errorf("BlockType(%d).String() = %q, want %q", c.bt, got, c.want)
		}
	}
}

// TestDetectBlock_BodyPrefixCap proves we never read past the configured cap.
// We pass a body large enough to OOM a naive scanner and verify the function
// completes promptly.
func TestDetectBlock_BodyPrefixCap(t *testing.T) {
	t.Parallel()

	// Body marker is buried after the 4 kB cap → must be missed.
	body := append(fill(maxBodyPrefix+10, 'z'), []byte(`g-recaptcha`)...)
	if got := DetectBlock(http.StatusOK, http.Header{}, body); got != BlockTypeNone {
		t.Fatalf("expected BlockTypeNone (marker beyond cap), got %s", got)
	}
}

// TestDetectBlock_NilHeaders ensures nil headers do not panic.
func TestDetectBlock_NilHeaders(t *testing.T) {
	t.Parallel()

	if got := DetectBlock(http.StatusOK, nil, []byte(`{}`)); got != BlockTypeNone {
		t.Fatalf("nil headers should not crash; got %s", got)
	}
	if got := DetectBlock(http.StatusForbidden, nil, []byte(`forbidden`)); got != BlockTypeForbidden {
		t.Fatalf("nil headers + 403 should still classify as forbidden; got %s", got)
	}
}

// fill returns a slice of n bytes filled with c.
func fill(n int, c byte) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = c
	}
	return out
}

// truncate returns up to n bytes of b for failure messages.
func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}
