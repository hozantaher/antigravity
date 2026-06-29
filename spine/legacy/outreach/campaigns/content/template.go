package content

import (
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// ErrTemplateNotFound is returned by Render when the requested template name
// is absent from the email_templates DB table and no file fallback is wired.
var ErrTemplateNotFound = errors.New("template not found in email_templates")

// templateNameRe matches the production template-name vocabulary
// (intro_machinery, followup_1, followup_2, initial, final, etc.).
// Anchored at both ends; rejects path separators, dots, spaces, NUL,
// and any character outside the allowlist.
var templateNameRe = regexp.MustCompile(`^[a-z0-9_-]+$`)

// shortURLRe matches known link-shortening services.
// These are treated as a detection signal: anti-spam filters classify
// short URLs as phishing-likely fingerprints. Fail hard on render
// so poisoned templates are caught before any send attempt.
var shortURLRe = regexp.MustCompile(`(?i)(https?://)?(bit\.ly|t\.co|tinyurl\.com|goo\.gl|ow\.ly|tiny\.cc|is\.gd|buff\.ly|rebrand\.ly|short\.io|lnkd\.in|smarturl\.it|yourls\.io|cutt\.ly|t\.ly|bit\.do)/`)

// ErrShortURL is returned by Render when the rendered body contains a
// short URL. The template MUST be updated in email_templates (DB) to
// replace the short URL with the full target URL before re-rendering.
var ErrShortURL = fmt.Errorf("template body contains a short URL — replace with full URL in email_templates")

// validTemplateName reports whether name is safe to embed in a path
// constructed via filepath.Join(templatesDir, name+".tmpl").
func validTemplateName(name string) bool {
	if len(name) == 0 || len(name) > 64 {
		return false
	}
	return templateNameRe.MatchString(name)
}

// TemplateVars holds variables for template rendering.
type TemplateVars struct {
	Firma    string
	Jmeno    string
	Prijmeni string
	Region   string
	ICO      string
	Podpis   string
	UnsubURL string // full URL for the unsubscribe link (token-gated)
	Extra    map[string]string
}

// RenderedEmail is the final output ready for sending.
type RenderedEmail struct {
	Subject   string
	BodyPlain string
	BodyHTML  string
	Headers   map[string]string

	// SkipHumanize is set when the template file declares
	// {{/* humanize: off */}} (or {{/* humanize: false */}}) as a
	// top-of-file marker. Sender-side PreSendHook implementations are
	// expected to early-return on true and deliver the rendered body
	// verbatim — for hand-authored notices.
	SkipHumanize bool
}

// Engine renders personalized, spin-resolved emails.
type Engine struct {
	templatesDir string
	signatures   []string
	// db is optional. When non-nil, Render queries email_templates first (DB-first
	// mode). A nil db means file-only mode — used by tests and dev fixtures.
	db *sql.DB
}

// NewEngine creates a file-only content engine (backward-compatible).
// Production callers should use NewEngineWithDB so templates stored in
// email_templates take precedence over on-disk .tmpl files.
func NewEngine(templatesDir string, signatures []string) *Engine {
	return &Engine{
		templatesDir: templatesDir,
		signatures:   signatures,
	}
}

// NewEngineWithDB creates a DB-first content engine.
//
// Render lookup order (Sprint AH — file fallback removed):
//  1. email_templates WHERE name=$1  (DB row — single authoritative source)
//  2. error — template %q not found in email_templates
//
// File fallback was removed in Sprint AH after all .tmpl bodies were migrated
// to email_templates via migration 061_email_templates_seed_from_tmpl.sql.
// templatesDir is retained for backward-compat in file-only NewEngine callers
// and existing tests that use NewEngine directly.
//
// Passing a nil db is equivalent to calling NewEngine — the engine falls back
// to file-only mode so callers that wire db lazily don't panic.
func NewEngineWithDB(db *sql.DB, templatesDir string, signatures []string) *Engine {
	return &Engine{
		db:           db,
		templatesDir: templatesDir,
		signatures:   signatures,
	}
}

// Render produces a unique email for the given template and contact variables.
// The seed is derived from contact ID + step to ensure deterministic output
// (same contact always gets same variant for debugging/auditability).
//
// Source precedence (Sprint AH — DB authoritative):
//
//  1. email_templates DB row (when engine was created with NewEngineWithDB and db != nil)
//     — if DB row absent: returns ErrTemplateNotFound (no file fallback)
//  2. <templatesDir>/<name>.tmpl file (file-only mode when db == nil — NewEngine callers)
func (e *Engine) Render(templateName string, vars TemplateVars, contactID int64, step int) (*RenderedEmail, error) {
	// Path-traversal guard: templateName flows from DB campaigns.sequence_config
	// (operator-editable). Without this allowlist, an operator could specify
	// template="../../../etc/passwd" and Render would load /etc/passwd.tmpl —
	// would error on missing file but leak filesystem layout via error messages.
	// Restrict to lowercase letters, digits, underscore, and hyphen — every
	// production template name in email_templates matches this pattern.
	if !validTemplateName(templateName) {
		return nil, fmt.Errorf("invalid template name %q (must match [a-z0-9_-]+)", templateName)
	}

	var content string

	// envelopeKey is a stable per-render identity used to deterministically
	// pick subject/body/HTML-profile variants. Combines contactID + step so
	// the same contact always gets the same variant (auditable).
	envelopeKey := fmt.Sprintf("%d:%d", contactID, step)

	// dbBodyHTML carries the operator-authored HTML override from
	// email_templates.body_html. When non-empty we ship it verbatim as the
	// HTML alternative part (skipping plainToHTMLWithProfile auto-generation).
	// Empty/NULL keeps the legacy behavior: HTML is synthesized from `body`.
	var dbBodyHTML string

	if e.db != nil {
		// DB-first mode (NewEngineWithDB): email_templates is the single
		// authoritative source. File fallback was removed in Sprint AH after
		// migration 061 seeded all .tmpl bodies into email_templates.
		var subject, body string
		var subjectVariantsRaw, bodyVariantsRaw []byte
		err := e.db.QueryRow(
			`SELECT subject, body,
			        COALESCE(subject_variants, '[]'::jsonb),
			        COALESCE(body_variants,    '[]'::jsonb),
			        COALESCE(body_html, '')
			 FROM email_templates WHERE name=$1`,
			templateName,
		).Scan(&subject, &body, &subjectVariantsRaw, &bodyVariantsRaw, &dbBodyHTML)
		switch {
		case err == nil:
			// AR1: pick subject variant deterministically.
			var subjectVariants []string
			if jerr := json.Unmarshal(subjectVariantsRaw, &subjectVariants); jerr != nil {
				subjectVariants = nil
			}
			subject = pickVariant(envelopeKey, templateName+":subject", subjectVariants, subject)

			// AR1: pick body variant deterministically.
			var bodyVariants []string
			if jerr := json.Unmarshal(bodyVariantsRaw, &bodyVariants); jerr != nil {
				bodyVariants = nil
			}
			body = pickVariant(envelopeKey, templateName+":body", bodyVariants, body)

			// Synthesise a content string with an embedded subject comment so the
			// shared subject-extraction / render pipeline works identically
			// regardless of source.
			content = fmt.Sprintf("{{/* subject: %s */}}\n%s", subject, body)
		case errors.Is(err, sql.ErrNoRows):
			// No file fallback — return clean error (Sprint AH).
			return nil, fmt.Errorf("template %q not found in email_templates", templateName)
		default:
			return nil, fmt.Errorf("template DB lookup %s: %w", templateName, err)
		}
	} else {
		// File-only mode (NewEngine callers — tests + dev fixtures).
		// Q4.3: NOTE — variant selection (pickVariant) is only available in
		// DB-first mode (NewEngineWithDB). File-only mode is intended for
		// template authoring, CI testing, and dev fixtures that don't exercise
		// variant A/B logic. Production sends MUST use NewEngineWithDB.
		path := filepath.Join(e.templatesDir, templateName+".tmpl")
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("load template %s: %w", templateName, err)
		}
		content = string(data)
	}

	// D3.6: detect template-level humanize opt-out. Must happen before
	// subject-comment stripping so the marker comment itself is also
	// removed from the body by removeDirectiveComments.
	skipHumanize := detectHumanizeOff(content)

	// Extract subject lines from template comments
	subjects := extractSubjects(content)
	content = removeSubjectComments(content)
	content = removeDirectiveComments(content)

	// Generate deterministic seed from contact ID + step
	seed := deterministicSeed(contactID, step)

	// Select subject line
	subject := subjects[0]
	if len(subjects) > 1 {
		subject = subjects[int(seed%int64(len(subjects)))]
	}

	// Substitute variables in subject
	subject = substituteVars(subject, vars)

	// Select signature
	if len(e.signatures) > 0 && vars.Podpis == "" {
		vars.Podpis = e.signatures[int(seed%int64(len(e.signatures)))]
	}

	// Substitute variables in body
	body := substituteVars(content, vars)

	// Resolve spin syntax
	body = ResolveSpin(body, seed)

	// Clean up whitespace
	body = strings.TrimSpace(body)

	// AR2 — Render-time anti-detection guards:
	//
	// 1. {{.OpenPixel}} placeholder: if still present after substitution the
	//    vars struct had no OpenPixel value (zero-value empty string). This
	//    means the placeholder was resolved to "" which is correct behaviour.
	//    However, if the raw *content* (before substitution) contained a
	//    rendered open-pixel <img> tag pointing to our /o endpoint, that's a
	//    detection signal. We log a WARN — backward compatible, no fail.
	if strings.Contains(body, `<img`) && strings.Contains(body, `/o?`) {
		slog.Warn("AR2: rendered body contains open-pixel <img> tag — remove from template in email_templates",
			"op", "content.Render/open_pixel_warn",
			"template", templateName,
		)
	}

	// 2. Short URLs are a hard render fail — they are classified as
	//    phishing-likely fingerprints by anti-spam filters (bit.ly etc.).
	//    The operator must expand them to full URLs in email_templates before
	//    the template can be rendered.
	if shortURLRe.MatchString(body) {
		return nil, fmt.Errorf("%w (template %q)", ErrShortURL, templateName)
	}

	headers := map[string]string{
		"Content-Language": "cs",
	}

	// AR3: deterministic HTML profile per envelope — 5 distinct HTML trees
	// so the rendered HTML hash differs across recipients.
	htmlProfile := pickHTMLProfile(envelopeKey, templateName)

	// Operator-authored HTML override wins over auto-generated HTML when set.
	// We still run substituteVars on the HTML so {{.FirstName}}, {{.PrivacyUrl}}
	// etc. are filled. Spin syntax is also expanded for HTML-level variation.
	htmlBody := plainToHTMLWithProfile(body, htmlProfile)
	if dbBodyHTML != "" {
		rendered := substituteVars(dbBodyHTML, vars)
		rendered = ResolveSpin(rendered, seed)
		htmlBody = strings.TrimSpace(rendered)
	}

	return &RenderedEmail{
		Subject:      subject,
		BodyPlain:    body,
		BodyHTML:     htmlBody,
		Headers:      headers,
		SkipHumanize: skipHumanize,
	}, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// AR1 — variant selection
// ─────────────────────────────────────────────────────────────────────────────

// pickVariant deterministically selects one entry from variants (or mainContent
// when variants is empty or when the hash falls on the main slot).
//
// Selection algorithm: SHA256(envelopeKey + ":" + variantKey) mod (len(variants)+1).
//   - index == len(variants) → return mainContent (main is always in the pool)
//   - index <  len(variants) → return variants[index]
//
// Invariants:
//   - Same inputs always produce same output (deterministic / auditable).
//   - When variants is empty, always returns mainContent.
//   - Distribution is approximately uniform across (len(variants)+1) choices.
func pickVariant(envelopeKey, variantKey string, variants []string, mainContent string) string {
	if len(variants) == 0 {
		return mainContent
	}
	h := sha256.Sum256([]byte(envelopeKey + ":" + variantKey))
	idx := int(binary.BigEndian.Uint32(h[:4])) % (len(variants) + 1)
	if idx == len(variants) {
		return mainContent
	}
	return variants[idx]
}

// ─────────────────────────────────────────────────────────────────────────────
// AR3 — HTML profile variation
// ─────────────────────────────────────────────────────────────────────────────

// HTMLProfile determines the HTML structure emitted by plainToHTMLWithProfile.
// Five distinct profiles produce different DOM shapes so the rendered HTML hash
// differs across recipients — breaking the fingerprint that arises when 100
// identical HTML trees are sent.
type HTMLProfile int

const (
	// HTMLProfileParagraphs renders body as <p> blocks (the historical default).
	HTMLProfileParagraphs HTMLProfile = iota
	// HTMLProfileDivBlocks renders body paragraphs as <div> blocks.
	HTMLProfileDivBlocks
	// HTMLProfileMixed alternates <p> and <div> at the paragraph boundary.
	HTMLProfileMixed
	// HTMLProfileInlineStyle adds explicit inline style on every block element.
	HTMLProfileInlineStyle
	// HTMLProfileClassDriven uses a class attribute instead of inline style on
	// paragraph/div elements (no-op visually in most clients, but different HTML).
	HTMLProfileClassDriven

	htmlProfileCount = 5
)

// pickHTMLProfile deterministically selects an HTMLProfile for a given envelope.
// Uses SHA256(envelopeKey + ":" + templateName + ":htmlprofile") mod 5.
func pickHTMLProfile(envelopeKey, templateName string) HTMLProfile {
	h := sha256.Sum256([]byte(envelopeKey + ":" + templateName + ":htmlprofile"))
	idx := int(binary.BigEndian.Uint32(h[:4])) % htmlProfileCount
	return HTMLProfile(idx)
}

// plainToHTMLWithProfile converts plain-text body to HTML using the specified
// structural profile. All 5 profiles honour the same --- footer-divider and
// **bold** conventions as the original plainToHTML. Footer variant is also
// selected deterministically from the envelopeKey embedded in profile choice.
//
// HARD RULE (memory feedback_no_unsub_url_in_body): footers NEVER contain href
// or unsub URL links — only "stačí odepsat" formulations.
func plainToHTMLWithProfile(text string, profile HTMLProfile) string {
	text = strings.ReplaceAll(text, "&", "&amp;")
	text = strings.ReplaceAll(text, "<", "&lt;")
	text = strings.ReplaceAll(text, ">", "&gt;")

	const hrMarker = "\n---\n"
	const hrMarkerStart = "---\n"
	var bodyPart, footerPart string
	hasFooter := false

	switch {
	case strings.Contains(text, hrMarker):
		idx := strings.Index(text, hrMarker)
		bodyPart = text[:idx]
		footerPart = text[idx+len(hrMarker):]
		hasFooter = true
	case strings.HasPrefix(text, hrMarkerStart):
		bodyPart = ""
		footerPart = text[len(hrMarkerStart):]
		hasFooter = true
	default:
		bodyPart = text
	}

	bodyHTML := paragraphizeWithProfile(applyBold(bodyPart), profile)
	out := "<html><body>" + bodyHTML
	if hasFooter {
		footerInner := strings.TrimSpace(footerPart)
		footerInner = strings.ReplaceAll(footerInner, "\n", "<br>\n")
		out += `<p ` + footerPStyle + `>` + footerInner + `</p>`
	}
	out += "</body></html>"
	return out
}

// paragraphizeWithProfile converts plain text into paragraph blocks using the
// structural variant described by profile.
func paragraphizeWithProfile(text string, profile HTMLProfile) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	paras := strings.Split(text, "\n\n")

	var sb strings.Builder
	for i, para := range paras {
		para = strings.ReplaceAll(para, "\n", "<br>\n")
		switch profile {
		case HTMLProfileParagraphs:
			sb.WriteString(`<p ` + pStyle + `>` + para + `</p>`)
		case HTMLProfileDivBlocks:
			sb.WriteString(`<div style="margin:0 0 16px 0;line-height:1.55">` + para + `</div>`)
		case HTMLProfileMixed:
			if i%2 == 0 {
				sb.WriteString(`<p ` + pStyle + `>` + para + `</p>`)
			} else {
				sb.WriteString(`<div style="margin:0 0 16px 0;line-height:1.55">` + para + `</div>`)
			}
		case HTMLProfileInlineStyle:
			sb.WriteString(`<p style="margin:0 0 18px 0;line-height:1.6;font-family:inherit">` + para + `</p>`)
		case HTMLProfileClassDriven:
			sb.WriteString(`<p class="body-para" style="margin:0 0 16px 0;line-height:1.55">` + para + `</p>`)
		default:
			sb.WriteString(`<p ` + pStyle + `>` + para + `</p>`)
		}
	}
	return sb.String()
}

