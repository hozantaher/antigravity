package mailsim

import (
	"strings"
	"testing"
	"time"
)

// TestClassifyHardBounce — dead-mailbox patterns must classify as hard
// bounces so the DSN path gets exercised.
func TestClassifyHardBounce(t *testing.T) {
	hardBounceAddrs := []string{
		"test@example.test",
		"noone@example.test",
		"nobody@acme.test",
		"unknown@corp.test",
		"null@null.test",
		"deleted@past.test",
		"alice-dead@company.test",
	}
	for _, a := range hardBounceAddrs {
		if got := Classify(a); got != BehaviorHardBounce {
			t.Errorf("Classify(%q) = %q, want %q", a, got, BehaviorHardBounce)
		}
	}
}

// TestClassifyNXDOMAIN — blocked-domain.test etc. must flag as domain
// failure. This lets us distinguish domain-level bounces from per-mailbox
// failures in suppression logic.
func TestClassifyNXDOMAIN(t *testing.T) {
	for _, a := range []string{
		"alice@blocked-domain.test",
		"bob@nxdomain.test",
		"ceo@deadhost.test",
	} {
		if got := Classify(a); got != BehaviorDomainNXDOMAIN {
			t.Errorf("Classify(%q) = %q, want %q", a, got, BehaviorDomainNXDOMAIN)
		}
	}
}

// TestClassifyReplies — the inline reply patterns must round-trip
// through Classify into their corresponding Behavior.
func TestClassifyReplies(t *testing.T) {
	cases := map[string]Behavior{
		"jana-interested@corp.test": BehaviorReplyInterested,
		"karel-meeting@corp.test":   BehaviorReplyMeeting,
		"lada-later@corp.test":      BehaviorReplyLater,
		"milan-objection@corp.test": BehaviorReplyObjection,
		"nina-negative@corp.test":   BehaviorReplyNegative,
		"petr-ooo@corp.test":        BehaviorOOO,
		"quido-silent@corp.test":    BehaviorSilent,
		"rada-ghost@corp.test":      BehaviorSilent,
	}
	for addr, want := range cases {
		if got := Classify(addr); got != want {
			t.Errorf("Classify(%q) = %q, want %q", addr, got, want)
		}
	}
}

// TestClassifyDefault — plain addresses should just deliver.
func TestClassifyDefault(t *testing.T) {
	for _, a := range []string{
		"jan.novak@acme.test",
		"info@strojirna-001.test",
		"petra.kralova@stroje-novak.test",
	} {
		if got := Classify(a); got != BehaviorDeliver {
			t.Errorf("Classify(%q) = %q, want %q", a, got, BehaviorDeliver)
		}
	}
}

// TestBehaviorDSNCodes — each bounce behaviour returns the right SMTP
// enhanced status code. Drift here would make bounce classifiers in
// the intelligence loop misread severities.
func TestBehaviorDSNCodes(t *testing.T) {
	cases := map[Behavior]string{
		BehaviorHardBounce:     "5.1.1",
		BehaviorDomainNXDOMAIN: "5.1.2",
		BehaviorSoftBounce:     "4.2.2",
		BehaviorSpamReject:     "5.7.1",
		BehaviorOOO:            "",
		BehaviorDeliver:        "",
	}
	for b, want := range cases {
		if got := b.DSNCode(); got != want {
			t.Errorf("%q.DSNCode() = %q, want %q", b, got, want)
		}
	}
}

// TestDSNBuilderShape — the generated DSN must carry all mandatory
// fields the intelligence-loop bounce parser looks for.
func TestDSNBuilderShape(t *testing.T) {
	b := DefaultDSNBuilder()
	orig := &OriginalMessage{
		From:      "outreach@test.local",
		To:        "test@dead.test",
		Subject:   "Nabídka odkoupení strojů",
		MessageID: "<orig-abc@outreach.test>",
		Date:      time.Date(2026, 4, 16, 10, 0, 0, 0, time.UTC),
	}
	dsn, err := b.Build(orig, BehaviorHardBounce, orig.To)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	s := string(dsn)

	// Structural checks every DSN must satisfy.
	mustContain := []string{
		"From: Mail Delivery Subsystem",
		"To: outreach@test.local",
		"Subject: Undelivered Mail Returned to Sender",
		"Content-Type: multipart/report; report-type=delivery-status",
		"Reporting-MTA: dns; mx1.gw.test",
		"Final-Recipient: rfc822; test@dead.test",
		"Action: failed",
		"Status: 5.1.1",
		"Diagnostic-Code: smtp; 550 5.1.1",
		"Message-ID: <orig-abc@outreach.test>",  // original referenced in Part 3
		"In-Reply-To: <orig-abc@outreach.test>", // thread stitching in top headers
	}
	for _, piece := range mustContain {
		if !strings.Contains(s, piece) {
			t.Errorf("DSN missing %q\n--full DSN--\n%s", piece, s)
		}
	}
	// Boundary must close.
	boundary := extractBoundary(s)
	if boundary == "" {
		t.Fatalf("no boundary in DSN headers")
	}
	if !strings.Contains(s, "--"+boundary+"--") {
		t.Errorf("DSN missing closing boundary %q", boundary)
	}
}

