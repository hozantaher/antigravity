# Contact Deliverability Verify Loop

**Status:** Open
**Datum:** 2026-05-08
**Trigger:** Při pre-flight kampaně 457 jsem zjistil, že 100% kontaktů má `email_status='unverified'`. Manuální DNS+role check (Railway native, NE Mullvad) ukázal 80 deliverable + 20 role-based, ale celé to byl ad-hoc skript. Po PR #1092 (verify probe → Railway native egress) je systém bezpečný — chybí ale automatický loop, který by průběžně ověřoval všechny kontakty v DB. Operator vyžaduje background-service.

## Cíl

Po dokončení iniciativy:

1. Každý nový kontakt zařazený do DB se automaticky ověří do 24 hodin (DNS + SMTP RCPT probe přes Railway egress, NE Mullvad).
2. Existující kontakty se re-verifikují periodicky (default 90 dní pro `valid`, 180 dní pro `role_only`).
3. Bounce events automaticky aktualizují `email_status` (hard bounce → `invalid`, soft → `risky` s retry).
4. Per-domain rate limit chrání MX servery + Railway IP reputation.
5. Operator vidí v dashboardu queue depth, error rate a může pauznout / manuálně triggernout / override.
6. Při spuštění kampaně pre-flight selže pokud je v segmentu kontakt s `email_status` v ('invalid', 'spamtrap', 'bounce_hold').

## Proč to dělat

Současný stav:
- `/api/contacts/:id/verify-email` endpoint existuje ale je manuální (per-call).
- `email_verify_queue` tabulka existuje ale neví se jestli ji někdo používá (ověří inventory).
- `mailbox_score_loop.go` v Go orchestrátoru řeší **naše vlastní schránky** (sendery), ne příjemce.
- Pre-launch kontrola dnes neumí filtr per-contact deliverability — operator si musí pamatovat manuálně spustit verify před každou kampaní.

Bez tohoto loopu:
- Nedeliverable kontakty si vezmou warmup volume, který by jinak šel na deliverable.
- Hard bounces zhoršují IP reputation kdyby šly opakovaně.
- Operator nemá data pro segment-level rozhodnutí ("kolik z 500 leadů má valid email?").

## Sprint AM1 — Schema + state machine foundation

Bez tohoto nelze spustit AM2. Migrace a column-level základy.

**Co uděláme:**

- Migrace `065_email_verify_state.sql`:
  - `contacts.email_verify_priority` (INT, default 50, vyšší = dřív)
  - `contacts.email_verify_attempts` (INT, default 0)
  - `contacts.email_verify_next_at` (TIMESTAMPTZ) — kdy je další pokus naplánován
  - CHECK constraint na `email_status` IN ('unverified', 'verifying', 'valid', 'role_only', 'risky', 'invalid', 'spamtrap', 'bounce_hold')
  - Index na `(email_status, email_verify_next_at)` pro rychlé due-picking
- Tabulka `email_verify_domain_quarantine` (key=domain, quarantine_until, reason)
- Pokud `email_verify_queue` existuje a je nepoužívaná → drop. Pokud používaná → dokumentovat a integrovat.
- Backfill: SET `email_status='unverified'`, `email_verify_next_at=NOW()` pro všechny kontakty kde je NULL.

**Definice hotovo:**

- Migrace aplikovaná na prod, audit `bash scripts/migrations/check-integrity.sh` zelený.
- DB má všechny sloupce a indexy; SELECT test prochází.
- Žádný kód v AM1 — jen schema + backfill.

## Sprint AM2 — Loop core (Go orchestrator)

Hlavní engine. Bez UI surface AM3 NESPOUŠTĚT v prod (default disabled via env).

**Co uděláme:**

- Nový Go balíček `features/inbound/orchestrator/intelligence/contact_verify_loop.go`.
- Tick každou hodinu (env `VERIFY_LOOP_INTERVAL_SECONDS=3600`).
- Per-tick: SELECT kontakty kde `email_verify_next_at <= NOW()` ORDER BY priority DESC, email_verify_next_at ASC, LIMIT batch_size (env `VERIFY_BATCH_SIZE=20`).
- Per-domain rate limit (env `VERIFY_PER_DOMAIN_RPS=5`) — kontroluje pomocí `email_verification_log` count v posledním okně.
- Globální rate limit (env `VERIFY_GLOBAL_RPS=200`).
- Pro každý due kontakt: zavolá relay `/v1/verify` přes HTTP klienta. Response → state transition + retry-backoff výpočet.
- Loop respektuje doménový quarantine.
- Slog každého ticku s `op=contact_verify_loop.tick` (per memory `slog-conventions`).
- Sentry event při error rate > 50% v jednom ticku.
- Default `VERIFY_LOOP_ENABLED=false` — operator zapne až po AM3.

**Definice hotovo:**