// ─────────────────────────────────────────────────────────────────────────────
// AR3 — footer text variants (3 formulations; no href per HARD RULE)
// ─────────────────────────────────────────────────────────────────────────────

// footerVariants holds the 3 equivalent opt-out footer formulations.
// None contains a URL. Opt-out is always by reply ("stačí odepsat").
var footerVariants = [3]string{
	"Pokud nemáte zájem, stačí odepsat — odhlásíme vás.",
	"V případě, že byste si nepřáli další zprávy, jednoduše odpovězte.",
	"Pro odhlášení z dalších kontaktů stačí krátká odpověď.",
}

// PickFooterVariant deterministically selects one footer opt-out formulation.
// Exported so it can be used by template operators and tests directly.
// Uses SHA256(envelopeKey + ":footer") mod 3.
func PickFooterVariant(envelopeKey string) string {
	h := sha256.Sum256([]byte(envelopeKey + ":footer"))
	idx := int(binary.BigEndian.Uint32(h[:4])) % len(footerVariants)
	return footerVariants[idx]
}

// detectHumanizeOff reports whether the template body should bypass the
// humanize engine. Sprint A (2026-05-11) inverted the default to OFF
// after a production incident: humanize prepended greeting + appended
// signature to a body that already had both, producing duplicit
// "Dobrý den," and a stale persona ("Jan Novak / Stroje s.r.o.") drawn
// from dev env vars. Operator-curated templates are now treated as
// final-and-shipped by default — no mutation.
//
// To opt in to humanize mutation, declare a marker comment on its own
// line within the body:
//
//	{{/* humanize: on */}} | {{/* humanize: true */}} | {{/* humanize: yes */}} | {{/* humanize: 1 */}}
//
// Any other marker (or no marker) keeps humanize OFF. Legacy markers
// `{{/* humanize: off */}}` etc. are still accepted (redundant but
// harmless — they declare the same default-off intent).
//
// Returns true when humanize should be SKIPPED (default), false when
// the template explicitly opts in.
func detectHumanizeOff(content string) bool {
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "{{/*") || !strings.HasSuffix(trimmed, "*/}}") {
			continue
		}
		inner := strings.TrimSuffix(strings.TrimPrefix(trimmed, "{{/*"), "*/}}")
		inner = strings.TrimSpace(inner)
		lower := strings.ToLower(inner)
		if !strings.HasPrefix(lower, "humanize") {
			continue
		}
		colon := strings.Index(lower, ":")
		if colon < 0 {
			continue
		}
		key := strings.TrimSpace(lower[:colon])
		val := strings.TrimSpace(lower[colon+1:])
		if key != "humanize" {
			continue
		}
		// Explicit opt-in flips humanize ON (returns false = "do not skip").
		switch val {
		case "on", "true", "yes", "1":
			return false
		}
	}
	// Default: skip humanize (inverted from pre-Sprint-A behavior).
	return true
}

