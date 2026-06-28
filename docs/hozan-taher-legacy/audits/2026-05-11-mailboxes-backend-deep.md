# Mailboxes Backend Deep Audit — 2026-05-11

**Scope:** všechny `/api/mailboxes/*` endpointy v BFF  
**Soubory:** `features/platform/outreach-dashboard/src/server-routes/mailboxes.js`, `server.js`  
**Výsledky:** 33 routes pokryto, 2 frontend-only URL bez backendu, 9 backend-only dead endpoints, řada schema/validation mezer

---

## 1. Route Table

Seřazeno podle path. Auth = global `createAuthMiddleware()` (X-API-Key nebo ?token=, timing-safe); výjimky viz sekce 6.

| METHOD | PATH | Soubor:řádek | Popis | Input shape | Output shape | Side effects | Rate limit | Auth |
|--------|------|--------------|-------|-------------|--------------|--------------|------------|------|
| GET | `/api/mailboxes` | mailboxes.js:171 | Seznam schránek; ?q= server-side ILIKE search; ?all=1 vč. test env | `?q`, `?all` | `Mailbox[]` (sanitized, bez password) | — | — | X-API-Key |
| POST | `/api/mailboxes` | mailboxes.js:219 | Vytvoření schránky; advisory lock + pool capacity pre-flight | body: email, smtp_host, smtp_port, smtp_username, password, daily_limit, imap_host, imap_port | `Mailbox` (sanitized) | INSERT outreach_mailboxes; INSERT operator_audit_log | — | X-API-Key |
| GET | `/api/mailboxes/anonymity-probe` | server.js:3743 | Spustí ring-topology probe přes relay /v1/submit; background IMAP fetch po 30s | — | `{ok, probe_id, results[]}` | smtpSend přes relay; setTimeout IMAP fetch | — | X-API-Key |
| POST | `/api/mailboxes/bulk-assign-proxy` | server.js:3680 | Přiřadí nejlepší proxy každé vybrané schránce přes SMTP AUTH probe | body: `{ids: number[]}` | `{ok, results[]}` | UPDATE outreach_mailboxes.proxy_url | — | X-API-Key |
| POST | `/api/mailboxes/bulk-check` | server.js:3722 | Spustí full-check pro N schránek (async loop) | body: `{ids: number[]}` | `{ok, triggered: N}` | Invaliduje proxyCache; volá /full-check interně | — | X-API-Key |
| GET | `/api/mailboxes/health-stream` | server.js:2997 | SSE stream — per-mailbox health events; heartbeat 25s | — | SSE `event: mailbox` JSON | — | — | X-API-Key nebo ?token= |
| GET | `/api/mailboxes/health-summary` | server.js:3228 | Agregovaný health snapshot ze `mailbox_check_cache`; 90s TTL | — | `{total, healthy, degraded, critical, mailboxes[]}` | — | — | X-API-Key |
| POST | `/api/mailboxes/import-csv` | server.js:3867 | Bulk import/upsert schránek z CSV řádků | body: `{rows: [{email,smtp_host,smtp_port,password,imap_host,imap_port}]}` | `{ok, imported, total, errors, ids, results}` | INSERT/ON CONFLICT UPDATE outreach_mailboxes | — | X-API-Key |
| GET | `/api/mailboxes/send-trends` | server.js:3266 | 7-denní denní sparkline data pro všechny schránky; ?days=1-30 | `?days` | `{[mailbox_id]: number[]}` | — | — | X-API-Key |
| GET | `/api/mailboxes/:id` | mailboxes.js:198 | Jedna schránka; forward na next() pro non-numeric :id | `?all` | `Mailbox` (sanitized) | — | — | X-API-Key |
| PATCH | `/api/mailboxes/:id` | mailboxes.js:292 | Update polí; FIELD_MAP bílý seznam; zvláštní handling pro password | body: subset {status, display_name, smtp_host, …, password} | `Mailbox` (sanitized) | UPDATE outreach_mailboxes; audit log status + credential změny; DELETE mailbox_check_cache (probe-affecting fields) | — | X-API-Key |
| DELETE | `/api/mailboxes/:id` | mailboxes.js:390 | Smazání schránky | — | `{ok: true}` | DELETE outreach_mailboxes (CASCADE); INSERT operator_audit_log | — | X-API-Key |
| GET | `/api/mailboxes/:id/alerts` | mailboxes.js:672 | Posledních 50 alertů z mailbox_alerts | — | `Alert[]` | — | — | X-API-Key |
| PATCH | `/api/mailboxes/:id/alerts/:alertId/resolve` | mailboxes.js:683 | Označení alertu jako resolved | — | `{ok: true}` | UPDATE mailbox_alerts.resolved_at | — | X-API-Key |
| POST | `/api/mailboxes/:id/assign-proxy` | server.js:1851 | Přiřadí nejlepší proxy přes SMTP AUTH probe (s timeoutem 50s) | — | `{proxy_url, latency_ms, country, mailbox}` | UPDATE outreach_mailboxes.proxy_url; INSERT watchdog_events | — | X-API-Key |
| POST | `/api/mailboxes/:id/auth-reset` | mailboxes.js:572 | Nuluje auth_fail_count, zavírá circuit, maže auth_fail_alert watchdog | body: `{reason?}` | `{ok, mailbox}` | UPDATE outreach_mailboxes (auth_fail_count=0); UPDATE watchdog_events; INSERT watchdog_events | — | X-API-Key |
| GET | `/api/mailboxes/:id/bounce-status` | server.js:3406 | Bounce health classification | — | `{ok, classification, consecutive, rate, total_sent, total_bounced, status}` | — | — | X-API-Key |
| GET | `/api/mailboxes/:id/campaigns` | mailboxes.js:472 | Kampaně kde mailbox byl použit (JOIN send_events) | — | `{total, campaigns[{id,name,status,sent_count,last_sent_at}]}` | — | — | X-API-Key |
| GET | `/api/mailboxes/:id/check-history` | server.js:3644 | Posledních 14 score ze mailbox_check_history | — | `[{score, ok, checked_at}]` | — | — | X-API-Key |
| POST | `/api/mailboxes/:id/clear-auth-lock` | mailboxes.js:700 | Odemčení auth_locked mailboxu po 24h cooldown | body: `{reason?}`; header `X-Confirm-Send: yes` | `{ok, mailbox}` nebo 425 s hours_remaining | UPDATE outreach_mailboxes (status='paused'); INSERT operator_audit_log; UPDATE mailbox_alerts | — | X-API-Key + X-Confirm-Send:yes |
| GET | `/api/mailboxes/:id/config-check` | server.js:3372 | Statická validace konfigurace schránky (bez síťového dotiazu) | — | `{ok, issues[]}` | — | — | X-API-Key |
| GET | `/api/mailboxes/:id/cooldown-log` | mailboxes.js:614 | Audit log bounce-hold cooldown periody | `?limit` | `CooldownRow[]` | — | — | X-API-Key |
| GET | `/api/mailboxes/:id/egress-history` | mailboxEgressHistory.js:47 | Historie egress pin změn z mailbox_egress_repin_audit | `?hours` | `{mailbox_id, egress_history[]}` | — | — | X-API-Key |
| GET | `/api/mailboxes/:id/full-check` | server.js:3463 | Kompletní zdravotní check (SMTP+IMAP+config+warmup+bounce+send_rate+pipeline+DNS+anti_trace); 90s cache; ?force=1 | `?force` | `{score, ok, cached, checks{…}, critical[], warnings[]}` | INSERT/UPDATE mailbox_check_cache; INSERT mailbox_check_history; INSERT mailbox_alerts (dns_fail); applyAutomationRules; publishHealthEvent SSE | AP3: max 2/hod | X-API-Key |
| POST | `/api/mailboxes/:id/header-probe` | server.js:3349 | IMAP fetch hlaviček podle Message-ID; analýza anonymity | body: `{message_id}` | `{score, issues, safe, found, rawHeaders}` | — | — | X-API-Key |
| GET | `/api/mailboxes/:id/imap-check` | server.js:3321 | IMAP auth check přes SOCKS5; recordAuthFail při selhání | — | `{ok, ms, steps[]}` | recordAuthFail (AP6) při auth chybě | — | X-API-Key |
| GET | `/api/mailboxes/:id/imap-inbox` | server.js:3656 | Počet nepřečtených z INBOX přes IMAP SOCKS5 | — | `{ok, unseen}` | — | AP3: max 6/hod | X-API-Key |
| GET | `/api/mailboxes/:id/pipeline-results` | mailboxes.js:634 | Posledních 5 uložených výsledků pipeline testu z DB | — | `PipelineResult[]` (normalizovaný) | — | — | X-API-Key |
| GET | `/api/mailboxes/:id/pipeline-status` | server.js:3445 | Nejnovější pipeline výsledek s stale detekci | — | `{ok, exists, overall_ok, tested_at, age_h, stale}` | — | — | X-API-Key |
| POST | `/api/mailboxes/:id/pipeline-test` | server.js:1465 | Spustí Node.js SMTP+IMAP pipeline test a uloží výsledek | — | `{id, overall_ok, steps, tested_at}` | INSERT mailbox_pipeline_results | — | X-API-Key |
| GET | `/api/mailboxes/:id/proxy-live-check` | server.js:1825 | Probe SOCKS5 proxy přiřazené k mailboxu | — | `{ok, ms, proxy_url, host, port}` | — | — | X-API-Key |
| POST | `/api/mailboxes/:id/recover` | mailboxes.js:521 | Manuální force-release; nuluje bounces, nastaví canary=10 | body: `{reason?}` | `{ok, mailbox, canary_remaining}` | UPDATE outreach_mailboxes; UPDATE mailbox_cooldown_log; INSERT watchdog_events | — | X-API-Key |
| POST | `/api/mailboxes/:id/repin` | mailboxesRepin.js:35 | Operator změna Mullvad endpoint pinu | body: `{new_endpoint_label, reason}`; header `X-Operator-Id` | `{mailbox_id, old_label, new_label, reason, actor}` | UPDATE outreach_mailboxes (pinned_endpoint_label); INSERT mailbox_egress_repin_audit | — | X-API-Key + X-Operator-Id allowlist |
| GET | `/api/mailboxes/:id/send-log` | mailboxes.js:451 | Posledních 30 send events s contact join | — | `SendEvent[]` | — | — | X-API-Key |
| GET | `/api/mailboxes/:id/send-rate` | server.js:3423 | Dnešní count vs. daily cap | — | `{ok, sent_today, limit, pct, last_send_at, last_send_age_h}` | — | — | X-API-Key |
| POST | `/api/mailboxes/:id/send-test` | server.js:3962 | Odeslání testovacího emailu přes relay; send window + suppression guard + warmup cap check | body: `{to, subject?, text?, port?}` | `{ok, messageId, from, to, via}` | smtpSendWithFallback → relay /v1/submit | — | X-API-Key |
| GET | `/api/mailboxes/:id/smtp-check` | server.js:3300 | SMTP auth probe přes relay | — | `{ok, ms, steps[]}` | — | AP3: max 12/hod | X-API-Key |
| GET | `/api/mailboxes/:id/stats` | mailboxes.js:431 | Aggregate statistiky (total_sent, bounced, sent_30d) | — | `{total_sent, total_bounced, sent_30d, consecutive_bounces}` | — | — | X-API-Key |
| PATCH | `/api/mailboxes/:id/warmup` | mailboxes.js:441 | Pause/resume warmup | body: `{paused: bool}` | `{ok: true}` | UPDATE mailbox_warmup.is_paused | — | X-API-Key |
| POST | `/api/mailboxes/:id/warmup/start` | mailboxes.js:652 | Spustí warmup od Day 1 (idempotentní) | — | `{ok, mailbox_address}` | INSERT/ON CONFLICT UPDATE mailbox_warmup | — | X-API-Key |
| GET | `/api/mailboxes/:id/warmup-status` | server.js:3385 | Warmup stav s stale detekcí | — | `{ok, active, day, paused, stale, last_advanced_h, pause_reason}` | — | — | X-API-Key |
| GET | `/api/mailboxes/:id/watchdog-events` | mailboxes.js:496 | Watchdog timeline pro jednu schránku | `?limit` (1-50) | `WatchdogEvent[]` | — | — | X-API-Key |

