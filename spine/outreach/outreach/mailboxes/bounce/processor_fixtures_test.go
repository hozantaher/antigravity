package bounce

// processor_fixtures_test.go — H3.2 bounce fixture corpus tests.
//
// These tests verify:
//  1. RFC 3464 structural integrity of each .eml fixture (multipart/report,
//     message/delivery-status part, required DSN fields present).
//  2. ClassifyBounce produces the correct BounceType for the SMTP code +
//     diagnostic extracted from each fixture's message/delivery-status part.
//  3. Edge cases for the classifier covering malformed input, encoding
//     variants, and boundary conditions per the extreme-testing HARD RULE.
//
// Fixtures live in testdata/ — synthetic addresses only (no PII).

import (
	"bufio"
	"bytes"
	"os"
	"strings"
	"testing"
)

// ── fixture helpers ──

// fixtureContains reads the named fixture and reports whether it contains
// the given substring. It fatals if the file cannot be read.
func fixtureContains(t *testing.T, name, substring string) bool {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("fixture %s: read failed: %v", name, err)
	}
	return bytes.Contains(raw, []byte(substring))
}

// fixtureRFC3464Headers checks the fixture contains the minimal RFC 3464
// required headers: Content-Type multipart/report with report-type=delivery-status
// and a message/delivery-status part.
func fixtureRFC3464Headers(t *testing.T, name string) {
	t.Helper()
	if !fixtureContains(t, name, "multipart/report") {
		t.Errorf("%s: missing Content-Type multipart/report", name)
	}
	if !fixtureContains(t, name, "report-type=delivery-status") {
		t.Errorf("%s: missing report-type=delivery-status", name)
	}
	if !fixtureContains(t, name, "message/delivery-status") {
		t.Errorf("%s: missing message/delivery-status part", name)
	}
}

// fixtureDSNFields checks that the DSN part contains the required RFC 3464
// per-recipient fields: Final-Recipient, Action, Status.
func fixtureDSNFields(t *testing.T, name string) {
	t.Helper()
	if !fixtureContains(t, name, "Final-Recipient:") {
		t.Errorf("%s: missing Final-Recipient field", name)
	}
	if !fixtureContains(t, name, "Action:") {
		t.Errorf("%s: missing Action field", name)
	}
	if !fixtureContains(t, name, "Status:") {
		t.Errorf("%s: missing Status field", name)
	}
}

// extractStatusCode finds the first "Status: X.Y.Z" line in the fixture
// and returns the dotted status code (e.g. "5.1.1"). Returns "" if not found.
func extractStatusCode(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("fixture %s: read failed: %v", name, err)
	}
	sc := bufio.NewScanner(bytes.NewReader(raw))
	for sc.Scan() {
		line := sc.Text()
		if after, ok := strings.CutPrefix(line, "Status: "); ok {
			return strings.TrimSpace(after)
		}
	}
	return ""
}

// extractDiagnosticCode extracts the SMTP diagnostic string after
// "Diagnostic-Code: smtp; " from the fixture. Returns "" if not found.
func extractDiagnosticCode(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("fixture %s: read failed: %v", name, err)
	}
	sc := bufio.NewScanner(bytes.NewReader(raw))
	for sc.Scan() {
		line := sc.Text()
		if after, ok := strings.CutPrefix(line, "Diagnostic-Code: smtp; "); ok {
			return strings.TrimSpace(after)
		}
	}
	return ""
}

// ── Fixture 1: 5xx permanent — mailbox not found ──

// TestFixture_5xxPermanent_RFC3464Structure verifies the permanent-bounce
// fixture is a valid RFC 3464 multipart/report message.
func TestFixture_5xxPermanent_RFC3464Structure(t *testing.T) {
	const f = "5xx-permanent-mailbox-not-found.eml"
	fixtureRFC3464Headers(t, f)
	fixtureDSNFields(t, f)

	if !fixtureContains(t, f, "Action: failed") {
		t.Errorf("%s: Action must be 'failed' for permanent bounce", f)
	}
	if !fixtureContains(t, f, "Status: 5.1.1") {
		t.Errorf("%s: expected Status 5.1.1", f)
	}
}

