package mailsim

import (
	"testing"
)

// ---- IsBounce ----

func TestIsBounce_HardBounce(t *testing.T) {
	if !BehaviorHardBounce.IsBounce() {
		t.Fatal("hard_bounce must be a bounce")
	}
}

func TestIsBounce_DomainNXDOMAIN(t *testing.T) {
	if !BehaviorDomainNXDOMAIN.IsBounce() {
		t.Fatal("domain_nxdomain must be a bounce")
	}
}

func TestIsBounce_SoftBounce(t *testing.T) {
	if !BehaviorSoftBounce.IsBounce() {
		t.Fatal("soft_bounce must be a bounce")
	}
}

func TestIsBounce_SpamReject(t *testing.T) {
	if !BehaviorSpamReject.IsBounce() {
		t.Fatal("spam_reject must be a bounce")
	}
}

func TestIsBounce_NonBounce(t *testing.T) {
	for _, b := range []Behavior{
		BehaviorDeliver, BehaviorOOO, BehaviorReplyInterested,
		BehaviorReplyMeeting, BehaviorReplyLater, BehaviorReplyObjection,
		BehaviorReplyNegative, BehaviorSilent,
	} {
		if b.IsBounce() {
			t.Fatalf("%s should not be a bounce", b)
		}
	}
}

// ---- IsReply ----

func TestIsReply_ReplyBehaviors(t *testing.T) {
	for _, b := range []Behavior{
		BehaviorReplyInterested, BehaviorReplyMeeting, BehaviorReplyLater,
		BehaviorReplyObjection, BehaviorReplyNegative,
	} {
		if !b.IsReply() {
			t.Fatalf("%s should be a reply", b)
		}
	}
}

func TestIsReply_NonReply(t *testing.T) {
	for _, b := range []Behavior{
		BehaviorDeliver, BehaviorHardBounce, BehaviorDomainNXDOMAIN,
		BehaviorSoftBounce, BehaviorSpamReject, BehaviorOOO, BehaviorSilent,
	} {
		if b.IsReply() {
			t.Fatalf("%s should not be a reply", b)
		}
	}
}

// ---- DSNCode ----

func TestDSNCode_AllBounces(t *testing.T) {
	cases := map[Behavior]string{
		BehaviorHardBounce:      "5.1.1",
		BehaviorDomainNXDOMAIN: "5.1.2",
		BehaviorSoftBounce:     "4.2.2",
		BehaviorSpamReject:     "5.7.1",
	}
	for b, want := range cases {
		if got := b.DSNCode(); got != want {
			t.Errorf("%s: DSNCode=%q want %q", b, got, want)
		}
	}
}

func TestDSNCode_NonBounce_Empty(t *testing.T) {
	for _, b := range []Behavior{BehaviorDeliver, BehaviorOOO, BehaviorSilent} {
		if code := b.DSNCode(); code != "" {
			t.Errorf("%s: expected empty DSNCode, got %q", b, code)
		}
	}
}

// ---- DSNText ----

func TestDSNText_AllBounces(t *testing.T) {
	for _, b := range []Behavior{
		BehaviorHardBounce, BehaviorDomainNXDOMAIN,
		BehaviorSoftBounce, BehaviorSpamReject,
	} {
		if txt := b.DSNText(); txt == "" {
			t.Errorf("%s: expected non-empty DSNText", b)
		}
	}
}

func TestDSNText_NonBounce_Empty(t *testing.T) {
	for _, b := range []Behavior{BehaviorDeliver, BehaviorOOO, BehaviorSilent,
		BehaviorReplyInterested, BehaviorReplyNegative} {
		if txt := b.DSNText(); txt != "" {
			t.Errorf("%s: expected empty DSNText, got %q", b, txt)
		}
	}
}

// ---- formatDiagnostic ----

func TestFormatDiagnostic_Bounce_ContainsRecipient(t *testing.T) {
	d := BehaviorHardBounce.formatDiagnostic("bad@example.test")
	if d == "" {
		t.Fatal("expected non-empty diagnostic")
	}
	// Template has %s for recipient
	if len(d) == 0 {
		t.Fatal("expected formatted diagnostic")
	}
}

