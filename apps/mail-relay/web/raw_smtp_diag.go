package web

// Diagnostic endpoint: POST /v1/raw-smtp-test
//
// Sprint H7 — egress isolation. Anti-trace pipeline (engine.go) layers 13
// safety mechanisms onto every send: multipart/alternative force, span
// injection, diacritics degrade, X-Mailer forge, custom Message-Id, etc.
// Today's diagnostic showed local Mullvad CZ + raw smtplib delivers (1/1)
// but Railway anti-trace path delivers 0/N — even after PR #694 fixed the
// Message-Id domain (D5).
//
// To isolate Railway egress IP reputation vs MIME content shape, this
// handler builds a PLAIN RFC822 message (text/plain, UTF-8, no anti-trace
// headers) and sends it through the same wgpool egress as production.
// If Plain-MIME-via-Railway also delivers 0/N, the egress IP itself is the
// issue (Mullvad CZ rep at recipient). If Plain-MIME-via-Railway delivers
// 1/1, the anti-trace transformations are the issue.
//
// Temporary: reverts after H7 conclusion or gates behind
// EGRESS_DIAG_MODE=1 so production can disable bypass capability.

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	mathrand "math/rand"
	"mime/quotedprintable"
	"net"
	"net/http"
	"net/smtp"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"common/humanize"

	"relay/internal/delivery"
	"relay/internal/transport"
	"relay/internal/transport/wgpool"
)

const (
	rawSMTPTestTimeout = 30 * time.Second
)

