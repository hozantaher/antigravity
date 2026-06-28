# Launch Readiness — First Real B2B Campaign

**Status:** Superseded
**Datum:** 2026-04-27
**Trigger:** Conservative launch plan executed; subsumed into master plan phase 0

**Souvisí s:**
- [2026-04-22-send-pipeline-unblock.md](2026-04-22-send-pipeline-unblock.md) — SEND-S1..S6 (mailbox creds, AUTH probe, E2E, guardrails). **Stále otevřená, není BLOCKED, jen čeká na user S1**.
- [first-campaign-launch.md](../playbooks/first-campaign-launch.md) — generic 0→1→5→20 staircase
- [LAUNCH-CAMPAIGN-001.md](../playbooks/LAUNCH-CAMPAIGN-001.md) — fully-instantiated execution log (20-contact machinery soft launch)
- [ADR-002](../decisions/ADR-002-autonomous-ops-architecture.md), [ADR-003](../decisions/ADR-003-test-suite-governance.md)
- Memory hard rules: `feedback_campaign_send.md` (NEVER bez explicit consent), `feedback_mailbox_passwords_via_db.md`, `feedback_no_direct_smtp.md`

## Kontext

User chce odeslat **první reálnou B2B email kampaň** (heavy machinery dealers, segment NACE 43.11/43.12, ~3-5k firem v ČR; první vlna ~30-50 contactů). Před launchem chce mít **kompletní kritickou infrastrukturu**, aby šel software dál vyvíjet proti produkčním datům.

Audit projektu (provedený 2026-04-27) zjistil: většina kódu hotová, ale 5 kritických blokátorů + 4 high-priority gaps brání bezpečnému launch. Tato iniciativa rozepisuje **3-denní cestu** k prvnímu live emailu.

### Diagnostické zjištění (zkrácený audit)

```
✅ HOTOVO
- Kontakty schema + segmentace (NACE filter, status enum, validation pipeline)
- Mailbox infrastruktura (4 Seznam schránky, DB-stored hesla, warm-up plán, proxy pool, circuit breaker)
- Send pipeline (BFF→Go proxy, preflight gate, sender engine 1001 LOC, anti-trace-relay)
- Suppression UNION (outreach_suppressions Go + suppression_list JS, semantika konzistentní)
- Templates (3 šablony: intro/followup/bump, spintax, unsubscribe footer, quoted-printable UTF-8)
- Reply detection + classification (LLM + keyword fallback, bounce DSN, IMAP poller)
- DSR endpoints (Article 15 access + Article 17 erasure, 8-table cascade)
- Sentry per service (4 projekty), slog conventions, /health surfaces
- preflight.sh, migration runner, secret rotation playbook draft

⏸ KRITICKÉ BLOKÁTORY (P0)
1. Mailbox app-passwords: všechny 4 mb mají placeholder `123p123p123p123` v DB
   → SMTP AUTH 535. Bez user action 0 emailů.
2. AUTH probe + circuit reset: 2 mb v stavu paused (auth_fail_count=3),
   bez S2 reset se i po opravě hesel přeskočí.
3. E2E self-send test nikdy neproběhl — žádné důkazy že real delivery funguje.
4. Suppression list není seeded — preflight gate vynucuje supCount > 0.
5. Pilot segment + enrollment do campaign_contacts ještě neexistuje.

⚠️ HIGH-PRIORITY GAPS (P1)
6. Leads tabulka + webhook (interested replies → leads) není napojený.
7. Unsubscribe action handler chybí (token-gated /unsubscribe endpoint).
8. Compliance footer manual smoke check první 3 emaily.
9. Bounce processing pipeline E2E ověření (kód existuje, prod test ne).

📊 OBSERVABILITY GAPS (P2 — měkký gate)
10. Sentry → GH integration (handoff H4) — bez toho blind spot na prod errors.
11. Daily digest GH Discussion (handoff H3).
12. Watchdog alarm pipeline pro stale advisory locks.
```

## Cíle