// TestFixture_5xxPermanent_ClassifyBounce verifies ClassifyBounce produces
// BounceHard for the SMTP code and diagnostic extracted from the fixture.
func TestFixture_5xxPermanent_ClassifyBounce(t *testing.T) {
	const f = "5xx-permanent-mailbox-not-found.eml"
	diagnostic := extractDiagnosticCode(t, f)
	if diagnostic == "" {
		t.Fatalf("%s: could not extract Diagnostic-Code", f)
	}
	// Diagnostic begins with "550 5.1.1 The email account does not exist"
	// ClassifyBounce receives (smtpCode, message). We use the leading SMTP
	// numeric code and the full diagnostic as the message.
	got := ClassifyBounce("550", diagnostic)
	if got != BounceHard {
		t.Errorf("fixture %s: ClassifyBounce(550, %q) = %s, want hard", f, diagnostic, got)
	}
}

// ── Fixture 2: 4xx temporary — greylist ──

// TestFixture_4xxGreylist_RFC3464Structure verifies the greylist DSN fixture
// has the correct structure and uses Action: delayed per RFC 3464 §2.3.4.
func TestFixture_4xxGreylist_RFC3464Structure(t *testing.T) {
	const f = "4xx-temporary-greylist.eml"
	fixtureRFC3464Headers(t, f)
	fixtureDSNFields(t, f)

	if !fixtureContains(t, f, "Action: delayed") {
		t.Errorf("%s: Action must be 'delayed' for temporary deferral", f)
	}
	if !fixtureContains(t, f, "Status: 4.7.0") {
		t.Errorf("%s: expected Status 4.7.0 for greylist", f)
	}
	// Will-Retry-Until is a valid optional field per RFC 3464 §2.3.9
	if !fixtureContains(t, f, "Will-Retry-Until:") {
		t.Errorf("%s: should include Will-Retry-Until for delayed DSN", f)
	}
}

// TestFixture_4xxGreylist_ClassifyBounce verifies that a 421 4.7.0 greylist
// deferral is classified as a soft bounce (transient, retry-eligible).
func TestFixture_4xxGreylist_ClassifyBounce(t *testing.T) {
	const f = "4xx-temporary-greylist.eml"
	diagnostic := extractDiagnosticCode(t, f)
	if diagnostic == "" {
		t.Fatalf("%s: could not extract Diagnostic-Code", f)
	}
	got := ClassifyBounce("421", diagnostic)
	if got != BounceSoft {
		t.Errorf("fixture %s: ClassifyBounce(421, %q) = %s, want soft", f, diagnostic, got)
	}
}

// ── Fixture 3: 4xx — mailbox full ──

// TestFixture_4xxMailboxFull_RFC3464Structure verifies the mailbox-full
// fixture has proper DSN structure and 4.2.2 status.
func TestFixture_4xxMailboxFull_RFC3464Structure(t *testing.T) {
	const f = "4xx-mailbox-full.eml"
	fixtureRFC3464Headers(t, f)
	fixtureDSNFields(t, f)

	if !fixtureContains(t, f, "Status: 4.2.2") {
		t.Errorf("%s: expected Status 4.2.2 (mailbox full)", f)
	}
}

// TestFixture_4xxMailboxFull_ClassifyBounce verifies mailbox-full (452 4.2.2)
// is classified as soft — the address is valid, quota is temporary.
func TestFixture_4xxMailboxFull_ClassifyBounce(t *testing.T) {
	const f = "4xx-mailbox-full.eml"
	diagnostic := extractDiagnosticCode(t, f)
	if diagnostic == "" {
		t.Fatalf("%s: could not extract Diagnostic-Code", f)
	}
	got := ClassifyBounce("452", diagnostic)
	if got != BounceSoft {
		t.Errorf("fixture %s: ClassifyBounce(452, %q) = %s, want soft", f, diagnostic, got)
	}
}

// ── Fixture 4: Out-of-office / vacation auto-reply ──

// TestFixture_OOO_IsAutoReply verifies the out-of-office fixture is flagged
// as an auto-reply via Auto-Submitted header (RFC 3834 §2).
func TestFixture_OOO_IsAutoReply(t *testing.T) {
	const f = "out-of-office-vacation.eml"
	if !fixtureContains(t, f, "Auto-Submitted: auto-replied") {
		t.Errorf("%s: must contain Auto-Submitted: auto-replied", f)
	}
	if !fixtureContains(t, f, "X-Auto-Response-Suppress:") {
		t.Errorf("%s: should contain X-Auto-Response-Suppress to prevent loops", f)
	}
}

