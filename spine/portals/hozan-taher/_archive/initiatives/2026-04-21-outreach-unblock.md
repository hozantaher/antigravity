# Outreach Unblock — od 5 TLS-proxy pool k živé kampani #1

**Status:** active
**Vlastník:** Chat A (feature) + Chat B (tests) + user (creds + unpause)
**Datum založení:** 2026-04-21
**Datum uzavření:** —

## Kontext

Po dnešní práci (2026-04-21) stojíme na bodě:

- Anti-trace-relay: pool 5 TLS-verified EU proxies (geonode, CZ+SK+PL+DE+AT+HU+NL+FR), race-free refresh, in-flight guard.
- Outreach dashboard: assign-proxy + bulk-assign-proxy vrací `{tried, summary, attempts}`; UI toasty renderují breakdown; proxyReassignGuard emituje watchdog_events severity=error při pool-exhaustion.
- Testy: 1544 vitest / 3417 outreach Go / 767 relay Go — všechno green.

**Ale:** kampaň #1 "Strojírenství — první kontakt" je paused protože mailboxy 631/632/1/3 mají placeholder password `123p123p123p123` → seznam vrací `535 5.7.8 incorrect credentials` → assign-proxy 503. Dokud user nedoloží real creds, nic neposíláme.

A i až creds přijdou, máme tenký pool (5 proxies). Jedna seznam-ban rána = −20 % kapacity. Potřebujeme:
1. odblokovat sending path (user action + verifikace),
2. zvětšit polštář pool resilience,
3. dohrát observability + testy, aby další bottleneck nebyl slepá rána.

## Cíle

1. **Do 48h po dodání creds:** kampaň #1 posílá legit e-maily, zero AUTH-fail backlog.
2. **Pool ≥ 15 TLS-verified EU proxies** do konce týdne (2026-04-27) — bez toho je každý seznam-ban výpadek.
3. **Žádný silent failure v proxy assign path:** každý fail má watchdog event + UI signál + klasifikovaný reason.
4. **Kontraktní + integrační testy na nový 503 body shape** (Chat B resolvne A→B signály z BOARD).
5. **Pre-flight gate** před unpause kampaně: creds OK, proxy přiřazena, suppression načtená, rate caps v limitech.

## Plán (sprinty)

### Sprint S1 — Sending path unblock (1–2 dny, gated na user)

**Trigger:** user doloží real seznam.cz creds pro mb 631/632/1/3.

- [ ] User: update `outreach_mailboxes.password` pro 4 affected mb přes dashboard "Upravit"
- [ ] Chat A: POST /api/mailboxes/{id}/assign-proxy × 4 → ověřit 200 (ne 503), zaznamenat proxy_url + country
- [ ] Chat A: POST /api/mailboxes/{id}/full-check × 4 → očekává smtp.ok=true, imap.ok=true
- [ ] Chat A: odeslat jeden manuální test email z každé mb na vlastní tracked adresu → ověřit `X-Mailer`, routing, tracking pixel, Reply-To
- [ ] User: unpause kampaň #1 přes UI
- [ ] Chat A: prvních 15 min po unpause sledovat `healing_log` + `watchdog_events` + `outreach_sends` status distribution

**Exit kritérium:** 10+ úspěšně odeslaných sends bez bounce, žádný `proxy_reassign_exhausted` event.

### Sprint S2 — Pool expansion + resilience (2–3 dny, paralelně s S1)

Chat A autonomně, bez blokace na user:

- [x] **Secondary proxy source:** proxyscrape.com přidaný jako parallel fan-out source, dedupe po addr, partial-fail tolerant. Commit `51df4d1`.
- [x] **Rozšířit EU country filtr:** 8 → 25 EU zemí (+IT BE CH ES SE DK FI IE PT LU SI HR RO BG EE LV LT). Commit `d2660ea`.
- [x] **Periodic refresh ticker:** 5min background ticker v RotatingProxyTransport, pool fresh nezávisle na DialContext traffic. Commit `918f6e7`.
- [x] **Per-mailbox AUTH cache:** in-memory TTL 30min / LRU 500, 1 AUTH probe místo N když cached proxy alive. Commit `5b982fe`.

**Exit kritérium:** ✅ implementačně splněno — stabilita ≥15 TLS proxies v 24h okně bude validována až po S1 unblock (live send traffic).

### Sprint S3 — Observability + pre-flight (2 dny)

Chat A autonomně, lze paralelně s S2:

- [x] **Pool health widget** na /mailboxes: CZ/Sousedi/EU/TLS yield/refresh age, color-coded (red/amber/yellow/green). Commit `b756afa`.
- [x] **Alert rule** `proxy_reassign_exhausted`: `/api/health/proxy-exhaust` + pure aggregator (10min window, threshold ≥2) + červený banner na /mailboxes. Commit `ccbcc7b`.
- [x] **Pre-flight gate** endpoint: `computeCampaignPreflight` — 5 parallel DB checks (proxy, full-check, suppression, capacity, templates) vrací `{ok, checks:[]}`. Commit `d78a5cd`.
- [ ] UI "Unpause" disabled + checklist — BFF endpoint dodán, UI wiring do Campaigns page zbývá.

