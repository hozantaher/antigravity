# Launch Fast-Track — First B2B Campaign in One Workday

**Status:** Superseded
**Datum:** 2026-04-27
**Trigger:** Fast-track launch pathway executed 2026-04-27; superseded by master plan conservative staircase

**Supersedes plánovací cadenci v:** [2026-04-27-launch-readiness.md](2026-04-27-launch-readiness.md) — ta je 3-denní conservative variant. Tato je 1-denní compressed variant, vhodný když jsme oba online a držíme tempo.

**Co se NEZMĚNILO oproti launch-readiness:**
- Kritické sprinty (L1, L2, L3 staircase) jsou stejné — jen běží paralelně místo sériově.
- Hard red lines respektovány: campaign send jen s explicit consent, mailbox passwords přes DB only, žádný direct SMTP probe.
- Hard rollback triggers stejné (bounce >5%, complaint >0.1%, Sentry spike).

**Co je deferred do post-launch:**
- L5 (S6 guardrails) — odložené 24h post-send. Hard tradeoff: pokud první send projde, tak guardrails jsou prevent-future ne block-current.
- L6 (7-day monitoring) — start automaticky po first send, ne separate sprint.

## Kontext

Předchozí plán launch-readiness rozprostírá práci do 3-7 dnů (conservative). User indikoval že **vše stihneme za pár hodin**. To je realistické pokud:
- User je dostupný pro L1.S1 (mailbox passwords) hned teď
- AI pracuje paralelně na L2 (suppression+leads+unsubscribe) + L4 (observability)
- Dry-run staircase (L3) probíhá kompresovaně bez 24h wait windows mezi stupni

Single-workday plan = 6-8h elapsed s 3 paralelními tracky merged do staircase.

## Cíle

1. **První real email odeslán** dnes (2026-04-27) před půlnocí.
2. **Pilot segment 30 contactů** odeslán do 8h od založení této iniciativy.
3. **Reply loop + bounce loop** prokázané E2E před soft launchem.
4. **Žádné placeholder data** v send pipeline (S1.S5 invariant).
5. **Observability minimum live**: Sentry events flow (i bez GH integration), dashboard auto-refresh.

## Non-cíle (FAST-TRACK kompromisy)

- **Neimplementujeme S6 guardrails před launchem.** CI invariant test, dashboard red badge, watchdog AUTH_FAIL alert — všechno deferred do post-launch (next session). Risk: pokud L1.S1 selže nebo se chyba opakuje, S6 nás chytne až post-mortem. Akceptovatelné protože L1.S1 je vis observed (4 mailboxes).
- **Neaktivujeme bot autonomous-ops** (handoff H1-H6) — bot může počkat. Launch-critical signály jsou Sentry email alert (default), ne GH issue auto-create.
- **Žádný Lighthouse/perf budget před launchem.** UI je good enough pro pilot.
- **Žádný stress test send rate.** Pilot 30 contactů je daleko od limit.

## Tracks (paralelně)

### TRACK A — Mailbox creds (user, ~1h)

**Vlastník:** uživatel
**Blocker pro:** L3 staircase entirely

```
A1.  Otevři Seznam webmail postupně 4× (4 mailboxy: mb=1, 3, 631, 632)
A2.  Pro každou: Account → Security → check 2FA stav
       - Pokud 2FA ON  → vygeneruj app-password ("Pošta" / "Other application")
       - Pokud 2FA OFF → použij login password
A3.  Otevři dashboard http://localhost:5175 → Mailboxy
A4.  Pro každou mailbox card: klik [Heslo] → vlož reálné heslo → Save
A5.  Verify v UI: žádný "PASSWORD MISSING" badge (až bude implementován v post-launch)
A6.  SQL sanity (nepříjemně optional, dashboard UI dělá to samé):
       psql ... "SELECT id, from_address, status, length(password)>0 as has_pwd
                 FROM outreach_mailboxes WHERE id IN (1,3,631,632)"
```

**Output po TRACK A:** 4× mailbox má v DB skutečné app-password / login password (nikdy `123p123p123p123`).

**Časový odhad:** 30-60 min reálně (login + app-password gen + paste do UI per mailbox = ~10-15 min).

### TRACK B — Suppression + leads + unsubscribe (AI, ~2-3h)

**Vlastník:** Chat A
**Blocker pro:** L3 (preflight gate vyžaduje supCount>0 + unsubscribe link funguje)
**Závislosti:** Žádné — můžu start hned