// TestDSNBuilderRejectsNonBounce — asking for a DSN on a deliver/reply
// behaviour is a programmer error; the builder must refuse.
func TestDSNBuilderRejectsNonBounce(t *testing.T) {
	b := DefaultDSNBuilder()
	orig := &OriginalMessage{From: "a@b.test", Subject: "x"}
	if _, err := b.Build(orig, BehaviorDeliver, "x@y.test"); err == nil {
		t.Error("expected error for deliver behavior")
	}
	if _, err := b.Build(orig, BehaviorReplyInterested, "x@y.test"); err == nil {
		t.Error("expected error for reply behavior")
	}
}

// TestReplyBuilderOOOHeaders — OOO replies need RFC 3834 headers so the
// intelligence loop can mark them as auto-replies, not genuine interest.
func TestReplyBuilderOOOHeaders(t *testing.T) {
	rb := DefaultReplyBuilder()
	orig := &OriginalMessage{
		From:      "outreach@test.local",
		To:        "ceo@acme.test",
		Subject:   "Nabídka",
		MessageID: "<orig-123@out.test>",
	}
	msg, err := rb.Build(orig, BehaviorOOO, orig.To)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	s := string(msg)
	for _, h := range []string{
		"Auto-Submitted: auto-replied",
		"Precedence: bulk",
		"Subject: Re: Nabídka",
		"In-Reply-To: <orig-123@out.test>",
	} {
		if !strings.Contains(s, h) {
			t.Errorf("OOO reply missing %q", h)
		}
	}
}

// TestReplyBuilderHumanReply — real replies must NOT carry
// Auto-Submitted, otherwise the intelligence loop would treat them as
// OOO and skip sentiment classification.
func TestReplyBuilderHumanReply(t *testing.T) {
	rb := DefaultReplyBuilder()
	orig := &OriginalMessage{
		From: "outreach@test.local", To: "bob@corp.test",
		Subject: "Hi", MessageID: "<x@y.test>",
	}
	msg, err := rb.Build(orig, BehaviorReplyInterested, orig.To)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	s := string(msg)
	if strings.Contains(s, "Auto-Submitted:") {
		t.Error("human reply must not include Auto-Submitted header")
	}
}

// TestReplyBuilderDeterminism — same Message-ID always picks the same
// variant body. Matters for fixture snapshot tests.
func TestReplyBuilderDeterminism(t *testing.T) {
	rb := DefaultReplyBuilder()
	orig := &OriginalMessage{
		From: "a@b.test", To: "c@d.test",
		Subject: "x", MessageID: "<stable@x.test>",
	}
	a, _ := rb.Build(orig, BehaviorReplyInterested, orig.To)
	b, _ := rb.Build(orig, BehaviorReplyInterested, orig.To)

	// Message-IDs will differ (each Build generates its own) but the
	// body paragraph must match. Extract bodies by splitting on the
	// blank line that terminates headers.
	parseBody := func(msg []byte) string {
		parts := strings.SplitN(string(msg), "\r\n\r\n", 2)
		if len(parts) != 2 {
			return ""
		}
		return parts[1]
	}
	if parseBody(a) != parseBody(b) {
		t.Errorf("reply body not deterministic for same Message-ID")
	}
}

// TestBuilderBracketed — Message-ID normalisation must work for both
// wrapped and bare inputs.
func TestBuilderBracketed(t *testing.T) {
	for input, want := range map[string]string{
		"abc@x.test":   "<abc@x.test>",
		"<abc@x.test>": "<abc@x.test>",
		"":             "",
	} {
		if got := bracketed(input); got != want {
			t.Errorf("bracketed(%q) = %q, want %q", input, got, want)
		}
	}
}

// extractBoundary pulls the MIME boundary out of a message's
// Content-Type header. Returns "" if not found.
func extractBoundary(s string) string {
	const marker = `boundary="`
	i := strings.Index(s, marker)
	if i < 0 {
		return ""
	}
	rest := s[i+len(marker):]
	j := strings.IndexByte(rest, '"')
	if j < 0 {
		return ""
	}
	return rest[:j]
}