// TestFixture_OOO_IsNotDSN verifies the out-of-office fixture is NOT a DSN —
// it lacks the multipart/report content-type. The classifier should not treat
// it as a hard or soft bounce.
func TestFixture_OOO_IsNotDSN(t *testing.T) {
	const f = "out-of-office-vacation.eml"
	// OOO messages are plain text auto-replies, not delivery status notifications.
	if fixtureContains(t, f, "report-type=delivery-status") {
		t.Errorf("%s: OOO should not contain delivery-status report", f)
	}
}

// TestFixture_OOO_ClassifyBounce_SoftOnAmbiguousContent verifies that if the
// OOO subject/body were mistakenly fed to ClassifyBounce (no delivery-status
// part to extract a real SMTP code), the classifier falls back to BounceSoft
// rather than BounceHard — preserving the contact for future sends.
func TestFixture_OOO_ClassifyBounce_SoftOnAmbiguousContent(t *testing.T) {
	// Simulate: no SMTP code found (empty string), content is benign reply.
	got := ClassifyBounce("", "Automatická odpověď: Out of office (until 15.5.2026)")
	if got != BounceSoft {
		t.Errorf("OOO-like content: ClassifyBounce(\"\", ooo subject) = %s, want soft", got)
	}
}

// ── Fixture 5: Blacklist / reputation rejection ──

// TestFixture_Blacklist_RFC3464Structure verifies the blacklist-rejection
// fixture has proper DSN structure with 5.7.1 status.
func TestFixture_Blacklist_RFC3464Structure(t *testing.T) {
	const f = "blacklist-rejection.eml"
	fixtureRFC3464Headers(t, f)
	fixtureDSNFields(t, f)

	if !fixtureContains(t, f, "Action: failed") {
		t.Errorf("%s: Action must be 'failed' for hard rejection", f)
	}
	if !fixtureContains(t, f, "Status: 5.7.1") {
		t.Errorf("%s: expected Status 5.7.1 for auth/reputation failure", f)
	}
}

// TestFixture_Blacklist_ClassifyBounce verifies that a 5.7.1 delivery-not-
// authorized response is classified as a hard bounce.
func TestFixture_Blacklist_ClassifyBounce(t *testing.T) {
	const f = "blacklist-rejection.eml"
	diagnostic := extractDiagnosticCode(t, f)
	if diagnostic == "" {
		t.Fatalf("%s: could not extract Diagnostic-Code", f)
	}
	got := ClassifyBounce("550", diagnostic)
	if got != BounceHard {
		t.Errorf("fixture %s: ClassifyBounce(550, %q) = %s, want hard", f, diagnostic, got)
	}
}

// ── Classifier edge cases ──

// TestClassifyBounce_MalformedDSN_EmptyCodeAndMessage verifies that a
// completely empty code+message defaults to BounceSoft (fail-open for
// transient unknowns — hard-block requires affirmative evidence).
func TestClassifyBounce_MalformedDSN_EmptyCodeAndMessage(t *testing.T) {
	got := ClassifyBounce("", "")
	if got != BounceSoft {
		t.Errorf("empty code+message: ClassifyBounce = %s, want soft", got)
	}
}

// TestClassifyBounce_SubjectContainsDeliveryButNotDSN verifies that a
// message with "delivery" in the text (but no hard SMTP code or keyword)
// is classified as soft, not hard.
func TestClassifyBounce_SubjectContainsDeliveryButNotDSN(t *testing.T) {
	got := ClassifyBounce("250", "Message accepted for delivery")
	if got != BounceSoft {
		t.Errorf("accepted delivery message: ClassifyBounce = %s, want soft", got)
	}
}

// TestClassifyBounce_UTF8InDiagnosticMessage verifies that non-ASCII
// characters in the diagnostic message (e.g. Czech provider error texts)
// do not cause a panic or misclassification.
func TestClassifyBounce_UTF8InDiagnosticMessage(t *testing.T) {
	cases := []struct {
		code string
		msg  string
		want BounceType
	}{
		// Czech provider: permanent rejection with UTF-8 text
		{"550", "550 Neexistující adresa příjemce (does not exist)", BounceHard},
		// Soft with diacritics
		{"421", "421 Příliš mnoho připojení, zkuste znovu", BounceSoft},
		// Complaint keyword in Czech context still triggers complaint classification
		{"550", "Zpráva označena jako spam (spam detection)", BounceComplaint},
	}
	for _, tc := range cases {
		got := ClassifyBounce(tc.code, tc.msg)
		if got != tc.want {
			t.Errorf("UTF-8 case ClassifyBounce(%q, %q) = %s, want %s", tc.code, tc.msg, got, tc.want)
		}
	}
}