1. **První email odeslán** přes anti-trace-relay → real Seznam recipient → confirmed delivery — během 3 dnů.
2. **Po prvním 100 emails:** delivery rate ≥90%, bounce rate ≤5%, 0 circuit trips.
3. **Reply loop funguje E2E:** klassifikace → leads tabulka → human-visible UI.
4. **Bounce loop funguje E2E:** hard bounce → outreach_suppressions → další send tento email skipne.
5. **Compliance:** unsubscribe link → token endpoint → contact status update bez confirmation loop.
6. **Observability live:** Sentry alerty proudí, watchdog logs viditelné, daily digest publikuje.
7. **Žádné placeholder data v prod:** S6 guardrails (CI assert, dashboard badge, alert) hotové.

## Non-cíle

- **Neoptimalizujeme send rate / throughput** — první kampaň je validation, ne scale.
- **Neměníme SMTP provider** — Seznam zůstává.
- **Neimplementujeme A/B testing** — jednu šablonu poslat first, iterace později.
- **Neschvalujeme nový SMTP routing** — anti-trace-relay je current cesta.
- **Nesnažíme se o GDPR/ePrivacy compliance** — deployment jurisdiction is mimo EU/EEA per CLAUDE.md.

## Plán (sprinty)

Iniciativa **navazuje na existující SEND-S1..S6** (initiative 2026-04-22-send-pipeline-unblock.md). SEND sprinty jsou specifické pro mailbox/AUTH/E2E. **Nové L sprinty pokrývají gaps**: suppression seed, leads, unsubscribe, observability activation, dry-run staircase.

### Sprint L1 — SEND prerekvizity (delegováno na 2026-04-22 init) (1 den, většinou user)

Plně specifikováno v [send-pipeline-unblock.md](2026-04-22-send-pipeline-unblock.md). Re-summary:

- [ ] **L1.S1** Real Seznam credentials → DB (user, ~2h)
  - Per mailbox: webmail login → check 2FA → app-password gen → dashboard UI → DB UPDATE
  - 4 mailboxy: mb=1, 3, 631, 632
- [ ] **L1.S2** AUTH probe + circuit reset (AI, 30 min)
  - `POST /v1/auth-check` per mb, expect `ok=true`
  - `UPDATE outreach_mailboxes SET status='active', circuit_opened_at=NULL, ...`
- [ ] **L1.S3** E2E self-send test (AI + user verify, 2-4h)
  - 4 self-sends přes relay `/submit` endpoint
  - Verify v Seznam webmail Inbox
  - 0 watchdog alerts, 0 relay errors
- [ ] **L1.S4** Send window + warmup config audit (AI, 1h)
  - `SENDING_WINDOW_START/END`, `SENDING_TIMEZONE`
  - `mailbox_warmup.warmup_day` per mb (rozhodnout: ramp vs. bump na 30)
  - `daily_cap_override` not zero, kalendář active

**Acceptance:** 4/4 mailboxů `status='active'` + auth-check ok + 4 self-send delivered.

### Sprint L2 — Suppression + leads + unsubscribe (parallel, 1 den)

Tato vrstva chybí. Bez ní preflight gate stop, bez leads reply loop "shadows" replies, bez unsubscribe nelze respect opt-out.

- [ ] **L2.1** Suppression initial seed
  - Seed minimum 20-50 entries: interní domény (`@hozan-taher.cz`, `@messing.dev`), partneři, honeypoty, spamtraps, competitors.
  - SQL: `INSERT INTO outreach_suppressions (email, reason, source) VALUES ...` + zhruba stejné v `suppression_list` (UI).
  - Verify preflight: `node features/platform/outreach-dashboard/scripts/preflight-check.mjs <campaign-id>` — `supCount > 0` ✓.
- [ ] **L2.2** Leads tabulka + migration
  - `scripts/migrations/008_leads.sql`: id, contact_id, campaign_id, mailbox_id, classified_at, sentiment, original_message_id, original_text, status (enum: new|contacted|qualified|disqualified), assigned_to.
  - Index: (status, classified_at desc), (contact_id), (campaign_id).
  - Backfill: žádný (greenfield).
