# Comprehensive Fixes — From Internal Test to First Real Send

**Status:** Superseded
**Datum:** 2026-04-27
**Trigger:** P0/P1 fixes from internal test campaign 456; superseded by master plan execution

**Supersedes:** none, complements 2026-04-27-first-send-mvp.md

## Cíl

Opravit P0/P1 nálezy z internal test campaign 456 + drift audit + e2e test matrix tak, aby se reálný B2B send (campaign 455) mohl spustit s plnou observabilitou a žádnou silent-fail vrstvou.

## Současný produkční stav (po internal testu)

- Binary deployed (slog deadlock fixed, templates v35 baked, healthcheck OK)
- Campaign 455 + 456 paused
- Mailbox 1, 3, 631, 632 all paused
- Send_events: 2 rows (internal test)
- env: SENDING_WINDOW=8/17, SKIP_CALENDAR_CHECK unset, CAMPAIGN_INTERVAL unset
- Suppression list 20+20 (sender-self entries restored)
- Migrations 005, 007 applied to prod DB

## P0/P1 issues found during test

| ID | Issue | Severity |
|---|---|---|
| F1 | `recordOutbound` looks up Schema B (`outreach_contacts`), test contacts only in Schema A → no `outreach_thread`/`outreach_message` row → reply pipeline broken | P0 |
| F2 | Engine writes `send_events.status='sent'` even when relay's later `outbound_smtp_failed` fires → DB lies about delivery | P0 |
| F3 | "auto: 3 consecutive SMTP failures" mailbox auto-pause running somewhere — string is in BFF (`features/platform/outreach-dashboard/server.js`) which IS NOT deployed → unknown source | P1 |
| F4 | Engine `pickMailbox` doesn't filter sender == recipient → self-sends accepted | P1 |
| F5 | mb=1 Seznam-side AUTH lock (535 5.7.8) — same password as 3/631 but rejected | P1 — manual |
| F6 | Engine status='sent' silently advances current_step even on real relay failure → contact skipped, treated as sent | P0 |
| F7 | mb=632 paused with `inbound_blocked_seznam_account_side_check_pending` — investigate | P2 |
| F8 | Strict-geo `PROXY_STRICT_GEO=1` env NOT set on relay — code deployed but feature off | P2 |
| F9 | BFF (features/platform/outreach-dashboard) not deployed → 144 ops endpoints theoretical, watchdog auto-swap disabled | P0 — architectural |

## Sprinty

### S1 — Mailbox auto-pause source identification (P1, 30 min)

**Cíl:** Zjistit kdo zapisuje `status_reason='auto: 3 consecutive SMTP failures'`.

| ID | Task | Acceptance |
|---|---|---|
| S1.1 | Grep all production-deployed services + sibling Garaaage Nuxt for the exact string | Found in code OR confirmed not in any deployed binary |
| S1.2 | Check Railway service logs for any process emitting it | Source identified |
| S1.3 | Document: if from non-deployed BFF → cannot fire; if from another service → control + alert | docs/audits update |

### S2 — Self-send guard (P1, 20 min)

**Cíl:** `pickMailbox` rejects mailboxes whose `Address == recipient`.

| ID | Task |
|---|---|
| S2.1 | features/outreach/campaigns/sender/engine.go pickMailbox: skip mb where mb.Address == req.ToAddress |
| S2.2 | Test case: `TestPickMailbox_SkipsSelfSend` |
| S2.3 | Run sender suite, verify no regression |

### S3 — Send-status integrity (P0, 1-2h)

**Cíl:** `send_events.status` reflects relay's actual delivery outcome (not just Submit success).

Two paths:

A) Relay → orchestrator webhook on terminal state (delivered/failed)
B) Engine polls `/v1/status/<envelope>` after Submit, updates send_events

Path A is cleaner but needs new endpoint on orchestrator + auth.
Path B is simpler — minor change in engine.

| ID | Task |
|---|---|
| S3.1 | Decide path (default: B for minimal change) |
| S3.2 | Implement: after Submit returns sealed, kick async goroutine that polls status until terminal, updates send_events |
| S3.3 | Test |

### S4 — Schema A/B drift fix (P0, 1h)

**Cíl:** `recordOutbound` should NOT silently fail when contact only in Schema A.

Two paths:

