package thread

import (
	"strings"
	"testing"
)

// sampleDSN returns a well-formed RFC 3464 DSN body for the given
// Status code. Reused across test cases to avoid copy-paste drift.
func sampleDSN(status, recipient, diagnostic string) string {
	var sb strings.Builder
	sb.WriteString("This is the mail system at host mx1.gw.test.\r\n\r\n")
	sb.WriteString("I'm sorry to have to inform you that your message could not\r\n")
	sb.WriteString("be delivered to one or more recipients.\r\n\r\n")
	sb.WriteString("Reporting-MTA: dns; mx1.gw.test\r\n")
	sb.WriteString("Final-Recipient: rfc822; " + recipient + "\r\n")
	sb.WriteString("Action: failed\r\n")
	sb.WriteString("Status: " + status + "\r\n")
	sb.WriteString("Diagnostic-Code: smtp; " + diagnostic + "\r\n")
	return sb.String()
}

func TestDetectBounce_HardBounceMailerDaemon(t *testing.T) {
	raw := RawInbound{
		From:      "Mail Delivery Subsystem <MAILER-DAEMON@mx1.gw.test>",
		Subject:   "Undelivered Mail Returned to Sender",
		BodyPlain: sampleDSN("5.1.1", "test@dead.test", "550 5.1.1 User unknown"),
	}
	b := DetectBounce(raw)
	if b.Kind != BounceHard {
		t.Fatalf("kind = %q, want %q", b.Kind, BounceHard)
	}
	if b.DSNCode != "5.1.1" {
		t.Errorf("dsn code = %q, want 5.1.1", b.DSNCode)
	}
	if !strings.Contains(b.Diagnostic, "User unknown") {
		t.Errorf("diagnostic %q missing 'User unknown'", b.Diagnostic)
	}
	if b.FailedRecipient != "test@dead.test" {
		t.Errorf("failed recipient = %q, want test@dead.test", b.FailedRecipient)
	}
}

func TestDetectBounce_SoftBounce(t *testing.T) {
	raw := RawInbound{
		From:      "MAILER-DAEMON@example.test",
		Subject:   "Delivery Status Notification (Delay)",
		BodyPlain: sampleDSN("4.2.2", "full@mailbox-full.test", "452 4.2.2 Mailbox full"),
	}
	b := DetectBounce(raw)
	if b.Kind != BounceSoft {
		t.Fatalf("kind = %q, want %q", b.Kind, BounceSoft)
	}
	if b.DSNCode != "4.2.2" {
		t.Errorf("dsn code = %q, want 4.2.2", b.DSNCode)
	}
}

func TestDetectBounce_NXDOMAIN(t *testing.T) {
	raw := RawInbound{
		From:      "MAILER-DAEMON@mx.outreach.test",
		Subject:   "Undelivered Mail Returned to Sender",
		BodyPlain: sampleDSN("5.1.2", "alice@blocked-domain.test", "550 5.1.2 Domain not found"),
	}
	b := DetectBounce(raw)
	if b.Kind != BounceHard {
		t.Errorf("NXDOMAIN should be hard, got %q", b.Kind)
	}
	if b.DSNCode != "5.1.2" {
		t.Errorf("dsn code = %q, want 5.1.2", b.DSNCode)
	}
}

func TestDetectBounce_SpamReject(t *testing.T) {
	raw := RawInbound{
		From:      "postmaster@recipient.test",
		Subject:   "Message rejected",
		BodyPlain: sampleDSN("5.7.1", "bob@corp.test", "554 5.7.1 Rejected as spam"),
	}
	b := DetectBounce(raw)
	if b.Kind != BounceHard {
		t.Errorf("spam reject should be hard, got %q", b.Kind)
	}
}

func TestDetectBounce_ActionDelayedDowngrades(t *testing.T) {
	// Some MTAs emit a 5.x.x status with Action: delayed during the
	// retry queue phase. We honour the Action hint and downgrade to
	// soft so the contact isn't permanently suppressed.
	body := sampleDSN("5.2.0", "x@y.test", "temporary failure")
	body = strings.Replace(body, "Action: failed", "Action: delayed", 1)
	raw := RawInbound{
		From:      "MAILER-DAEMON@example.test",
		Subject:   "Delivery delayed",
		BodyPlain: body,
	}
	b := DetectBounce(raw)
	if b.Kind != BounceSoft {
		t.Errorf("Action: delayed with 5.x.x should downgrade to soft, got %q", b.Kind)
	}
}