// rawSMTPTestRequest is the input shape for /v1/raw-smtp-test.
//
// `from` is the SMTP username + envelope From: address (single value used
// for both — same as smtplib bypass). `password` is the SMTP login secret.
// `recipient`, `subject`, `body` populate the message; the body is sent
// verbatim as text/plain UTF-8 8bit.
type rawSMTPTestRequest struct {
	From      string `json:"from"`
	Password  string `json:"password"`
	Recipient string `json:"recipient"`
	Subject   string `json:"subject"`
	Body      string `json:"body"`
	// EngineMessageID, when true, builds the Message-Id using the same
	// HMAC-SHA256 algorithm as services/campaigns/sender Engine
	// (BuildMessageIDHeader): `<{16-hex}.{nanos}@{fqdn}>` where
	// {16-hex} = HMAC-SHA256(recipient || envelopeID, key)[:8] hex.
	// Default false → legacy `<{16-hex}@{fqdn}>` random format.
	// Used by sprint I1 to A/B test whether Seznam ML detector
	// fingerprints the HMAC dot-nanos shape vs random hex.
	EngineMessageID bool `json:"engine_messageid"`
	// Multipart, when true, builds a multipart/alternative message with
	// two parts: text/plain (UTF-8, 8bit, body verbatim) followed by
	// text/html (minimal `<!DOCTYPE html><html><body><p>…</p></body></html>`
	// with HTML-escaped body and CRLF→<br/> conversion). Default false →
	// single text/plain part (back-compat with I0/I1).
	//
	// Sprint I2 uses this flag to A/B test whether Seznam tolerates
	// minimal multipart structure (mirroring real B2B mail) vs flat
	// text/plain. Real Czech B2B email is overwhelmingly multipart;
	// flat text/plain may itself be a spam signal at the recipient.
	Multipart bool `json:"multipart"`
	// HumanizeLight, when true, applies three SAFE char-level substitutions
	// to the body BEFORE MIME wrap (so both text/plain and text/html parts
	// see the same substituted text):
	//   1. ~30% of ASCII spaces → non-breaking space (U+00A0)
	//   2. " - " patterns → " — " (em-dash, U+2014)
	//   3. Straight ASCII double quotes → curly quotes (U+201C / U+201D)
	//
	// Subject and headers are NEVER touched — only body content. These are
	// the same substitutions that real B2B mail readers (Word/Outlook auto-
	// correct, Apple Mail typography) introduce, so a Seznam ML detector
	// fingerprinting them as "machine-perfect ASCII" should see legitimate-
	// looking variance instead. Diacritics in source are preserved verbatim
	// (no degradation — the H1 humanize/imperfect.go diacritics path is
	// SEPARATE and intentionally not invoked from this diagnostic).
	//
	// Sprint I3: A/B test which char-level substitutions Seznam tolerates
	// without raising spam score. Default false → body verbatim (back-compat
	// with I0/I1/I2).
	HumanizeLight bool `json:"humanize_light"`
	// DiacriticsDegrade, when true, randomly replaces ~30% of Czech diacritic
	// characters in the body with their ASCII equivalents (á→a, ř→r, š→s,
	// etc.). The substitution is per-character independent so a single
	// paragraph contains a MIX of correct and degraded forms — e.g.
	// "vážený" might become "vazeny" while "klient" stays "klient".
	//
	// Subject and headers are NEVER touched — only body content. This is the
	// canonical CZ-spam ML signal: real B2B Czech mail keeps diacritics
	// consistent (UTF-8 input methods don't drop them stochastically). A
	// mid-paragraph mix is the classic "machine-translated spam" fingerprint
	// — H1 hypothesis says Seznam's filter trains on exactly this signal.
	//
	// Sprint I4: A/B test against I3's humanize_light to quantify exact
	// failure rate. Per H1 ranking, I4 is an EXPECTED FAIL — if 0/10
	// delivered we confirm the hypothesis and recommend disabling for CZ
	// providers. If 1+/10 delivered, the rate becomes ammunition for an
	// ADR proposal documenting cost-vs-benefit.
	//
	// Stochastic via crypto/rand in production, seeded via env
	// DIACRITICS_DEGRADE_TEST_SEED for deterministic tests.
	DiacriticsDegrade bool `json:"diacritics_degrade"`
	// SpansInject, when true, splits the HTML body part into lines and
	// independently flips a 30% coin per non-empty line; on heads, the
	// line is wrapped in `<span style="font-size:Npx">...</span>` where
	// N ∈ {13, 14, 15} (uniform). Mirrors the per-line span churn in
	// services/common/humanize/fingerprint.go:67-76 — the canonical
	// "messy webmail" HTML structure that anti-trace's WrapBodyHTML
	// emits for every campaign send.
	//
	// Subject and headers are NEVER touched. text/plain part is
	// untouched. Only effective when multipart=true (SPECIFICALLY
	// because flat text/plain has no HTML to inject into) — when
	// spans_inject=true and multipart=false the runner behaves as a
	// no-op: the flag is echoed in the response but no MIME mutation
	// happens.
	//
	// Sprint I5: A/B test whether per-line random span injection
	// (HTML structure churn across sends) flags Seznam ML detector.
	// H1 ranks this HIGH suspicion: B2B mail readers (Outlook/Word/
	// Gmail) DO emit messy span-soup, so a span-injected body should
	// look MORE legitimate than clean `<p>...</p>`. If delivery
	// drops, the H1 hypothesis is wrong and the canonical fingerprint
	// path itself is a problem.
	//
	// Stochastic via crypto/rand in production, seeded via env
	// SPANS_INJECT_TEST_SEED for deterministic tests.
	SpansInject bool `json:"spans_inject"`
	// EngineHTMLWrap, when true, replaces the minimal
	// `<!DOCTYPE html><html><body><p>...</p></body></html>` HTML body
	// (multipart=true default) with the Fingerprint engine's wrap from
	// services/common/humanize/fingerprint.go:
	//   <html><head><meta charset="utf-8"></head><body>
	//   <div style="font-family: Arial, sans-serif; font-size: 14px;">
	//   ...lines (each terminated with <br>, optional spans if SpansInject)...
	//   </div></body></html>
	// Only effective when Multipart=true. Per J3 audit (Stage 1 candidate
	// killer #2): the explicit Arial/14px font-family + meta-charset block
	// looks engineered relative to real CZ-webmail HTML. A/B for sprint L.
	EngineHTMLWrap bool `json:"engine_html_wrap"`
	// RedundantDivs, when true, splices `<div>&nbsp;</div>` after empty
	// lines with 20% probability per empty line — mirrors the redundant-
	// div injection in services/common/humanize/fingerprint.go:79-81.
	// Only effective when Multipart=true AND EngineHTMLWrap=true (the
	// minimal `<p>...</p>` wrap has no notion of paragraph breaks for
	// div insertion). Per J3 audit Stage 1 candidate #5: orphan
	// `<div>&nbsp;</div>` is not standard Outlook/Gmail output and may
	// fingerprint Engine-emitted MIME.
	//
	// Stochastic via crypto/rand; reuses the SPANS_INJECT_TEST_SEED env
	// for determinism (same seed source — both transformations live in
	// the HTML-body churn family).
	RedundantDivs bool `json:"redundant_divs"`
	// EngineFromDisplayName, when true, replaces the bare `From: email`
	// header with `From: "DisplayName" <email>` where DisplayName is
	// derived from the email local part via title-case (e.g. "a.mazher"
	// → "A. Mazher"). Mirrors services/campaigns/sender/headers.go
	// BuildFromHeader + titleCaseLocalPart. Per J3 audit Stage 3
	// candidate killer #19/Rank 3: algorithmically-derived display
	// names across all sends are a fingerprint at scale.
	EngineFromDisplayName bool `json:"engine_from_displayname"`
	// XMailerHeader, when true, adds `X-Mailer: Seznam.cz` to the headers
	// (forged client identification). Note: relay's D5 sanitizeHeaders
	// strips X-Mailer in the production drain path; the diagnostic emits
	// it BEFORE relay processing to A/B Seznam's recipient-side reaction
	// to a self-identifying webmail tag. Per J3 audit Stage 3 candidate
	// #22, listed as relay-stripped in production but explicitly
	// reachable here for hypothesis testing.
	XMailerHeader bool `json:"xmailer_header"`
	// ContentLanguageCS, when true, adds `Content-Language: cs` to the
	// headers — emitted by services/campaigns/content/template.go for
	// every render. Per J3 audit Stage 3 candidate #23: legitimate B2B
	// header but is one of the few tagged identifiers Engine adds that
	// raw bypass omits.
	ContentLanguageCS bool `json:"content_language_cs"`
	// ToneGreeting, when true, prepends a Czech B2B greeting opener to the
	// body BEFORE MIME wrap: "Dobrý den,\n\n". Mirrors
	// services/common/humanize/tone.go GreetingForStep — every Engine send
	// starts with a Tone-rendered greeting line. Sprint M body-composition
	// bisection candidate.
	ToneGreeting bool `json:"tone_greeting"`
	// ToneClosing, when true, appends a Czech B2B closing line to the body
	// BEFORE MIME wrap: "\n\nS pozdravem,". Mirrors
	// services/common/humanize/tone.go ClosingForStep — every Engine send
	// ends with a Tone-rendered closing. Sprint M body-composition
	// bisection candidate.
	ToneClosing bool `json:"tone_closing"`
	// SignatureBlock, when true, appends a static B2B-style signature to the
	// body BEFORE MIME wrap (after ToneClosing if both flags are set):
	//   \n\nA. Mazher\nObchodník\nemail.cz\n+420 ...
	// Mirrors services/common/humanize/signature.go Render output. Sprint M
	// body-composition bisection candidate. Note: real Engine signatures
	// are randomized across multiple variants per VoiceProfile; the
	// diagnostic uses ONE static fixture so the test is byte-deterministic.
	SignatureBlock bool `json:"signature_block"`
	// RestoreDiacritics, when true, runs services/common/humanize.RestoreDiacritics
	// on the body BEFORE MIME wrap. Replaces ~125 canonical Czech words
	// with their diacritic-correct forms (e.g. "vazeny" → "vážený")
	// regardless of input form. Mirrors humanize/engine.go:166-170 (the
	// post-imperfection diacritic-restore pass). Sprint M body-transform
	// bisection candidate.
	RestoreDiacritics bool `json:"restore_diacritics"`
	// RelayBuildMessage, when true, routes the assembled MIME (after all
	// other body / header flags) through `delivery.BuildMessage` from
	// services/relay/internal/delivery — the same wire-format function the
	// production drain (D6) uses. This applies the D5 sanitizeHeaders
	// second pass + Message-ID anonymization + header reorder + the
	// relay-side multipart boundary generator. Sprint M ULTIMATE bisection
	// flag — when ON, the diagnostic exercises the full relay wire-format
	// pipeline, isolating "raw direct SMTP" vs "production drain wire
	// format" as the differentiator.
	RelayBuildMessage bool `json:"relay_build_message"`

	// ─── Sprint F — TBD anti-trace flags (H5, H6, H7, H8, C8, C9, C10, M6, M7, M8) ───
	// Anti-trace pipeline step map SHA c82e95a2 (docs/subsystem-maps/anti-trace.md)

	// H5 date_prague_tz — when true, the Date header is formatted in
	// Europe/Prague local time (`time.Now().In(prague)`) so the wire-MIME
	// carries +0100 (CET) or +0200 (CEST) offset.  When false (default),
	// Date uses UTC ("+0000").  Relevant only for buildPlainMIME and
	// buildMultipartMIME direct paths; buildViaRelayBuildMessage also
	// honours it via the `now` argument.
	DatePragueTZ bool `json:"date_prague_tz"`

	// H6 received_chain_strip — when true, a synthetic "Received: from
	// local by relay; <date>" header is inserted into the headers map
	// BEFORE the sanitizeHeaders / stripPrivacyHeaders pass (D5) so the
	// test proves the strip logic fires.  When false (default), no
	// synthetic Received: header is added.  Effective only for paths that
	// build headers maps (buildViaRelayBuildMessage and the new
	// buildHeadersMap helper used by buildPlainMIME / buildMultipartMIME).
	// Wire-MIME must contain zero "Received:" lines after the send.
	ReceivedChainStrip bool `json:"received_chain_strip"`

	// H7 user_agent_strip — when true, "User-Agent: Go-http-client/1.1" is
	// added to the headers map BEFORE the sanitizeHeaders pass so the test
	// proves that relay D5 strips it.  When false (default), no User-Agent
	// is injected.  Wire-MIME must contain zero "User-Agent:" lines after
	// the send.  Effective in the same paths as H6.
	UserAgentStrip bool `json:"user_agent_strip"`

	// H8 rfc2047_subject_encoding — when true, the Subject header is
	// encoded as RFC 2047 base64: `=?UTF-8?B?<base64>?=`.  When false
	// (default), Subject is emitted as raw UTF-8 8bit.  Subject must
	// contain Czech diacritics to exercise non-ASCII encoding.
	RFC2047SubjectEncoding bool `json:"rfc2047_subject_encoding"`

	// C8 typo_injection — when true, randomly inserts 0–3 commas or
	// periods into the body text (deterministic via env
	// TYPO_INJECT_TEST_SEED when set).  When false (default), body is
	// verbatim.  Applied BEFORE MIME wrap as part of the body-transform
	// pipeline at position 3.5 (after DiacriticsDegrade, before MIME).
	TypoInjection bool `json:"typo_injection"`

	// C9 bump_forward_wrap — when true, wraps the body in a reply-style
	// forward quote: "Re: <subject>\n\n> <original-body>".  Applied BEFORE
	// humanize_light in the pipeline order so the inserted framing also
	// participates in typography substitutions if both flags are ON.
	// When false (default), body is verbatim.
	BumpForwardWrap bool `json:"bump_forward_wrap"`

	// C10 voice_profile_variation — when true, prepends a "Voice:
	// VARIANT_<X>" annotation to the body where X ∈ {A, B, C} is
	// derived deterministically from a SHA-256 hash of the senderFromAddr.
	// When false (default), no annotation is prepended.
	VoiceProfileVariation bool `json:"voice_profile_variation"`

	// M6 header_order — controls the order of wire-MIME headers.
	//   "default"      current order: Date → Message-ID → MIME-Version → X-Mailer → custom
	//   "reverse"      reverses the default priority list
	//   "alphabetical" sorts headers by name (case-insensitive)
	// Empty string / omitted is treated as "default".
	HeaderOrder string `json:"header_order"`

	// M7 boundary_format — controls the multipart boundary string format.
	//   "default"  ----=_Part_<32hex>  (current)
	//   "uuid"     <UUID v4>
	//   "nextpart" _NextPart_<32hex>
	//   "mimepart" _mimepart_<32hex>
	// Only effective when Multipart=true.  Empty string is treated as "default".
	BoundaryFormat string `json:"boundary_format"`

	// M8 content_transfer_encoding_8bit — controls the Content-Transfer-
	// Encoding for the plain-text body part.  When true, force
	// quoted-printable encoding (Content-Transfer-Encoding: quoted-printable).
	// When false (default), use 8bit — the existing pre-Sprint-F behavior.
	// Only effective for non-multipart plain-text messages (Multipart=false).
	//
	// The flag name follows the Q4 catalogue spec; the boolean polarity is
	// inverted (true = QP, false = 8bit) to keep the zero-value as the
	// backward-compatible default.
	ContentTransferEncoding8Bit bool `json:"content_transfer_encoding_8bit"`
}

// rawSMTPTestResponse is the output shape.
//
// `endpoint_label` is the wgpool endpoint that carried the dial (e.g.
// "cz5"). `exit_ip` is unused for now — populating it would require an
// extra ipify hop on the same SOCKS, which would distort the latency
// measurement of the SMTP handshake itself.
type rawSMTPTestResponse struct {
	OK                    bool   `json:"ok"`
	SMTPResponse          string `json:"smtp_response,omitempty"`
	EndpointLabel         string `json:"endpoint_label,omitempty"`
	MessageID             string `json:"message_id,omitempty"`
	LatencyMs             int64  `json:"latency_ms"`
	Error                 string `json:"error,omitempty"`
	EngineMessageID             bool   `json:"engine_messageid"`
	Multipart                   bool   `json:"multipart"`
	HumanizeLight               bool   `json:"humanize_light"`
	DiacriticsDegrade           bool   `json:"diacritics_degrade"`
	SpansInject                 bool   `json:"spans_inject"`
	EngineHTMLWrap              bool   `json:"engine_html_wrap"`
	RedundantDivs               bool   `json:"redundant_divs"`
	EngineFromDisplayName       bool   `json:"engine_from_displayname"`
	XMailerHeader               bool   `json:"xmailer_header"`
	ContentLanguageCS           bool   `json:"content_language_cs"`
	ToneGreeting                bool   `json:"tone_greeting"`
	ToneClosing                 bool   `json:"tone_closing"`
	SignatureBlock               bool   `json:"signature_block"`
	RestoreDiacritics           bool   `json:"restore_diacritics"`
	RelayBuildMessage           bool   `json:"relay_build_message"`
	// Sprint F — TBD flags echo-back
	DatePragueTZ                bool   `json:"date_prague_tz"`
	ReceivedChainStrip          bool   `json:"received_chain_strip"`
	UserAgentStrip              bool   `json:"user_agent_strip"`
	RFC2047SubjectEncoding      bool   `json:"rfc2047_subject_encoding"`
	TypoInjection               bool   `json:"typo_injection"`
	BumpForwardWrap             bool   `json:"bump_forward_wrap"`
	VoiceProfileVariation       bool   `json:"voice_profile_variation"`
	HeaderOrder                 string `json:"header_order"`
	BoundaryFormat              string `json:"boundary_format"`
	ContentTransferEncoding8Bit bool   `json:"content_transfer_encoding_8bit"`
}