// removeDirectiveComments strips humanize directive comments from the
// template body so the marker never leaks into outbound mail.
func removeDirectiveComments(content string) string {
	var lines []string
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "{{/*") && strings.HasSuffix(trimmed, "*/}}") {
			inner := strings.TrimSpace(
				strings.TrimSuffix(strings.TrimPrefix(trimmed, "{{/*"), "*/}}"),
			)
			if strings.HasPrefix(strings.ToLower(inner), "humanize") {
				continue
			}
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func substituteVars(text string, vars TemplateVars) string {
	replacements := map[string]string{
		"{{firma}}":    vars.Firma,
		"{{jmeno}}":    vars.Jmeno,
		"{{prijmeni}}": vars.Prijmeni,
		"{{region}}":   vars.Region,
		"{{ico}}":      vars.ICO,
		"{{podpis}}":   vars.Podpis,
		"{{unsuburl}}": vars.UnsubURL,
		// Also support dot notation
		"{{.Firma}}":    vars.Firma,
		"{{.Jmeno}}":    vars.Jmeno,
		"{{.Prijmeni}}": vars.Prijmeni,
		"{{.Region}}":   vars.Region,
		"{{.ICO}}":      vars.ICO,
		"{{.Podpis}}":   vars.Podpis,
		"{{.UnsubURL}}": vars.UnsubURL,
	}

	for key, val := range replacements {
		text = strings.ReplaceAll(text, key, val)
	}

	// Handle conditional blocks: {{if .Jmeno}}...{{end}}
	text = resolveConditionals(text, vars)

	return text
}

func resolveConditionals(text string, vars TemplateVars) string {
	conditionals := map[string]string{
		"Jmeno":  vars.Jmeno,
		"Region": vars.Region,
		"ICO":    vars.ICO,
		"Firma":  vars.Firma,
	}

	for varName, value := range conditionals {
		ifTag := "{{if ." + varName + "}}"
		endTag := "{{end}}"

		for {
			start := strings.Index(text, ifTag)
			if start < 0 {
				break
			}
			end := strings.Index(text[start:], endTag)
			if end < 0 {
				break
			}
			end += start + len(endTag)

			if value != "" {
				inner := text[start+len(ifTag) : end-len(endTag)]
				text = text[:start] + inner + text[end:]
			} else {
				text = text[:start] + text[end:]
			}
		}
	}

	return text
}

func extractSubjects(content string) []string {
	var subjects []string
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "{{/* subject:") {
			subj := strings.TrimPrefix(trimmed, "{{/* subject:")
			subj = strings.TrimSuffix(subj, "*/}}")
			subj = strings.TrimSpace(subj)
			if subj != "" {
				subjects = append(subjects, subj)
			}
		}
	}
	if len(subjects) == 0 {
		subjects = []string{"Poptávka"}
	}
	return subjects
}

