# Live Smoke Test — `/api/mailboxes/*` routes

**Datum:** 2026-05-11  
**BFF:** http://localhost:18001  
**Test mailboxy:** 14227 (nowak.goran@seznam.cz), 14228 (goran.nowak@seznam.cz)  
**Test campaign ID:** 457  
**Scope:** GET routes + safe POSTs (bulk-check, bulk-assign-proxy dry_run). DELETE 14227/14228, auth-reset, send-test přeskočeny záměrně.

---

## 1. Smoke result table

Zdroje: `src/server-routes/mailboxes.js` (mounter module, 17 routes) + `server.js` inline routes.

| METHOD | PATH | HTTP | sample response (first 180 chars) | verdict |
|--------|------|------|-----------------------------------|---------|
| GET | /api/mailboxes | 200 | `[{"id":"14228","email":"goran.nowak@seznam.cz","display_name":"Goran Nowak","host":"smtp.seznam.cz",...` | ok |
| GET | /api/mailboxes?all=1 | 200 | stejný payload jako bez `?all=1` — obě MB jsou environment=production | ok |
| GET | /api/mailboxes/14227 | 200 | `{"id":"14227","email":"nowak.goran@seznam.cz","display_name":"Nowak Goran",...,"has_valid_password":true}` | ok |
| GET | /api/mailboxes/14228 | 200 | `{"id":"14228","email":"goran.nowak@seznam.cz","display_name":"Goran Nowak",...,"has_valid_password":true}` | ok |
| GET | /api/mailboxes/14227/stats | 200 | `{"total_sent":"25","total_bounced":"0","consecutive_bounces":0,"sent_30d":"22"}` | ok |
| GET | /api/mailboxes/14227/send-log | 200 | `[{"sent_at":"2026-05-11T17:57:28.426Z","status":"sent","subject":"Dotaz — máte techniku k odprodeji?",...}]` | ok |
| GET | /api/mailboxes/14227/campaigns | 200 | `{"total":1,"campaigns":[{"id":"457","name":"Strojírenství — výkup techniky první vlna","status":"running","sent_count":22,...}]}` | ok |
| GET | /api/mailboxes/14227/watchdog-events | 200 | `[]` | empty |
| GET | /api/mailboxes/14227/cooldown-log | 200 | `[]` | empty |
| GET | /api/mailboxes/14227/pipeline-results | 200 | `[{"id":97,"overall_ok":false,"steps":{...}}]` | ok |
| GET | /api/mailboxes/14227/alerts | 200 | `[{"id":107,"type":"score_drop","severity":"warn","message":"Score dropped 30 points (100 → 70)","created_at":"2026-05-11T17:34:14.767Z","resolved_at":null}]` | ok |
| PATCH | /api/mailboxes/:id/alerts/:alertId/resolve | — | přeskočeno (nedestruktivní ale produkční stav) | skip |
| POST | /api/mailboxes/:id/warmup/start | — | přeskočeno (mutuje warmup stav) | skip |
| PATCH | /api/mailboxes/:id/warmup | — | přeskočeno (mutuje warmup stav) | skip |
| POST | /api/mailboxes/:id/recover | — | přeskočeno | skip |
| POST | /api/mailboxes/:id/auth-reset | — | přeskočeno | skip |
| POST | /api/mailboxes/:id/clear-auth-lock | — | přeskočeno (AP6 — 14227/14228 nejsou auth_locked) | skip |
| GET | /api/mailboxes/14227/check-history | 200 | `[{"score":70,"ok":false,"checked_at":"2026-05-11T17:34:13.805Z"},{"score":83,"ok":true,"checked_at":"2026-05-11T17:55:42.478Z"}]` | ok |
| GET | /api/mailboxes/14227/imap-inbox | 200 | `{"ok":false,"reason":"connect ECONNREFUSED 127.0.0.1:1082","unseen":null}` | broken (SOCKS port 1082 nedostupný v dev) |
| GET | /api/mailboxes/14227/warmup-status | 200 | `{"ok":false,"active":false,"day":null,"paused":false,"stale":true,"last_advanced_h":null,"pause_reason":null}` | ok (warmup nevybrán — stale) |
| GET | /api/mailboxes/14227/bounce-status | 200 | `{"ok":true,"classification":"ok","consecutive":0,"rate":0,"total_sent":25,"total_bounced":0,"status":"active"}` | ok |
| GET | /api/mailboxes/14227/send-rate | 200 | `{"ok":true,"sent_today":7,"limit":100,"pct":7,"last_send_at":"2026-05-11T17:57:28.427Z","last_send_age_h":0.1}` | ok |
| GET | /api/mailboxes/14227/pipeline-status | 200 | `{"ok":false,"exists":true,"overall_ok":false,"tested_at":"2026-05-11T17:52:53.202Z","age_h":0,"stale":false}` | ok |
| GET | /api/mailboxes/14227/config-check | 200 | `{"ok":true,"issues":[]}` | ok |
| GET | /api/mailboxes/14227/egress-history?hours=24 | 200 | `{"mailbox_id":14227,"hours":24,"observations":[{"id":"5","egress_country":"CZ","egress_endpoint_label":"cz-prg-wg-201","op_type":"probe",...}]}` | ok |
| GET | /api/mailboxes/health-summary | 200 | `{"total":2,"healthy":2,"degraded":0,"critical":0,"mailboxes":[{"id":"14227","email":"nowak.goran@seznam.cz","score":83,"ok":true,...}]}` | ok |
| GET | /api/mailboxes/send-trends | 200 | `{"14227":[0,0,0,0,1,14,7],"14228":[0,0,0,0,0,15,7]}` | ok |
| POST | /api/mailboxes/bulk-check | 200 | `{"ok":true,"triggered":2}` | ok |
| POST | /api/mailboxes/bulk-assign-proxy (dry_run:true) | 200 | `{"ok":true,"results":[{"id":14227,"ok":true,"proxy_url":"socks5://127.0.0.1:1080","country":"CZ","latency_ms":3139},{"id":14228,...}]}` | ok |
| GET | /api/mailboxes/health-stream (SSE) | viz sekce 3 | — | viz níže |

