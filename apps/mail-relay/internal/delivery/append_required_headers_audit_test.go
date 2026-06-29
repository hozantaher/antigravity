package delivery

import (
	"net/mail"
	"strings"
	"testing"
)

// TestAppendRequiredHeadersAudit enforces that BuildWireMIMEForAppend
// ALWAYS emits Date and Message-ID headers, even when the caller omits
// them from the headers map. This audit ratchet keeps baseline 0 violations.
//
// Scenarios (≥20):
//   - Minimal: only From/To/Subject provided
//   - With empty headers map
//   - With nil headers
//   - With partial headers (no Date, no Message-ID)
//   - With caller-provided Date, no Message-ID
//   - With caller-provided Message-ID, no Date
//   - With both Date and Message-ID provided
//   - Text/plain vs multipart/alternative bodies
//   - Special characters in from/to addresses
//   - Empty body
//   - Various subject lengths and content
func TestAppendRequiredHeadersAudit(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name      string
		from      string
		to        string
		subject   string
		bodyPlain string
		bodyHTML  string
		headers   map[string]string
		wantDate  bool
		wantMsgID bool
	}{
		{
			name:      "minimal_no_headers_map",
			from:      "alice@example.com",
			to:        "bob@example.com",
			subject:   "Test",
			bodyPlain: "Hello",
			bodyHTML:  "",
			headers:   nil,
			wantDate:  true,
			wantMsgID: true,
		},
		{
			name:      "empty_headers_map",
			from:      "alice@example.com",
			to:        "bob@example.com",
			subject:   "Test",
			bodyPlain: "Hello",
			bodyHTML:  "",
			headers:   map[string]string{},
			wantDate:  true,
			wantMsgID: true,
		},
		{
			name:      "headers_without_date_or_msgid",
			from:      "alice@example.com",
			to:        "bob@example.com",
			subject:   "Test",
			bodyPlain: "Hello",
			bodyHTML:  "",
			headers: map[string]string{
				"X-Custom": "value",
			},
			wantDate:  true,
			wantMsgID: true,
		},
		{
			name:      "caller_provided_date_missing_msgid",
			from:      "alice@example.com",
			to:        "bob@example.com",
			subject:   "Test",
			bodyPlain: "Hello",
			bodyHTML:  "",
			headers: map[string]string{
				"Date": "Mon, 11 May 2026 10:00:00 +0200",
			},
			wantDate:  true,
			wantMsgID: true,
		},
		{
			name:      "caller_provided_msgid_missing_date",
			from:      "alice@example.com",
			to:        "bob@example.com",
			subject:   "Test",
			bodyPlain: "Hello",
			bodyHTML:  "",
			headers: map[string]string{
				"Message-ID": "<custom@example.com>",
			},
			wantDate:  true,
			wantMsgID: true,
		},
		{
			name:      "both_date_and_msgid_provided",
			from:      "alice@example.com",
			to:        "bob@example.com",
			subject:   "Test",
			bodyPlain: "Hello",
			bodyHTML:  "",
			headers: map[string]string{
				"Date":       "Mon, 11 May 2026 10:00:00 +0200",
				"Message-ID": "<custom@example.com>",
			},
			wantDate:  true,
			wantMsgID: true,
		},
		{
			name:      "multipart_html_body",
			from:      "alice@example.com",
			to:        "bob@example.com",
			subject:   "Test",
			bodyPlain: "Hello",
			bodyHTML:  "<p>Hello</p>",
			headers:   nil,
			wantDate:  true,
			wantMsgID: true,
		},
		{
			name:      "empty_body",
			from:      "alice@example.com",
			to:        "bob@example.com",
			subject:   "Test",
			bodyPlain: "",
			bodyHTML:  "",
			headers:   nil,
			wantDate:  true,
			wantMsgID: true,
		},
		{
			name:      "special_chars_in_from",
			from:      "alice+tag@example.com",
			to:        "bob@example.com",
			subject:   "Test",
			bodyPlain: "Hello",
			bodyHTML:  "",
			headers:   nil,
			wantDate:  true,
			wantMsgID: true,
		},
		{
			name:      "special_chars_in_to",
			from:      "alice@example.com",
			to:        "bob+tag@example.com",
			subject:   "Test",
			bodyPlain: "Hello",
			bodyHTML:  "",
			headers:   nil,
			wantDate:  true,
			wantMsgID: true,
		},
		{
			name:      "long_subject",
			from:      "alice@example.com",
			to:        "bob@example.com",
			subject:   strings.Repeat("A", 200),
			bodyPlain: "Hello",
			bodyHTML:  "",
			headers:   nil,
			wantDate:  true,
			wantMsgID: true,
		},
		{
			name:      "multiline_body",
			from:      "alice@example.com",
			to:        "bob@example.com",
			subject:   "Test",
			bodyPlain: "Line1\r\nLine2\r\nLine3",
			bodyHTML:  "",
			headers:   nil,
			wantDate:  true,
			wantMsgID: true,
		},
		{
			name:      "with_reply_to",
			from:      "alice@example.com",
			to:        "bob@example.com",
			subject:   "Test",
			bodyPlain: "Hello",
			bodyHTML:  "",
			headers: map[string]string{
				"Reply-To": "reply@example.com",
			},
			wantDate:  true,
			wantMsgID: true,
		},
		{
			name:      "with_x_mailer",
			from:      "alice@example.com",
			to:        "bob@example.com",
			subject:   "Test",
			bodyPlain: "Hello",
			bodyHTML:  "",
			headers: map[string]string{
				"X-Mailer": "relay/1.0",
			},
			wantDate:  true,
			wantMsgID: true,
		},
		{
			name:      "empty_date_header_should_be_generated",
			from:      "alice@example.com",
			to:        "bob@example.com",
			subject:   "Test",
			bodyPlain: "Hello",
			bodyHTML:  "",
			headers: map[string]string{
				"Date": "", // Empty string should trigger generation
			},
			wantDate:  true,
			wantMsgID: true,
		},
		{
			name:      "empty_msgid_header_should_be_generated",
			from:      "alice@example.com",
			to:        "bob@example.com",
			subject:   "Test",
			bodyPlain: "Hello",
			bodyHTML:  "",
			headers: map[string]string{
				"Message-ID": "", // Empty string should trigger generation
			},
			wantDate:  true,
			wantMsgID: true,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			mime := BuildWireMIMEForAppend(tc.from, tc.to, tc.subject, tc.bodyPlain, tc.bodyHTML, tc.headers)
			mimeStr := string(mime)

			// Parse the MIME as a mail.Message to verify headers are properly formatted.
			msg, err := mail.ReadMessage(strings.NewReader(mimeStr))
			if err != nil {
				t.Fatalf("failed to parse generated MIME: %v\nContent:\n%s", err, mimeStr)
			}

			// Assert Date is present
			if tc.wantDate {
				dateVal := msg.Header.Get("Date")
				if dateVal == "" {
					t.Errorf("Date header is missing\nMIME:\n%s", mimeStr)
				}
			}

			// Assert Message-ID is present
			if tc.wantMsgID {
				msgIDVal := msg.Header.Get("Message-ID")
				if msgIDVal == "" {
					t.Errorf("Message-ID header is missing\nMIME:\n%s", mimeStr)
				}
			}

			// Verify standard headers are present
			if got := msg.Header.Get("From"); got == "" {
				t.Errorf("From header missing")
			}
			if got := msg.Header.Get("To"); got == "" {
				t.Errorf("To header missing")
			}
			if got := msg.Header.Get("Subject"); got == "" {
				t.Errorf("Subject header missing")
			}
		})
	}
}

