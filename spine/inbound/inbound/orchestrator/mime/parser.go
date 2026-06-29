// Package mime parses raw RFC822 messages into a structured form ready
// for persistence + UI render.
//
// Design goals (mail-client-fidelity initiative S1.3):
//   - Stdlib only — net/mail, mime, mime/multipart, encoding/quotedprintable.
//   - Recursive multipart traversal (multipart/mixed → multipart/related →
//     multipart/alternative is a common nesting in real-world mail).
//   - Distinguishes inline parts (Content-ID set, used by HTML <img src="cid:X">)
//     from non-inline attachments (Content-Disposition: attachment).
//   - Decodes Content-Transfer-Encoding (quoted-printable, base64, 7bit, 8bit).
//   - Decodes RFC 2047 encoded headers + RFC 2231 parameter values.
//   - Returns plain + sanitized HTML separately so RecordInbound (S1.4)
//     can persist body_text + body_html + body_html_raw.
//
// Non-goals (deferred to later sprints):
//   - HTML sanitization (S1.4 wires bluemonday).
//   - DKIM/DMARC verification (lab + prod do this at the receiving MTA).
//   - Full message/rfc822 nested-attachment recursion (rare; we pass it
//     through as a single attachment blob).
package mime

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	stdmime "mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html/charset"
)

// ParsedMessage is the structured output of Parse.
//
// BodyHTML is the *raw* HTML extracted from the message — RecordInbound
// (S1.4) is responsible for sanitizing it before storage. BodyPlain
// is plain text already (no decoding needed beyond CTE).
type ParsedMessage struct {
	Headers     mail.Header
	BodyPlain   string
	BodyHTML    string
	Attachments []Attachment
}

// Attachment is one decoded MIME part — either inline (referenced from
// HTML body via cid:<ContentID>) or non-inline (download chip in UI).
type Attachment struct {
	ContentID   string // bare value, no angle brackets. "" for non-inline.
	Filename    string
	ContentType string // canonicalized lowercased, no parameters
	Data        []byte
	IsInline    bool
}

// ErrNoBody indicates the message has no parseable body (headers only).
// Returned alongside a ParsedMessage with populated Headers but empty
// BodyPlain / BodyHTML.
var ErrNoBody = errors.New("mime: message has no body")

// Parse decodes a raw RFC822 message.
//
// On malformed input the parser is conservative: it returns whatever
// could be extracted without panicking, plus a wrapped error describing
// the boundary at which parsing stopped. Callers should log the error
// but still proceed with the partial ParsedMessage — losing one inline
// image is better than losing the whole reply.
func Parse(raw []byte) (*ParsedMessage, error) {
	if len(raw) == 0 {
		return nil, errors.New("mime: empty input")
	}

	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("mime: parse headers: %w", err)
	}

	out := &ParsedMessage{Headers: msg.Header}

	ctype := msg.Header.Get("Content-Type")
	if ctype == "" {
		// Default per RFC 2045: text/plain; charset=us-ascii
		ctype = "text/plain; charset=us-ascii"
	}
	mediaType, params, err := stdmime.ParseMediaType(ctype)
	if err != nil {
		// Treat as plain text on malformed Content-Type — RFC says assume
		// text/plain when unparseable.
		mediaType = "text/plain"
		params = nil
	}

	cte := msg.Header.Get("Content-Transfer-Encoding")
	body, err := readPart(msg.Body, cte)
	if err != nil {
		return out, fmt.Errorf("mime: read body: %w", err)
	}

	if strings.HasPrefix(mediaType, "multipart/") {
		boundary := params["boundary"]
		if boundary == "" {
			return out, fmt.Errorf("mime: multipart without boundary")
		}
		if err := walkMultipart(out, body, boundary); err != nil {
			return out, fmt.Errorf("mime: walk: %w", err)
		}
		return out, nil
	}

	// Single-part body.
	switch mediaType {
	case "text/plain":
		out.BodyPlain = decodeBodyText(body, params["charset"], mediaType)
	case "text/html":
		out.BodyHTML = decodeBodyText(body, params["charset"], mediaType)
	default:
		// Treat as attachment if we can't render inline.
		filename := paramFilename(msg.Header)
		out.Attachments = append(out.Attachments, Attachment{
			Filename:    filename,
			ContentType: strings.ToLower(mediaType),
			Data:        body,
		})
	}

	return out, nil
}