// errRawSMTPNoEgress is returned when neither wgpool nor a fallback SOCKS5
// is wired — the relay cannot dial anywhere. Exported (lowercase) so tests
// can sentinel-match instead of string-matching.
var errRawSMTPNoEgress = errors.New("no egress configured (wgpool or fallback SOCKS5 required)")

func (s *Server) handleRawSmtpTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if _, ok := s.requireActor(w, r); !ok {
		return
	}

	var req rawSMTPTestRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, s.maxBodyBytes)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.From == "" || req.Password == "" || req.Recipient == "" || req.Subject == "" || req.Body == "" {
		writeError(w, http.StatusBadRequest, "from, password, recipient, subject, body required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), rawSMTPTestTimeout)
	defer cancel()

	resp := s.runRawSMTPTest(ctx, req)
	writeJSON(w, http.StatusOK, resp)
}

// runRawSMTPTest performs the diagnostic send. Split out from the HTTP
// handler so unit tests can drive it without an http.Server.
func (s *Server) runRawSMTPTest(ctx context.Context, req rawSMTPTestRequest) rawSMTPTestResponse {
	start := time.Now()
	out := rawSMTPTestResponse{
		EngineMessageID:             req.EngineMessageID,
		Multipart:                   req.Multipart,
		HumanizeLight:               req.HumanizeLight,
		DiacriticsDegrade:           req.DiacriticsDegrade,
		SpansInject:                 req.SpansInject,
		EngineHTMLWrap:              req.EngineHTMLWrap,
		RedundantDivs:               req.RedundantDivs,
		EngineFromDisplayName:       req.EngineFromDisplayName,
		XMailerHeader:               req.XMailerHeader,
		ContentLanguageCS:           req.ContentLanguageCS,
		ToneGreeting:                req.ToneGreeting,
		ToneClosing:                 req.ToneClosing,
		SignatureBlock:              req.SignatureBlock,
		RestoreDiacritics:           req.RestoreDiacritics,
		RelayBuildMessage:           req.RelayBuildMessage,
		// Sprint F — TBD flags
		DatePragueTZ:                req.DatePragueTZ,
		ReceivedChainStrip:          req.ReceivedChainStrip,
		UserAgentStrip:              req.UserAgentStrip,
		RFC2047SubjectEncoding:      req.RFC2047SubjectEncoding,
		TypoInjection:               req.TypoInjection,
		BumpForwardWrap:             req.BumpForwardWrap,
		VoiceProfileVariation:       req.VoiceProfileVariation,
		HeaderOrder:                 req.HeaderOrder,
		BoundaryFormat:              req.BoundaryFormat,
		ContentTransferEncoding8Bit: req.ContentTransferEncoding8Bit,
	}

	fqdn := senderFQDN(req.From)
	if fqdn == "" {
		out.Error = "could not extract sender FQDN from from address"
		out.LatencyMs = time.Since(start).Milliseconds()
		return out
	}
	messageID, err := pickMessageID(req, fqdn, time.Now())
	if err != nil {
		out.Error = fmt.Sprintf("build message-id: %v", err)
		out.LatencyMs = time.Since(start).Milliseconds()
		return out
	}
	out.MessageID = messageID

	// Determine the "now" timestamp for Date header.
	// H5 date_prague_tz: when true, format in Europe/Prague TZ so wire-MIME
	// carries +0100/+0200 offset instead of the default +0000 (UTC).
	now := pickNow(req.DatePragueTZ)

	// Body transformation pipeline order (Sprint L+M+F):
	//
	//   1. ToneGreeting prepend ("Dobrý den,\n\n")
	//   2. ToneClosing append ("\n\nS pozdravem,")
	//   3. SignatureBlock append (after closing if both set)
	//   4. RestoreDiacritics (canonical CZ word fix)
	//   5. HumanizeLight typography substitutions (NBSP / em-dash / curly quotes)
	//   6. DiacriticsDegrade (random ASCII fallback)
	//   7. C10 VoiceProfileVariation prepend (annotation before body)
	//   8. C9 BumpForwardWrap (wraps the result in reply-style quote)
	//   9. C8 TypoInjection (inserts 0–3 commas/periods after wrap)
	//
	// Order matters: composition (1-3) BEFORE transforms (4-6) so the
	// inserted greeting/closing/signature participate in restore +
	// degradation passes.  C10 comes before C9 so the voice annotation
	// itself is included in the forward-wrap quote.  C8 typo injection is
	// last so it acts on the final body shape.
	mimeReq := req
	if req.ToneGreeting {
		mimeReq.Body = "Dobrý den,\n\n" + mimeReq.Body
	}
	if req.ToneClosing {
		mimeReq.Body = mimeReq.Body + "\n\nS pozdravem,"
	}
	if req.SignatureBlock {
		mimeReq.Body = mimeReq.Body + signatureFixture(req.From)
	}
	if req.RestoreDiacritics {
		mimeReq.Body = humanize.RestoreDiacritics(mimeReq.Body, 1.0)
	}
	if req.HumanizeLight {
		mimeReq.Body = applyHumanizeLight(mimeReq.Body, loadHumanizeLightSeed())
	}
	if req.DiacriticsDegrade {
		mimeReq.Body = applyDiacriticsDegrade(mimeReq.Body, diacriticsDegradeProb, loadDiacriticsDegradeSeed())
	}
	// Sprint F — C10, C9, C8 applied after existing transforms.
	if req.VoiceProfileVariation {
		mimeReq.Body = applyVoiceProfileVariation(mimeReq.Body, req.From)
	}
	if req.BumpForwardWrap {
		mimeReq.Body = applyBumpForwardWrap(mimeReq.Body, mimeReq.Subject)
	}
	if req.TypoInjection {
		mimeReq.Body = applyTypoInjection(mimeReq.Body, loadTypoInjectSeed())
	}

	mime, err := pickMIME(mimeReq, messageID, now)
	if err != nil {
		out.Error = fmt.Sprintf("build mime: %v", err)
		out.LatencyMs = time.Since(start).Milliseconds()
		return out
	}

	// Pick egress: prefer wgpool (real production rotation, captures label),
	// fall back to single SOCKS5 when pool is unwired (e.g. local dev).
	envelopeID := envelopeIDFromInputs(req.Subject, messageID)

	conn, label, dialErr := s.dialRawSMTP(ctx, envelopeID, "smtp.seznam.cz:587")
	if dialErr != nil {
		out.Error = fmt.Sprintf("dial: %v", dialErr)
		out.EndpointLabel = label
		out.LatencyMs = time.Since(start).Milliseconds()
		return out
	}
	out.EndpointLabel = label
	defer conn.Close()

	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	smtpResp, sendErr := sendRawSMTP(ctx, conn, "smtp.seznam.cz", req, mime)
	out.SMTPResponse = smtpResp
	if sendErr != nil {
		out.Error = sendErr.Error()
		out.LatencyMs = time.Since(start).Milliseconds()
		return out
	}
	out.OK = true
	out.LatencyMs = time.Since(start).Milliseconds()
	return out
}

// dialRawSMTP routes through wgpool when wired (preferred — gives a real
// endpoint label and exercises the production path) and falls back to the
// single SOCKS5 when only fallbackProxyAddr is set. Returns the live conn
// plus the endpoint label.
func (s *Server) dialRawSMTP(ctx context.Context, envelopeID, target string) (net.Conn, string, error) {
	if s.wgPool != nil {
		t := wgpool.NewTransport(s.wgPool, 10*time.Second)
		dialCtx := wgpool.WithRoutingKeys(ctx, envelopeID, "")
		conn, err := t.DialContext(dialCtx, "tcp", target)
		if err != nil {
			return nil, "", err
		}
		return conn, wgpool.EndpointLabelFromConn(conn), nil
	}
	if s.fallbackProxyAddr != "" {
		socks := transport.NewSOCKS5Transport(s.fallbackProxyAddr, 10*time.Second)
		conn, err := socks.DialContext(ctx, "tcp", target)
		if err != nil {
			return nil, "fallback", err
		}
		return conn, "fallback", nil
	}
	return nil, "", errRawSMTPNoEgress
}

// sendRawSMTP performs the EHLO + STARTTLS + AUTH PLAIN + MAIL/RCPT/DATA
// dance using the existing smtp.Client. Mirrors the production path in
// internal/delivery/smtp.go but skips DKIM, sanitization, anti-trace.
//
// ctx is reserved for future per-command timeouts. Today net/smtp has no
// context-aware API; conn.SetDeadline upstream already enforces the wall
// clock budget set by the handler.
func sendRawSMTP(_ context.Context, conn net.Conn, host string, req rawSMTPTestRequest, mime []byte) (string, error) {
	client, err := smtp.NewClient(conn, host)
	if err != nil {
		return "", fmt.Errorf("smtp client: %w", err)
	}
	defer client.Close()

	tlsCfg := transport.SMTPParrotTLS(host)
	if err := client.StartTLS(tlsCfg); err != nil {
		return "", fmt.Errorf("starttls: %w", err)
	}

	auth := smtp.PlainAuth("", req.From, req.Password, host)
	if err := client.Auth(auth); err != nil {
		return "", fmt.Errorf("auth: %w", err)
	}

	if err := client.Mail(req.From); err != nil {
		return "", fmt.Errorf("mail from: %w", err)
	}
	if err := client.Rcpt(req.Recipient); err != nil {
		return "", fmt.Errorf("rcpt to: %w", err)
	}

	wc, err := client.Data()
	if err != nil {
		return "", fmt.Errorf("data: %w", err)
	}
	if _, err := wc.Write(mime); err != nil {
		_ = wc.Close()
		return "", fmt.Errorf("write: %w", err)
	}
	if err := wc.Close(); err != nil {
		// net/smtp returns the server's response in the error string when DATA
		// is rejected — preserve it verbatim for the diagnostic caller.
		return err.Error(), fmt.Errorf("data close: %w", err)
	}
	// ctx already drove conn.SetDeadline upstream; net/smtp has no per-cmd ctx.
	if err := client.Quit(); err != nil {
		// QUIT failure is non-fatal — message was already accepted.
		return "250 OK (quit error: " + err.Error() + ")", nil
	}
	return "250 OK", nil
}

// buildPlainMIME builds the minimal RFC 5322 message:
//
//   - text/plain; charset=utf-8
//   - Content-Transfer-Encoding: 8bit (default) or quoted-printable (M8=false)
//   - no X-Mailer, no anti-trace headers, no multipart
//
// The goal is byte-shape parity with `smtplib` raw send so that any
// Railway-vs-local delivery delta cannot be blamed on MIME structure.
//
// H5 date_prague_tz is honoured via the `now` parameter (caller sets TZ).
// H6 received_chain_strip and H7 user_agent_strip are handled via
// the stripTestHeaders helper applied inside this function when the
// diagnostic injects those headers before MIME assembly.
// H8 rfc2047_subject_encoding and M6 header_order affect header emission.
// M8 content_transfer_encoding_8bit controls CTE for the body part.
func buildPlainMIME(req rawSMTPTestRequest, messageID string, now time.Time) []byte {
	var b strings.Builder
	writeFromHeader(&b, req)
	// Build structured headers list for M6 header_order support.
	hdrs := buildDirectHeaders(req, messageID, now)
	writeMIMEHeaders(&b, hdrs, req.HeaderOrder)
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	// M8: false (default/zero-value) → 8bit (existing behavior, backward-compat).
	//     true → quoted-printable.
	if req.ContentTransferEncoding8Bit {
		b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n")
		b.WriteString("\r\n")
		b.WriteString(encodeQuotedPrintable(req.Body))
	} else {
		b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
		b.WriteString("\r\n")
		b.WriteString(req.Body)
		if !strings.HasSuffix(req.Body, "\r\n") {
			b.WriteString("\r\n")
		}
	}
	return []byte(b.String())
}

// writeFromHeader emits the `From:` header. Default = bare email
// (`From: a.mazher@email.cz`). When EngineFromDisplayName=true, derives
// `"Display Name" <email>` from the email local part via title-case
// (mirrors services/campaigns/sender/headers.go BuildFromHeader +
// titleCaseLocalPart). RFC 5322 §3.4 mailbox production.
func writeFromHeader(b *strings.Builder, req rawSMTPTestRequest) {
	b.WriteString("From: ")
	if req.EngineFromDisplayName {
		display := titleCaseLocalPartDiag(req.From)
		if display != "" {
			b.WriteString("\"")
			b.WriteString(display)
			b.WriteString("\" <")
			b.WriteString(req.From)
			b.WriteString(">")
		} else {
			b.WriteString(req.From)
		}
	} else {
		b.WriteString(req.From)
	}
	b.WriteString("\r\n")
}

// titleCaseLocalPartDiag derives a display name from an email local part.
// "a.mazher@example.com" → "A. Mazher". Matches the heuristic in
// services/campaigns/sender/headers.go titleCaseLocalPart but inlined to
// avoid a cross-package import (the diagnostic is intentionally relay-
// internal). Returns "" when the local part is empty or the address has
// no "@".
func titleCaseLocalPartDiag(email string) string {
	at := strings.LastIndex(email, "@")
	if at <= 0 {
		return ""
	}
	local := email[:at]
	parts := strings.Split(local, ".")
	for i, p := range parts {
		if p == "" {
			continue
		}
		runes := []rune(p)
		runes[0] = unicodeToUpperASCII(runes[0])
		parts[i] = string(runes)
	}
	return strings.Join(parts, ". ")
}

// unicodeToUpperASCII upper-cases an ASCII letter only (avoids the
// Czech-locale folding edge cases of unicode.ToUpper). Non-ASCII runes
// pass through unchanged.
func unicodeToUpperASCII(r rune) rune {
	if r >= 'a' && r <= 'z' {
		return r - 'a' + 'A'
	}
	return r
}

// pickMIME dispatches on req.Multipart. Default → buildPlainMIME (single
// text/plain part, byte-shape parity with smtplib). Multipart branch
// builds RFC 2046 multipart/alternative with text/plain THEN text/html
// (per RFC: "least rich first") so a recipient that only displays
// plain text falls through to the same content.
//
// Sprint I2: A/B test whether Seznam tolerates minimal multipart
// structure better than flat text/plain. Real B2B email is rarely
// flat text/plain; flat-only may itself be a low-grade spam signal.
//
// Sprint F M7: boundary_format controls the boundary token shape.
func pickMIME(req rawSMTPTestRequest, messageID string, now time.Time) ([]byte, error) {
	if req.RelayBuildMessage {
		return buildViaRelayBuildMessage(req, messageID, now), nil
	}
	if !req.Multipart {
		return buildPlainMIME(req, messageID, now), nil
	}
	boundary, err := pickBoundary(req.BoundaryFormat)
	if err != nil {
		return nil, fmt.Errorf("boundary: %w", err)
	}
	return buildMultipartMIME(req, messageID, now, boundary), nil
}

// buildViaRelayBuildMessage assembles the MIME via relay's production
// `delivery.BuildMessage` — the same wire-format function the production
// drain (D6) uses. This applies the D5 sanitizeHeaders second pass +
// Message-ID anonymization + header reorder + the relay-side multipart
// boundary generator. Used by sprint M ULTIMATE bisection flag.
//
// Header construction mirrors what the relay sees from antitrace.Submit:
// caller supplies From/To/Subject implicitly via BuildMessage's first
// two args, plus a headers map containing the optional X-Mailer /
// Content-Language / Date / Message-ID emitted by the toggle flags.
//
// Sprint F:
//   - H6 received_chain_strip: injects a synthetic Received: header that
//     relay D5 stripPrivacyHeaders will strip (test that strip fires).
//   - H7 user_agent_strip: injects User-Agent: Go-http-client/1.1 that
//     relay D5 stripPrivacyHeaders will strip.
//   - H8 rfc2047_subject_encoding: encodes the subject before passing.
func buildViaRelayBuildMessage(req rawSMTPTestRequest, messageID string, now time.Time) []byte {
	headers := map[string]string{
		"Date":         now.Format(time.RFC1123Z),
		"Message-ID":   messageID,
		"MIME-Version": "1.0",
	}
	if req.XMailerHeader {
		headers["X-Mailer"] = "Seznam.cz"
	}
	if req.ContentLanguageCS {
		headers["Content-Language"] = "cs"
	}
	// H6: inject synthetic Received: — sanitizeHeaders will strip it.
	if req.ReceivedChainStrip {
		headers["Received"] = "from local by relay; " + now.Format(time.RFC1123Z)
	}
	// H7: inject User-Agent — sanitizeHeaders will strip it.
	if req.UserAgentStrip {
		headers["User-Agent"] = "Go-http-client/1.1"
	}
	from := req.From
	if req.EngineFromDisplayName {
		if display := titleCaseLocalPartDiag(req.From); display != "" {
			from = "\"" + display + "\" <" + req.From + ">"
		}
	}
	subject := req.Subject
	if req.RFC2047SubjectEncoding {
		subject = encodeSubjectRFC2047(subject)
	}
	bodyHTML := ""
	if req.Multipart {
		bodyHTML = buildHTMLBody(req)
	}
	return delivery.BuildMessage(from, []string{req.Recipient}, subject, req.Body, bodyHTML, headers)
}

// signatureFixture returns a static B2B signature block for the diagnostic.
// Real Engine signatures (services/common/humanize/signature.go) are
// randomized across multiple variants per VoiceProfile; the diagnostic
// uses ONE fixture so the test is byte-deterministic. Local part of the
// from-address is title-cased into the rendered name for plausibility.
func signatureFixture(fromAddr string) string {
	name := titleCaseLocalPartDiag(fromAddr)
	if name == "" {
		name = "Obchodník"
	}
	return "\n\n" + name + "\nObchodní zástupce\n+420 777 123 456\nwww.email.cz"
}

// buildMultipartMIME builds an RFC 2046 multipart/alternative message:
//
//   - top-level Content-Type: multipart/alternative; boundary="…"
//   - Part 1: text/plain; charset=utf-8; 8bit (body verbatim)
//   - Part 2: text/html; charset=utf-8; 8bit (HTML-escaped body,
//     CRLF→<br/> conversion, wrapped in minimal `<!DOCTYPE html>...`)
//
// Body is appended to text/plain part with trailing CRLF normalization
// matching the buildPlainMIME contract. HTML part wraps the escaped body
// in a single <p> with newlines preserved as <br/> so the visual result
// is the same as the plain part (no formatting drift between alternatives).
//
// H5/H6/H7/H8/M6 flags are honoured via buildDirectHeaders + writeMIMEHeaders.
// M7 boundary_format is honoured by the `boundary` argument (caller picks format).
func buildMultipartMIME(req rawSMTPTestRequest, messageID string, now time.Time, boundary string) []byte {
	var b strings.Builder
	writeFromHeader(&b, req)
	hdrs := buildDirectHeaders(req, messageID, now)
	writeMIMEHeaders(&b, hdrs, req.HeaderOrder)
	b.WriteString("Content-Type: multipart/alternative; boundary=\"")
	b.WriteString(boundary)
	b.WriteString("\"\r\n")
	b.WriteString("\r\n")

	// Part 1 — text/plain (least rich first per RFC 2046).
	b.WriteString("--")
	b.WriteString(boundary)
	b.WriteString("\r\n")
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	b.WriteString("\r\n")
	b.WriteString(req.Body)
	if !strings.HasSuffix(req.Body, "\r\n") {
		b.WriteString("\r\n")
	}

	// Part 2 — text/html.
	b.WriteString("--")
	b.WriteString(boundary)
	b.WriteString("\r\n")
	b.WriteString("Content-Type: text/html; charset=utf-8\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	b.WriteString("\r\n")
	b.WriteString(buildHTMLBody(req))
	b.WriteString("\r\n")

	// Closing boundary.
	b.WriteString("--")
	b.WriteString(boundary)
	b.WriteString("--\r\n")
	return []byte(b.String())
}

// buildHTMLBody returns the text/html body content. Defaults to the
// minimal `<!DOCTYPE html><html><body><p>...</p></body></html>` shape
// (back-compat with sprints I0–I5). When EngineHTMLWrap=true, switches
// to the Fingerprint engine wrap from
// services/common/humanize/fingerprint.go: `<html><head><meta>...</head>
// <body><div style="font-family: Arial, ..." font-size:14px;">...</div>
// </body></html>` with optional per-line span injection (SpansInject)
// and 20%-prob redundant `<div>&nbsp;</div>` after empty lines
// (RedundantDivs).
//
// SpansInject is honored in BOTH modes — for the minimal `<p>` mode it
// applies per-line span wrapping inside the <p>. For the Engine wrap
// mode it integrates with the lines/<br> structure.
func buildHTMLBody(req rawSMTPTestRequest) string {
	if req.EngineHTMLWrap {
		return buildEngineHTMLWrap(req)
	}
	if req.SpansInject {
		return "<!DOCTYPE html><html><body><p>" +
			buildSpansInjectHTMLBody(req.Body, spansInjectProb, loadSpansInjectSeed()) +
			"</p></body></html>"
	}
	return "<!DOCTYPE html><html><body><p>" + escapeHTMLBody(req.Body) + "</p></body></html>"
}

// buildEngineHTMLWrap mirrors services/common/humanize/fingerprint.go
// WrapBodyHTML — `<html><head><meta charset="utf-8"></head><body><div
// style="font-family: Arial, sans-serif; font-size: 14px;">...</div>
// </body></html>` — one rendering option per line:
//
//   - Empty line → `<br>` (and optional `<div>&nbsp;</div>` if
//     RedundantDivs and the coin flips heads at 20%)
//   - Non-empty line → either bare-escaped + `<br>`, or wrapped in
//     `<span style="font-size:Npx;">...</span><br>` when SpansInject
//     coin flips heads at 30%
//
// Stochastic via crypto/rand; reuses SPANS_INJECT_TEST_SEED for both
// span and div coin flippers (deterministic in tests).
func buildEngineHTMLWrap(req rawSMTPTestRequest) string {
	var b strings.Builder
	b.WriteString(`<html><head><meta charset="utf-8"></head><body>`)
	b.WriteString(`<div style="font-family: Arial, sans-serif; font-size: 14px;">`)
	seed := loadSpansInjectSeed()
	spanFlip := newCoinFlipper(spansInjectProb, seed)
	divFlip := newCoinFlipper(0.20, seed)
	fontPicker := newFontSizePicker(seed)
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(req.Body, "\r\n", "\n"), "\r", "\n"), "\n")
	for i, line := range lines {
		if line == "" {
			b.WriteString("<br>")
			if req.RedundantDivs && i > 0 && i < len(lines)-1 && divFlip() {
				b.WriteString("<div>&nbsp;</div>")
			}
			continue
		}
		if req.SpansInject && spanFlip() {
			fmt.Fprintf(&b, `<span style="font-size: %dpx;">`, fontPicker())
			b.WriteString(escapeHTMLBody(line))
			b.WriteString("</span><br>")
		} else {
			b.WriteString(escapeHTMLBody(line))
			b.WriteString("<br>")
		}
	}
	b.WriteString("</div></body></html>")
	return b.String()
}