```
B1.  Suppression seed (10 min)
       SQL INSERT 20-50 entries do outreach_suppressions:
       - @hozan-taher.cz (interní)
       - @messing.dev (interní)
       - Známí partners/sellers
       - Common honeypots (postmaster@, abuse@, noreply@, spamtrap@)
       - Competitors (manual list)
       Mirror do suppression_list (UI side) pro UNION konzistenci

B2.  Migration 008_leads.sql (15 min)
       CREATE TABLE leads (
         id SERIAL PRIMARY KEY,
         contact_id INT REFERENCES contacts(id),
         campaign_id INT REFERENCES campaigns(id),
         mailbox_id INT REFERENCES outreach_mailboxes(id),
         classified_at TIMESTAMPTZ DEFAULT NOW(),
         sentiment TEXT NOT NULL,    -- interested|meeting|later|objection|negative|ooo
         original_message_id TEXT,
         original_text TEXT,
         status TEXT DEFAULT 'new',  -- new|contacted|qualified|disqualified
         assigned_to TEXT,
         UNIQUE (contact_id, original_message_id)
       );
       CREATE INDEX leads_status_classified ON leads(status, classified_at DESC);
       CREATE INDEX leads_campaign ON leads(campaign_id);
       Run migration: bash scripts/migrations/run.sh

B3.  Webhook in InboundProcessor (30 min)
       features/inbound/orchestrator/thread/inbound.go:
         func (p *InboundProcessor) onClassified(ctx, msg, sentiment) {
           if sentiment == "interested" || sentiment == "meeting" {
             insertLead(ctx, msg, sentiment)
           }
         }
       insertLead: ON CONFLICT DO NOTHING (idempotent via UNIQUE)
       Sentry log severity=info on insert

B4.  Leads UI read-only (45 min)
       features/platform/outreach-dashboard/src/pages/Leads.jsx
         table view: classified_at, contact email, sentiment, mailbox, status
         filter chip: status (default 'new'), sentiment (default 'interested|meeting')
       Route v src/routes.js: /leads
       BFF GET /api/leads → SELECT FROM leads ORDER BY classified_at DESC LIMIT 100

B5.  Unsubscribe endpoint (45 min)
       features/platform/outreach-dashboard/server.js:
         GET /unsubscribe?t=<token>     → render confirmation HTML page
         POST /unsubscribe              → verify HMAC, UPDATE contact, INSERT suppression
       features/platform/common/unsubscribe/token.go:
         Generate(contactID int64, expiry time.Duration) (string, error)
         Verify(token string) (contactID int64, err error)
         HMAC-SHA256 with env UNSUBSCRIBE_SECRET
       Templates render {{.UnsubURL}} → token URL injected in Go sender

B6.  Compliance smoke test (10 min)
       features/outreach/campaigns/render: render heavy-01-intro pro test contact
       curl localhost:8080/v1/render-template?template=heavy-01-intro&contact_id=42
       Verify {{.UnsubURL}} substituted, link funguje (klik → confirmation page)
```

**Output po TRACK B:** Preflight gate unblocks (supCount>0). Reply loop ukládá leads. Unsubscribe E2E funguje.

**Časový odhad:** 2-3h skutečné kódování (SQL + Go + JSX). Sequential v rámci TRACKu B, parallel s A+C.

### TRACK C — Observability minimum (AI, ~30 min)

**Vlastník:** Chat A
**Blocker pro:** Nic, ale wanted before staircase startuje
**Závislosti:** Žádné

```
C1.  Verify Sentry DSN aktivní per service (5 min)
       Test event do každého ze 4 Sentry projektů (relay, privacy-gateway, mailboxes, campaigns)
       Verify event visible v Sentry web UI
       Pokud ne: check env SENTRY_DSN, restart service

C2.  Dashboard live view audit (10 min)
       Otevři http://localhost:5175/dashboard
       Verify visible: mailbox health (4× green), today's send counts, bounce counts, reply counts
       Verify auto-refresh interval ≤30s (intervalRef v useOutreachHealth)
       Pokud /leads route ještě neexistuje (čekáme TRACK B B4), skip

C3.  Watchdog event log audit (10 min)
       psql: SELECT id, mailbox_id, event_type, severity, message, created_at
             FROM watchdog_events ORDER BY id DESC LIMIT 20
       Recent events sane? (žádné stale, žádné nezpracované high-severity)

C4.  Manual log tail prep (5 min)
       In separate terminal:
         tail -f /tmp/machinery-outreach.log
         tail -f /tmp/anti-trace-relay.log
       (or wherever services log; verify before staircase starts)
```

