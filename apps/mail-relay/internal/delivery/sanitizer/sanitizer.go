package sanitizer

import (
	"relay/internal/model"
	"strings"
	"unicode/utf8"
)

// Service sanitizes content and metadata to remove identifying information.
type Service struct{}

func NewService() *Service {
	return &Service{}
}

// SanitizeIntake sanitizes a raw intake request, stripping dangerous content
// and normalizing text to remove fingerprinting vectors.
func (s *Service) SanitizeIntake(req model.IntakeRequest) model.SanitizationResult {
	result := model.SanitizationResult{
		Status: "clean",
	}
	var notes []string

	subject := strings.TrimSpace(req.Subject)
	body := strings.TrimSpace(req.Body)

	if !utf8.ValidString(subject) {
		subject = strings.ToValidUTF8(subject, "")
		notes = append(notes, "invalid_utf8_in_subject")
	}
	if !utf8.ValidString(body) {
		body = strings.ToValidUTF8(body, "")
		notes = append(notes, "invalid_utf8_in_body")
	}

	subject = stripControlChars(subject)
	body = stripControlChars(body)

	if containsBlockedContent(body) {
		result.HasBlockedContent = true
		result.Status = "blocked"
		notes = append(notes, "blocked_content_detected")
	}

	if containsHTML(body) {
		result.HasHTML = true
		body = stripHTMLTags(body)
		notes = append(notes, "html_stripped")
	}

	if containsTrackingPatterns(body) {
		body = stripTrackingPatterns(body)
		notes = append(notes, "tracking_patterns_removed")
	}

	body = normalizeWhitespace(body)
	subject = normalizeWhitespace(subject)

	result.NormalizedSubject = subject
	result.NormalizedBody = body
	result.Notes = notes

	if result.Status != "blocked" && (subject == "" && body == "") {
		result.Status = "empty"
	}

	return result
}

// StripHeaders removes identifying headers from a header map.
func (s *Service) StripHeaders(headers map[string]string) map[string]string {
	clean := make(map[string]string)
	forbidden := []string{
		"x-originating-ip", "x-mailer", "x-mimeole",
		"user-agent", "x-forwarded-for", "x-real-ip",
		"received", "x-sender", "x-source",
		"x-authenticated", "x-client", "x-device",
	}
	for k, v := range headers {
		lk := strings.ToLower(k)
		blocked := false
		for _, fb := range forbidden {
			if strings.Contains(lk, fb) {
				blocked = true
				break
			}
		}
		if !blocked {
			clean[k] = v
		}
	}
	return clean
}

func stripControlChars(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r == '\n' || r == '\t' || r >= 32 {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func containsHTML(s string) bool {
	ls := strings.ToLower(s)
	tags := []string{"<html", "<body", "<script", "<style", "<img", "<a ", "<div", "<span", "<iframe"}
	for _, tag := range tags {
		if strings.Contains(ls, tag) {
			return true
		}
	}
	return false
}

func stripHTMLTags(s string) string {
	var b strings.Builder
	inTag := false
	for _, r := range s {
		if r == '<' {
			inTag = true
			continue
		}
		if r == '>' {
			inTag = false
			continue
		}
		if !inTag {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func containsBlockedContent(s string) bool {
	ls := strings.ToLower(s)
	blocked := []string{"<script", "javascript:", "data:text/html", "vbscript:"}
	for _, b := range blocked {
		if strings.Contains(ls, b) {
			return true
		}
	}
	return false
}

func containsTrackingPatterns(s string) bool {
	ls := strings.ToLower(s)
	patterns := []string{
		"<img src=\"http", "<img src='http",
		"1x1", "pixel.gif", "track.gif",
		"utm_source=", "utm_medium=", "utm_campaign=",
		"click.", "open.track", "beacon",
	}
	for _, p := range patterns {
		if strings.Contains(ls, p) {
			return true
		}
	}
	return false
}

func stripTrackingPatterns(s string) string {
	s = stripHTMLTags(s)
	return s
}

// normalizeWhitespace collapses intra-line whitespace runs to single spaces
// while PRESERVING line breaks. Multi-paragraph email body structure
// (greeting / body paragraphs / closing / signature) is essential for
// recipient anti-spam classifiers — collapsing all whitespace produces a
// single-line wall of text that Czech webmail (Seznam) flags as
// machine-generated and silently drops after SMTP accept.
//
// RCA Sprint X vs Y (2026-05-04): identical body via /v1/raw-smtp-test
// (no sanitizer) → 5/5 INBOX; via /v1/submit (this sanitizer) → 3/5 INBOX.
// Single-line collapse was the kill differentiator. Initiative
// docs/initiatives/2026-05-04-anti-trace-incremental-verification.md.
func normalizeWhitespace(s string) string {
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		// Collapse intra-line whitespace runs (spaces + tabs) to single space.
		// strings.Fields splits on Unicode space and drops empties, so a
		// blank line ("   ") becomes "" — we keep that empty entry to
		// preserve paragraph breaks via the surrounding \n boundaries.
		out = append(out, strings.Join(strings.Fields(line), " "))
	}
	return strings.Join(out, "\n")
}
