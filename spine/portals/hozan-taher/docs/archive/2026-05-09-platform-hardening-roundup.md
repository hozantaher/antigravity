# Iniciativa: Platform hardening + UX roundup

**Status:** Closed (2026-05-10 03:00 CEST)
**Datum vytvoření:** 2026-05-09 23:10 CEST
**Datum uzavření:** 2026-05-10 03:00 CEST (5h runtime)
**Trigger:** Po dnešním campaign 457 misfire (4 distinct bugy odhalené při aktivaci) operátor požaduje plošnou hardening napříč 8 oblastmi: claude-context indexace, hardening, testing, performance, security, edge cases, gaps, UX/UI.

## Kontext

Dnešek odhalil že platforma má víc skrytých bugů než jsme tušili — 3 missing migrations (`parent_ico`, `updated_at`, vůbec aplikace 049) plus legacy zombie schránky plus runner-engine atomicity defekt. To znamená že podobné landmines existují v dalších oblastech kde testy nepokrývají + monitoring nesvítí. Cíl: systematicky najít + opravit, nezdržovat odeslání kampaní víc než kolikový spec vyžaduje.

## Sprinty (každý jako separate initiative jakmile spuštěn)

### AW1 — Codebase awareness (`claude-context`)

Re-index repo přes MCP `claude-context` tool aby AI partner viděl aktuální stav. Index zastarává každých ~24h. Cron + manuální re-index po velkých změnách. Audit: zda `mcp__claude-context__get_indexing_status` běží OK na produkci. Sprint deliverable: post-CAD-A2 (codebase awareness discipline) revision podle dnešních zjištění.

### AW2 — Hardening (defense-in-depth ratchets)

Přidat ratchet testy které by zachytily dnešní bugy:
- Ratchet: každá `ALTER TABLE` v migrations MUSÍ mít odpovídající SELECT v testu (chyba pokud column referencovaný v code, ale v žádné migration)
- Ratchet: každá Go SQL query proti contacts/campaign_contacts MUSÍ projít přes ověření na "schema_check" že sloupce existují (boot-time invariant)
- Ratchet: legacy mailboxes (status='retired') MUSÍ být cleanup-ed z cfg.Mailboxes overlay
- Boot-time invariant: pokud `mailbox registry overlaid count > active mailboxes in DB`, fail boot

### AW3 — Testing (gap analysis)

