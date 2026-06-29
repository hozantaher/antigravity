// Package mailsim provides a local-only email-pipeline simulator that
// replicates the production outbound/inbound lifecycle on a developer
// machine. The simulator:
//
//   - polls Mailpit (which catches all outbound SMTP from the dev
//     outreach sender),
//   - classifies each recipient into a behaviour bucket (dead mailbox,
//     full inbox, OOO, happy reply, silent, …),
//   - generates the appropriate response — RFC 3464 DSN bounce for dead
//     mailboxes, RFC 3834 auto-reply for OOO, handcrafted Czech reply
//     text for happy responders,
//   - injects that response back into GreenMail IMAP (port 1144) so the
//     production `poll` command picks it up exactly as it would in
//     production.
//
// Nothing in this package touches a real SMTP relay or DNS — all
// senders/recipients stay inside the .test TLD and the localhost
// Mailpit/GreenMail containers.
package mailsim

import (
	"fmt"
	"strings"
)

// Behavior describes how a given recipient address will behave when
// the outreach sender tries to deliver to it. Behaviours are what makes
// the localhost simulation statistically close to a real campaign:
// 5 % of real prospects bounce hard, a few percent are full mailboxes,
// some are on vacation, most simply never reply.
type Behavior string

const (
	// BehaviorDeliver — normal delivery, no response. The default
	// for most addresses: the mail lands, nobody replies, thread stays
	// in "sent" forever. This is ~80 % of real campaigns.
	BehaviorDeliver Behavior = "deliver"

	// BehaviorHardBounce — address is dead. Mailer-daemon returns a
	// DSN with a 5.x.x code (permanent failure). Contact should be
	// auto-suppressed downstream.
	BehaviorHardBounce Behavior = "hard_bounce"

	// BehaviorDomainNXDOMAIN — the domain itself has no MX record.
	// DSN 5.1.2 "Host unknown" is returned. Useful for exercising the
	// domain-level suppression path.
	BehaviorDomainNXDOMAIN Behavior = "domain_nxdomain"

	// BehaviorSoftBounce — temporary failure (mailbox full, server
	// over quota, greylist). DSN 4.x.x; sender usually retries.
	BehaviorSoftBounce Behavior = "soft_bounce"

	// BehaviorSpamReject — MTA's spam filter rejects the message
	// (5.7.1 "Message content rejected as spam"). Treated like a hard
	// bounce in consent scoring but carries a different reason code.
	BehaviorSpamReject Behavior = "spam_reject"

	// BehaviorOOO — recipient exists but is out of office. An RFC 3834
	// auto-reply comes back with Auto-Submitted: auto-replied.
	BehaviorOOO Behavior = "ooo"

	// BehaviorReplyInterested — enthusiastic reply. After a short
	// delay the recipient "replies" with a positive Czech text. Used
	// to exercise the intelligence loop's classifier.
	BehaviorReplyInterested Behavior = "reply_interested"

	// BehaviorReplyMeeting — recipient suggests a meeting time.
	BehaviorReplyMeeting Behavior = "reply_meeting"

	// BehaviorReplyLater — recipient asks to follow up in N weeks.
	BehaviorReplyLater Behavior = "reply_later"

	// BehaviorReplyObjection — recipient objects but is not hostile.
	BehaviorReplyObjection Behavior = "reply_objection"

	// BehaviorReplyNegative — recipient asks to be removed.
	BehaviorReplyNegative Behavior = "reply_negative"

	// BehaviorSilent — accepted by MTA but the human never opens it.
	// Indistinguishable from BehaviorDeliver at the MTA level; we keep
	// it separate so tests can reason about "ghost" recipients
	// explicitly.
	BehaviorSilent Behavior = "silent"
)

// BehaviorWeights captures the rough prod-observed probability of each
// outcome. Used by the prodlike seed to tag contacts and by the
// bouncer as a default when the registry has no explicit entry.
var BehaviorWeights = []struct {
	Behavior Behavior
	Weight   int
}{
	{BehaviorDeliver, 600},         // 60 % baseline: delivered, no reply (soon)
	{BehaviorSilent, 200},          // 20 % ghosts (same MTA path as deliver)
	{BehaviorReplyInterested, 30},  // 3 %
	{BehaviorReplyMeeting, 20},     // 2 %
	{BehaviorReplyLater, 25},       // 2.5 %
	{BehaviorReplyObjection, 15},   // 1.5 %
	{BehaviorReplyNegative, 15},    // 1.5 %
	{BehaviorOOO, 30},              // 3 %
	{BehaviorHardBounce, 40},       // 4 %
	{BehaviorSoftBounce, 15},       // 1.5 %
	{BehaviorDomainNXDOMAIN, 5},    // 0.5 %
	{BehaviorSpamReject, 5},        // 0.5 %
}