**Speciálně:**
- `GET /api/metrics/mailboxes` (server.js:1331) — Prometheus text-format gauge snapshot; mimo `/api/mailboxes/` namespace

---

## 2. Routes Called by Frontend But Missing Backend

Cross-reference Mailboxes.jsx + MailboxDrawer.jsx → všechna `fetch('/api/mailboxes/...')`:

| Frontend URL | Soubor:řádek | Status |
|---|---|---|
| `/api/mailboxes/${mb.id}/full-check` | MailboxDrawer.jsx:487,504,558 | ✅ EXISTS server.js:3463 |
| `/api/mailboxes/${mb.id}/check-history` | MailboxDrawer.jsx:489 | ✅ EXISTS server.js:3644 |
| `/api/mailboxes/${mb.id}/stats` | MailboxDrawer.jsx:491 | ✅ EXISTS mailboxes.js:431 |
| `/api/mailboxes/${mb.id}/campaigns` | MailboxDrawer.jsx:494 | ✅ EXISTS mailboxes.js:472 |
| `/api/mailboxes/${mb.id}/auth-reset` | MailboxDrawer.jsx:515 | ✅ EXISTS mailboxes.js:572 |
| `/api/mailboxes/${mb.id}/send-test` | MailboxDrawer.jsx:534 | ✅ EXISTS server.js:3962 |
| `/api/mailboxes/${mb.id}/warmup` (PATCH) | Mailboxes.jsx:773 | ✅ EXISTS mailboxes.js:441 |
| `/api/mailboxes/${mb.id}/full-check?force=1` | Mailboxes.jsx:879 | ✅ EXISTS server.js:3463 |
| `/api/mailboxes/${mbId}/assign-proxy` | Mailboxes.jsx:816 | ✅ EXISTS server.js:1851 |
| `/api/mailboxes/bulk-assign-proxy` | Mailboxes.jsx:832 | ✅ EXISTS server.js:3680 |
| `/api/mailboxes/bulk-check` | Mailboxes.jsx:858 | ✅ EXISTS server.js:3722 |
| `/api/mailboxes/import-csv` | Mailboxes.jsx:393 | ✅ EXISTS server.js:3867 |
| `/api/mailboxes/health-summary` | Mailboxes.jsx:593,865 | ✅ EXISTS server.js:3228 |
| `/api/mailboxes/health-stream` | Mailboxes.jsx:643 | ✅ EXISTS server.js:2997 |
| `/api/mailboxes/send-trends?days=7` | Mailboxes.jsx:611 | ✅ EXISTS server.js:3266 |