**Bonus (nad rámec S3):**
- [x] **Empty-pool streak watchdog** v relay: `consecutiveZeroRefreshes` atomic, threshold ≥3 = critical. `/v1/proxy-pool` response extended. Commit `c111ef0`.
- [x] **24h pool trend sparkline:** in-memory ring buffer (288 × 5min) + `/api/proxy-pool-trend` + PoolTrendSparkline SVG. Commit `d56572d`.
- [x] **Hygiena:** poslední production raw `time.Sleep` v onion.WaitReady → ctx-aware select. Commit `ae8b0e6`.

**Exit kritérium:** ✅ preflight endpoint hotový; UI wiring do unpause flow zbývá jako follow-up (T-U01 níže).

### Sprint S4 — Test coverage (Chat B, 1–2 dny)

Chat B grepne `git log origin/main | grep Needs-Tests:` + čte Cross-branch signals v BOARD. Dnes tam čekají:

- [ ] **A→B: proxyDiagnostics kontrakt** — `classifyProbeReason` fuzzy test nad reálnými seznam error stringy + 503 body shape integration test (POST /api/mailboxes/:id/assign-proxy pod podmínky "nulový AUTH yield")
- [ ] **A→B: SOCKS5 handshake deadline** — resolved (`9df73f8`), ale `TestVerifyTLSHandshake_RejectsPlainTCP` pokrývá jen `plain-TCP`. Přidat případ `proxy returns bad cert` (e.g. self-signed) → očekává `bad_cert` classification
- [ ] **A→B: engine ctx-honoring backoff** — property test: `Run(ctx)` s canceled ctx ve všech stavech backoffu returns do 100ms
- [ ] **A→B: WithProxyPool wiring** — E2E: boot relay → GET /v1/proxy-pool → count > 0 když je transport attached; covered by `9717efd` commit — Chat B ověří že test existuje

**Exit kritérium:** všechny 4 signály v BOARD resolved; A→B sekce prázdná.

### Sprint S5 — Long-tail hardening (low priority, parallel)

- [ ] **Intelligence loop validation:** dnes běží každých 6h (CLAUDE.md). Logs check: žádný `scheduler_miss` za posledních 48h?
- [ ] **ARES sync health:** `outreach_ares_subjects` — fresh záznamy v posledních 7 dnech? Scheduler working?
- [ ] **IMAP replies smoke:** jedna manuální inbox check pro mb 631 po prvním odeslání — ověří že reply detection loop žije
- [ ] **Mailsim bouncer** v dev prostředí: znovu ověřit že bounce-rate simulace funguje (po `time.Sleep` raw tam zůstal — intentional, není prod path)

**Exit kritérium:** žádný tichý démon nevypadl přes poslední týden.

## Blokátory

- **S1 celý:** čeká na user creds pro mb 631/632/1/3 (seznam.cz). Bez nich kampaň #1 nejde unpausnout, nejde verify end-to-end.
- **S2 secondary source:** ověřit že proxyscrape.com nemá rate limit per IP (pokud ano, deploy musí Railway výstupní IP whitelistnout — není snadné).

## Rizika

- **Seznam IP ban:** pokud seznam shodí všech 5 EU proxies najednou (masivní abuse wave), žádný fallback až do S2. Mitigace: priorita secondary source + widening.
- **proxyscrape.com nespolehlivé / rate-limited:** pokud druhá source je horší než geonode, přidává komplexitu bez yield. Mitigace: A/B měřit yield per source přes první 48h.
- **Per-mailbox AUTH cache staleness:** pokud proxy jde dead *po* úspěšném cache hit a před `smtpSendWithFallback`, první send failne → reassign. Akceptujeme (guard už to handluje), cache jen zkracuje happy-path latenci.

## Log

- 2026-04-21 — založeno, S1 blocked on user creds, S2 připraven k okamžitému startu
- 2026-04-21 — S2 kompletní (S2.1–S2.4) + S3 kompletní (S3.1–S3.3) + bonus S3.4 (empty-pool watchdog) + S3.5 (24h trend sparkline) + onion.WaitReady ctx-aware. Pool expansion + observability implementačně hotové; čeká se na user creds pro S1 live-validation.

## Follow-ups

- **T-U01** — Frontend wiring: mount `computeCampaignPreflight` checklist do Campaigns page (disabled "Unpause" když preflight.ok=false). BFF endpoint existuje, UI čeká.
- **T-U02** — S5 smoke po S1 unblock: intelligence loop 48h miss check, ARES freshness, IMAP reply smoke.