// TestGenerateMessageID verifies the Message-ID generator produces
// RFC-compliant format and is reasonably unique.
func TestGenerateMessageID(t *testing.T) {
	t.Parallel()

	domain := "example.com"
	msgID1 := generateMessageID(domain)
	msgID2 := generateMessageID(domain)

	// Format check: should be <append-{hex}@example.com>
	if !strings.HasPrefix(msgID1, "<append-") || !strings.HasSuffix(msgID1, "@"+domain+">") {
		t.Errorf("Message-ID format wrong: %s", msgID1)
	}

	// Uniqueness: two consecutive calls should produce different IDs
	if msgID1 == msgID2 {
		t.Errorf("Message-IDs not unique: %s == %s", msgID1, msgID2)
	}

	// Test with different domains
	msgID3 := generateMessageID("other.com")
	if !strings.HasSuffix(msgID3, "@other.com>") {
		t.Errorf("Message-ID domain not reflected: %s", msgID3)
	}
}

// TestBuildWireMIMEDateFormats verifies that the generated Date header
// is in valid RFC 1123Z format and can be parsed by time.Parse.
func TestBuildWireMIMEDateFormats(t *testing.T) {
	t.Parallel()

	mime := BuildWireMIMEForAppend(
		"alice@example.com",
		"bob@example.com",
		"Test",
		"Hello",
		"",
		nil,
	)
	mimeStr := string(mime)

	msg, err := mail.ReadMessage(strings.NewReader(mimeStr))
	if err != nil {
		t.Fatalf("failed to parse MIME: %v", err)
	}

	dateStr := msg.Header.Get("Date")
	if dateStr == "" {
		t.Fatal("Date header missing")
	}

	// Verify it can be parsed by the mail package (uses time.Parse RFC1123Z)
	_, err = mail.ParseDate(dateStr)
	if err != nil {
		t.Errorf("Date header value unparseable: %q, error: %v", dateStr, err)
	}
}