// IsBounce returns true for any behaviour that produces a DSN.
func (b Behavior) IsBounce() bool {
	switch b {
	case BehaviorHardBounce, BehaviorDomainNXDOMAIN, BehaviorSoftBounce, BehaviorSpamReject:
		return true
	}
	return false
}

// IsReply returns true for any behaviour that produces an actual
// human-looking reply message (excluding OOO, which is classified
// separately by the intelligence loop).
func (b Behavior) IsReply() bool {
	switch b {
	case BehaviorReplyInterested, BehaviorReplyMeeting, BehaviorReplyLater,
		BehaviorReplyObjection, BehaviorReplyNegative:
		return true
	}
	return false
}

// DSNCode returns the SMTP enhanced status code associated with this
// behaviour. Empty string for non-bounce behaviours.
func (b Behavior) DSNCode() string {
	switch b {
	case BehaviorHardBounce:
		return "5.1.1" // bad destination mailbox address
	case BehaviorDomainNXDOMAIN:
		return "5.1.2" // bad destination system address
	case BehaviorSoftBounce:
		return "4.2.2" // mailbox full
	case BehaviorSpamReject:
		return "5.7.1" // delivery not authorised / spam
	}
	return ""
}

// DSNText returns the human-readable diagnostic line used in the DSN.
func (b Behavior) DSNText() string {
	switch b {
	case BehaviorHardBounce:
		return "550 5.1.1 <%s>: Recipient address rejected: User unknown in local recipient table"
	case BehaviorDomainNXDOMAIN:
		return "550 5.1.2 <%s>: Recipient address rejected: Domain not found"
	case BehaviorSoftBounce:
		return "452 4.2.2 <%s>: Recipient address rejected: Mailbox full"
	case BehaviorSpamReject:
		return "554 5.7.1 <%s>: Message rejected as spam by local policy"
	}
	return ""
}

// formatDiagnostic injects the recipient address into the diagnostic
// template. A convenience wrapper around DSNText.
func (b Behavior) formatDiagnostic(recipient string) string {
	t := b.DSNText()
	if t == "" {
		return ""
	}
	return fmt.Sprintf(t, recipient)
}

// Classify returns the Behavior for a given recipient address based on
// a simple pattern matcher. The rules are ordered — first match wins.
// Rules use glob-style prefix/suffix wildcards; a match against
// "*@blocked-domain.test" catches any local part on that domain.
//
// This default classifier is intentionally simple; richer logic lives
// in the Registry type (see registry.go) which supports per-contact
// overrides stored in the database.
func Classify(address string) Behavior {
	a := strings.ToLower(address)

	// Hard bounces: well-known test patterns
	switch {
	case strings.HasPrefix(a, "test@"),
		strings.HasPrefix(a, "noone@"),
		strings.HasPrefix(a, "nobody@"),
		strings.HasPrefix(a, "unknown@"),
		strings.HasPrefix(a, "null@"),
		strings.HasPrefix(a, "deleted@"),
		strings.Contains(a, "-dead@"),
		strings.HasPrefix(a, "asdf@"):
		return BehaviorHardBounce
	}

	// Domain-level NXDOMAIN
	if strings.HasSuffix(a, "@blocked-domain.test") ||
		strings.HasSuffix(a, "@nxdomain.test") ||
		strings.HasSuffix(a, "@deadhost.test") {
		return BehaviorDomainNXDOMAIN
	}

	// Soft bounces: mailbox full
	if strings.HasPrefix(a, "full@") || strings.Contains(a, "-full@") {
		return BehaviorSoftBounce
	}

	// Spam rejection
	if strings.HasPrefix(a, "spam-trap@") || strings.HasPrefix(a, "abuse@") {
		return BehaviorSpamReject
	}

	// Out of office
	if strings.Contains(a, "-ooo@") || strings.HasPrefix(a, "ooo@") {
		return BehaviorOOO
	}

	// Explicit reply behaviours (seed generator tags these patterns)
	switch {
	case strings.Contains(a, "-interested@"):
		return BehaviorReplyInterested
	case strings.Contains(a, "-meeting@"):
		return BehaviorReplyMeeting
	case strings.Contains(a, "-later@"):
		return BehaviorReplyLater
	case strings.Contains(a, "-objection@"):
		return BehaviorReplyObjection
	case strings.Contains(a, "-negative@"):
		return BehaviorReplyNegative
	case strings.Contains(a, "-silent@") || strings.Contains(a, "-ghost@"):
		return BehaviorSilent
	}

	// Default: deliver silently (most addresses in a real campaign).
	return BehaviorDeliver
}