A) Mirror cron: contacts (A) → outreach_contacts (B) so both schemas always populated
B) Make `recordOutbound` graceful: write to thread/message in Schema A directly OR skip with metric

Path A more comprehensive, Path B faster.

| ID | Task |
|---|---|
| S4.1 | Decide path (default: B with metric for now, A as proper fix later) |
| S4.2 | Update recordOutbound: on Schema B miss, log info (not warn), skip thread creation but DON'T block send_events |
| S4.3 | Add audit metric `outreach_contacts_lookup_misses_total` |
| S4.4 | Test |

### S5 — Strict-geo deploy verification (P2, 10 min)

**Cíl:** PROXY_STRICT_GEO active na relay.

| ID | Task |
|---|---|
| S5.1 | Set `PROXY_STRICT_GEO=1` on anti-trace-relay env |
| S5.2 | Verify relay logs: filterByGeo applied, only EU-25 candidates |
| S5.3 | Verify pool not empty after refresh |

### S6 — Production deploy doc + BFF decision (P0 doc, P? archi)

**Cíl:** Capture working deploy procedure + decide BFF future.

| ID | Task |
|---|---|
| S6.1 | docs/playbooks/machinery-outreach-deploy.md — final working setup (rootDir=/, dockerfilePath=features/inbound/orchestrator/Dockerfile, all 8 modules COPY, no in-process migrate) |
| S6.2 | Decision doc: BFF deploy paths (a) deploy as new Railway service (b) port to garaaage Nuxt (c) drop, do ops via direct DB+relay |
| S6.3 | Pick path with user |

### S7 — First real send rehearsal + GO (P0, 30 min)

**Cíl:** Single send to ing.martincech@centrum.cz s plnou monitoring.

| ID | Task |
|---|---|
| S7.1 | Verify mb=3 (or 631) AUTH still OK after pause/unpause cycle |
| S7.2 | Verify send_events table — 2 internal test rows visible, no real B2B yet |
| S7.3 | Reset campaign_contacts 418176: current_step=0, next_send_at=NOW() |
| S7.4 | Restore campaign 455 status='running' |
| S7.5 | Wait for next scheduler tick within send window 8-17 Prague |
| S7.6 | Verify enqueue → submit → deliver → send_event row → outreach_thread row |
| S7.7 | Monitor IMAP poll for any reply within 24h |
| S7.8 | Tomáš explicit GO před S7.4 (memory `feedback_campaign_send`) |

### S8 — Post-launch (P1, 1-2 weeks)

| ID | Task |
|---|---|
| S8.1 | Privacy@hozan-taher.cz inbox setup |
| S8.2 | Footer update: include privacy@ DSR contact |
| S8.3 | Retention cron (auto-delete >12 měsíců, except suppressions) |
| S8.4 | LIA refresh for current scope (machinery export to MENA) |
| S8.5 | Bounce auto-suppress flow (hard bounce → suppress immediately) |
| S8.6 | Watchdog daemon callback — needs deployed BFF or alternative |

## Hard red lines

1. NEsendovat na real B2B (ing.martincech@centrum.cz) bez Tomášova explicit GO (memory `feedback_campaign_send`).
2. Mailbox passwords NIKDY do env / log / commit (memory `feedback_mailbox_passwords_via_db`).
3. Žádný direct SMTP z localhost (memory `feedback_no_direct_smtp`).
4. Suppression UNION pre-send check je gate.

## Send log

| Datum | Recipient | Outcome | Envelope ID |
|---|---|---|---|
| 2026-04-27 19:06:12 UTC | b.maarek@email.cz (mb=631) | DELIVERED | env_34b756aa48f4f886ca28728b — direct relay submit, internal pre-test |
| 2026-04-27 20:00:01 UTC | a.mazher@email.cz (mb=3 self) | DELIVERED | env_dbe900dbfdff2bed041c3be8 — campaign 456 step 0 |
| 2026-04-27 20:04:18 UTC | b.maarek@email.cz (mb=631) | FAILED | env_1657e3481268bd87ada0d174 — campaign 456 step 0; relay outbound_smtp_failed |

## Otázky pro Tebe

1. S3 path: A (relay webhook) nebo B (engine poll)? — default B
2. S4 path: A (Schema mirror cron) nebo B (graceful skip)? — default B
3. S6.2 BFF decision: deploy / port / drop?
4. S7 GO: zítra ráno 8-17 Prague na ing.martincech@centrum.cz?
