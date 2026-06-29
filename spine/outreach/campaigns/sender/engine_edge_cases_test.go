package sender

import (
	"common/config"
	"errors"
	"strings"
	"testing"
	"time"
)

// AW6 edge-case coverage — boundary conditions across the send pipeline that
// were not previously asserted. Each test pins a specific gating behaviour
// that was either implicit, intuited, or reasoned-through but not codified.
//
// Cross-references:
//   - engine.go: allowDomain (per-domain hour cap + greylisting deferral)
//   - engine.go: mailboxSpacingOK (per-mailbox spacing dampener)
//   - engine.go: buildMessage (MIME header sanitization)
//   - engine.go: recordSendResult (greylisting backoff schedule)
//   - backoff.go: greylistingBackoff (15m / 1h / 4h / 24h schedule)

// ── allowDomain edge cases ────────────────────────────────────────────────

// MaxPerDomainHour=0 must block every domain (cap is "less-than", so 0 < 0
// is false, blocking immediately). Documents the operator-controlled
// kill-switch case where domain sends are temporarily fully paused.
func TestAllowDomain_ZeroCapBlocksAll(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{MaxPerDomainHour: 0}, config.SafetyConfig{})
	if e.allowDomain("any.cz") {
		t.Error("MaxPerDomainHour=0 must block all domains immediately (kill-switch semantics)")
	}
}

// Negative cap is a misconfiguration that must also block (degenerate case
// of the same comparison). Asserts the engine fails closed for nonsensical
// operator input rather than panicking or treating it as unlimited.
func TestAllowDomain_NegativeCapBlocksAll(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{MaxPerDomainHour: -5}, config.SafetyConfig{})
	if e.allowDomain("any.cz") {
		t.Error("negative cap must block (fail-closed on misconfiguration)")
	}
}

// Greylisting deferral expiry — once now() ≥ domainDeferredUntil, the next
// call to allowDomain must clear the deferral and permit the send (subject
// to the hourly cap). This is the recovery contract: greylist expires
// silently, queue resumes.
func TestAllowDomain_GreylistDeferralExpires(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{MaxPerDomainHour: 100}, config.SafetyConfig{})
	e.mu.Lock()
	e.domainDeferredUntil["seznam.cz"] = time.Now().Add(-1 * time.Second) // expired 1s ago
	e.mu.Unlock()
	if !e.allowDomain("seznam.cz") {
		t.Error("expired greylisting deferral should not block; expected allow after expiry")
	}
}

// Active greylisting deferral blocks even when the hourly cap is not hit.
// Documents that the deferral check happens BEFORE the cap check inside
// allowDomain.
func TestAllowDomain_GreylistDeferralActiveBlocks(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{MaxPerDomainHour: 1000}, config.SafetyConfig{})
	e.mu.Lock()
	e.domainDeferredUntil["seznam.cz"] = time.Now().Add(15 * time.Minute) // active
	e.mu.Unlock()
	if e.allowDomain("seznam.cz") {
		t.Error("active greylisting deferral must block even when domain cap has plenty of headroom")
	}
}

// ── greylisting escalation ────────────────────────────────────────────────

// Sustained 4xx beyond maxGreylistingAttempts (4) must reclassify the domain
// as a permanent failure. Asserts the budget exhaustion branch increments
// bounce counters instead of scheduling another retry — protects against an
// endless retry loop on hostile servers that always return 4xx.
func TestRecordSendResult_GreylistBudgetExhausted_TreatedAsPermanent(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{MaxPerDomainHour: 100}, config.SafetyConfig{MaxBounceRate: 1.0})
	transient := errors.New("451 4.7.1 try again later")

	// Pre-set attempt counter to the budget limit so the next 4xx exhausts it.
	e.mu.Lock()
	e.domainBackoffAttempt["seznam.cz"] = maxGreylistingAttempts
	e.mu.Unlock()

	prevBounces := e.bounceCount
	e.recordSendResult("mb@s.test", "seznam.cz", transient)

	if e.bounceCount != prevBounces+1 {
		t.Errorf("budget-exhausted 4xx must escalate to bounce; bounce count: %d → %d", prevBounces, e.bounceCount)
	}
}