func TestDetectBounce_NotABounce_NormalReply(t *testing.T) {
	// A legitimate Czech reply must not trigger the bounce path — the
	// wording above already sets many false-positive traps.
	raw := RawInbound{
		From:      "jan.novak@prospect.test",
		Subject:   "Re: Nabídka spolupráce",
		BodyPlain: "Dobrý den, děkuji za zprávu. Máme zájem, pošlete prosím detaily.",
	}
	if got := DetectBounce(raw); got.IsBounce() {
		t.Errorf("regular reply misdetected as bounce: %+v", got)
	}
}

func TestDetectBounce_NotABounce_InterestedReply(t *testing.T) {
	// Specifically exercise the previous production bug where the DSN
	// body phrase "I'm sorry to have to inform you" collided with no
	// real reply.
	raw := RawInbound{
		From:      "buyer@prospect.test",
		Subject:   "Re: Stroje",
		BodyPlain: "Ahoj, díky za nabídku — pojďme si zavolat příští týden.",
	}
	if got := DetectBounce(raw); got.IsBounce() {
		t.Errorf("interested reply misdetected as bounce: %+v", got)
	}
}

func TestDetectBounce_Fallback_PlainNDR(t *testing.T) {
	// Older NDR messages with no structured Status: line should still
	// classify as hard via the fallback heuristics.
	raw := RawInbound{
		From:      "MAILER-DAEMON@old.mta.test",
		Subject:   "Undelivered mail",
		BodyPlain: "Sorry, user unknown at recipient.test",
	}
	b := DetectBounce(raw)
	if b.Kind != BounceHard {
		t.Errorf("plain NDR should fall back to hard bounce, got %q", b.Kind)
	}
}

func TestDetectBounce_Fallback_PlainDelayed(t *testing.T) {
	raw := RawInbound{
		From:      "postmaster@greylist.test",
		Subject:   "Message delayed — will retry",
		BodyPlain: "Temporary failure, will retry in 15 minutes.",
	}
	b := DetectBounce(raw)
	if b.Kind != BounceSoft {
		t.Errorf("plain delayed NDR should be soft, got %q", b.Kind)
	}
}

func TestDetectBounce_NoSignalAtAll(t *testing.T) {
	// Completely inert message — neither sender nor subject nor body
	// hints. Must return BounceNone so it falls through to the reply
	// classifier untouched.
	raw := RawInbound{
		From:      "ceo@prospect.test",
		Subject:   "Request for proposal",
		BodyPlain: "We would like to request a proposal.",
	}
	if got := DetectBounce(raw); got.IsBounce() {
		t.Errorf("non-bounce misdetected: %+v", got)
	}
}