**Output po TRACK C:** Sentry events viditelné, dashboard live, watchdog history clean, log tails ready pro staircase monitoring.

**Časový odhad:** 30 min včetně inspekce.

### MERGE GATE — Před L3 staircase

Před spuštěním L3 staircase **všechny 3 tracky musí být done**:
- [ ] TRACK A: 4/4 mailboxů má real password v DB (verify SQL)
- [ ] TRACK B: leads tabulka exists, /unsubscribe funguje, suppression seed >0
- [ ] TRACK C: Sentry events flow, dashboard live, log tails ready

Merge step = AI verifikuje všechny 3 výše + odsouhlasí GO/NO-GO.

### TRACK D — L3 dry-run staircase (AI + user verify, 2-3h post-merge)

**Vlastník:** Chat A pro execution, uživatel pro **explicit GO** mezi stupni.

Per first-campaign-launch.md playbook, ale komprese: žádné 24h wait mezi stupni — jen **5-10 min wait** + dashboard inspekce.

```
D0.  AUTH probe (5 min)
       POST /v1/auth-check pro každou ze 4 mailboxů
       Expect ok=true
       Pokud fail → STOP, debug TRACK A
       SQL: UPDATE outreach_mailboxes SET status='active', circuit_opened_at=NULL,
            consecutive_bounces=0, auth_fail_count=0, status_reason=NULL
            WHERE id IN (1,3,631,632)

D1.  E2E self-send (15 min)
       4× test email (jeden z každé mailbox na vlastní adresu)
       Wait 2-3 min → verify v Seznam webmail Inbox
       Pokud ≥3/4 doručené → GO D2
       Pokud <3/4 doručené → STOP, post-mortem

D2.  Pilot segment + draft campaign (10 min)
       UI: New segment (NACE 43.11/43.12, region CZ, email status valid)
       Target ~30 contacts (pokud máme méně valid, použít kolik je)
       Save jako segment_pilot_machinery_001
       UI: New campaign s template heavy-01-intro
       Mailbox pool: 4× Seznam round-robin
       Daily cap per mailbox: 10
       Status: draft

D3.  STEP 0 dry-run (5 min)
       CAMPAIGN_DRY_RUN=true CAMPAIGN_ID=<n> pnpm send (or via dashboard "Dry run" button)
       Verify slog [dry_run] per recipient (~30)
       Verify operator_audit_log entry: action=campaign_tick_completed, dry_run=true
       Verify NO rows v send_events
       USER GO: před D4

D4.  STEP 1 single send (10 min)
       Manuálně: SELECT contact pro test (ideálně @messing.dev)
       UPDATE campaign_contacts SET enrollment_status='active' WHERE campaign_id=<n>
         AND contact_id=<test-contact> LIMIT 1
       Run live (no dry-run flag)
       Wait 3 min → verify delivery, verify send_events row, verify audit_log clean
       Verify dashboard counter increments
       USER GO: před D5

D5.  STEP 5 sample send (15 min)
       UPDATE campaign_contacts SET enrollment_status='active' WHERE ... LIMIT 5
         (mix internal+external)
       Run live
       Wait 5 min → check Sentry quiet, watchdog quiet
       Verify 5/5 v send_events
       Pokud ≥1 bounce → STOP, inspect
       USER GO: před D6

D6.  STEP 20 soft launch (30 min wait window)
       UPDATE campaign_contacts SET enrollment_status='active' WHERE ... LIMIT 20
       Run live
       Wait 30 min → review send_events, watchdog, Sentry
       Pokud ≥18/20 delivered + bounce ≤5% + 0 circuit trips → GO D7
       Pokud cokoliv worse → STOP, decision needed

D7.  Full pilot (zbytek 10-30 contactů)
       UPDATE všechny zbylé enrollment_status='active'
       Run live
       Monitor 1h → final stats
       Document v BOARD.md
```

**Output po TRACK D:** 30+ emails delivered, 1+ reply parsed (pokud někdo odpoví), 0 critical issues.

**Časový odhad:** 2-3h elapsed (5-10 min mezi stupni + 30 min D6 wait + 1h D7 monitor).

## Timeline (paralelní)

