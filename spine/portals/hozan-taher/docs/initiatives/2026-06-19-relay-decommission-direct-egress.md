# Relay decommission → direct egress

> Status: **in progress** (Stage 1 implemented). Owner: operator decision 2026-06-19.
> Branch: `feat/relay-decommission-imap-direct`.

## Goal

Retire the `anti-trace-relay` service and move the orchestrator's egress
**direct** (no proxy), for both inbound IMAP and outbound SMTP.

## Context (why this is more than a config flip)

The relay is the **single mandatory egress** for the whole pipeline — not just
IMAP polling:

| Path | Today | Endpoint |
|---|---|---|
| Inbound IMAP poll | `ImapPollLoop` → relay | `POST /v1/imap-fetch` |
| Outbound SMTP send | `engine.go` (SMTP-EGRESS-LOCKDOWN R4 — **mandatory**, sender fails closed without it) | `POST /v1/submit` |
| Mailbox scoring | `MailboxScoreLoop` | `POST /v1/probe`, `/v1/auth-check` |
| SOCKS addr discovery | BFF + orchestrator | `GET /v1/imap-socks-addr` |

`wgsocks` (the SOCKS5→WireGuard egress) lives **inside the relay container**;
the orchestrator has no egress proxy of its own. Removing the relay therefore
removes all IP shielding.

**Trigger incident:** the relay's CZ WireGuard egress (`cz-prg-wg-*`) died on
**2026-06-03 22:37 UTC** (`socks5 connect failed: status=5`). IMAP polling has
returned 502 ever since → `mailbox_imap_state.polled_at` frozen → 16 days of
inbound replies not ingested. The relay HTTP control plane stayed up, so no
alert fired (and `protection_alerts_layer_level_open_unique` constraint is
missing → alerting sink itself errors).

## Decision

**Direct egress, operator-approved 2026-06-19.** Accepts the deliverability /
fraud-detection risk: direct IMAP/SMTP from the orchestrator's datacenter IP to
post.cz/Seznam is the multi-country/datacenter pattern that originally caused the
nowak.gorak fraud lock. **Precondition before Stage 2 ship:** confirm the
orchestrator egresses from a CZ/EU IP, or accept lock risk.

## Stages

### Stage 1 — relay-free IMAP poll ✅ (this branch)
- `imap.FetchMailboxDirect` — stateless in-process IMAP fetch via `connect()`
  (direct when `ALLOW_IMAP_DIRECT=1`). Reuses the existing IMAP protocol code.
- `ImapPollLoop` gains a `direct` mode: `pollOne` calls `fetchDirect` instead of
  `fetchFromRelay`; all DB state (watermark, circuit, ProcessReply) unchanged.
- `startImapPollLoop` boot gate: starts in direct mode on `ALLOW_IMAP_DIRECT=1`
  (no longer requires relay URL/token).
- **Env (machinery-outreach):** set `ALLOW_IMAP_DIRECT=1`. Keep
  `ANTI_TRACE_RELAY_URL` set for now → harmless (direct path ignores it);
  unset in Stage 5.
- **No ratchet change:** `connect()` direct path uses `baseDialer.DialContext`
  (a method), which `no_raw_imap_hosts_audit_test.go` does not match.
- **Verify after deploy:** `GET /api/ingest-freshness` →
  `mailboxes_polled_recently > 0` and `last_poll_at` advancing; the 16-day
  backlog drains into `reply_inbox`.
- **Rollback:** unset `ALLOW_IMAP_DIRECT` (reverts to relay path).

### Stage 2 — direct SMTP send (HIGH RISK, separate PR + canary)
- Unlock `engine.go` SMTP-EGRESS-LOCKDOWN R4 / `WithAntiTrace` mandatory gate.
- Rewrite the airtight ratchets: `features/outreach/campaigns/sender/{no_bypass,airtight}_audit_test.go`,
  `features/outreach/relay/internal/transport/wgpool/no_raw_smtp_dial_audit_test.go`.
- Per-mailbox `ProxyURL` (config) already supports direct TLS — wire send to it.
- Canary one mailbox, watch bounce-rate + auth-locks before fleet-wide.

### Stage 3 — scoring loop
- Repoint or disable `MailboxScoreLoop` (`/v1/probe`, `/v1/auth-check`) and the
  BFF full-check path.

### Stage 4 — BFF on-demand IMAP
- `features/platform/outreach-dashboard` `dialIMAPViaSOCKS5` + JS audit ratchets
  (`tests/audit/no_raw_imap_socket.test.js`, `no_raw_smtp_socket.test.js`).

### Stage 5 — teardown
- Delete the `anti-trace-relay` Railway service; remove `ANTI_TRACE_RELAY_URL` /
  `ANTI_TRACE_RELAY_TOKEN` across services.
- Update HARD-RULE memories (`feedback_anti_trace_full_stack`,
  `feedback_no_direct_smtp`) to record the conscious reversal.
- Fix the missing `protection_alerts_layer_level_open_unique` constraint so
  egress outages alert again.