// TestDetectBounce_RawBytesFallback_MultipartReport reproduces the
// real-world leak: a multipart/report DSN keeps Status/Action/Final-Recipient
// in its message/delivery-status part (which mime.Parse files as an
// attachment), and the inbound pipeline overwrites BodyPlain with the
// human-readable part before DetectBounce runs. The DSN must still be
// detected — and its fields extracted — by falling back to the full RawBytes.
func TestDetectBounce_RawBytesFallback_MultipartReport(t *testing.T) {
	rawDSN := "From: MAILER-DAEMON@mx.seznam.cz\r\n" +
		"Subject: Undeliverable: Nabídka\r\n" +
		"Content-Type: multipart/report; report-type=delivery-status; boundary=\"BOUND\"\r\n" +
		"\r\n" +
		"--BOUND\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n\r\n" +
		"Vaše zpráva nebyla doručena jednomu nebo více příjemcům.\r\n" +
		"--BOUND\r\n" +
		"Content-Type: message/delivery-status\r\n\r\n" +
		"Reporting-MTA: dns; mx.seznam.cz\r\n" +
		"Final-Recipient: rfc822; jan@nezijici.cz\r\n" +
		"Action: failed\r\n" +
		"Status: 5.1.1\r\n" +
		"Diagnostic-Code: smtp; 550 5.1.1 User unknown\r\n" +
		"--BOUND--\r\n"
	raw := RawInbound{
		From:    "MAILER-DAEMON@mx.seznam.cz",
		Subject: "Undeliverable: Nabídka",
		// BodyPlain holds only the human-readable part (the overwrite upstream
		// strips the machine-readable delivery-status block).
		BodyPlain: "Vaše zpráva nebyla doručena jednomu nebo více příjemcům.",
		RawBytes:  []byte(rawDSN),
	}
	b := DetectBounce(raw)
	if b.Kind != BounceHard {
		t.Fatalf("kind = %q, want %q (Status only in RawBytes delivery-status part)", b.Kind, BounceHard)
	}
	if b.DSNCode != "5.1.1" {
		t.Errorf("dsn code = %q, want 5.1.1", b.DSNCode)
	}
	if b.FailedRecipient != "jan@nezijici.cz" {
		t.Errorf("failed recipient = %q, want jan@nezijici.cz", b.FailedRecipient)
	}
	if !strings.Contains(b.Diagnostic, "User unknown") {
		t.Errorf("diagnostic %q missing 'User unknown'", b.Diagnostic)
	}
}

// TestDetectBounce_Fallback_MicrosoftUndeliverable covers the Outlook/Exchange
// NDR subject "Undeliverable:" — NOT a substring of "undelivered", so the
// pre-fix keyword set missed it entirely.
func TestDetectBounce_Fallback_MicrosoftUndeliverable(t *testing.T) {
	raw := RawInbound{
		From:      "postmaster@corp.example",
		Subject:   "Undeliverable: Re: Nabídka strojů",
		BodyPlain: "Your message to bob@corp.example couldn't be delivered.",
	}
	if got := DetectBounce(raw); got.Kind != BounceHard {
		t.Errorf("Microsoft 'Undeliverable:' NDR should be hard, got %q", got.Kind)
	}
}

// TestDetectBounce_Fallback_CzechNedorucitelna covers Seznam/Centrum localized
// bounce subjects.
func TestDetectBounce_Fallback_CzechNedorucitelna(t *testing.T) {
	raw := RawInbound{
		From:      "MAILER-DAEMON@seznam.cz",
		Subject:   "Zpráva je nedoručitelná",
		BodyPlain: "Tato zpráva nemohla být doručena.",
	}
	if got := DetectBounce(raw); got.Kind != BounceHard {
		t.Errorf("Czech 'nedoručitelná' NDR should be hard, got %q", got.Kind)
	}
}

// TestDetectBounce_Fallback_MailerDaemonNoKeyword_Soft verifies that a
// confirmed MAILER-DAEMON envelope with no structured DSN and no recognized
// phrase is still treated as (at least) a soft bounce — the reply classifier
// must not see it as an interested reply.
func TestDetectBounce_Fallback_MailerDaemonNoKeyword_Soft(t *testing.T) {
	raw := RawInbound{
		From:      "Mail Delivery System <MAILER-DAEMON@mta.test>",
		Subject:   "Delivery Status Notification",
		BodyPlain: "The mail system encountered a problem handling your message.",
	}
	got := DetectBounce(raw)
	if got.Kind != BounceSoft {
		t.Errorf("MAILER-DAEMON envelope w/o keyword should be soft, got %q", got.Kind)
	}
	if !got.IsBounce() {
		t.Error("MAILER-DAEMON envelope should be classified as a bounce")
	}
}

func TestDetectBounce_XFailedRecipientsHeader(t *testing.T) {
	// Some Google Workspace bounces rewrite From to the end user but
	// include X-Failed-Recipients in the envelope — we treat that as
	// a strong hint for the gate.
	raw := RawInbound{
		From:      "user@group.test",
		Subject:   "Delivery Status Notification (Failure)",
		BodyPlain: "X-Failed-Recipients: blocked@list.test\r\n\r\nStatus: 5.1.1",
	}
	b := DetectBounce(raw)
	if b.Kind != BounceHard {
		t.Errorf("X-Failed-Recipients DSN should parse as hard, got %+v", b)
	}
}
