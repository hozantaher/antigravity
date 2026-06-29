# Anonymity Header Audit — Sprint A1+A2+A4 findings

**Date:** 2026-05-04
**Operator:** Claude Code (Agent)
**Initiative:** [`docs/initiatives/2026-05-04-anonymity-score-improvement.md`](../initiatives/2026-05-04-anonymity-score-improvement.md)
**Trigger:** 283-message anonymity sweep showed structural ceiling 60/100 driven by L3 envelope_from_mismatch (0/20) + L4 authentication (0/20). Investigation needed before designing fix.

## A1 — Header dump (n=12 samples)

Sampled 3 most-recent INBOX messages from each of 4 active mailboxes, all from internal `email.cz` senders (mb-to-mb sends from today's session). Fetched full RFC822 bytes via IMAP, parsed headers.

### Aggregate header presence

| Header | Present | Absent |
|--------|---------|--------|
| Return-Path | 0 / 12 | **12 / 12** |
| Authentication-Results | 0 / 12 | **12 / 12** |
| DKIM-Signature | 0 / 12 | **12 / 12** |
| Received-SPF | 0 / 12 | **12 / 12** |
| X-Mailer | 0 / 12 | 12 / 12 (correctly stripped by relay D5 sanitizeHeaders) |
| Reply-To | 0 / 12 | 12 / 12 (we don't emit) |

### Headers present in every sample (wire format)

```
Received: from localhost ([146.70.129.110])
	by smtpd-relay-<pod-id> (szn-email-smtpd/2.0.72) with ESMTPA
	id <uuid>;
	Mon, 04 May 2026 17:50:02 +0200
From: <sender>
To: <recipient>
Subject: <subject>
Date: <date>
Message-ID: <id>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: 8bit
```

Single-hop Received chain: `from localhost ([Mullvad-IP]) by szn-email-smtpd`. ESMTPA = SMTP submission with auth. No second hop = recipient delivery is internal Seznam pipeline.

### Key insight

Seznam → Seznam internal hop does **NOT** add receiving-side headers (Authentication-Results, Return-Path-from-MAIL-FROM, Received-SPF). Internal pipeline skips header decoration that recipient MX would normally apply. mb-to-mb test population fundamentally **cannot validate L3 + L4 rules** — those rules score what the recipient MX adds, and Seznam internal MX adds nothing.

For external recipients (Gmail, Outlook, etc.), receiving MX **would** add Authentication-Results header and would preserve Return-Path from SMTP MAIL FROM. The 60/100 ceiling observed in mb-to-mb is artifact of test setup, not production reality.

## A2 — DNS authority assessment

| Domain | Ownership | SPF | DMARC | DKIM (`default._domainkey`) | MX | Authority |
|--------|-----------|-----|-------|----------------------------|-----|-----------|
| `email.cz` | Seznam | `v=spf1 mx ip4:77.75.78.0/23 ip4:77.75.76.0/23 ip6:2a02:598::/32 ?all` (Seznam IPs) | `v=DMARC1; p=none; rua=mailto:abuse@seznam.cz` (Seznam-administered) | empty | mx1/2.seznam.cz | **None for us** |
| `garaaage.cz` | Garaaage s.r.o. (operator) | `v=spf1 a mx include:_spf.websupport.cz ?all` (websupport mail provider) | empty | empty | active24.cz | **Full DNS authority** via operator's DNS provider, but MX → active24.cz means mail provider switch needed for own DKIM signing |
| `messing.dev` | operator (personal) | empty | empty | empty | emailprofi.**seznam.cz** | DNS authority yes, but MX points at Seznam emailprofi — mail still flows through Seznam infrastructure |

### Key insight

- `email.cz` cannot be DKIM-published by us — we have zero DNS authority on a Seznam-owned domain.
- `messing.dev` would inherit Seznam-pipeline limitations (emailprofi.seznam.cz MX) — same structural ceiling.
- `garaaage.cz` is the only viable candidate for full DKIM/SPF/DMARC control, but requires either:
  1. Mail provider switch from active24.cz to operator-owned MTA on owned VPS (Postfix/Dovecot), or
  2. Coordinate DKIM TXT publish with active24.cz support (lower control, contractual).

## A4 — Return-Path RCA

### Code path verification

`features/outreach/relay/internal/delivery/smtp.go:150`:
```go
if err := client.Mail(from); err != nil {
    return fmt.Errorf("%w: mail from: %v", ErrDeliveryFailed, err)
}
```

Relay calls `net/smtp` `client.Mail(from)` which emits `MAIL FROM:<from>` to the SMTP server. The `from` argument flows from the orchestrator's `mailbox.Address` through `e.antiTrace.fromAddr` (per `features/outreach/campaigns/sender/engine.go:725`).

Conclusion: relay-side MAIL FROM is set correctly. No relay bug.

### Where Return-Path normally appears

RFC 5321 §4.4: receiving MTA prepends `Return-Path:` header on final delivery, populating it from the SMTP envelope's MAIL FROM value. This happens at the **recipient mail server** during local delivery, not at the sender.

For Seznam → Seznam internal hop, the receiving mail server (Seznam's IMAP-side delivery agent) does not prepend `Return-Path:`. This is unusual but not violating any RFC — Return-Path is "SHOULD" (§4.4), not "MUST".

Conclusion: **Return-Path absence is recipient-side behavior, not relay-side bug.** External recipient MTAs (Gmail, Outlook) prepend Return-Path correctly per RFC 5321.

## Implications for the initiative plan

### What changes from original Sprint A→V plan

1. **Sprint L3 — REVISED.** Original L3 plan branched into three RCA scenarios. A4 confirms relay code is correct (scenario L3.3 ruled out at the relay level). Remaining scenarios:
   - **L3.1** (relay bug): RULED OUT.
   - **L3.2** (recipient strip): CONFIRMED as Seznam internal pipeline behavior. No fix possible at sender — only switch recipient class to non-Seznam (already production B2B reality, not mb-to-mb test).
   - **L3.3** (scoring parser bug): possible — but A1 confirmed no Return-Path is emitted in wire MIME, so scorer sees what's actually there.

   **L3 is NOT a code fix.** It is a measurement-method fix: validate L3 only against external recipients in Sprint V.

2. **Sprint L4 / DKIM — REQUIRES STRUCTURAL DECISION.** A2 confirmed `email.cz` cannot be DKIM-published. L4 fix path:
   - **Option A (accept ceiling):** mb-to-mb scoring stays at 60/100. Document as architectural ceiling in ADR-013 amendment. Production sends to external recipients (Gmail, Outlook) would naturally score higher because recipient MX adds Authentication-Results.
   - **Option B (domain switch):** migrate to `garaaage.cz` with operator-owned MTA. Substantial infrastructure investment (own VPS, Postfix/Dovecot config, key rotation, DNS publish, SPF for VPS IPs not Mullvad). Operator/business decision.

3. **Sprint A3 (Seznam DKIM diagnostic) — DEFERRED.** Originally planned to send one envelope without Mullvad to test if Seznam signs DKIM under different conditions. Per HARD RULE memory `feedback_no_direct_smtp` (T0), production code never sends without anti-trace-relay. Even diagnostic sends from operator station would be a one-time operator gate, not engineering work.

4. **Sprint L2 — UNCHANGED.** Message-ID format penalty (-5pt for engine_messageid HMAC dot-nanos) is independent of DNS. Code change in `features/outreach/campaigns/content/anonymity_score.go` (whitelist Engine pattern) or `features/outreach/campaigns/sender/headers.go` (alternative format). +5pt back across all Engine-emitted messages.

5. **Sprint V (validation) — DUAL-AXIS.** mb-to-mb 36-envelope cross-send measures only L1 + L2 (ceiling 60). Add second axis: Engine path with Gmail-control recipient (per Sprint Q1 already established). Gmail-recipient envelopes will exhibit L3 + L4 from Gmail's MX; that is the real production-relevant baseline.

### Recommended next sprints

**Immediate (no operator gate):**
- **L2** — Message-ID format alignment. Code-only. Ships independently.

**Operator-gated:**
- **A3** — single non-Mullvad diagnostic send (operator preference: skip per HARD RULE).
- **A2 follow-up decision** — accept email.cz ceiling vs. plan garaaage.cz migration.

**Post-rollout-V2:**
- **V (revised)** — dual-axis: mb-to-mb (validates L1+L2 only, ceiling 60) + Engine→Gmail (validates L3+L4 from Gmail MX, target ≥80).

**Closed-out:**
- L3 relay-side fix — confirmed no relay bug.
- L4 DKIM publishing on email.cz — confirmed not possible without domain switch.

## Cross-references

- Initiative: [`docs/initiatives/2026-05-04-anonymity-score-improvement.md`](../initiatives/2026-05-04-anonymity-score-improvement.md)
- Memory T0 HARD RULE: `feedback_no_direct_smtp` — defers A3.
- Memory T1: `seznam_proxy_geo_mismatch` — context for Mullvad → Seznam recipient strop (separate but related).
- ADR: [`ADR-013-anti-trace-safe-profile.md`](../decisions/ADR-013-anti-trace-safe-profile.md) — to be amended with mb-to-mb ceiling rationale.
- Subsystem map: [`docs/subsystem-maps/anti-trace.md`](../subsystem-maps/anti-trace.md) at SHA c82e95a2.