- [ ] **L2.3** Webhook v `InboundProcessor` při `sentiment=interested|meeting`
  - `features/inbound/orchestrator/thread/inbound.go` → `onInterested()` → `INSERT INTO leads ...`
  - Idempotent (UNIQUE on contact_id + original_message_id).
  - Sentry log on insert (severity=info).
- [ ] **L2.4** Leads UI (read-only first)
  - Dashboard route `/leads` — table view (sentiment, contact, mailbox, classified_at).
  - Filter: status (new), sentiment (interested|meeting).
  - Action: link na contact detail + mailbox composer pre-filled In-Reply-To.
- [ ] **L2.5** Unsubscribe endpoint + handler
  - `GET /unsubscribe?t=<token>` → render confirmation page (1-click confirm).
  - `POST /unsubscribe` → `UPDATE contacts SET status='opted_out' WHERE id=<token-decoded-id>` + insert do `outreach_suppressions` (reason=`user_unsubscribe`).
  - Token signing via env `UNSUBSCRIBE_SECRET` (HMAC SHA256 contact_id+exp).
  - Token expiration: 90 dní.
  - Audit log: insert do `operator_audit_log` (action=`unsubscribe`).
- [ ] **L2.6** Compliance footer smoke test
  - Render každou ze 3 šablon přes `features/outreach/campaigns/render` test endpoint.
  - Verify `{{.UnsubURL}}` substituován validním tokenem.
  - Verify HTML link funguje (klik → confirmation page).

**Acceptance:** preflight unblock + leads INSERT idempotent + unsubscribe E2E (token → status update + suppression).

### Sprint L3 — Pilot segment + dry-run staircase (1 den)

Per `first-campaign-launch.md` playbook. Nesmí přeskakovat kroky.

- [ ] **L3.1** Pilot segment creation v UI
  - Filter: NACE 43.11 OR 43.12, region CZ, email status=`valid`, ne v suppression
  - Target size: 30-50 contacts (podle dostupných valid emails).
  - Save jako `segment_pilot_machinery_001`.
- [ ] **L3.2** Pilot kampaň creation v UI
  - Použít template heavy-01-intro
  - Schedule: `now()`, send window 8:00-18:00 weekday only
  - Mailbox pool: 4 Seznam (round-robin, daily_cap=10/each pro pilot)
  - Status: `draft`
- [ ] **L3.3** Step 0: Dry-run
  - `CAMPAIGN_DRY_RUN=true CAMPAIGN_ID=<n> pnpm send`
  - Verify: slog `[dry_run]` per recipient, audit log entry, **0 rows v `send_events`**
  - Gate: dry-run succeeds, recipient count = expected
- [ ] **L3.4** Step 1: Single send (1 contact, ideally @messing.dev test)
  - Manual SQL: `UPDATE campaign_contacts SET enrollment_status='active' WHERE campaign_id=<n> LIMIT 1`
  - Run live send (no dry-run flag)
  - Verify: 1 email delivered, opened, audit log clean
  - Gate: delivery succeeded, no circuit trip, no relay error
- [ ] **L3.5** Step 5: Sample send (5 contacts, mix internal+external)
  - Same flow as L3.4 but 5 contacts
  - Wait 1h post-send → check `send_events` table + Sentry quiet
  - Gate: 5/5 delivered, ≤1 bounce, 0 circuit trips
- [ ] **L3.6** Step 20: Soft launch (20 contacts external)
  - Full pipeline run, monitor 24h
  - Gate: ≥18/20 delivered, ≤5% bounce, 0 spam complaint
- [ ] **L3.7** Full pilot (zbytek 30-50 contacts) — pokud L3.6 gate OK
  - Po 24h monitoring window post-L3.6
  - Document outcome in `LAUNCH-CAMPAIGN-002.md` (next campaign instance log)

**Acceptance:** 30+ emails delivered to real recipients, bounce ≤5%, 0 circuit trips, 0 spam complaints.

### Sprint L4 — Observability activation (parallel s L3, 0.5 dne)

Nutné aby user viděl prod issues v real-time během L3 staircase.