func removeSubjectComments(content string) string {
	var lines []string
	for _, line := range strings.Split(content, "\n") {
		if !strings.Contains(line, "{{/* subject:") {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "\n")
}

func deterministicSeed(contactID int64, step int) int64 {
	h := sha256.Sum256([]byte(fmt.Sprintf("%d:%d", contactID, step)))
	return int64(binary.BigEndian.Uint64(h[:8]) & 0x7FFFFFFFFFFFFFFF)
}

// pStyle: every <p> gets visible paragraph spacing in webmail. Webmail
// clients (Gmail/Outlook) strip <head>/<style> blocks so inline is the
// only reliable channel.
const pStyle = `style="margin:0 0 16px 0;line-height:1.55"`

// footerPStyle: GDPR / compliance footer. Maximally subtle — operator
// decision 2026-05-08 (third revision): even with thin HR + small italic,
// the footer was still "moc nápadná". Drop italic (italic is itself an
// attention signal — text rendered in a different shape than body), drop
// the explicit HR (use whitespace separation only via margin-top), shrink
// font to 0.8em, lighten grey to #aaa. Result: footer fades to "fine
// print" status, present for compliance but visually inert.
const footerPStyle = `style="margin:32px 0 0 0;font-size:0.8em;color:#aaa;line-height:1.5"`

// boldRe matches Markdown-style **bold** emphasis. Used to support inline
// emphasis on hand-picked phrases (e.g. "Vykupuju techniku už přes 20 let.")
// without polluting the plain-text body — the asterisks remain visible in
// the text/plain alternative, which is acceptable in B2B context.
//
// Non-greedy match prevents one set of asterisks from swallowing across
// multiple bold spans.
var boldRe = regexp.MustCompile(`\*\*(.+?)\*\*`)

// plainToHTML converts plain-text body into HTML email body using the default
// HTMLProfileParagraphs profile. Kept for backward compatibility with callers
// that do not participate in the AR3 profile-variation pipeline (e.g. tests
// that call plainToHTML directly, preview endpoints).
//
// Production Render() calls plainToHTMLWithProfile instead so each envelope
// receives a deterministically-chosen structural profile.
func plainToHTML(text string) string {
	return plainToHTMLWithProfile(text, HTMLProfileParagraphs)
}

// applyBold expands Markdown **emphasis** into <strong>. Run AFTER HTML
// entity escaping so a stray "**" inside escaped HTML doesn't trigger
// false matches.
func applyBold(s string) string {
	return boldRe.ReplaceAllString(s, `<strong>$1</strong>`)
}

// paragraphize converts plain text into <p style>…</p> blocks with <br>
// for in-paragraph line breaks. Returns empty string for empty input.
func paragraphize(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	closeOpen := `</p><p ` + pStyle + `>`
	text = strings.ReplaceAll(text, "\n\n", closeOpen)
	text = strings.ReplaceAll(text, "\n", "<br>\n")
	return `<p ` + pStyle + `>` + text + `</p>`
}

// ListTemplates returns all available template names.
// When the engine was created with NewEngineWithDB, names are read from the
// email_templates DB table (Sprint AH — DB authoritative). Falls back to
// directory listing when db is nil (file-only NewEngine callers / tests).
func (e *Engine) ListTemplates() []string {
	if e.db != nil {
		rows, err := e.db.Query(`SELECT name FROM email_templates ORDER BY name`)
		if err != nil {
			return nil
		}
		defer rows.Close()
		var names []string
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				continue
			}
			names = append(names, name)
		}
		return names
	}
	// File-only fallback (NewEngine callers).
	entries, err := os.ReadDir(e.templatesDir)
	if err != nil {
		return nil
	}
	var names []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".tmpl") {
			names = append(names, strings.TrimSuffix(entry.Name(), ".tmpl"))
		}
	}
	return names
}