// escapeHTMLBody escapes the five HTML special characters (& < > " ')
// then converts newlines to <br/>. Order matters: amp must run first so
// subsequent entities don't get double-escaped.
//
// Newline handling: CRLF, LF, and CR are all collapsed to a single <br/>
// so the visual rendering of the HTML part matches the plain part for
// any input line-ending convention.
func escapeHTMLBody(s string) string {
	// Normalize line endings to LF first (CRLF → LF, lone CR → LF) so
	// the entity replacer below sees a single newline form.
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		"\"", "&quot;",
		"'", "&#39;",
		"\n", "<br/>",
	)
	return r.Replace(s)
}

// freshBoundary returns an RFC 2046 boundary token of the form
// `----=_Part_<32-hex>` — the leading dashes guarantee the boundary is
// not a valid line in any RFC 5322 header or text/plain body (no
// header line ever begins with `--`). The 32 hex chars are
// crypto/rand so collisions across requests are statistically impossible.
func freshBoundary() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "----=_Part_" + hex.EncodeToString(buf[:]), nil
}

// buildMessageID returns an RFC 5322 Message-Id of the form
// `<<16-hex>@fqdn>` where the 16 hex chars are crypto/rand. The brackets
// are part of the value (per the RFC), the surrounding `<>` is the
// msg-id production.
func buildMessageID(fqdn string) (string, error) {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return fmt.Sprintf("<%s@%s>", hex.EncodeToString(buf), fqdn), nil
}