// walkMultipart recurses through a multipart body, populating BodyPlain,
// BodyHTML, and Attachments as it descends.
//
// Strategy:
//   - multipart/alternative: prefer text/html if present; fall through to
//     text/plain otherwise. (Most clients render HTML when both are sent.)
//   - multipart/related: collect parts into the same buckets but each
//     image-typed part with Content-ID becomes an inline Attachment so
//     the HTML body can reference it via <img src="cid:...">.
//   - multipart/mixed: treat each part by its own Content-Type, recursing
//     into nested multipart parts.
//
// Recursion depth is implicitly bounded by mime/multipart's own
// max-parts safeguards plus the size cap enforced upstream by the
// IMAP poller (mail-client S1.2: maxMailSizeBytes()).
func walkMultipart(out *ParsedMessage, body []byte, boundary string) error {
	mr := multipart.NewReader(bytes.NewReader(body), boundary)
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("next part: %w", err)
		}

		ctype := part.Header.Get("Content-Type")
		if ctype == "" {
			ctype = "text/plain; charset=us-ascii"
		}
		mediaType, params, err := stdmime.ParseMediaType(ctype)
		if err != nil {
			mediaType = "application/octet-stream"
			params = nil
		}

		cte := part.Header.Get("Content-Transfer-Encoding")
		data, err := readPart(part, cte)
		if err != nil {
			// Skip the broken part but keep walking.
			continue
		}

		if strings.HasPrefix(mediaType, "multipart/") {
			if err := walkMultipart(out, data, params["boundary"]); err != nil {
				continue
			}
			continue
		}

		disposition, dparams, _ := stdmime.ParseMediaType(part.Header.Get("Content-Disposition"))
		contentID := stripBrackets(part.Header.Get("Content-Id"))
		if contentID == "" {
			contentID = stripBrackets(part.Header.Get("Content-ID"))
		}
		isInline := disposition == "inline" || (contentID != "" && disposition != "attachment")

		switch {
		case mediaType == "text/plain" && disposition != "attachment":
			// First text/plain part wins for BodyPlain (alternative ordering
			// usually puts plain first).
			if out.BodyPlain == "" {
				out.BodyPlain = decodeBodyText(data, params["charset"], mediaType)
			}
		case mediaType == "text/html" && disposition != "attachment":
			if out.BodyHTML == "" {
				out.BodyHTML = decodeBodyText(data, params["charset"], mediaType)
			}
		default:
			// Attachment (inline or download).
			filename := paramFilename(part.Header)
			if filename == "" {
				filename = dparams["filename"]
			}
			if filename == "" && params["name"] != "" {
				filename = params["name"]
			}
			out.Attachments = append(out.Attachments, Attachment{
				ContentID:   contentID,
				Filename:    filename,
				ContentType: strings.ToLower(mediaType),
				Data:        data,
				IsInline:    isInline,
			})
		}
	}
}

// readPart reads all bytes from r and decodes Content-Transfer-Encoding.
// Unknown CTE values pass through unchanged (8bit / 7bit semantics).
func readPart(r io.Reader, cte string) ([]byte, error) {
	switch strings.ToLower(strings.TrimSpace(cte)) {
	case "quoted-printable":
		return io.ReadAll(quotedprintable.NewReader(r))
	case "base64":
		raw, err := io.ReadAll(r)
		if err != nil {
			return nil, err
		}
		// Strip whitespace + decode.
		clean := bytes.Map(func(rn rune) rune {
			switch rn {
			case ' ', '\t', '\r', '\n':
				return -1
			}
			return rn
		}, raw)
		return base64.StdEncoding.DecodeString(string(clean))
	default:
		return io.ReadAll(r)
	}
}