- [ ] **L4.1** Sentry → GH integration setup (delegováno na handoff H4)
  - 4 Sentry projekty, alert rules, repo wiring
- [ ] **L4.2** Watchdog alarm pipeline
  - `features/outreach/mailboxes/watchdog/alert.go` already wires `AlertWebhook`
  - Verify env `ALERT_WEBHOOK_URL` set (pokud not, log to Sentry as severity=warning)
  - Test: trigger fake circuit trip → verify Sentry event with correct severity
- [ ] **L4.3** Bot autonomous-ops handoff (H1, H2, H3)
  - Per [autonomous-ops-handoff.md](2026-04-27-autonomous-ops-handoff.md) — H1 (project board), H2 (secrets), H3 (Bot Reports)
  - Po H5 merge → daily digest publishes ráno post-launch
- [ ] **L4.4** Dashboard live view
  - Verify `/dashboard` shows: mailbox health, today's sends, bounces, replies, leads
  - Verify auto-refresh interval ≤30s
- [ ] **L4.5** Manual gauge per L3 step
  - Před každým L3 stupněm: screenshot dashboard → save jako evidence
  - Po každém L3 stupněm: 5-min wait → screenshot delta

**Acceptance:** Sentry events flow to GH issues, dashboard live, daily digest publishes day after L3.

### Sprint L5 — S6 guardrails (závazné po L3) (0.5 dne)

Aby S1 incident (placeholder hesla) nebyl možný znova.

- [ ] **L5.1** CI invariant test
  - `tests/invariant/no_placeholder_passwords.sql` — fail pokud `outreach_mailboxes.password` matchuje placeholder hex
  - Wire do `.github/workflows/go-services-ci.yml`
- [ ] **L5.2** Dashboard red badge
  - `features/platform/outreach-dashboard/src/components/MailboxCard.jsx` — pokud `password IS NULL OR length(password) < 10 OR password LIKE '123%'` → render `<Badge variant="error">PASSWORD MISSING</Badge>`
- [ ] **L5.3** Watchdog alert: `AUTH_FAIL_3X`
  - `features/outreach/mailboxes/watchdog/daemon.go` — emit event when `auth_fail_count >= 3 within 15 min` window
  - Sentry event severity=error, GH issue auto-create via Sentry → GH integration
- [ ] **L5.4** Memory rule + CLAUDE.md update
  - Memory `feedback_mailbox_passwords_via_db.md` already exists — re-confirm
  - CLAUDE.md `Service-local rules` → `outreach`: explicit "passwords NEVER env vars after bootstrap"
- [ ] **L5.5** Mailbox onboarding runbook
  - `docs/playbooks/MAILBOX-PASSWORD-UPDATE.md` — full draft (S6.5 from 2026-04-22)
  - Steps: webmail login → 2FA check → app-password gen → dashboard UI → SQL verify

**Acceptance:** CI fails on placeholder password, badge visible, watchdog event fires, runbook committed.

### Sprint L6 — Post-launch monitoring + iterate (3-7 dní)

- [ ] **L6.1** 24h post-L3.6: review delivery/bounce/reply stats
- [ ] **L6.2** 7d post-L3.7: aggregate report — open rate, click rate, reply rate, bounce rate, complaint rate
- [ ] **L6.3** Reply triage manual: classify edge cases that LLM misclassified, log to dataset for tuning (D2 sprint)
- [ ] **L6.4** Bounce review: hard bounces auto-suppressed, soft bounces triage manual
- [ ] **L6.5** Lessons learned → playbook updates (`first-campaign-launch.md` `Lessons` section)
- [ ] **L6.6** Decision: scale next campaign? Pokud ano → cílový segment 100-200 contacts.

**Acceptance:** Report viditelný, decision dokumentovaný v BOARD.md, next campaign sized.

## Závislostní graf

```
L1.S1 (user) ──► L1.S2 ──► L1.S3 ──► L1.S4 ──┐
                                              │
L2.1 (suppression seed) ─────────────────────┤
L2.2-L2.6 (leads + unsubscribe) ─────────────┤
                                              ▼
L4.1-L4.5 (observability) ─parallel──► L3.1 ──► L3.3 (dry-run) ──► L3.4 ──► L3.5 ──► L3.6 ──► L3.7
                                                                              ▼
                                                                    L5 (guardrails)
                                                                              ▼
                                                                    L6 (monitor + iterate)
```