// ── mailboxSpacingOK boundary ─────────────────────────────────────────────

// Exactly-at-spacing-window: elapsed == want must allow (>= comparison).
// Pins the inclusive boundary so a refactor to strictly > would break this.
func TestMailboxSpacingOK_ExactBoundaryAllows(t *testing.T) {
	e := NewEngine(
		[]config.MailboxConfig{{Address: "a@x"}},
		config.SendingConfig{MailboxMinSpacingSeconds: 60},
		config.SafetyConfig{},
	)
	now := time.Now()
	// Stamp last-send to exactly 60 seconds ago.
	e.mu.Lock()
	e.mailboxLastSend["a@x"] = now.Add(-60 * time.Second)
	e.mu.Unlock()
	ok, wait := e.mailboxSpacingOK("a@x", now)
	if !ok || wait != 0 {
		t.Errorf("exact-boundary spacing must allow (elapsed >= want); got ok=%v wait=%v", ok, wait)
	}
}

// Multi-mailbox spacing isolation: A's last-send must not block B. Pins the
// per-address keying of mailboxLastSend.
func TestMailboxSpacingOK_PerMailboxIsolation(t *testing.T) {
	e := NewEngine(
		[]config.MailboxConfig{{Address: "a@x"}, {Address: "b@x"}},
		config.SendingConfig{MailboxMinSpacingSeconds: 60},
		config.SafetyConfig{},
	)
	now := time.Now()
	// Mailbox A sent 1s ago — should be deferred.
	e.mu.Lock()
	e.mailboxLastSend["a@x"] = now.Add(-1 * time.Second)
	e.mu.Unlock()

	if okA, _ := e.mailboxSpacingOK("a@x", now); okA {
		t.Error("mailbox A should be deferred (1s elapsed of 60s)")
	}
	if okB, _ := e.mailboxSpacingOK("b@x", now); !okB {
		t.Error("mailbox B has no last-send; must not be blocked by A's spacing")
	}
}

// ── buildMessage MIME edge cases ──────────────────────────────────────────

// CR/LF in subject must be stripped, not propagated as a literal newline
// that would forge additional headers (CRLF injection defense). The
// hostile substring may still appear collapsed into the Subject value, but
// must not introduce a real "\r\nBcc:" separator that the SMTP wire would
// parse as a second header.
func TestBuildMessage_CRLFInSubjectStripped(t *testing.T) {
	hostile := "Hello\r\nBcc: spy@evil.cz"
	msg := buildMessage("f@t.cz", "t@t.cz", hostile, "B", "", nil, "id@t.cz")
	s := string(msg)
	// Forged separator must NOT appear: a real "\r\nBcc:" mid-header.
	if strings.Contains(s, "\r\nBcc: spy@evil.cz") {
		t.Error("CRLF injection: real Bcc header smuggled through subject (\\r\\nBcc found)")
	}
	// Hostile content must collapse into the Subject value.
	if !strings.Contains(s, "Subject: HelloBcc: spy@evil.cz") {
		t.Errorf("expected stripped subject in output; got message: %q", s[:300])
	}
}

// Custom headers with control chars in keys must be dropped wholesale, not
// "fixed up" by stripping. Pins handler.go:1388 reject-key-on-CRLF behavior.
func TestBuildMessage_HeaderKeyWithCRLFRejected(t *testing.T) {
	headers := map[string]string{
		"X-Good":   "value-1",
		"B\r\ncc":  "evil@x", // hostile key — must be dropped, NOT collapsed to "Bcc"
		"X-Other":  "value-2",
	}
	msg := buildMessage("f@t.cz", "t@t.cz", "S", "B", "", headers, "id@t.cz")
	s := string(msg)
	if strings.Contains(s, "Bcc: evil@x") {
		t.Error("hostile header key with CRLF must be rejected, not stripped into a real Bcc")
	}
	if !strings.Contains(s, "X-Good: value-1") || !strings.Contains(s, "X-Other: value-2") {
		t.Errorf("legitimate headers must still pass; got: %q", s[:300])
	}
}

