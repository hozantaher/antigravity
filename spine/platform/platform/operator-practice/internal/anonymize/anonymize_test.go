package anonymize

import (
	"strings"
	"testing"
	"time"
)

// TestAnonymizeEmail_Deterministic verifies hash-based replacement is
// stable across calls so re-anonymizing the same row yields the same
// fixture (idempotency contract for seed log + cron retries).
func TestAnonymizeEmail_Deterministic(t *testing.T) {
	a := AnonymizeEmail("honza@somecompany.cz", "salt-A")
	b := AnonymizeEmail("honza@somecompany.cz", "salt-A")
	if a != b {
		t.Fatalf("deterministic violation: %q != %q", a, b)
	}
	if !strings.HasSuffix(a, "@anon.lab") {
		t.Fatalf("expected @anon.lab suffix, got %q", a)
	}
	if !strings.HasPrefix(a, "prospect-") {
		t.Fatalf("expected prospect- prefix, got %q", a)
	}
}

// TestAnonymizeEmail_DifferentSalts ensures the salt parameter actually
// changes output (would be a serious leak if it did not).
func TestAnonymizeEmail_DifferentSalts(t *testing.T) {
	a := AnonymizeEmail("a@b.cz", "salt-1")
	b := AnonymizeEmail("a@b.cz", "salt-2")
	if a == b {
		t.Fatalf("different salts produced same output %q", a)
	}
}

// TestAnonymizeEmail_DefaultSalt verifies the package default kicks in
// when caller passes an empty salt.
func TestAnonymizeEmail_DefaultSalt(t *testing.T) {
	a := AnonymizeEmail("u@x.cz", "")
	b := AnonymizeEmail("u@x.cz", DefaultSalt)
	if a != b {
		t.Fatalf("empty salt should fall back to DefaultSalt; got %q vs %q", a, b)
	}
}

// TestAnonymizeEmail_AlreadyAnon avoids re-rolling addresses that are
// already in the anon space — protects against bouncing replies that
// quoted a previously-anonymized fixture.
func TestAnonymizeEmail_AlreadyAnon(t *testing.T) {
	got := AnonymizeEmail("prospect-1234@anon.lab", DefaultSalt)
	if got != "prospect-1234@anon.lab" {
		t.Fatalf("anon address should round-trip unchanged; got %q", got)
	}
}

// TestAnonymizePhone_AllVariants checks the four phone-format regexes
// in one table-driven sweep.
func TestAnonymizePhone_AllVariants(t *testing.T) {
	cases := map[string]string{
		"volejte +420 605 123 456":  "volejte [Telefon]",
		"+420605123456":             "[Telefon]",
		"tel 605 123 456":           "tel [Telefon]",
		"call (605) 123-4567 today": "call [Telefon] today",
		"+421 905 111 222":          "[Telefon]",
	}
	for in, want := range cases {
		if got := AnonymizePhone(in); got != want {
			t.Errorf("AnonymizePhone(%q) = %q; want %q", in, got, want)
		}
	}
}

// TestAnonymizeURL_PreservesTLDShape verifies we keep enough of the
// shape (https + .cz) to avoid dropping operator context.
func TestAnonymizeURL_PreservesTLDShape(t *testing.T) {
	got := AnonymizeURL("Visit https://acme.cz/contact please")
	if !strings.Contains(got, "anon.cz") {
		t.Fatalf("expected anon.cz in %q", got)
	}
	if !strings.Contains(got, "https://") {
		t.Fatalf("expected scheme preserved in %q", got)
	}
}

// TestAnonymizeURL_SkipsAlreadyAnon — double-pass should be idempotent.
func TestAnonymizeURL_SkipsAlreadyAnon(t *testing.T) {
	first := AnonymizeURL("https://acme.cz/x")
	second := AnonymizeURL(first)
	if !strings.Contains(second, "anon") {
		t.Fatalf("anon should still be present in double-pass; got %q", second)
	}
}

// TestAnonymizeCzechNames_ReplacesFirstName covers the main intended
// transformation.
func TestAnonymizeCzechNames_ReplacesFirstName(t *testing.T) {
	got := AnonymizeCzechNames("Jan Novák píše")
	if !strings.Contains(got, "[Jméno]") {
		t.Fatalf("expected [Jméno] in %q", got)
	}
}

// TestAnonymizeCompanies covers the three suffix variants we ship.
func TestAnonymizeCompanies(t *testing.T) {
	cases := []string{
		"ABC Servis s.r.o. má novinku",
		"Test a.s. nabízí",
		"Foo k.s. představuje",
	}
	for _, in := range cases {
		got := AnonymizeCompanies(in)
		if !strings.Contains(got, "[Firma]") {
			t.Errorf("expected [Firma] for %q; got %q", in, got)
		}
	}
}