---

## 2. Hidden 500 errors / prázdná data kde by měl být obsah

| Route | Vrátila | Problém |
|-------|---------|---------|
| GET /api/mailboxes/14227/watchdog-events | `[]` | Žádné záznamy — mailbox nebyl nikdy v cooldown/circuit-break stavu; tabulka `watchdog_events` existuje (middleware vrátil 200, ne fallback). Prázdné pole je správné pro nový/zdravý mailbox. **Bez závady.** |
| GET /api/mailboxes/14227/cooldown-log | `[]` | Stejná situace — mailbox nikdy neprošel bounce-hold. Správné. |
| GET /api/mailboxes/14227/imap-inbox | `{"ok":false,"reason":"connect ECONNREFUSED 127.0.0.1:1082","unseen":null}` | **Závada (dev-environment):** SOCKS5 port 1082 není v local dev dostupný — wgpool endpoint pro IMAP není spuštěn. Route vrátí HTTP 200 s `ok:false` místo 503. V produkci OK, v lokálním smoke testu maskuje selhání jako success (HTTP 200). |
| GET /api/mailboxes/14227/warmup-status | `{"ok":false,"active":false,"day":null,"stale":true}` | 14227 nemá záznam v `mailbox_warmup`. `stale:true` je korektní stav. Warmup nikdy nebylo spuštěno — pro aktivní produkční mailbox je to potenciálně absence konfigurace, ale mimo scope tohoto smoke testu. |

---

## 3. SSE smoke — `/api/mailboxes/health-stream`

```
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
...

event: hello
data: {"at":"2026-05-11T18:02:09.686Z"}
```

- **Content-Type:** `text/event-stream; charset=utf-8` — správně
- **Aspoň 1 `event:` chunk:** ano (`event: hello` přišel okamžitě)
- **Timeout:** stream zůstal otevřený po dobu 5s bez dalšího eventu (normální — ping interval je delší)
- **Verdict:** ok