```
00:00  Start. TRACK A (user) + TRACK B (AI) + TRACK C (AI) start paralelně.
00:30  TRACK C done. (Sentry/dashboard/log tails ready.)
01:00  TRACK A done. (Mailbox passwords v DB.)
03:00  TRACK B done. (Suppression seed + leads + unsubscribe live.)
03:00  MERGE GATE — verify all 3 tracks. GO/NO-GO.
03:15  D0 AUTH probe. → 4/4 ok.
03:30  D1 self-send. → 4/4 delivered.
03:45  D2 segment + draft campaign.
04:00  D3 dry-run. → 30 [dry_run] rows.
04:15  D4 single send (test contact). → 1/1 delivered.
04:30  D5 sample send. → 5/5 delivered.
05:00  D6 soft launch 20. → wait 30 min.
05:30  D6 review. → 18+/20 delivered, GO D7.
05:30  D7 full pilot.
06:30  D7 monitor 1h. → done.

Total: ~6.5h elapsed → 30+ real emails delivered.
```

Pokud TRACK A vyžaduje 2h místo 1h (user busy elsewhere): timeline posune o 1h, end ~7:30. Pořád stihneme dnes.

## Co NE-uděláme dnes (deferred do post-launch session)

- **L5 / S6 guardrails:** CI invariant test, dashboard red badge, watchdog AUTH_FAIL alert. **Risk akceptován** protože S1 incident nebude reprodukován v ten samý den (dáváme reálné passwords právě teď).
- **L6 / 7-day aggregate report:** monitor next session.
- **Bot autonomous-ops handoff (H1-H6):** může počkat. Bot není launch-critical signal source.
- **Sentry → GH native integration (H4):** Sentry email alerts default zachytí incidents. GH issue auto-create je nice-to-have.
- **Daily digest GH Discussion (H3):** může počkat. První digest má cenu po týdnu provozu, ne den 1.
- **Lighthouse / perf budget audit:** UI good enough pro pilot.

## Decision matrix (compressed)

| Při... | Krok |
|---|---|
| TRACK A AUTH check fail (D0 1-2/4) | 30 min retry; pokud stále fail, STOP + debug Seznam side |
| TRACK A AUTH check fail (D0 3-4/4) | STOP. Re-confirm passwords. Možná Seznam side issue (rate limit, IP block). |
| D1 self-send 0/4 | STOP. Anti-trace-relay nebo Seznam reputation issue. Investigate logs. |
| D1 self-send 1-3/4 | Identify which mailbox failed. Pokud isolated: continue D2 s healthy mailboxes. |
| D5 bounce 1/5 | Inspect bounce reason. Pokud typo/recipient invalid: continue. Pokud catch-all: pause. |
| D5 bounce 2+/5 | STOP. Verifier rules nebo segment quality issue. |
| D6 bounce >5% | STOP. Bigger sample needed before D7. |
| D6 spam complaint | STOP. Rollback all enrollments. Audit. |
| D6 ok | Continue D7. |
| Sentry spike anywhere | Investigate immediately. STOP send pokud severity=error. |

## Hard rollback (any step)

```bash
# Pause all 4 mailboxes
psql ... "UPDATE outreach_mailboxes SET status='paused', status_reason='launch-fasttrack rollback' WHERE id IN (1,3,631,632)"

# Halt enrollment
psql ... "UPDATE campaign_contacts SET enrollment_status='paused' WHERE campaign_id=<n> AND enrollment_status='active'"

# Sentry alert (manual)
curl -X POST https://sentry.io/api/0/.../events/  -d '{...}'

# GH issue
gh issue create --title "Launch rollback YYYY-MM-DD" --body "..." --label priority/p0,kind/bug
```

## Závislostní graf

```
TRACK A (user, 1h) ─────────────────────────┐
TRACK B (AI, 2-3h) ─────────────────────────┤
                                              ▼
TRACK C (AI, 30min) ────────────────────►  MERGE GATE  ────► D0 → D1 → D2 → D3 → D4 → D5 → D6 → D7
```

A, B, C jsou paralelní. MERGE GATE = AI verify všech 3. D0-D7 sequential s user GO mezi stupni.

## Otevřené otázky (rozhodnout PŘED tracku D)

- **Pilot size**: 30 nebo 50? Záleží kolik valid contactů reálně máme. Conservative 30.
- **D1 self-send recipient**: vlastní @messing.dev nebo Seznam webmail self? Doporučuji `@messing.dev` (visible, no Seznam-Seznam routing tricks).
- **D6 wait length**: 30 min default. Pokud user wants faster: 15 min minimum (Seznam delivery typically <2 min, ale spam folder check 10 min).
- **Compliance check D2**: Zkontroluj že segment není v EU/EEA jurisdiction (per CLAUDE.md). Pokud CZ pilot → potvrdit s user že outreach nemá GDPR scope.

## Log

- 2026-04-27 — založeno; supersedes timeline z launch-readiness pro single-workday compressed mode
