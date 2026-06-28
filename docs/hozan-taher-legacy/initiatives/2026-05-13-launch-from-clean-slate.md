# Launch from clean slate — Hozan Taher výkup-techniky

> **Status:** Active
> **Datum:** 2026-05-13
> **Trigger:** Po incident-fixu + čištění (PR #1338-#1342, send_events=0, 4 schránky 1180-1183, 31199 scored cohort). Cesta od "vše uklizené" k prvnímu reálnému batch sendu.

## Cíl

Operator klikne **Odeslat 5** na `/campaigns/457` v lokálním UI → 5× A-tier kontaktů (Demolice/Kamiony/Stavební firmy) dostane email od **hozan.taher.75-78@post.cz** → bez bouncí, bez spam reportů, replies přicházejí do `/replies`.

## Aktuální stav (proč existuje tento doc)

| Vrstva | Stav | Blocker? |
|---|---|---|
| Code on main | ✅ 11 PRs merged | — |
| Migrations | ✅ 111+112 applied | — |
| send_events | 0 (clean) | — |
| 4 active mailboxes | 1180-1183 production cap=120 | — |
| 31199 pending scored | A=6338/B=12279/C=5532/D=1929/E=5121 | — |
| DB trigger `enforce_warmup_cap` | RAISE on missing mailbox | — |
| Go runner machinery-outreach | DOWN (3× FAILED deploy) | OK — trigger drží |
| Railway BFF outreach-dashboard | STUCK na 11:46 deployi (3× FAILED) | ⚠️ blokuje verify cron + nové endpointy |
| Verify cron | 0/31198 (env nepicknul) | ⚠️ |
| Operator UI | `pnpm dev` lokálně, fungující | — |

## 6 sprintů

### W1 — Railway BFF deploy fix (P0, blocker)

Cíl: dostat čerstvý BFF deploy z main (commit 3ce5c645+).

3 FAILED deploys za sebou na "scheduling build" stage. Příčina: TBD (možnosti: builder overload, billing, .railwayignore size, broken GitHub integration).

Steps:
1. Inspect Railway service settings → Source → ověř GitHub branch=main, auto-deploy on push, builder=Nixpacks/Dockerfile
2. Pokud disconnected → re-attach GitHub repo
3. Pokud builder overload → wait + retry manual "Deploy" button
4. Pokud .railwayignore problem → audit size of build context (`du -sh` z PROJECT_ROOT minus excludes)
5. Smoke after: `git_sha` v `/api/health` matchne `git rev-parse HEAD`

Acceptance: BFF git_sha != "unknown", verify cron config picked up, /api/campaigns/457/priority-distribution returns 200.

### W2 — Smoke send z mailboxu 1180 (P0)

Cíl: ověřit credentials + relay path end-to-end pro hozan.taher.75@post.cz.

Pošli **1 synthetic [TEST] email** z 1180 → info@messing.dev:
- Body: "[TEST] Hozan Taher mailbox 1180 smoke 2026-05-13" + timestamp
- Per HARD rule `feedback_test_send_synthetic_only` — žádný production content
- Path: `pnpm dev` lokálně → `/campaigns/457` → SendBatchPanel (manual override "Test send")
- OR direct BFF curl: `POST /api/campaigns/457/send-test` s mailbox_id=1180

Acceptance:
- envelope sealed v send_events (status='sealed' or 'sent')
- Email přijde v Gmailu (info@messing.dev) do 30s
- IMAP poll uvidí Sent folder s message-id

Plus opakuj pro 1181, 1182, 1183 (4 smoke testy celkem).

### W3 — Local DNS verify driver (P1)

Cíl: dokončit DNS check 31198 contactů bez závislosti na Railway cron.

Pokud W1 vyřeší cron, **přeskoč W3**. Jinak:

Standalone Node skript v `features/platform/outreach-dashboard/scripts/verify-cohort-local.mjs`:
- Import `lib/emailProbe.js` (existing)
- SELECT contact_id, email FROM contacts WHERE email_verify_next_at <= now() LIMIT 31200
- Concurrency 20 (sequential SMTP probes per host, parallel across hosts)
- For each: probe MX + A + SPF/DMARC + RCPT + catch-all
- UPDATE contacts.email_status + email_verified_at + email_verification
- INSERT email_verification_log row per result
- Run via `node scripts/verify-cohort-local.mjs --campaign=457 --limit=31200`

Acceptance: 31198 contactů má fresh `email_verified_at` v rámci 30 min. Per-tier breakdown updated.

### W4 — A-tier první batch (5 sendů, P0)

Cíl: spustit reálnou outreach na 5 A-tier kontaktů.

Předpoklady: W2 (smoke OK) + W3 (verify done).

Steps:
1. Operator otevře lokální `localhost:18175/campaigns/457`
2. Vidí tier breakdown: A=6338 (top)
3. Klikne **Odeslat 5** v SendBatchPanel
4. 5× A-tier (Demolice/Kamiony/Stavební-firmy podle priority DESC) → rozhozeno přes 4 mailboxy
5. Spacing 180s mezi sendy stejné schránky
6. Email obsahuje template `intro_machinery` (subject "Dotaz", body Hozan Taher + Balkan Motors)

Acceptance:
- 5× send_events status='sent'
- 0 bouncí v následujících 5 minutách
- 0 spam-trap hitů
- Operator vidí v "Recent sends" panel (CampaignDetail) s priority badges

### W5 — Scale to 50/den (P1)

Po W4 (24h bez incidentu):
- Operator klikne **Odeslat 10** 5× během dne (~každé 2h)
- Cumulative 50 sendů/den, distribuováno přes 8-20h send window
- Sledování per-mailbox bounce rate (M1 panel)
- Pokud bounce > 2% → pause mailboxu (auto-trigger)

Acceptance: 7 dní × 50/den = 350 sendů s bounce rate < 1%, spam rate < 0.1%.

### W6 — Reply monitoring + manual triage (P1)

Po W5 (350 sendů → očekávané ~5-10 replies dle dnes-2024 baseline):
- Operator otevře `/replies` (sidebar badge červený dot na unmatched)
- Pro každou odpověď: zobrazí thread + draft reply v UI
- Manual reply send přes existing Sprint 2.2 flow
- Per HARD rule `feedback_test_send_synthetic_only` — žádné auto-reply, vždy operator-in-the-loop

Acceptance: 3-5 reálných replies / 350 sends = ~1.5% reply rate (matchne 2024 Hozan baseline).

## Sekvencování + závislosti

- **W1** (Railway fix) → unlocks W3 (Railway cron) ALEBO `feedback_check_backlog_when_idle` workaround → W3 standalone
- **W2** (smoke) je independent — runs anytime
- **W3** depends jen on W2 (zajistí credentials work)
- **W4** depends on W2 + (W3 OR accepted-existing-valid)
- **W5** depends on W4 (24h burn-in)
- **W6** runs continuously po W4 onwards

## Estimát

| Sprint | ETA | Pokud blocker hit |
|---|---|---|
| W1 | 30-60 min | Operator action v Railway dashboard |
| W2 | 5 min | Re-verify credentials in DB if AUTH fail |
| W3 | 30-60 min build + 30 min run | — |
| W4 | 1 min execution + 5 min observation | — |
| W5 | 7 dní burn-in | — |
| W6 | Continuous | — |

## Riziko

| Riziko | Likelihood | Mitigation |
|---|---|---|
| Railway zůstane FAILED → W1 protrahované | M | W3 bypass; UI funguje z localu i bez deploye |
| Mailbox 1180 password mismatch | L | W2 smoke catch; re-check DB password |
| Send hit spam-trap → mailbox bann | L | A-tier only (Demolice/Stavby = real businesses, ne lists); per-mailbox bounce throttle |
| Bounce rate > 2% při W5 | M | Auto-pause mailboxu (existující M1 trigger); manual review per-domain |
| Replies dorazí ale R4 sidebar badge neviditelný | L | Místní UI z `pnpm dev` má kód, R4 už merged |

## Cross-reference HARD rules

- `feedback_test_send_synthetic_only` T0 — W2 smoke je synthetic; W4 production content vyžaduje explicit operator click
- `feedback_outreach_dashboard_local_only` T0 — UI z `pnpm dev`, ne přes Railway URL
- `feedback_campaign_send` T0 — žádný send bez explicit operator consent (klik v UI)
- `feedback_engine_path_test` T0 — W2 testuje full path daemon→engine→relay→IMAP (ne raw relay submit)
- `feedback_anti_trace_full_stack` T0 — sends musí jít přes `sender.Engine.Run()` chain
- `feedback_audit_log_on_mutations` T0 — každý send mutates state, audit-logged via existing helper