**Chybějící backend — 2 URL:**

1. **`/api/mailboxes/anonymity-probe/results?probe_id=<id>`** — note uvnitř `POST /api/mailboxes/anonymity-probe` response (server.js:3826) slibuje tento GET endpoint pro výsledky. Endpoint neexistuje. Výsledky jsou pouze logovány do konzole, nikdy persistovány ani dostupné přes HTTP. (server.js:3862-3864)

2. **`/api/mailboxes/${mb.id}/clear-auth-lock`** — volá se z žádného z Mailboxes.jsx / MailboxDrawer.jsx souborů. Endpoint existuje (mailboxes.js:700) ale UI pro AP6 auth-lock unlock není wired ve zkoumaných frontend souborech. Hledej v dalších komponentách nebo v případě, že se otevírá přes jiný povrch.

---

## 3. Routes Existing But Unused (Dead Endpoints)

Backend routes definované ale nevolané z Mailboxes.jsx ani MailboxDrawer.jsx:

| PATH | Soubor:řádek | Poznámka |
|---|---|---|
| GET `/api/mailboxes/:id/smtp-check` | server.js:3300 | Není volán z žádného ze zkoumaných FE souborů; volán interně z full-check pipeline |
| GET `/api/mailboxes/:id/imap-check` | server.js:3321 | Není volán z FE; volán interně |
| GET `/api/mailboxes/:id/config-check` | server.js:3372 | Není volán z FE; subsumován do full-check |
| GET `/api/mailboxes/:id/warmup-status` | server.js:3385 | Není volán z FE; data přichází z full-check |
| GET `/api/mailboxes/:id/bounce-status` | server.js:3406 | Není volán z FE; subsumován do full-check |
| GET `/api/mailboxes/:id/send-rate` | server.js:3423 | Není volán z FE; subsumován do full-check |
| GET `/api/mailboxes/:id/pipeline-status` | server.js:3445 | Není volán z FE; subsumován do full-check |
| GET `/api/mailboxes/:id/proxy-live-check` | server.js:1825 | Není volán z FE; možná legacy |
| POST `/api/mailboxes/:id/header-probe` | server.js:3349 | Není volán z FE; volán z OchranyPanel/anonymity subsystému |
| GET `/api/mailboxes/:id/egress-history` | mailboxEgressHistory.js:47 | Není volán z FE souborů v tomto auditu |
| POST `/api/mailboxes/:id/repin` | mailboxesRepin.js:35 | Není volán z FE souborů v tomto auditu |
| GET `/api/mailboxes/:id/cooldown-log` | mailboxes.js:614 | Není volán z FE souborů v tomto auditu |
| POST `/api/mailboxes/anonymity-probe` | server.js:3743 | Není volán z Mailboxes.jsx / MailboxDrawer.jsx přímo |