// senderFQDN extracts the FQDN from `local@fqdn`. Returns empty when the
// input is not a single-@ address.
func senderFQDN(addr string) string {
	at := strings.LastIndex(addr, "@")
	if at < 1 || at == len(addr)-1 {
		return ""
	}
	return addr[at+1:]
}

// envelopeIDFromInputs derives a stable routing key from the inputs the
// caller controls — same input → same wgpool endpoint pick. This makes
// repeated diagnostic sends idempotent w.r.t. endpoint selection so the
// operator can correlate label ↔ delivery outcome.
func envelopeIDFromInputs(subject, messageID string) string {
	h := sha256.New()
	h.Write([]byte(subject))
	h.Write([]byte{0x00})
	h.Write([]byte(messageID))
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// pickMessageID dispatches on req.EngineMessageID. Default branch is the
// legacy `<{16-hex}@{fqdn}>` random shape. Engine branch builds the same
// shape as services/campaigns/sender BuildMessageIDHeader:
// `<{16-hex}.{nanos}@{fqdn}>` where {16-hex} = HMAC-SHA256(recipient ||
// envelopeID, key)[:8] hex.
//
// Sprint I1 uses this dispatch to A/B test whether the Seznam ML detector
// fingerprints the HMAC dot-nanos shape independently of MIME content.
// If both shapes deliver, the HMAC format is innocent. If only the
// random shape delivers, headers.go format is the trigger.
//
// On HMAC key absent / too short, falls back to random — fail-open per
// the same defence-in-depth rule as Engine.BuildMessageIDHeader.
func pickMessageID(req rawSMTPTestRequest, fqdn string, now time.Time) (string, error) {
	if !req.EngineMessageID {
		return buildMessageID(fqdn)
	}
	key := loadEngineHMACKey()
	if len(key) == 0 {
		// Fallback: random. Caller still gets a working diagnostic.
		return buildMessageID(fqdn)
	}
	envelopeID, err := freshEnvelopeID()
	if err != nil {
		return "", err
	}
	return buildEngineMessageID(req.Recipient, envelopeID, fqdn, key, now), nil
}

// buildEngineMessageID is a verbatim port of
// services/campaigns/sender.BuildMessageIDHeader. Kept here (not imported)
// so the relay stays a leaf with no campaigns dependency — every line
// matches headers.go:66-85 so a Seznam-side fingerprint of the Engine
// shape sees an identical wire format.
func buildEngineMessageID(recipient, envelopeID, fqdn string, hmacKey []byte, now time.Time) string {
	domain := fqdn
	if domain == "" {
		domain = "alias.local"
	}
	h := hmac.New(sha256.New, hmacKey)
	h.Write([]byte(recipient))
	h.Write([]byte(envelopeID))
	digest := h.Sum(nil)
	hexed := hex.EncodeToString(digest[:8]) // 16 hex chars, matches Engine
	return fmt.Sprintf("<%s.%d@%s>", hexed, now.UnixNano(), domain)
}

// freshEnvelopeID returns a 32-hex random envelope id used as input to
// the Engine HMAC. Mirrors generateEnvelopeID in the sender package.
func freshEnvelopeID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("envelope id: %w", err)
	}
	return hex.EncodeToString(buf[:]), nil
}

