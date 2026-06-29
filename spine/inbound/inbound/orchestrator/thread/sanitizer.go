package thread

import "github.com/microcosm-cc/bluemonday"

// HTMLSanitizer scrubs raw email HTML before persistence so the UI
// (S2.3) can render it without a server-side XSS risk. Tests can swap
// in a no-op fake by satisfying this interface.
//
// We sanitize at write time (RecordInbound) instead of read time so
// `body_html` in the DB is *always* safe to render. `body_html_raw`
// retains the original input for DSR Article 15 export only — it is
// never served to the UI.
type HTMLSanitizer interface {
	Sanitize(rawHTML string) string
}

// bluemondaySanitizer wraps bluemonday's UGCPolicy with one carve-out:
// `cid:` URL scheme is allowed on `<img src>` so inline images keep
// their reference until the BFF rewrites cid: → /api/messages/.../attachments/...
// at read time (S2.1).
type bluemondaySanitizer struct{ p *bluemonday.Policy }

// NewSanitizer returns the production sanitizer.
func NewSanitizer() HTMLSanitizer {
	p := bluemonday.UGCPolicy()
	p.AllowURLSchemes("http", "https", "mailto", "cid")
	return &bluemondaySanitizer{p: p}
}

func (b *bluemondaySanitizer) Sanitize(s string) string {
	if s == "" {
		return ""
	}
	return b.p.Sanitize(s)
}

// noopSanitizer passes input through unchanged. Test-only.
type noopSanitizer struct{}

func (noopSanitizer) Sanitize(s string) string { return s }