Poznámka: část z těchto endpointů je volána z jiných komponent (OchranyPanel, pnpm report, diagnostics), nikoli z Mailboxes.jsx.

---

## 4. Schema Gaps

### 4a. Routes vracející JSON bez explicit shape doc

Všechny routes — žádná nemá JSDoc `@returns` v handler kódu. Kritické neznámé shape:

- `GET /api/mailboxes/:id/full-check` — `checks` objekt má 10 keys (smtp, imap, config, proxy, anti_trace, warmup, bounce, send_rate, pipeline, dns), každý jiný tvar. Zdokumentováno pouze inline komentáři v server.js:3571-3599.
- `POST /api/mailboxes/anonymity-probe` — `results[].anonymity` je `null` v sync odpovědi; async background vyplní (ale výsledky nejsou dostupné přes API — viz sekce 2).
- `PATCH /api/mailboxes/:id` — RETURNING klauzule neobsahuje všechna pole z `MB_SELECT` (chybí `warmup_*`, `environment`, `anti_trace_enabled`). FE musí znovu volat `GET /api/mailboxes/:id` pro kompletní data.

### 4b. Routes accepting body bez validace

| PATH | Problém |
|---|---|
| POST `/api/mailboxes` | Žádný Zod; smtp_port defaultuje na 587, ale není zkontrolován range. `b.email` přijato as-is bez email format check. |
| PATCH `/api/mailboxes/:id` | Bílý seznam polí v FIELD_MAP chrání SQL injection; `password` přijat jako jakýkoli string (délka, komplexita nekontrolovány) |
| POST `/api/mailboxes/import-csv` | Iteruje `csvRows` bez global size limit; může importovat neomezené množství řádků najednou. `smtp_port` defaultuje na 465 bez range check. |
| POST `/api/mailboxes/bulk-check` | `ids` array bez max-size limit (DoS risk — neomezený počet full-check volání). |
| POST `/api/mailboxes/bulk-assign-proxy` | `ids` array bez max-size limit. |
| POST `/api/mailboxes/:id/send-test` | `to` email validace chybí — jen `!to` null check. |
| POST `/api/mailboxes/:id/clear-auth-lock` | `reason` trimmed + sliced, jinak OK. |

