package sanitizer

import (
	"testing"
	"unicode/utf8"

	"privacy-gateway/internal/model"
)

// FuzzSanitize exercises the Sanitize* boundary parsers with arbitrary bytes
// coming from untrusted mail bodies / headers. The sanitizer is the outer
// parser for externally supplied Subject/TextBody/HTMLBody and must:
//
//   - never panic on any input,
//   - never read out of bounds,
//   - produce output that is itself valid UTF-8 whenever the input is valid
//     UTF-8 (i.e. the sanitizer must not introduce new invalid sequences).
//
// Seeds cover: empty, single byte, known-good, CRLF-heavy, embedded NULs,
// long-string, and deliberately malformed UTF-8.
func FuzzSanitize(f *testing.F) {
	seeds := []string{
		"",
		"a",
		"Hello",
		" Subject \r\n ",
		"text with\x00embedded null",
		"líne\nbreak\tmix",
		"<p>html-looking body</p>",
		"\xff\xfe\xfd invalid utf-8",
		string(make([]byte, 4096)),
	}
	for _, s := range seeds {
		f.Add(s, s, s)
	}

	svc := NewService()

	f.Fuzz(func(t *testing.T, subject, text, html string) {
		// Outbound path.
		outbound := svc.SanitizeOutbound(model.SendMessageInput{
			Subject:  subject,
			TextBody: text,
			HTMLBody: html,
		})
		assertSanitizedStringsValid(t, "outbound", subject, text, outbound)

		// Submission path (standard profile).
		submission := svc.SanitizeSubmission(model.CreateSubmissionInput{
			Subject:  subject,
			TextBody: text,
			HTMLBody: html,
		})
		assertSanitizedStringsValid(t, "submission", subject, text, submission)

		// Submission path (strict profile) with a recipient to exercise the
		// recipient-blocking branch.
		strict := svc.SanitizeSubmission(model.CreateSubmissionInput{
			SanitizerProfile: ProfileStrict,
			Subject:          subject,
			TextBody:         text,
			HTMLBody:         html,
			To:               []string{"a@b.co"},
		})
		assertSanitizedStringsValid(t, "strict", subject, text, strict)

		// Inbound path.
		inbound := svc.SanitizeInbound(model.InboxMessage{
			Subject:  subject,
			TextBody: text,
		})
		assertSanitizedStringsValid(t, "inbound", subject, text, inbound)

		// Profile normalizer must also be crash-free for arbitrary input.
		_ = NormalizeSubmissionProfile(subject)
	})
}

// assertSanitizedStringsValid enforces the UTF-8 invariant: if the caller
// supplied valid UTF-8, the sanitizer must not emit invalid UTF-8. If the
// caller supplied invalid UTF-8 the sanitizer is permitted to pass it through
// (strings.TrimSpace is byte-level), but it still must not panic and the
// output length must not exceed the input length.
func assertSanitizedStringsValid(t *testing.T, label, rawSubject, rawText string, r model.SanitizationResult) {
	t.Helper()

	if utf8.ValidString(rawSubject) && !utf8.ValidString(r.NormalizedSubject) {
		t.Fatalf("%s: valid-utf8 subject became invalid after sanitize: %q -> %q", label, rawSubject, r.NormalizedSubject)
	}
	if utf8.ValidString(rawText) && !utf8.ValidString(r.NormalizedText) {
		t.Fatalf("%s: valid-utf8 text became invalid after sanitize: %q -> %q", label, rawText, r.NormalizedText)
	}
	if len(r.NormalizedSubject) > len(rawSubject) {
		t.Fatalf("%s: sanitizer grew subject: in=%d out=%d", label, len(rawSubject), len(r.NormalizedSubject))
	}
	if len(r.NormalizedText) > len(rawText) {
		t.Fatalf("%s: sanitizer grew text: in=%d out=%d", label, len(rawText), len(r.NormalizedText))
	}
}