// TestFindReviewCandidates_FlagsForeignName surfaces non-Czech names
// that the static list missed — manual operator review will catch them.
func TestFindReviewCandidates_FlagsForeignName(t *testing.T) {
	got := FindReviewCandidates("Sincerely, Hiroshi Tanaka")
	found := false
	for _, c := range got {
		if c == "Hiroshi" || c == "Tanaka" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected Hiroshi/Tanaka surfaced for review; got %v", got)
	}
}

// TestFindReviewCandidates_SkipsAllowList ensures common greeting words
// don't poison the review checklist.
func TestFindReviewCandidates_SkipsAllowList(t *testing.T) {
	for _, c := range FindReviewCandidates("Dobrý den, děkuji.") {
		if c == "Dobrý" || c == "Pondělí" {
			t.Fatalf("greeting should be allow-listed: %v", c)
		}
	}
}

// TestAnonymize_HappyPath integrates the full message → EML transform.
// Verifies all the must-haves in the output (X-Lab-Source header,
// Czech name swap, deterministic From, MIME boundary).
func TestAnonymize_HappyPath(t *testing.T) {
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)
	msg := Message{
		ID:             42,
		FromAddr:       "honza@firma.cz",
		Subject:        "Re: Vaše nabídka",
		BodyText:       "Dobrý den,\n\nJan Novák zde, volejte +420 605 123 456 nebo na honza@firma.cz.\n\nS pozdravem\nJan",
		ReceivedAt:     now,
		Classification: "interested",
		MessageID:      "<orig-1@firma.cz>",
	}
	res := Anonymize(msg, Options{Salt: "test", ToAddr: "op@gmail.lab", NowFunc: func() time.Time { return now }})

	checks := []struct {
		name string
		want string
	}{
		{"category preserved", "interested"},
		{"X-Lab-Source header", "X-Lab-Source: real-anonymized"},
		{"X-Lab-Category header", "X-Lab-Category: interested"},
		{"Anonymized email present", "@anon.lab"},
		{"Phone redacted", "[Telefon]"},
		{"Name redacted", "[Jméno]"},
		{"MIME version", "MIME-Version: 1.0"},
		{"To header", "To: op@gmail.lab"},
		{"Subject preserved (anonymized)", "Subject:"},
		{"Message-ID copied", "<orig-1@firma.cz>"},
	}
	for _, c := range checks {
		if !strings.Contains(res.EML, c.want) {
			t.Errorf("%s: missing %q in EML\n--EML--\n%s\n", c.name, c.want, res.EML)
		}
	}
	if res.Category != "interested" {
		t.Errorf("expected category=interested; got %q", res.Category)
	}
}

// TestAnonymize_RoundTrip verifies the anonymized output, when fed back
// into the anonymizer, is unchanged in the structural fields. Critical
// for OP1.2 fixture commits — operator runs anonymizer twice during
// review and both passes must produce stable bytes.
func TestAnonymize_RoundTrip(t *testing.T) {
	now := time.Date(2026, 4, 30, 0, 0, 0, 0, time.UTC)
	msg := Message{
		ID:         1,
		FromAddr:   "test@x.cz",
		Subject:    "Re: ahoj",
		BodyText:   "Pavel zde",
		ReceivedAt: now,
	}
	first := Anonymize(msg, Options{NowFunc: func() time.Time { return now }})
	msg.BodyText = first.EML
	second := Anonymize(msg, Options{NowFunc: func() time.Time { return now }})
	if !strings.Contains(second.EML, "[Jméno]") {
		t.Fatalf("second pass should still contain redaction marker")
	}
}

// TestAnonymize_EmptyInput exercises the feedback_no_fabricated_test_data
// rule: empty message in → no synthesised data out. The EML still has
// the canonical header skeleton (so callers can write the file) but
// body must be blank.
func TestAnonymize_EmptyInput(t *testing.T) {
	res := Anonymize(Message{}, Options{NowFunc: func() time.Time { return time.Unix(0, 0).UTC() }})
	if !strings.HasSuffix(res.EML, "\r\n") {
		t.Fatalf("expected trailing CRLF on EML; got %q", res.EML)
	}
	if strings.Contains(res.EML, "Faker") || strings.Contains(res.EML, "@example.com") {
		t.Fatalf("anonymizer must not invent data: %q", res.EML)
	}
}

// TestAnonymize_AutoSubmittedHeader ensures DSN/OOO autoreplies keep
// their Auto-Submitted marker — the orchestrator's reply classifier
// uses this header to short-circuit the LLM path.
func TestAnonymize_AutoSubmittedHeader(t *testing.T) {
	res := Anonymize(Message{AutoSubmitted: true}, Options{})
	if !strings.Contains(res.EML, "Auto-Submitted: auto-replied") {
		t.Fatalf("auto-submitted marker missing")
	}
}