### 4c. Inconsistent error format

Míchání 3 různých formátů:

| Format | Výskyt |
|---|---|
| `{ error: 'text' }` | Převažující — mailboxes.js, většina server.js routes |
| `{ ok: false, error: 'text' }` | POST /send-test, POST /anonymity-probe |
| `{ ok: false, reason: 'text' }` | GET /imap-inbox (catch blok), GET /proxy-live-check |
| `{ error: '...', pool_size, pinned_count, message, runbook }` | POST / 503 pool_exhausted — rozšířený objekt |

Konkrétní: `GET /api/mailboxes/:id` vrací `{ error: 'not_found' }` (s podtržítkem), zatímco `POST /api/mailboxes` vrací `{ error: 'Mailbox not found' }` (lidsky čitelný). Nekonzistence komplikuje FE error handling.

---

## 5. Side Effect Inventory

| PATH | DB tabulky (write) | Cache invalidace | SSE emit | Audit log | Sentry |
|---|---|---|---|---|---|
| POST `/api/mailboxes` | outreach_mailboxes (INSERT), operator_audit_log | — | — | operator_audit_log ✅ | capture500 |
| PATCH `/api/mailboxes/:id` | outreach_mailboxes (UPDATE), operator_audit_log (status + cred changes) | DELETE mailbox_check_cache (probe fields) ✅ | — | operator_audit_log ✅ | capture500 |
| DELETE `/api/mailboxes/:id` | outreach_mailboxes (DELETE CASCADE), operator_audit_log | — | — | operator_audit_log ✅ | capture500 |
| POST `/api/mailboxes/:id/recover` | outreach_mailboxes (status='active', canary=10), mailbox_cooldown_log (UPDATE), watchdog_events (INSERT) | — | — | watchdog_events | capture500 |
| POST `/api/mailboxes/:id/auth-reset` | outreach_mailboxes (auth_fail_count=0), watchdog_events (2× UPDATE+INSERT) | — | — | watchdog_events | capture500 |
| POST `/api/mailboxes/:id/clear-auth-lock` | outreach_mailboxes (status='paused'), operator_audit_log, mailbox_alerts (resolve) | — | — | operator_audit_log ✅ | capture500 |
| PATCH `/api/mailboxes/:id/warmup` | mailbox_warmup.is_paused | — | — | — | capture500 |
| POST `/api/mailboxes/:id/warmup/start` | mailbox_warmup (INSERT/ON CONFLICT UPDATE) | — | — | — | capture500 |
| PATCH `/api/mailboxes/:id/alerts/:alertId/resolve` | mailbox_alerts.resolved_at | — | — | — | capture500 |
| POST `/api/mailboxes/:id/assign-proxy` | outreach_mailboxes.proxy_url, watchdog_events | — | — | watchdog_events | capture500 |
| POST `/api/mailboxes/:id/repin` | outreach_mailboxes (pinned_endpoint_label), mailbox_egress_repin_audit | — | — | mailbox_egress_repin_audit ✅ | capture500 |
| POST `/api/mailboxes/:id/send-test` | send_events (nepřímo přes relay) | — | — | — | capture500 |
| POST `/api/mailboxes/bulk-assign-proxy` | outreach_mailboxes.proxy_url (N×) | — | — | — | capture500 |
| POST `/api/mailboxes/bulk-check` | — (async, side effects v full-check) | invalidateProxyCache() | — | — | — |
| POST `/api/mailboxes/import-csv` | outreach_mailboxes (INSERT/ON CONFLICT UPDATE, N×) | — | — | — | capture500 |
| GET `/api/mailboxes/:id/full-check` | mailbox_check_cache (upsert), mailbox_check_history (INSERT), mailbox_alerts (dns_fail) | — | publishHealthEvent SSE ✅ | — + applyAutomationRules | capture500 |
| GET `/api/mailboxes/:id/imap-check` | — (recordAuthFail → mailbox_auth_fails + možná outreach_mailboxes.status='auth_locked') | — | — | — | capture500 |
| GET `/api/mailboxes/:id/smtp-check` | — (nepřímo: full-check volá applyAutomationRules) | — | — | — | capture500 |