// ─── humanize-light char-level substitutions (sprint I3) ──────────

// humanizeLightSpaceProb is the fraction of ASCII spaces converted to
// non-breaking space (U+00A0). 0.30 ≈ same density that Word/Outlook
// auto-correct introduces in real B2B mail (heuristic from sampled
// corpus, not a tuned magic number).
const humanizeLightSpaceProb = 0.30

// applyHumanizeLight applies three SAFE char-level substitutions to s:
//
//  1. " - " (ASCII space + hyphen + space) → " — " (em-dash, U+2014)
//  2. "…" straight ASCII double quotes → curly "…" (U+201C / U+201D)
//     paired in document order: 1st becomes opening, 2nd closing, etc.
//  3. ~30% of remaining ASCII spaces → non-breaking space (U+00A0)
//
// Order matters: em-dash and quote substitutions run BEFORE the space
// substitution so the spaces flanking " — " and " between quote runs
// can themselves be NBSP-converted (matches what Word does — typography
// auto-correct first, NBSP second).
//
// Diacritics, newlines, and all non-targeted characters are preserved
// verbatim. Empty input returns empty output (no-op).
//
// seed controls the NBSP probabilistic conversion. Pass 0 for
// crypto-strong randomness (production diagnostic); pass non-zero for
// deterministic test output. The first two substitutions are pure
// string ops and ignore the seed — they're already deterministic.
func applyHumanizeLight(s string, seed int64) string {
	if s == "" {
		return s
	}
	s = substituteEmDash(s)
	s = substituteCurlyQuotes(s)
	s = substituteNBSP(s, humanizeLightSpaceProb, seed)
	return s
}

// substituteEmDash replaces " - " patterns with " — " (em-dash, U+2014).
// The flanking spaces are preserved as ASCII so the subsequent NBSP pass
// can decide whether to upgrade them. Replaces ALL occurrences (real B2B
// mail rarely has more than one or two per paragraph; idempotency over
// chunking matters more than partial-replacement aesthetics).
func substituteEmDash(s string) string {
	return strings.ReplaceAll(s, " - ", " — ")
}