// TestClassifyBounce_MultipleRecipientsDSN_EachExtractedSeparately verifies
// the classifier produces distinct results when called separately for each
// recipient's status from a multi-recipient DSN (the caller is responsible
// for splitting per-recipient blocks before calling ClassifyBounce).
func TestClassifyBounce_MultipleRecipientsDSN_EachExtractedSeparately(t *testing.T) {
	// Recipient 1: hard bounce
	got1 := ClassifyBounce("550", "550 5.1.1 user does not exist")
	if got1 != BounceHard {
		t.Errorf("recipient 1: got %s, want hard", got1)
	}
	// Recipient 2: soft bounce (mailbox temporarily unavailable)
	got2 := ClassifyBounce("452", "452 4.2.2 Mailbox full")
	if got2 != BounceSoft {
		t.Errorf("recipient 2: got %s, want soft", got2)
	}
	// Recipient 3: accepted (no bounce)
	got3 := ClassifyBounce("250", "250 OK message delivered")
	if got3 != BounceSoft {
		t.Errorf("recipient 3 (250 OK): got %s, want soft fallback", got3)
	}
}

// TestClassifyBounce_5xxCodeNotInHardList falls back to soft because
// not all 5xx codes are in the explicit hardCodes list (e.g. "555").
// This tests the boundary between keyword-gated and code-gated logic.
func TestClassifyBounce_5xxCodeNotInHardList_WithKeyword(t *testing.T) {
	// "555" is not in hardCodes but message contains hard keyword → hard
	got := ClassifyBounce("555", "invalid recipient address on this system")
	if got != BounceHard {
		t.Errorf("555 + hard keyword: ClassifyBounce = %s, want hard", got)
	}
}

// TestClassifyBounce_5xxCodeNotInHardList_NoKeyword verifies that a 5xx
// code NOT in the hardCodes list and without a hard keyword → soft bounce.
// This matches ClassifyBounce's behaviour: only 550-554 are unconditionally
// hard; other 5xx codes need a keyword match.
func TestClassifyBounce_5xxCodeNotInHardList_NoKeyword(t *testing.T) {
	// "555" is not in hardCodes; no hard keyword → soft (unknown 5xx treated
	// as transient to avoid over-suppression without clear evidence).
	got := ClassifyBounce("555", "authentication required")
	if got != BounceSoft {
		t.Errorf("555 no keyword: ClassifyBounce = %s, want soft", got)
	}
}

// TestClassifyBounce_StatusCodeMapping verifies the full RFC 5321 / RFC 3463
// enhanced status code surface that the classifier is expected to handle.
func TestClassifyBounce_StatusCodeMapping(t *testing.T) {
	cases := []struct {
		smtpCode string
		msg      string
		want     BounceType
	}{
		// Permanent: user / address errors
		{"550", "5.1.1 user does not exist", BounceHard},
		{"551", "5.1.6 user not local; please try forwarding", BounceHard},
		{"552", "5.2.3 message exceeds maximum size", BounceHard},
		{"553", "5.1.3 bad destination mailbox address syntax", BounceHard},
		{"554", "5.7.0 delivery not authorized, message refused", BounceHard},
		// Transient: temporary failures
		{"421", "4.7.0 service not available, try later", BounceSoft},
		{"450", "4.1.1 requested mailbox action not taken", BounceSoft},
		{"451", "4.3.0 requested action aborted", BounceSoft},
		{"452", "4.2.2 mailbox full", BounceSoft},
		// Complaint override
		{"550", "abuse complaint filed", BounceComplaint},
		{"200", "spam was detected", BounceComplaint},
	}
	for _, tc := range cases {
		got := ClassifyBounce(tc.smtpCode, tc.msg)
		if got != tc.want {
			t.Errorf("ClassifyBounce(%q, %q) = %s, want %s", tc.smtpCode, tc.msg, got, tc.want)
		}
	}
}
