package imap

// subject_decode_test.go — G3.3 RFC 2047 subject decoder unit tests.
//
// Verifies that decodeSubjectRFC2047 correctly decodes the two encoding
// variants present in reply_inbox (26/36 QP + 1/36 Base64) and is a
// no-op for plain ASCII subjects.

import (
	"net/mail"
	"strings"
	"testing"

	"orchestrator/thread"
)

func TestDecodeSubjectRFC2047(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "QP utf-8 Re: Poptávka",
			in:   "=?utf-8?Q?Re:_Popt=C3=A1vka?=",
			want: "Re: Poptávka",
		},
		{
			name: "Base64 utf-8 Re: Poptávka",
			in:   "=?utf-8?B?UmU6IFBvcHTDoXZrYQ==?=",
			want: "Re: Poptávka",
		},
		{
			name: "plain ASCII passthrough",
			in:   "Re: Hello",
			want: "Re: Hello",
		},
		{
			name: "empty string",
			in:   "",
			want: "",
		},
		{
			name: "mixed ASCII and encoded word",
			in:   "=?utf-8?Q?Re:_Dotaz_na_cen=C3=ADk?=",
			want: "Re: Dotaz na ceník",
		},
		{
			name: "already decoded UTF-8",
			in:   "Re: Zájem o nabídku",
			want: "Re: Zájem o nabídku",
		},
		{
			name: "iso-8859-2 QP encoded plain text",
			in:   "=?iso-8859-2?Q?Re:_Dotaz?=",
			want: "Re: Dotaz",
		},
		{
			name: "two adjacent encoded words",
			in:   "=?utf-8?Q?Re:_Popt=C3=A1vka?= =?utf-8?Q?_na_stroje?=",
			want: "Re: Poptávka na stroje",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decodeSubjectRFC2047(tc.in)
			if got != tc.want {
				t.Errorf("decodeSubjectRFC2047(%q)\n  got:  %q\n  want: %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestFillHeadersFromMail_SubjectDecoded verifies that fillHeadersFromMail
// decodes the RFC 2047 subject before storing it on RawInbound.
func TestFillHeadersFromMail_SubjectDecoded(t *testing.T) {
	rawMsg := "From: sender@example.com\r\n" +
		"To: me@example.com\r\n" +
		"Message-ID: <test@example.com>\r\n" +
		"Subject: =?utf-8?Q?Re:_Popt=C3=A1vka?=\r\n" +
		"Date: Thu, 29 May 2026 10:00:00 +0000\r\n" +
		"\r\n"

	m, err := mail.ReadMessage(strings.NewReader(rawMsg))
	if err != nil {
		t.Fatalf("parse raw message: %v", err)
	}
	var result thread.RawInbound
	fillHeadersFromMail(&result, m)
	if result.Subject != "Re: Poptávka" {
		t.Errorf("fillHeadersFromMail subject = %q, want %q", result.Subject, "Re: Poptávka")
	}
}