**Klíčové poznatky:**
- `GET /api/mailboxes/:id/full-check` má bohaté side effects přes `applyAutomationRules` (auto-pause, cap reduction, proxy reassign, watchdog alerts) — navzdory GET metodě.
- `GET /api/mailboxes/:id/imap-check` mutuje DB přes `recordAuthFail` — opět GET s write side effects.
- `POST /api/mailboxes/import-csv` neloguje do `operator_audit_log` (na rozdíl od jednotlivého POST `/api/mailboxes`).

---

## 6. Rate-limit + Auth Coverage

### AP3 Rate Limits (checkOpRateLimit → mailbox_op_rate_log)

| op_type | max/hod | Route |
|---|---|---|
| `smtp_probe` | 12 | GET `/api/mailboxes/:id/smtp-check` (server.js:3303) |
| `full_check` | 2 | GET `/api/mailboxes/:id/full-check` (server.js:3469) |
| `imap_inbox_fetch` | 6 | GET `/api/mailboxes/:id/imap-inbox` (server.js:3659) |

`imap_check`, `header-probe`, `pipeline-test`, `send-test`, `assign-proxy`, `recover`, `auth-reset`, `clear-auth-lock` — žádný AP3 rate limit!

### Auth

**Global middleware** (server.js:371): `createAuthMiddleware()` → X-API-Key (timing-safe) nebo ?token= (pro SSE)  
**Exempt paths**: `/api/health`, `/api/health/system`, `/api/health/drift`, `/api/health/guards`, `/api/health/auth-fail-alerts`, `/api/version`, `/api/daemons`, `/unsubscribe`