- Test sweep: ≥10 testů (per memory `feedback_extreme_testing`) — happy path, rate limit, retry backoff, domain quarantine, dead-MX, role detection.
- Loop běží lokálně manuálně 1 tick → updates nějaký kontakt v test DB.
- Slog výstup viditelný, Sentry release tag set.

## Sprint AM3 — Operator surface (BFF + React)

Bez tohohle se v prod nesmí AM2 zapnout. Operator potřebuje pause/resume + manuální trigger + viditelnost.

**Co uděláme:**

- BFF endpointy `features/platform/outreach-dashboard/src/server-routes/verifyLoop.js`:
  - `GET /api/verify-loop/status` — { enabled, last_tick, contacts_pending, verified_today, error_rate, paused }
  - `POST /api/verify-loop/pause` — X-Confirm-Send guard, settne pause flag v DB
  - `POST /api/verify-loop/resume`
  - `POST /api/verify-loop/trigger` — rate-limited, manual tick (BFF→Go orchestrator HTTP call)
  - `GET /api/verify-loop/queue?limit=N` — top N due kontaktů
  - `POST /api/contacts/:id/reverify` — force re-verify single
- React stránka `features/platform/outreach-dashboard/src/pages/SettingsVerifyLoop.jsx` na route `/settings/verify-loop`:
  - Status pill (running/paused/disabled)
  - Queue depth + last_tick timestamp
  - Error rate sparkline (24h)
  - Recent verifications table (top 20)
  - Pause/Resume button + manual trigger
  - Per-domain quarantine list
- Nav link v Layout.jsx sidebar.

**Definice hotovo:**

- Operator může v UI vidět co loop dělá, pauznout, znovu spustit.
- Po commitu lze zapnout AM2 v prod (env `VERIFY_LOOP_ENABLED=true`).

## Sprint AM4 — Bounce integration

Loop sám neví o bounces. Tahle integrace zavře feedback.

**Co uděláme:**

- Existing bounce_events processor (najít location v inventory) doplnit o:
  - Hard bounce (5xx, mailbox does not exist) → `contacts.email_status='invalid'` + suppression cascade.
  - Soft bounce (4xx, temporary) → `contacts.email_status='risky'` + retry scheduled in `email_verify_next_at = NOW() + 24h`.
  - 5+ consecutive bounces → `email_status='bounce_hold'` (permanent).
- Test E2E: simulovaný bounce z mock SMTP → kontakt se update.
- Žádný auto re-verify na 'bounce_hold' — operator musí explicitly resetovat.

**Definice hotovo:**

- Bounce v test DB → contacts row reflektuje stav.
- Suppression UNION zahrnuje 'invalid' + 'bounce_hold' kontakty.

## Sprint AM5 — Smart scheduling + observability

Polish. Není blocker. Lze odložit.

**Co uděláme:**

- Priority queue: NEW contacts (status NULL nebo 'unverified') priority=100, regular re-verify priority=50.
- Exponential backoff: failed verify pokus 1 → retry za 1h, pokus 2 → 6h, pokus 3 → 24h, pokus 4 → 7d, pokus 5 → mark `invalid`.
- Domain quarantine: 3 timeouts za hodinu na doméně → 24h quarantine.
- Health surface: `/health` Go orchestrator vrací `verify_loop` field s metrics.
- Optional: Sentry release alert když verify error rate > 50% v 24h okně.

**Definice hotovo:**

- Operator vidí domain quarantine v UI + může manuálně unblock.
- Backoff functions table-driven (configurable).

## Pořadí + závislosti

| Sprint | Závislost | Effort | P |
|---|---|---|---|
| AM1 schema | žádná | 1d | P0 |
| AM2 loop core | AM1 | 3d | P0 |
| AM3 operator surface | AM2 (souběžně lze začít) | 2d | P0 |
| AM4 bounce integration | AM2 | 2d | P1 |
| AM5 smart scheduling | AM2 | 2d | P2 |

Total: ~10 dní práce, ale paralelizovatelné po AM2 hotovém.

## Otevřené otázky pro operátora

1. **Re-verify perioda** pro `valid` — 90 dní default OK? Kratší (30) = víc probe load, delší (180) = stale data.
2. **Manual override** — operator pravo přímo settingnout `email_status='valid'` přes UI bez probe? (Důvěryhodné kontakty z CRM.)
3. **Bounce processor location** — existuje nebo musí být součástí AM4?
4. **VERIFY_GLOBAL_RPS=200/h** — OK threshold? Železné max je ~500/h Railway egress IP, ale nechci spalovat reputaci.

Po odpovědích startujem AM1.

## Co tato iniciativa NEDĚLÁ

- Verify SENDING mailboxes (naše Goran schránky) — to je oddělený `mailbox_score_loop.go`.
- 3rd party verify API (ZeroBounce atd.) — operator memory `feedback_no_external_services`.
- Per-mailbox preferred country — sprint AN (běží paralelně, jiný agent).