// Date header from caller (humanize fingerprint) must be preserved verbatim
// so mailbox-locale formatting (RFC5322) survives the buildMessage path.
func TestBuildMessage_DateHeaderPreserved(t *testing.T) {
	customDate := "Sat, 09 May 2026 20:07:30 +0200"
	headers := map[string]string{"Date": customDate}
	msg := buildMessage("f@t.cz", "t@t.cz", "S", "B", "", headers, "id@t.cz")
	s := string(msg)
	if !strings.Contains(s, "Date: "+customDate+"\r\n") {
		t.Errorf("custom Date header must be preserved verbatim; got: %q", s[:300])
	}
}

// Header key containing a colon would, if accepted, smuggle a second header
// after the value separator. Must be dropped.
func TestBuildMessage_HeaderKeyWithColonRejected(t *testing.T) {
	headers := map[string]string{"X-Bad: Bcc": "evil@x"}
	msg := buildMessage("f@t.cz", "t@t.cz", "S", "B", "", headers, "id@t.cz")
	s := string(msg)
	if strings.Contains(s, "X-Bad: Bcc:") {
		t.Error("header key containing ':' must be dropped, not concatenated")
	}
}

// Long Message-ID (>8 chars) gets truncated to 8 chars for boundary
// generation — pins this as a deliberate slice, asserts the boundary is well
// formed even with very long IDs.
func TestBuildMessage_LongMessageID_BoundaryWellFormed(t *testing.T) {
	longID := "very-long-message-identifier-with-lots-of-chars@host.cz"
	msg := buildMessage("f@t.cz", "t@t.cz", "S", "Plain", "<html>HTML</html>", nil, longID)
	s := string(msg)
	if !strings.Contains(s, "boundary=\"----=_Part_very-lon\"") {
		t.Errorf("expected 8-char-truncated boundary marker, got: %q", s[:400])
	}
	// Boundary must close properly even with truncation
	if !strings.Contains(s, "------=_Part_very-lon--\r\n") {
		t.Error("multipart closing boundary must be well-formed for long Message-ID")
	}
}

// ── allowDomain cross-domain isolation ────────────────────────────────────

// Cap exhausted on domain A does NOT affect domain B's quota. Documents the
// per-domain partitioning of domainCounts.
func TestAllowDomain_CrossDomainIsolation(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{MaxPerDomainHour: 2}, config.SafetyConfig{})
	// Exhaust seznam.cz
	e.recordSend("mb@t.cz", "seznam.cz", false)
	e.recordSend("mb@t.cz", "seznam.cz", false)
	if e.allowDomain("seznam.cz") {
		t.Error("seznam.cz at cap (2/2) should be blocked")
	}
	if !e.allowDomain("gmail.com") {
		t.Error("gmail.com (0/2) must be unaffected by seznam.cz exhaustion")
	}
}

// 6th send to same domain when cap=5 is the canonical scenario from the AW6
// brief: 5 odjedou, 6th deferred. Encodes the strict-less-than semantics
// (count < cap → allowed) of the gate.
func TestAllowDomain_SixthAtCapFiveBlocked(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{MaxPerDomainHour: 5}, config.SafetyConfig{})
	for i := 0; i < 5; i++ {
		if !e.allowDomain("seznam.cz") {
			t.Fatalf("send %d: must allow up to cap (5)", i+1)
		}
		e.recordSend("mb@t.cz", "seznam.cz", false)
	}
	if e.allowDomain("seznam.cz") {
		t.Error("6th send to same domain must be blocked at cap=5")
	}
}