L1.S1 (user mailbox creds) je **kritická cesta blokátor**. Bez S1 nelze L1.S2 → L1.S3 → L3 staircase.
L2 + L4 jsou paralelně k L1, dokončitelné offline.
L5 guardrails po L3.6 (= prokázané že send funguje) a před L3.7 (full pilot).

## Časový odhad

| Sprint | User čas | AI čas | Elapsed |
|---|---|---|---|
| L1 (delegováno) | 2h | 4-6h | 1 den |
| L2 (suppression + leads + unsub) | 30 min | 6-8h | 1 den |
| L3 (pilot + staircase) | 30 min/step × 5 | 4h | 1 den (+ 24h wait) |
| L4 (observability) | 30 min | 2h | 0.5 dne (parallel) |
| L5 (guardrails) | — | 4h | 0.5 dne |
| L6 (monitoring) | průběžně | průběžně | 7 dní baseline |

**Total elapsed do prvního live emailu**: 2-3 dny.
**Total elapsed do plného pilot completion + scale decision**: 7-10 dní.

## Hard rollback triggers (z first-campaign-launch.md)

Stop at any L3 step pokud:
- Bounce rate > 5% (segment quality issue)
- Spam complaint > 0.1% (deliverability dying)
- Sentry error spike > 10/h (relay/sender bug)
- Mailbox circuit trip > 1 (auth/rate issue)
- Watchdog AUTH_FAIL within 1h post-send (creds rotated, account compromised)

Rollback action: `UPDATE outreach_mailboxes SET status='paused', status_reason='L3.X rollback'` + GH issue + Sentry event severity=error.

## Decision matrix

| Scenario | Action |
|---|---|
| L1.S2 AUTH ok 4/4 | Proceed L1.S3 |
| L1.S2 AUTH fail 1-2/4 | Diagnose: app-password formatting? rebind? Retry. NO L1.S3 advance. |
| L1.S2 AUTH fail 3-4/4 | Stop. User action: re-verify webmail credentials, check 2FA state. |
| L1.S3 self-send 4/4 | Proceed L3 |
| L1.S3 self-send 0-3/4 | Diagnose: Seznam reputation? IP block? Greylisting? Retry +30 min. NO L3 advance. |
| L3.4 single delivery OK | Proceed L3.5 (5 emails) |
| L3.4 bounce | Inspect bounce reason. If recipient typo: continue. If catch-all: pause segment, scrub. |
| L3.5 bounce 1/5 | Investigate. If isolated: continue. If pattern: stop. |
| L3.5 bounce 2+/5 | Stop. Suppress segment, audit verifier rules. |
| L3.6 bounce >1/20 (5%) | Stop. Bigger sample needed before full pilot. |
| L3.6 ok | Proceed L3.7 (full pilot) + L5 guardrails parallel. |

## Otevřené otázky

- **Pilot segment size:** 30 vs 50? Záleží kolik valid contactů reálně máme (k zjištění ve L3.1). Conservative 30.
- **Send timing:** Začít v úterý/středu ráno (best B2B response window). Pokud L1+L2 done v pátek, čekat do úterý.
- **Reply mailbox**: Replies přijdou na sender mailbox. Human triage v `/leads` UI nebo dedicated `/replies` route? L2.4 specifikuje read-only `/leads`; full reply composer = E3 sprint (oddělená iniciativa).
- **Compliance jurisdiction**: Per CLAUDE.md "Deployment jurisdiction is outside EU/EEA; GDPR/ePrivacy do not apply." Ověřit s user že to platí pro segment NACE 43.11 v ČR (CZ je v EU). Pokud ne → re-scope unsubscribe na opt-in confirm vs current opt-out.

## Log

- 2026-04-27 — založeno; navazuje na 2026-04-22-send-pipeline-unblock + first-campaign-launch playbook