Žádný mailbox endpoint není exempt → všechny vyžadují X-API-Key.

### Dodatečná ochrana (intent guards)

| Route | Guard |
|---|---|
| POST `/api/mailboxes/:id/clear-auth-lock` | `X-Confirm-Send: yes` header (mailboxes.js:705) + 24h cooldown check |
| POST `/api/mailboxes/:id/repin` | `X-Operator-Id` header musí být v allowlistu `ALLOWED_OPERATOR_IDS` (mailboxesRepin.js:49-53) |

**Chybí intent guard:**
- POST `/api/mailboxes/:id/send-test` — `?force=1` bypass send window, ale žádný intent header. Může odeslat email mimo business hours bez varování.
- POST `/api/mailboxes/anonymity-probe` — spustí reálné odesílání emailů bez potvrzení. Schází X-Confirm-Send ekvivalent.
- DELETE `/api/mailboxes/:id` — destruktivní operace, žádný intent header (pouze Confirm dialog na FE).

---

## 7. Go Backend Forwarding

Všechny mailbox routes jsou **čistě BFF→PostgreSQL** — žádná nevolá Go backend (`GO_SERVER_URL`).

Proxy na Go backend existuje pouze pro kampně:
- POST `/api/campaigns`, POST `/api/campaigns/:id/run`, POST `/api/campaigns/:id/pause` → Go
- GET `/api/__schema-check` → Go `/schema`

Mailbox scoring (last_score / last_score_at) byl přesunut na Go orchestrator (CAD-S8, `mailbox_score_loop.go`), ale samotné CRUD + health routes zůstávají 100% BFF/Postgres.

Relay (`ANTI_TRACE_RELAY_URL`) volají mailbox routes (nikoli Go backend):
- `smtpCheck` → relay `/v1/probe`
- `smtpSend` / `smtpSendWithFallback` → relay `/v1/submit` (send-test, anonymity-probe)
- `relaySmtpAuthProbe` → relay `/v1/auth-check` (assign-proxy, bulk-assign-proxy)
- `relayProxyPool` → relay `/v1/proxy-pool` (full-check anti_trace check)
- `relayImapSocksAddr` → relay `/v1/imap-socks-addr` (imap-check, imap-inbox, header-probe)

---

## Shrnutí kritických nálezů

1. **`GET /api/mailboxes/anonymity-probe/results`** — deklarovaný v response notepad, neexistuje (server.js:3826). Výsledky se ztratí při restartu BFF.
2. **GET metody s write side effects** — `full-check` mutuje 3 tabulky + spouští automation; `imap-check` může auto-lockovat mailbox. Nesémantické, narušuje HTTP idempotence.
3. **Bez max-size guard** na `ids[]` v bulk-check a bulk-assign-proxy — DoS vektor.
4. **`POST /api/mailboxes/import-csv`** neloguje do `operator_audit_log` (na rozdíl od jednotlivého CREATE).
5. **Nekonzistentní error shapes** — tři různé formáty bez standardizace.
6. **`POST /send-test`** chybí X-Confirm-Send guard i email format validace na `to` poli.
7. **`POST /anonymity-probe`** spouští reálné emaily bez intent headeru.
8. **`PATCH /api/mailboxes/:id`** RETURNING shape je menší než `MB_SELECT` — FE potřebuje druhý fetch pro kompletní data po update.