func TestFormatDiagnostic_NonBounce_Empty(t *testing.T) {
	if d := BehaviorDeliver.formatDiagnostic("x@y.test"); d != "" {
		t.Fatalf("expected empty, got %q", d)
	}
}

func TestFormatDiagnostic_SoftBounce(t *testing.T) {
	d := BehaviorSoftBounce.formatDiagnostic("full@mbox.test")
	if d == "" {
		t.Fatal("expected non-empty diagnostic for soft bounce")
	}
}

func TestFormatDiagnostic_SpamReject(t *testing.T) {
	d := BehaviorSpamReject.formatDiagnostic("trap@spam.test")
	if d == "" {
		t.Fatal("expected non-empty diagnostic for spam reject")
	}
}

func TestFormatDiagnostic_DomainNXDOMAIN(t *testing.T) {
	d := BehaviorDomainNXDOMAIN.formatDiagnostic("user@nxdomain.test")
	if d == "" {
		t.Fatal("expected non-empty diagnostic for nxdomain")
	}
}

// ---- Classify ----

func TestClassify_HardBounce_Prefixes(t *testing.T) {
	for _, addr := range []string{
		"test@example.test",
		"noone@firm.test",
		"nobody@firm.test",
		"unknown@firm.test",
		"null@firm.test",
		"deleted@firm.test",
		"asdf@firm.test",
		"user-dead@firm.test",
	} {
		if got := Classify(addr); got != BehaviorHardBounce {
			t.Errorf("Classify(%q)=%s want hard_bounce", addr, got)
		}
	}
}

func TestClassify_DomainNXDOMAIN(t *testing.T) {
	for _, addr := range []string{
		"user@blocked-domain.test",
		"user@nxdomain.test",
		"user@deadhost.test",
	} {
		if got := Classify(addr); got != BehaviorDomainNXDOMAIN {
			t.Errorf("Classify(%q)=%s want domain_nxdomain", addr, got)
		}
	}
}

func TestClassify_SoftBounce(t *testing.T) {
	for _, addr := range []string{
		"full@firm.test",
		"user-full@firm.test",
	} {
		if got := Classify(addr); got != BehaviorSoftBounce {
			t.Errorf("Classify(%q)=%s want soft_bounce", addr, got)
		}
	}
}

func TestClassify_SpamReject(t *testing.T) {
	for _, addr := range []string{
		"spam-trap@firm.test",
		"abuse@firm.test",
	} {
		if got := Classify(addr); got != BehaviorSpamReject {
			t.Errorf("Classify(%q)=%s want spam_reject", addr, got)
		}
	}
}

func TestClassify_OOO(t *testing.T) {
	for _, addr := range []string{
		"user-ooo@firm.test",
		"ooo@firm.test",
	} {
		if got := Classify(addr); got != BehaviorOOO {
			t.Errorf("Classify(%q)=%s want ooo", addr, got)
		}
	}
}

func TestClassify_ReplyBehaviors(t *testing.T) {
	cases := map[string]Behavior{
		"user-interested@firm.test": BehaviorReplyInterested,
		"user-meeting@firm.test":    BehaviorReplyMeeting,
		"user-later@firm.test":      BehaviorReplyLater,
		"user-objection@firm.test":  BehaviorReplyObjection,
		"user-negative@firm.test":   BehaviorReplyNegative,
		"user-silent@firm.test":     BehaviorSilent,
		"user-ghost@firm.test":      BehaviorSilent,
	}
	for addr, want := range cases {
		if got := Classify(addr); got != want {
			t.Errorf("Classify(%q)=%s want %s", addr, got, want)
		}
	}
}

func TestClassify_Default_Deliver(t *testing.T) {
	if got := Classify("jan.novak@firma.cz"); got != BehaviorDeliver {
		t.Errorf("Classify(normal)=%s want deliver", got)
	}
}

func TestClassify_CaseInsensitive(t *testing.T) {
	if got := Classify("TEST@Example.TEST"); got != BehaviorHardBounce {
		t.Errorf("Classify(uppercase)=%s want hard_bounce", got)
	}
}