// decodeBodyText converts a decoded MIME body part (post Content-
// Transfer-Encoding) into a valid UTF-8 string, transcoding from the
// part's Content-Type charset param when present.
//
// Why this exists (AL-F3, 2026-05-18): inbound id=504 in
// unmatched_inbound had Czech text rendered as `Dobr� den` (U+FFFD)
// instead of `Dobrý den` because the previous code called string(data)
// directly on a windows-1250 quoted-printable Outlook reply. Once those
// bytes were stored as if they were UTF-8, the only signal left was
// U+FFFD — the original byte was unrecoverable downstream.
//
// Strategy:
//
//  1. If the part already contains valid UTF-8, return it unchanged.
//     This covers the common-case fast path with no allocations beyond
//     string(body), and avoids accidental double-transcoding when the
//     charset label is wrong (e.g. an Outlook reply tagged windows-1250
//     but actually UTF-8).
//  2. Otherwise, ask golang.org/x/net/html/charset for a reader that
//     transcodes from the declared label. NewReaderLabel falls back to
//     a sniff (BOM, meta tag) when the label is unknown. Czech mail
//     parts are typically labeled "windows-1250" or "iso-8859-2"; both
//     map to known decoders.
//  3. If the resulting bytes are still not valid UTF-8 (label invalid
//     and sniff failed), apply a last-resort latin-1 byte-to-rune
//     widening so Postgres TEXT INSERTs still succeed. Each input byte
//     becomes a rune of the same scalar value (0x00..0xFF), producing
//     valid UTF-8 even when the original encoding cannot be identified.
//
// safeUTF8() in services/orchestrator/thread/inbound.go remains the
// downstream guard; this function is the *upstream* transcoder.
func decodeBodyText(body []byte, charsetLabel, contentType string) string {
	if utf8.Valid(body) {
		return string(body)
	}

	r, err := charset.NewReaderLabel(strings.ToLower(strings.TrimSpace(charsetLabel)), bytes.NewReader(body))
	if err == nil {
		decoded, derr := io.ReadAll(r)
		if derr == nil && utf8.Valid(decoded) {
			return string(decoded)
		}
	}

	// Fallback: latin-1 byte-widening. Always produces valid UTF-8.
	// Worse than the correct charset but recoverable: the operator sees
	// readable ASCII with some accent garbling instead of U+FFFD.
	var b strings.Builder
	b.Grow(len(body))
	for _, by := range body {
		b.WriteRune(rune(by))
	}
	return b.String()
}

// headerGetter abstracts mail.Header and textproto.MIMEHeader (multipart
// parts use the latter) so paramFilename works for both.
type headerGetter interface {
	Get(string) string
}

// paramFilename extracts a decoded filename from the part header. Looks
// at Content-Disposition first, then Content-Type "name" param. Decodes
// RFC 2047 (=?utf-8?Q?...?= style) and RFC 2231 (filename*=utf-8''...) forms.
func paramFilename(h headerGetter) string {
	if cd := h.Get("Content-Disposition"); cd != "" {
		if _, params, err := stdmime.ParseMediaType(cd); err == nil {
			if fn := params["filename"]; fn != "" {
				return decodeRFC2047(fn)
			}
		}
	}
	if ct := h.Get("Content-Type"); ct != "" {
		if _, params, err := stdmime.ParseMediaType(ct); err == nil {
			if name := params["name"]; name != "" {
				return decodeRFC2047(name)
			}
		}
	}
	return ""
}

// decodeRFC2047 decodes any =?charset?Q/B?...?= encoded chunks, leaving
// already-decoded text alone. Errors fall through to the original
// string — never lossy.
func decodeRFC2047(s string) string {
	dec := new(stdmime.WordDecoder)
	out, err := dec.DecodeHeader(s)
	if err != nil {
		return s
	}
	return out
}

// stripBrackets removes leading/trailing '<' and '>' from a Content-Id
// value. Per RFC 2392 the id is enclosed in brackets when used as a
// header but referenced bare in cid: URIs.
func stripBrackets(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "<")
	s = strings.TrimSuffix(s, ">")
	return s
}