// substituteCurlyQuotes pairs ASCII double-quote characters in document
// order: 1st → U+201C (opening curly), 2nd → U+201D (closing curly),
// 3rd → U+201C, etc. Odd trailing quotes (unbalanced source) are left
// as opening curly so the visible orientation still hints at quotation.
//
// Single quotes (apostrophes) are NOT touched — Czech apostrophe usage
// is rare and replacing them risks breaking abbreviations like "s.r.o.".
func substituteCurlyQuotes(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	open := true
	for _, r := range s {
		if r == '"' {
			if open {
				b.WriteRune('“')
			} else {
				b.WriteRune('”')
			}
			open = !open
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// substituteNBSP converts a fraction (≈prob) of ASCII space runes to
// non-breaking space (U+00A0). Operates rune-by-rune so multibyte
// sequences (em-dash from substituteEmDash, curly quotes, diacritics)
// are preserved untouched.
//
// seed=0 → crypto/rand bytes drive the per-space coin flip.
// seed!=0 → math/rand seeded for deterministic test output.
//
// Probability is exact-fraction over the population: e.g. for 100 spaces
// at prob=0.30 the seeded run produces ~30 conversions (binomial mean).
// We do NOT enforce "exactly N" since real auto-correct is also
// stochastic; deterministic-counts would itself be a fingerprint.
func substituteNBSP(s string, prob float64, seed int64) string {
	if prob <= 0 || s == "" {
		return s
	}
	flip := newCoinFlipper(prob, seed)
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r == ' ' && flip() {
			b.WriteRune(' ')
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// newCoinFlipper returns a function that, on each call, returns true with
// approximately the given probability. Seeded math/rand when seed != 0
// (deterministic for tests), crypto/rand otherwise.
//
// The crypto path generates one 8-byte chunk per 8 calls (amortized
// cost — coin flips are O(1) average).
func newCoinFlipper(prob float64, seed int64) func() bool {
	threshold := uint64(prob * float64(1<<32))
	if seed != 0 {
		// Deterministic path — math/rand seeded with caller-supplied seed.
		// G404 (weak rand) is acceptable here: this is a presentation-
		// layer typography flip, NOT a security primitive.
		r := mathrand.New(mathrand.NewSource(seed)) //nolint:gosec
		return func() bool {
			return uint64(r.Uint32()) < threshold
		}
	}
	// Crypto path — fill an 8-byte buffer, slice into 4-byte uint32 windows
	// so each coin flip costs negligibly more than the seeded path.
	var buf [8]byte
	idx := 8 // force refill on first call
	return func() bool {
		if idx >= 8 {
			if _, err := rand.Read(buf[:]); err != nil {
				// Defence-in-depth: fall back to "no conversion" so a
				// crypto/rand outage doesn't crash the diagnostic.
				return false
			}
			idx = 0
		}
		v := binary.BigEndian.Uint32(buf[idx : idx+4])
		idx += 4
		return uint64(v) < threshold
	}
}

// loadHumanizeLightSeed reads HUMANIZE_LIGHT_TEST_SEED. When set to a
// parseable int64, the NBSP coin-flipper becomes deterministic — used
// by tests + operator A/B replays. Returns 0 (= crypto path) when unset
// or undecodable.
//
// Diagnostic-scoped: not boot-validated. Production callers leave it
// unset; tests use t.Setenv to drive deterministic output.
func loadHumanizeLightSeed() int64 {
	// envconfig-allowed: diagnostic-only seed; no boot-time validation needed (set per-test via t.Setenv, absent in production).
	raw := strings.TrimSpace(os.Getenv("HUMANIZE_LIGHT_TEST_SEED"))
	if raw == "" {
		return 0
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0
	}
	return v
}

// ─── diacritics random-degrade (sprint I4) ───────────────────────

// diacriticsDegradeProb is the per-character replacement probability for
// the diacritics_degrade pipeline stage. 0.30 matches the specification
// in the I4 sprint plan and produces a visibly inconsistent paragraph
// (some words keep diacritics, some lose them, some are mid-word mixed).
const diacriticsDegradeProb = 0.30

// diacriticsDegradeMap maps every Czech diacritic rune to its closest
// ASCII equivalent. Mirrors the production map at
// services/common/humanize/imperfect.go:135-142 verbatim — keeping the
// data in two places is intentional: the relay must not import the
// campaigns/common humanize package (relay is a stdlib-only leaf in the
// dependency graph). Any drift between the two maps is caught by the
// TestApplyDiacriticsDegrade_MapMatchesH1Source ratchet test.
var diacriticsDegradeMap = map[rune]rune{
	'á': 'a', 'č': 'c', 'ď': 'd', 'é': 'e', 'ě': 'e',
	'í': 'i', 'ň': 'n', 'ó': 'o', 'ř': 'r', 'š': 's',
	'ť': 't', 'ú': 'u', 'ů': 'u', 'ý': 'y', 'ž': 'z',
	'Á': 'A', 'Č': 'C', 'Ď': 'D', 'É': 'E', 'Ě': 'E',
	'Í': 'I', 'Ň': 'N', 'Ó': 'O', 'Ř': 'R', 'Š': 'S',
	'Ť': 'T', 'Ú': 'U', 'Ů': 'U', 'Ý': 'Y', 'Ž': 'Z',
}

// applyDiacriticsDegrade walks `s` rune-by-rune. For each rune that is a
// Czech diacritic, it flips a `prob`-weighted coin: heads → replace with
// the ASCII equivalent (e.g. 'á' → 'a'), tails → keep verbatim. All
// non-diacritic runes (ASCII letters, punctuation, multibyte typography
// chars like U+2014 em-dash and U+201C curly quote, control chars,
// emoji) are passed through untouched.
//
// Capitalization is preserved by the map ('Á' → 'A', not 'a'); each
// uppercase glyph has a dedicated entry.
//
// seed=0 → crypto/rand drives the coin flip (production behavior).
// seed!=0 → math/rand seeded for deterministic test output. Reuses the
// same newCoinFlipper helper as the I3 humanize_light pipeline, so the
// coin distribution is identical and the operator can substitute one
// seed for another in a controlled experiment.
//
// Empty input returns empty output (no-op). prob<=0 returns input
// verbatim (defense-in-depth — a misconfigured probability must not
// silently mutate the body).
func applyDiacriticsDegrade(s string, prob float64, seed int64) string {
	if s == "" || prob <= 0 {
		return s
	}
	flip := newCoinFlipper(prob, seed)
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if ascii, ok := diacriticsDegradeMap[r]; ok {
			if flip() {
				b.WriteRune(ascii)
				continue
			}
		}
		b.WriteRune(r)
	}
	return b.String()
}

// loadDiacriticsDegradeSeed reads DIACRITICS_DEGRADE_TEST_SEED. When set
// to a parseable int64, the per-character coin-flipper becomes
// deterministic — used by tests + operator A/B replays. Returns 0
// (= crypto path) when unset or undecodable.
//
// Diagnostic-scoped: not boot-validated. Production callers leave it
// unset; tests use t.Setenv to drive deterministic output.
func loadDiacriticsDegradeSeed() int64 {
	// envconfig-allowed: diagnostic-only seed; no boot-time validation needed (set per-test via t.Setenv, absent in production).
	raw := strings.TrimSpace(os.Getenv("DIACRITICS_DEGRADE_TEST_SEED"))
	if raw == "" {
		return 0
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0
	}
	return v
}

// ─── span injection — per-line HTML structure churn (sprint I5) ──

// spansInjectProb is the per-line probability of wrapping the escaped
// line content in a `<span style="font-size:Npx">...</span>` envelope.
// 0.30 mirrors the corresponding constant in
// services/common/humanize/fingerprint.go:67-76 — kept literal here so
// the relay stays a stdlib-only leaf without a humanize import.
const spansInjectProb = 0.30

// spansInjectFontSizes lists the candidate font-size values (in px)
// for the span wrapper. Uniform pick across {13, 14, 15} mirrors the
// production fingerprint: `13 + randMinute(0,3)` over {0,1,2} = {13,14,15}.
// Keep as a fixed-length array so the picker can index into it without
// re-constructing per call.
var spansInjectFontSizes = [3]int{13, 14, 15}

// buildSpansInjectHTMLBody converts plain-text body s into HTML body
// content (the inside of the `<p>...</p>` envelope) with per-line
// random span injection. Each non-empty line independently flips a
// `prob`-weighted coin: heads → wrap escaped line in
// `<span style="font-size:Npx">...</span>` (N uniform from {13,14,15}),
// tails → emit escaped line verbatim. Lines are joined by `<br/>`.
//
// Empty lines produce no content (just the `<br/>` separator), matching
// the canonical fingerprint.go:62-65 short-circuit behavior. The
// resulting content is appended after `<!DOCTYPE html><html><body><p>`
// and before `</p></body></html>` by the caller.
//
// HTML escaping runs on the line content BEFORE wrapping so the span
// tags themselves are never entity-encoded — they are intentional HTML
// structure, not literal text. CRLF and lone CR are normalized to LF
// before splitting (parity with escapeHTMLBody).
//
// seed=0 → crypto/rand drives the coin flips and font-size picks.
// seed!=0 → math/rand seeded for deterministic test output. Reuses the
// newCoinFlipper helper from the I3/I4 pipeline so the coin-flip
// distribution is identical across the three diagnostic stages.
//
// Empty input returns empty output (no-op). prob<=0 returns the body
// with HTML escape but NO span wrapping — defense-in-depth so a
// misconfigured probability still produces valid HTML.
func buildSpansInjectHTMLBody(s string, prob float64, seed int64) string {
	if s == "" {
		return ""
	}
	// Normalize line endings (parity with escapeHTMLBody).
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	lines := strings.Split(s, "\n")

	flip := newCoinFlipper(prob, seed)
	pickFontSize := newFontSizePicker(seed)

	// Per-rune escape of one line — same set as escapeHTMLBody minus the
	// `\n → <br/>` step (we handle line breaks explicitly via Join below).
	escapeLine := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		"\"", "&quot;",
		"'", "&#39;",
	)

	var b strings.Builder
	b.Grow(len(s) + 64)
	for i, line := range lines {
		if i > 0 {
			b.WriteString("<br/>")
		}
		if line == "" {
			// Empty line: no inner content, just contribute the `<br/>`
			// separator above. Mirrors fingerprint.go's short-circuit.
			continue
		}
		escaped := escapeLine.Replace(line)
		if prob > 0 && flip() {
			fontSize := pickFontSize()
			b.WriteString(`<span style="font-size:`)
			b.WriteString(strconv.Itoa(fontSize))
			b.WriteString(`px">`)
			b.WriteString(escaped)
			b.WriteString(`</span>`)
			continue
		}
		b.WriteString(escaped)
	}
	return b.String()
}

// newFontSizePicker returns a function that, on each call, returns one
// of {13, 14, 15} uniformly. seed=0 → crypto/rand bytes; seed!=0 →
// math/rand seeded for deterministic test output.
//
// Distinct from newCoinFlipper because the latter returns bool — we
// need a 3-way pick here. Implementation refills an 8-byte buffer in
// 4-byte windows so each pick costs O(1) amortized (same trick as
// newCoinFlipper).
func newFontSizePicker(seed int64) func() int {
	if seed != 0 {
		// Deterministic path. G404 (weak rand) is acceptable here:
		// presentation-layer font-size pick, NOT a security primitive.
		// XOR with a fixed offset so the picker's pseudo-random stream
		// doesn't trivially align with the coin flipper's stream when
		// the same seed drives both.
		r := mathrand.New(mathrand.NewSource(seed ^ 0x5A5A5A5A5A5A5A5A)) //nolint:gosec
		return func() int {
			return spansInjectFontSizes[r.Uint32()%uint32(len(spansInjectFontSizes))]
		}
	}
	var buf [8]byte
	idx := 8
	return func() int {
		if idx >= 8 {
			if _, err := rand.Read(buf[:]); err != nil {
				// Defence-in-depth: fall back to the median size so a
				// crypto/rand outage doesn't crash the diagnostic.
				return spansInjectFontSizes[1]
			}
			idx = 0
		}
		v := binary.BigEndian.Uint32(buf[idx : idx+4])
		idx += 4
		return spansInjectFontSizes[v%uint32(len(spansInjectFontSizes))]
	}
}

// loadSpansInjectSeed reads SPANS_INJECT_TEST_SEED. When set to a
// parseable int64, the per-line coin-flipper + font-size picker
// become deterministic — used by tests + operator A/B replays.
// Returns 0 (= crypto path) when unset or undecodable.
//
// Diagnostic-scoped: not boot-validated. Production callers leave it
// unset; tests use t.Setenv to drive deterministic output.
func loadSpansInjectSeed() int64 {
	// envconfig-allowed: diagnostic-only seed; no boot-time validation needed (set per-test via t.Setenv, absent in production).
	raw := strings.TrimSpace(os.Getenv("SPANS_INJECT_TEST_SEED"))
	if raw == "" {
		return 0
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0
	}
	return v
}

// loadEngineHMACKey reads MESSAGE_ID_HMAC_KEY (base64-encoded 32-byte
// value, same env var as Engine.WithMessageIDHMACKey). Returns nil when
// unset, empty, or undecodable — the caller falls back to random.
//
// Diagnostic-scoped: the relay does not boot-validate this var because
// engine_messageid=true is operator-driven and rare. The Engine boot
// path still validates ≥32 bytes; this helper accepts any non-empty
// length to keep the diagnostic flexible.
func loadEngineHMACKey() []byte {
	// envconfig-allowed: shared with relay boot config; reading via os.Getenv here keeps the diag endpoint loosely coupled (boot path is the canonical loader and validates presence).
	raw := strings.TrimSpace(os.Getenv("MESSAGE_ID_HMAC_KEY"))
	if raw == "" {
		return nil
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil
	}
	return decoded
}

// ─── Sprint F — TBD anti-trace helpers ────────────────────────────────────
// Anti-trace pipeline step map SHA c82e95a2 (docs/subsystem-maps/anti-trace.md)

// ─── H5: date_prague_tz ───────────────────────────────────────────────────

// pragueLocation is loaded once at init time; if the tz database is
// unavailable (stripped binary) we fall back to a fixed +0100 offset
// which keeps tests passing without a full tz database.
var pragueLocation = func() *time.Location {
	loc, err := time.LoadLocation("Europe/Prague")
	if err != nil {
		// Fallback: CET +0100 (safe for test environments without tzdata).
		loc = time.FixedZone("CET", 3600)
	}
	return loc
}()

// pickNow returns the current time in Europe/Prague when datePragueTZ is
// true; otherwise returns time.Now().UTC(). Used to set the Date header
// so the wire-MIME carries +0100/+0200 (Prague) or +0000 (UTC).
func pickNow(datePragueTZ bool) time.Time {
	if datePragueTZ {
		return time.Now().In(pragueLocation)
	}
	return time.Now().UTC()
}

// ─── H8: rfc2047_subject_encoding ────────────────────────────────────────

// encodeSubjectRFC2047 encodes the subject string as RFC 2047 base64:
// `=?UTF-8?B?<base64(s)>?=`. The entire string is encoded regardless of
// whether it is ASCII-only — this mirrors what many CZ webmail clients emit
// when they do not first check whether encoding is necessary.
func encodeSubjectRFC2047(s string) string {
	if s == "" {
		return s
	}
	return "=?UTF-8?B?" + base64.StdEncoding.EncodeToString([]byte(s)) + "?="
}

// ─── M7: boundary_format ─────────────────────────────────────────────────

// pickBoundary returns a fresh boundary token in the requested format.
//
//   "default"  ----=_Part_<32hex>      (existing freshBoundary behavior)
//   "uuid"     <UUID v4 format>
//   "nextpart" _NextPart_<32hex>
//   "mimepart" _mimepart_<32hex>
//
// Empty / unrecognised values fall back to "default".
func pickBoundary(format string) (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	hexStr := hex.EncodeToString(buf[:])
	switch format {
	case "uuid":
		// UUID v4 shape: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
		// We set the version (4) and variant (10) bits on the random bytes.
		buf[6] = (buf[6] & 0x0f) | 0x40
		buf[8] = (buf[8] & 0x3f) | 0x80
		return fmt.Sprintf("%x-%x-%x-%x-%x",
			buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16]), nil
	case "nextpart":
		return "_NextPart_" + hexStr, nil
	case "mimepart":
		return "_mimepart_" + hexStr, nil
	default: // "default" or ""
		return "----=_Part_" + hexStr, nil
	}
}

// ─── M6: header_order ────────────────────────────────────────────────────

// mimeHeader is a key-value pair for ordered header emission.
type mimeHeader struct{ key, val string }

// defaultHeaderPriority is the standard emission order for direct-build
// MIME (Date → To → Message-Id → MIME-Version → optional extras).
// This mirrors the existing order in buildPlainMIME / buildMultipartMIME
// before Sprint F.
var defaultHeaderPriority = []string{"To", "Subject", "Date", "Message-Id", "MIME-Version"}

// buildDirectHeaders assembles the ordered headers for direct-build MIME
// paths (buildPlainMIME, buildMultipartMIME).  It applies:
//
//   - H6 received_chain_strip: inserts synthetic Received: (will NOT be
//     stripped here — these are direct-build paths without relay sanitize).
//     The test therefore checks that the header IS present in the raw wire
//     MIME and then verifies that the relay path (H6+RelayBuildMessage)
//     strips it.  The flag name refers to the relay D5 behavior; in the
//     direct paths the header is injected so the caller can verify
//     strip behavior in test cases that use RelayBuildMessage.
//   - H7 user_agent_strip: same rationale as H6.
//   - H8 rfc2047_subject_encoding: subject is encoded before insertion.
//
// Returns a slice ordered per defaultHeaderPriority (further sorted by M6).
func buildDirectHeaders(req rawSMTPTestRequest, messageID string, now time.Time) []mimeHeader {
	subject := req.Subject
	if req.RFC2047SubjectEncoding {
		subject = encodeSubjectRFC2047(subject)
	}
	hdrs := []mimeHeader{
		{"To", req.Recipient},
		{"Subject", subject},
		{"Date", now.Format(time.RFC1123Z)},
		{"Message-Id", messageID},
		{"MIME-Version", "1.0"},
	}
	if req.XMailerHeader {
		hdrs = append(hdrs, mimeHeader{"X-Mailer", "Seznam.cz"})
	}
	if req.ContentLanguageCS {
		hdrs = append(hdrs, mimeHeader{"Content-Language", "cs"})
	}
	// H6: inject synthetic Received: for strip-test.
	if req.ReceivedChainStrip {
		hdrs = append(hdrs, mimeHeader{"Received", "from local by relay; " + now.Format(time.RFC1123Z)})
	}
	// H7: inject User-Agent for strip-test.
	if req.UserAgentStrip {
		hdrs = append(hdrs, mimeHeader{"User-Agent", "Go-http-client/1.1"})
	}
	return hdrs
}

// writeMIMEHeaders writes the ordered headers to b according to the M6
// header_order flag:
//
//   "default"      existing order (no re-sort)
//   "reverse"      reverse the slice order
//   "alphabetical" sort by header name (case-insensitive)
//
// Empty / unrecognised values fall back to "default".
func writeMIMEHeaders(b *strings.Builder, hdrs []mimeHeader, order string) {
	switch order {
	case "reverse":
		for i, j := 0, len(hdrs)-1; i < j; i, j = i+1, j-1 {
			hdrs[i], hdrs[j] = hdrs[j], hdrs[i]
		}
	case "alphabetical":
		sort.Slice(hdrs, func(i, j int) bool {
			return strings.ToLower(hdrs[i].key) < strings.ToLower(hdrs[j].key)
		})
	}
	for _, h := range hdrs {
		b.WriteString(h.key)
		b.WriteString(": ")
		b.WriteString(h.val)
		b.WriteString("\r\n")
	}
}

// ─── M8: content_transfer_encoding_8bit ──────────────────────────────────

// encodeQuotedPrintable returns the quoted-printable encoding of s with
// CRLF line endings, suitable for use as the body of a text/plain part
// with Content-Transfer-Encoding: quoted-printable.
func encodeQuotedPrintable(s string) string {
	var buf strings.Builder
	w := quotedprintable.NewWriter(&buf)
	_, _ = w.Write([]byte(s))
	_ = w.Close()
	result := buf.String()
	// Ensure the body ends with CRLF.
	if !strings.HasSuffix(result, "\r\n") {
		result += "\r\n"
	}
	return result
}

// ─── C8: typo_injection ───────────────────────────────────────────────────

// typoInjectMaxCount is the maximum number of punctuation characters to
// inject per call (0–3 uniform pick per inject site).
const typoInjectMaxCount = 3

// applyTypoInjection inserts 0–3 commas or periods at random word
// boundaries within s.  The insertion site is chosen deterministically
// when seed != 0 (via TYPO_INJECT_TEST_SEED env).  Each punctuation
// character is chosen from {',', '.'} with equal probability.
// Returns s verbatim when empty or seed-driven count is 0.
func applyTypoInjection(s string, seed int64) string {
	if s == "" {
		return s
	}
	words := strings.Fields(s)
	if len(words) == 0 {
		return s
	}

	var r *mathrand.Rand
	if seed != 0 {
		r = mathrand.New(mathrand.NewSource(seed)) //nolint:gosec
	} else {
		// Crypto-seeded via a single read.
		var seedBuf [8]byte
		_, _ = rand.Read(seedBuf[:])
		cryptoSeed := int64(binary.BigEndian.Uint64(seedBuf[:]))
		r = mathrand.New(mathrand.NewSource(cryptoSeed)) //nolint:gosec
	}

	count := r.Intn(typoInjectMaxCount + 1)
	if count == 0 {
		return s
	}
	puncts := []byte{',', '.'}
	for i := 0; i < count; i++ {
		if len(words) == 0 {
			break
		}
		idx := r.Intn(len(words))
		punct := string(puncts[r.Intn(len(puncts))])
		words[idx] = words[idx] + punct
	}
	// Reconstruct preserving single-space joins (typo injection is about
	// punctuation placement, not whitespace structure).
	return strings.Join(words, " ")
}

// loadTypoInjectSeed reads TYPO_INJECT_TEST_SEED. Returns 0 (crypto path)
// when unset or undecodable.
func loadTypoInjectSeed() int64 {
	// envconfig-allowed: diagnostic-only seed.
	raw := strings.TrimSpace(os.Getenv("TYPO_INJECT_TEST_SEED"))
	if raw == "" {
		return 0
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0
	}
	return v
}

// ─── C9: bump_forward_wrap ────────────────────────────────────────────────

// applyBumpForwardWrap wraps the body in a reply-style forward quote:
//
//	Re: <subject>
//
//	> <line1>
//	> <line2>
//	…
//
// Applied BEFORE humanize_light in the transform pipeline so the inserted
// "Re:" framing participates in typography substitutions when both flags
// are enabled.
func applyBumpForwardWrap(body, subject string) string {
	var b strings.Builder
	b.WriteString("Re: ")
	b.WriteString(subject)
	b.WriteString("\n\n")
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\r", "\n"), "\n")
	for i, line := range lines {
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString("> ")
		b.WriteString(line)
	}
	return b.String()
}

// ─── C10: voice_profile_variation ────────────────────────────────────────

// voiceVariants are the three voice annotation labels.  The variant is
// chosen deterministically from a SHA-256 hash of the senderFromAddr mod 3.
var voiceVariants = [3]string{"A", "B", "C"}

// applyVoiceProfileVariation prepends "Voice: VARIANT_<X>\n\n" to the body
// where X ∈ {A, B, C} is derived from SHA-256(senderFromAddr)[:1] mod 3.
func applyVoiceProfileVariation(body, senderFromAddr string) string {
	h := sha256.Sum256([]byte(senderFromAddr))
	variant := voiceVariants[int(h[0])%3]
	return "Voice: VARIANT_" + variant + "\n\n" + body
}