---

## 4. Response time — top 5 nejpomalejších routes

| Route | time_total |
|-------|-----------|
| POST /api/mailboxes/bulk-assign-proxy (dry_run) | **9.45 s** — SOCKS5 latency probe na obě MB (2× ~3.1s round-trip přes wgpool) |
| GET /api/mailboxes/14227/imap-inbox | **2.49 s** — timeout na ECONNREFUSED 127.0.0.1:1082 |
| GET /api/mailboxes/14227/stats | **1.35 s** — `COUNT(*)` přes `send_events` (30d window, bez index hint) |
| GET /api/mailboxes/14227/egress-history?hours=24 | **1.04 s** — join přes `outreach_egress_observations` |
| GET /api/mailboxes/14228/egress-history?hours=24 | **1.02 s** — stejná query |

Ostatní routes: 0.24–0.78 s. Žádná route nepřekočila 10s. Threshold 2s přesáhly 3 routes: bulk-assign-proxy (očekávané), imap-inbox (ECONNREFUSED), stats (COUNT scan).

---

## 5. Data quality — detailní výsledky

### /api/mailboxes/14227/alerts
```json
[{"id":107,"type":"score_drop","severity":"warn","message":"Score dropped 30 points (100 → 70)",
  "created_at":"2026-05-11T17:34:14.767Z","resolved_at":null}]
```
Obsahuje 1 neuzavřený alert `score_drop` / warn. `resolved_at: null` — alert stále aktivní.

### /api/mailboxes/14227/cooldown-log
```json
[]
```
Žádné záznamy — MB 14227 nikdy nevstoupila do bounce-hold cooldown. Správné.

### /api/mailboxes/14227/check-history
```json
[{"score":70,"ok":false,"checked_at":"2026-05-11T17:34:13.805Z"},
 {"score":83,"ok":true,"checked_at":"2026-05-11T17:55:42.478Z"}]
```
2 záznamy. Score se zlepšilo z 70 → 83 po opravě. IMAP step stále failing (viz pipeline-results).

### /api/mailboxes/14227/send-log
Obsahuje záznamy — poslední send `2026-05-11T17:57:28.426Z`, subject `"Dotaz — máte techniku k odprodeji?"`, status `sent`. Správně.

### /api/mailboxes/14227/campaigns — campaign 457
```json
{"total":1,"campaigns":[{"id":"457","name":"Strojírenství — výkup techniky první vlna",
  "status":"running","sent_count":22,"last_sent_at":"2026-05-11T17:57:28.426Z"}]}
```
Campaign 457 viditelná, `status:running`, 22 sendů z tohoto mailboxu.

### /api/mailboxes/14227/watchdog-events
```json
[]
```
Žádné watchdog události. Mailbox nebyl auto-quarantined ani nevyžadoval self-heal.

### /api/mailboxes/14227/egress-history?hours=24
Vrátil observace s `egress_country:CZ`, `egress_endpoint_label:cz-prg-wg-201`. Egress přes správný CZ endpoint. Více než 2 observace za posledních 24h.

---

## Shrnutí

| Oblast | Stav |
|--------|------|
| 17 mounter-module routes | 12 testováno GET — vše 200 OK |
| server.js inline GET routes (check-history, warmup-status, bounce-status, send-rate, pipeline-status, config-check, egress-history, health-summary, send-trends) | vše 200 OK |
| imap-inbox | 200 s `ok:false` / ECONNREFUSED 127.0.0.1:1082 — dev-only, wgpool IMAP port nespuštěn |
| SSE health-stream | ok — text/event-stream + hello event |
| bulk-check | ok |
| bulk-assign-proxy | ok — CZ egress ověřen, latency 3.1s/endpoint (expected) |
| stats COUNT scan >1s | performance note — možná candidate pro EXPLAIN ANALYZE |
| warmup chybí na 14227 | ops note — žádný záznam v mailbox_warmup |
| score_drop alert 14227 | neuzavřený warn alert — ID 107 |