Coverage gaps odhalené dnes:
- runner.go step advance — žádný test pro engine-deferred contacts (phantom completed bug)
- scheduler.go advisory lock — concurrent runner test chybí (issue #1182)
- BFF send-batch — chybí integration test že proletí přes real DB schema (jen mocks)
- migration apply scripts — žádný test že každá migration má apply na PROD verifikovanou
- Sprint deliverable: 4 nové integration tests pokrývající tyto gaps

### AW4 — Performance

Audit:
- 100-contact tick v runner.go trvá ~jak dlouho? (logy nesvítí)
- relay drain throughput per minute pro 1 schránku?
- send_events INSERT load na DB při 50/h global cap?
- DB connection pool — orchestrator má 5 max, BFF má X, je to dost?

Sprint deliverable: benchmark report + tunings pokud nutné

### AW5 — Security

- Schránková hesla v env vars vs DB (HARD: jen DB) — audit že žádný service nečte z env
- API key rotation — kdy naposledy? rotation runbook?
- Mullvad endpoint reputation — manualní audit endpointů
- HMAC keys (Message-ID, unsub) — rotace, doba platnosti
- DSR endpoints — Article 17 deletion test
- Sentry release tag — git_sha přítomný v každém logu?

Sprint deliverable: security audit report + remediation list

### AW6 — Edge cases

Konkrétní edge cases odhalené dnes + známé:
- Campaign daemon disabled stav — co když operator zapomene re-enable po fixu?
- updated_at backfill po migraci 092 — co když v původním sloupci je NULL?
- relay /v1/submit when env queued při startup — pickup tick OK?
- Schránka se status='retired' — jaké flow vrátí na active?
- DST forward boundary (2026-10-25) — pacing math kolem té chvíle
- 100k+ contact campaign — pagination v runner.go correct?

Sprint deliverable: 10+ edge cases test cases pokrývající známé

### AW7 — Gaps

Otevřené issues (#1179, #1182) plus:
- Issue #1179 (orchestrator IMAP-direct-dial bypass SOCKS5) — fix
- Issue #1182 (runner-engine atomicity) — fix
- AV3 (concurrent runner audit) — když je daemon disabled, kdy znovu enable?
- BFF auth-walled z Railway edge — operátor nemá vzdálený přístup
- send_events auto-INSERT — když daemon disabled, manuálně CLI script
- log retention — 30 min relay logy → audit?

Sprint deliverable: backlog cleanup + priority assignment

### AW8 — UX/UI dashboard

Co operátor postrádá v dashboardu (z dnešního provozu):
- Bulk action "send-batch" tlačítko — vidět které campaigns můžou
- Live status orchestratora (daemon enabled/disabled, last tick)
- Inline view na send_events historie per kampaň
- Quick toggle pro DISABLE_CAMPAIGN_DAEMON
- Replies tab — keyboard shortcuts pro classify
- Mobile responzivita?
- Dark mode?
- Inbox-style mailbox health board

Sprint deliverable: UX audit report + 5-10 high-value tweaks

## Priorita (návrh)

| # | Sprint | Proč first |
|---|---|---|
| 1 | **AW2 Hardening** (ratchet tests) | Zabraň dalším migration_apply incidentům |
| 2 | **AW7 Gaps** (issues #1179, #1182) | Odblokuje campaign daemon re-enable |
| 3 | **AW3 Testing** | Pokryje co AW2 ratchet nepostihne |
| 4 | **AW8 UX/UI** | Quick wins pro operátorskou produktivitu |
| 5 | **AW4 Performance** | Až má smysl měřit (po cleaning) |
| 6 | **AW5 Security** | Kontinuální, ne urgent |
| 7 | **AW6 Edge cases** | Po hardening |
| 8 | **AW1 claude-context** | Setup task, support pro ostatní |

## Souhrn — 22 PRs merged (4 cykly, 5 hodin)

### Cycle 1 (foundation — 6 PRs)
- AW2 #1185 — migration column ratchet (audit test pro missing columns)
- AW7 #1186 — runner-engine atomicity fix (closes #1182)
- AW5 #1187 — security audit report (post-campaign-457)
- AW8 #1188 — 5 dashboard quick wins (operatorská UX)
- AW4 #1189 — performance audit report (runner/relay/DB analysis)
- AW6 #1190 — 20 edge case tests (send pipeline)

### Cycle 2 (atomicity + SOCKS5 — 5 PRs)
- AW7-2 #1191 — orchestrator IMAP via SOCKS5 (closes #1179)
- AW2-2 #1192 — ratchet phase 2 (baseline=0, re-import 21 migrations)
- AW4-2 #1193 — relay backpressure gate (429 + Retry-After)
- AW6-2 #1194 — 21 cycle-2 edge cases (atomicity/SOCKS5/backpressure)
- AW8-2 #1195 — 5 more dashboard wins (cycle 2)

### Cycle 3 (watchdog + retry — 5 PRs)
- AW7-3 #1196 — watchdog reaper (24h threshold, stuck in_flight)
- AW7-4 #1197 — engine panic atomic rollback (no stuck in_flight)
- AW6-3 #1198 — 37 cycle-3 edge cases (reaper races, BFF, atomicity)
- AW7-5 #1199 — relay auto-retry (greylisting, exponential backoff)
- AW8-3 #1200 — 5 dashboard cycle-3 features

### Cycle 4 (deep RCA + tightening — 6 PRs)
- AW7-6 #1201 — concurrent runner deep RCA (ordering swap post-AW7)
- AW2-3 #1202 — 4 envconfig violations + table-existence ratchet
- AW3-2 #1203 — 18 integration tests (cycle-3 BFF endpoints)
- AW6-4 #1204 — 10 edge cases (retry + ordering)
- AW1-2 #1206 — claude-context daily auto-reindex cron
- AW4-3 #1207 — empirical performance benchmark (relay/runner/DB)

## Klíčové behavioral wins

1. Žádný phantom completed contact — atomicity (AW7 #1186 + reaper AW7-3 + panic AW7-4 + ordering AW7-6)
2. Žádný stuck in_flight — 24h watchdog reaper (#1196)
3. Žádný manuální greylist retry — auto-retry 5m/15m/60m (#1199)
4. Žádný silent direct IMAP — orchestrator fail-fast via SOCKS5 (#1191)
5. Žádný missing-column regrese — migration ratchet baseline=0 (#1185, #1192)
6. Žádný relay overload — backpressure 429 + Retry-After (#1193)

## Test coverage

88 nových testů v 4 cyklech:
- AW6 #1190: 20 edge cases
- AW6-2 #1194: 21 edge cases
- AW6-3 #1198: 37 edge cases
- AW6-4 #1204: 10 edge cases

## Open follow-ups

- Issue #1182 closed via #1186 ✓
- Issue #1179 closed via #1191 ✓
- OUTREACH_API_KEY rotation pending operator-side action
- Campaign 457 re-launch (97 pending contacts, AW7-6 ordering fix safe)
