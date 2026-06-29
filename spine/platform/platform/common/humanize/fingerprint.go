package humanize

import (
	"fmt"
	htmlpkg "html"
	"strings"
	"time"
)

// FingerprintEngine generates email headers and structure that match
// a real Seznam.cz webmail client.
type FingerprintEngine struct {
	senderDomain string
	loc          *time.Location
}

// NewFingerprintEngine creates a fingerprint engine for the sender domain.
func NewFingerprintEngine(senderDomain string) *FingerprintEngine {
	loc, _ := time.LoadLocation("Europe/Prague")
	if loc == nil {
		loc = time.UTC
	}
	return &FingerprintEngine{senderDomain: senderDomain, loc: loc}
}

// Headers returns realistic email headers matching Seznam.cz webmail.
func (f *FingerprintEngine) Headers(from, to, subject, messageID string, sendTime time.Time) map[string]string {
	sendTime = sendTime.In(f.loc)

	headers := map[string]string{
		"From":                    from,
		"To":                     to,
		"Subject":                subject,
		"Date":                   sendTime.Format("Mon, 02 Jan 2006 15:04:05 -0700"),
		"Message-ID":             "<" + messageID + ">",
		"MIME-Version":           "1.0",
		"Content-Type":           "text/plain; charset=utf-8",
		"Content-Transfer-Encoding": "quoted-printable",
		"X-Mailer":               "Seznam.cz",
	}

	return headers
}

// MessageID generates a realistic Message-ID for Seznam.cz.
func (f *FingerprintEngine) MessageID(sendTime time.Time) string {
	// Seznam format: alphanumeric@email.seznam.cz
	randomPart := fmt.Sprintf("%x%x", sendTime.UnixNano(), randMinute(10000, 99999))
	return randomPart + "@email.seznam.cz"
}

// WrapBodyHTML wraps plain text in messy HTML that looks like webmail output.
// Real webmail produces inconsistent HTML with redundant spans.
func (f *FingerprintEngine) WrapBodyHTML(plainText string) string {
	var b strings.Builder

	b.WriteString(`<html><head><meta charset="utf-8"></head><body>`)
	b.WriteString(`<div style="font-family: Arial, sans-serif; font-size: 14px;">`)

	lines := strings.Split(plainText, "\n")
	for i, line := range lines {
		if line == "" {
			b.WriteString("<br>")
			continue
		}

		// Randomly wrap in span with slightly different font-size (webmail artifact)
		if cryptoRandFloat() < 0.3 {
			fontSize := 13 + randMinute(0, 3) // 13-15px
			b.WriteString(fmt.Sprintf(`<span style="font-size: %dpx;">`, fontSize))
			b.WriteString(escapeHTML(line))
			b.WriteString("</span><br>")
		} else {
			b.WriteString(escapeHTML(line))
			b.WriteString("<br>")
		}

		// Occasional redundant <div> after paragraph breaks
		if i > 0 && i < len(lines)-1 && line == "" && cryptoRandFloat() < 0.2 {
			b.WriteString("<div>&nbsp;</div>")
		}
	}

	b.WriteString("</div></body></html>")
	return b.String()
}

func escapeHTML(s string) string {
	// html.EscapeString escapes &, <, >, ", ' — superset of the previous
	// hand-rolled version that was missing " and '.
	return htmlpkg.EscapeString(s)
}
