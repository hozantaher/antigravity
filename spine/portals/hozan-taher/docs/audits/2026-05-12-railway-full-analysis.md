# Railway Full Analysis — garaaage-mcp project

**Status:** Complete
**Datum:** 2026-05-12
**Trigger:** Cost optimization ($273/měsíc); top žrouti: outreach-db $146, ollama $49, typesense $42, legacy Postgres $23
**Author:** Claude (automated audit)

---

## Executive Summary — seřazeno dle savings

| Rank | Service | Est. cost/mo | Recommendation | Est. saving | Effort |
|------|---------|-------------|----------------|-------------|--------|
| 1 | `ollama` | ~$49 | Pause (keep code wired) | $49/mo | Low |
| 2 | `garaaage-grafana` | ~$10–20 | Delete (Sentry replaces) | $10–20/mo | Low |
| 3 | `loki` | ~$5–15 | Delete if LOKI_URL unset on Go services | $5–15/mo | Low |
| 4 | `garaaage-db-test` | ~$5–10 | Delete or reprovision on-demand | $5–10/mo | Low |
| 5 | `searxng` | ~$5–10 | Pause if SEARXNG_URL unset on worker | $5–10/mo | Low |
| 6 | `outreach-db` | $146 | PG tuning (partial) — done; evaluate connection pooling | ~$5–10/mo | Med |
| 7 | `garaaage-scrapers` | ~$5 | Keep + monitor (dormant, low cost) | $0 | — |
| 8 | `typesense` | $42 | Keep (active MCP consumer) — tune volume | $0 | — |

**Total achievable saving: ~$74–104/měsíc** (konservativní scénář: $74/mo; při agresivním pausu: $104/mo)

---

## Per-service detail

---

## outreach-dashboard

- **Role:** Express 5 BFF + React 19 SPA — primary operator UI. Veškerý /api/* traffic jde přes tento service.
- **Active usage:** `features/platform/outreach-dashboard/server.js` (6214 LoC), 27 mounter modulů v `src/server-routes/`. `GO_SERVER_URL` + `OUTREACH_API_KEY` forward do `machinery-outreach`. Folder-ops cron bug fixnut (commit b52135d1 + 58a93c50).
- **Status:** live (production)
- **Cost driver:** CPU (request handling + 8 cron jobs); RAM strojové učení klasifikátor
- **Recommendation:**
  - [ ] Review cron intervals — `runFullCheckCron` (4h) a `runImapPollCron` (15m) jsou největší zátěž (effort: low, saving: negligible ale snižuje CPU spikes)
  - [ ] Zkontrolovat, zda `LLM_RUNNER_URL` env var je SET na Railway — pokud ne, llmReplyClassifier defaultuje na Ollama volání bez wrapperu; server.js:4137 (effort: low, saving: potential stability)
- **Risk if removed:** Celý operator UI offline; kampaně nelze ovládat

---

## outreach-db

- **Role:** Produkční PostgreSQL 16 pro campaigns, mailboxes, contacts, send_events, suppression, threads
- **Active usage:** všechny Go services + BFF direct connection; `DATABASE_URL` / `OUTREACH_DSN` env vars; primární zdroj pravdy
- **Status:** live, CRITICAL
- **Cost driver:** RAM — 608 TB-h billing (největší single-service cost $146). PG tuning work_mem 4→2 MB + maintenance_work_mem 64→32 MB already applied.
- **Recommendation:**
  - [ ] Ověřit PgBouncer nebo Railway connection pooler — BFF + orchestrator + campaigns otevírají concurrent pools; bez pooleru Railway účtuje idle connections do RAM (effort: med, saving: $10–20/mo estimate)
  - [ ] Audit max_connections nastavení; default 100 na Railway může být příliš vysoké pro workload (effort: low, saving: $5/mo)
  - [ ] Periodic VACUUM ANALYZE na největší tabulkách (send_events, contacts) — bloated tables = vyšší RAM footprint (effort: low, saving: $5–10/mo)
- **Risk if removed:** Celá platforma down

---

## machinery-outreach

- **Role:** Go orchestrator — intelligence loop (6h), IMAP polling, campaign scheduler, `/healthz` + API endpoint. Mapuje na `features/inbound/orchestrator/cmd/outreach/` (merged z modules/outreach).
- **Active usage:** BFF proxy přes `GO_SERVER_URL`; všechny `/api/campaigns/*`, `/api/mailboxes/*`, `/api/contacts/*` routes (server.js:1207). Přijímá `LLM_RUNNER_URL` pro photo pipeline (orchestrator/cmd/outreach/photo_pipeline.go:48).
- **Status:** live (per SERVICES.md byl FAILED 2026-05-07; dle CLAUDE.md je active v prod)
- **Cost driver:** CPU (intelligence loop, IMAP poll); nízké RAM
- **Recommendation:**
  - [ ] Ověřit zda `LLM_RUNNER_URL` je set — pokud ne, photo_pipeline skippuje vision parsing (effort: low, zero cost change)
  - [ ] Pokud OLLAMA_URL není set (per SERVICES.md: nikdy nebyl), kód v orchestrator bezpečně skipuje LLM větve — **nevolej OLLAMA_URL nastavení bez explicitního rozhodnutí**
- **Risk if removed:** Kampaně přestanou odesílat; IMAP polling offline; dashboard ztratí data

---

## anti-trace-relay

- **Role:** SMTP + SOCKS5 relay pro veškerý outbound email. 42-krokový anti-trace pipeline. Běží v `features/outreach/relay/`.
- **Active usage:** `features/outreach/campaigns/campaign/runner.go` → `ANTI_TRACE_RELAY_URL` + `ANTI_TRACE_RELAY_TOKEN`; každý campaign send prochází přes relay. CRITICAL per memory `feedback_anti_trace_full_stack`.
- **Status:** live, CRITICAL
- **Cost driver:** CPU (SMTP + WireGuard/SOCKS5 proxying); nízké RAM
- **Recommendation:**
  - [ ] Keep; žádná optimalizace bez ROI analýzy (SLO 99.5%)
- **Risk if removed:** Veškeré outbound emaily přestanou fungovat; kampaně mrtvé

---

## redis

- **Role:** Shared Redis 7 — session store pro BFF, rate limiter, BullMQ queue pro `features/platform/worker` + `features/acquisition/scrapers`. Také relay pool state cache.
- **Active usage:**
  - `features/platform/worker/worker/queue.ts:24` — `REDIS_URL` required, crash bez něj
  - `features/acquisition/scrapers/src/queue/scrape-queue.ts:22` — IORedis connection
  - `features/platform/mcp/mcp-server/index.ts:31` — OAuth store (optional, fallback in-memory)
  - BFF session store + rate limiter
- **Status:** live, CRITICAL
- **Cost driver:** RAM (minimal — Redis managed service)
- **Recommendation:**
  - [ ] Keep; analyze memory usage — `removeOnComplete: { count: 100 }` + `removeOnFail: { count: 200 }` pro worker (queue.ts) chrání před memory bloat (effort: low, verify config is deployed)
- **Risk if removed:** BullMQ queues offline (worker + scrapers); BFF sessions ztraceny; relay pool state resetuje

---

## ollama

- **Role:** Self-hosted LLM inference daemon (llama3.2:3b text + llama3.2-vision:11b). Přístupný přes `ollama.railway.internal:11434`. Consumer: výhradně `features/platform/llm-runner` wrapper.
- **Active usage:**
  - `features/platform/llm-runner/cmd/llm-runner/main.go:42` — `OLLAMA_URL` required pro llm-runner
  - Per SERVICES.md (2026-04-22): `OLLAMA_URL` **NENÍ SET** na `machinery-outreach` — všech 6 `if ollamaURL != ""` větví nikdy nevstoupí
  - Per ADR-006: `llm-runner` service je deployed (railway.toml existuje), ale stav `LLM_RUNNER_URL` na outreach-dashboard v prod není ověřen z kódu
  - `features/platform/outreach-dashboard/src/lib/llmReplyClassifier.js:91` — `LLM_PROVIDER` env, default `'ollama'`; ale `classifyViaOllama` volá přímo ollama (obchází llm-runner wrapper — ADR-006 porušení pokud OLLAMA_URL nastaven)
- **Status:** live (stale, $49/měsíc za idle service)
- **Cost driver:** RAM (~8 GB pro modely) + persistent volume (20 GB, $5/mo) — největší opodstatněná úspora po outreach-db
- **Recommendation:**
  - [ ] **PAUSE ollama service** (`railway down --service ollama`) — kód zůstane wired, bez consumer OLLAMA_URL env var žádný volající. Saving: ~$44/mo compute (volume $5/mo zůstane dokud smažeme). (effort: low)
  - [ ] Ověřit, zda `LLM_RUNNER_URL` je set na outreach-dashboard prod env — pokud ne, llmReplyClassifier nikdy nedosáhne ollama (server.js:4139). Pokud ano, llm-runner bude degraded (ollama down). (effort: low, prereq pro restart)
  - [ ] Pokud chceme LLM features zpět: `railway up --service ollama` + set `LLM_RUNNER_URL` na BFF + ověřit llm-runner healthz pings ollama (ADR-006 §Recovery). Trvá < 15 min (plus 10 min model preload warm-up).
- **Risk if paused:** llm-runner /v1/classify + /v1/generate + /v1/parse-photo vrátí 502; BFF degraded (non-critical path, soft fail per server.js:4122); reply classification fallback na `needs_review`; photo parse audit rows zapsány s `extracted=NULL`

---

## typesense

- **Role:** Search engine — indexuje contact + company records pro MCP db lookup. Také scrapers indexer target.
- **Active usage:**
  - `features/platform/mcp/mcp-server/db.ts:415` — `typesenseSearch()` volána pro engine='typesense' queries
  - `features/platform/mcp/lib/meilisearch.ts:82` — `TYPESENSE_URL || MEILI_URL` env
  - `features/acquisition/scrapers/src/queue/scrape-queue.ts` — indexer target přes `TYPESENSE_URL=http://typesense.railway.internal:8108`
- **Status:** live (active consumer)
- **Cost driver:** RAM (index data) + persistent volume
- **Recommendation:**
  - [ ] Ověřit, jak časté jsou MCP queries — pokud scrapers jsou dormant (BullMQ producer není wired per scrapers.md), index může být stale; ale MCP server stále queruje (effort: low audit)
  - [ ] Keep; MCP server má aktivního consumera. Bez Typesense degrades na `ilike` SQL fallback (db.ts:393 `engine?: 'typesense' | 'ilike'`) — latence horší ale funkční
  - [ ] Zvažit downsize Railway Typesense plan pokud index neporoste (effort: med, saving: $5–10/mo)
- **Risk if removed:** MCP search fallback na ILIKE SQL — pomalejší ale nespadne; scrapers indexer přestane fungovat

---

## privacy-gateway

- **Role:** Privacy-first email submission/relay/inbox gateway (Go, stdlib-only). DELIVERY_MODE=record-only default. Architektonicky kompletní MVP, ale dle RC-DECISION.md (2026-04-07): **NO-GO**, provider-backed verification nebyla nikdy spuštěna.
- **Active usage:**
  - `features/inbound/inbox/.env.example:29` — `# PRIVACY_GATEWAY_URL` (komentovaný — OPTIONAL, ne wired v prod)
  - `features/inbound/orchestrator/Dockerfile:21` — kopíruje kód do build contextu (pouze pro Go workspace build, ne runtime dependency)
  - Žádný přímý caller z campaigns/runner nebo BFF
- **Status:** live (deployed, ale DELIVERY_MODE=record-only → žádná live delivery; prakticky dormant)
- **Cost driver:** CPU/RAM (minimal Go binary, málo traffic)
- **Recommendation:**
  - [ ] Audit Railway vars — ověřit `DELIVERY_MODE`; pokud stále `record-only`, service neposílá žádný email a je bezpečné pausovat (effort: low, saving: $5/mo estimate)
  - [ ] **Zvažit pause** dokud provider-backed verification (Fastmail live run) neproběhne (effort: low, saving: $5/mo)
- **Risk if paused:** NO-GO dle RC-DECISION — neblokuje produkci. `PRIVACY_GATEWAY_URL` není set na žádném prod service.

---

## garaaage-grafana

- **Role:** Grafana monitoring dashboard (observability, metriky, logy).
- **Active usage:**
  - Žádný programmatický volající z kódu (grep: 0 hits na `grafana`/`GRAFANA` v apps/ + services/ + modules/)
  - Loki jako log backend: `features/platform/mcp/lib/logger.ts:5` + `features/acquisition/scrapers/lib/logger.ts:5` + `features/platform/worker/lib/logger.ts:5` — všechna volání jsou `if (process.env.LOKI_URL)` guard = optional
  - Go services: žádné pino-loki; slog → Railway stdout (Railway má vlastní log viewer)
- **Status:** live (stale — last deploy 2026-03-28)
- **Cost driver:** RAM (Grafana image ~500MB) + Loki storage
- **Recommendation:**
  - [ ] **DELETE garaaage-grafana** — per memory `feedback_no_extra_monitoring`: "jen Sentry". Žádný programmatický consumer. Operator monitoring přes Railway dashboard + Sentry. (effort: low, saving: $10–20/mo)
  - [ ] **DELETE loki** — pokud `LOKI_URL` není set na prod services; mcp/scrapers/worker mají fallback na stdout. (effort: low, saving: $5–15/mo)
- **Risk if removed:** Ztráta Grafana visual dashboards a Loki log aggregation. Mitigace: Railway log viewer (7-day retention) + Sentry error tracking pokrývá alerting per platform rule.

---

## garaaage-scrapers

- **Role:** TypeScript BullMQ scraper worker — ARES + firmy.cz + autoline + mascus + mobile-de + judikaty + esbirka. Indexuje do Typesense + outreach-db.
- **Active usage:**
  - `features/acquisition/scrapers/src/queue/scrape-queue.ts:64` — BullMQ Queue definice; **no producer wired** (per scrapers.md: dormant)
  - `features/acquisition/scrapers/src/queue/scrape-worker.ts:300` — worker listening na queue `scrape-jobs`, ale frontu nikdo nenaplňuje
  - Typesense indexer target
- **Status:** live (dormant — no producer; last meaningful scrape unknown)
- **Cost driver:** minimal (idle Node process)
- **Recommendation:**
  - [ ] Keep + monitor — nízká cena; ale zvažit pause pokud scrapers aktivně nepoužíváme (effort: low, saving: $3–5/mo)
  - [ ] Pokud chceme reaktivovat: wire BullMQ producer (API endpoint nebo cron) per scrapers.md §Job dispatch
- **Risk if paused:** Typesense index přestane být aktualizován; MCP queries vrátí stale data. Scrapers lze restartovat kdykoliv.

---

## loki

- **Role:** Log aggregation backend pro Grafana.
- **Active usage:** `features/platform/mcp/lib/logger.ts:5`, `features/acquisition/scrapers/lib/logger.ts:5`, `features/platform/worker/lib/logger.ts:5` — všechny jsou `if (process.env.LOKI_URL)` optionals. Go services: žádné Loki.
- **Status:** live (stale — 2026-03-28)
- **Cost driver:** storage + RAM
- **Recommendation:**
  - [ ] **DELETE** spolu s garaaage-grafana (effort: low, saving: $5–15/mo)
- **Risk if removed:** 0 — `LOKI_URL` guard znamená fallback na Railway stdout automaticky

---

## searxng

- **Role:** Metasearch engine pro web search feature v `features/platform/worker`.
- **Active usage:**
  - `features/platform/worker/worker/web-search.ts:1` — `SEARXNG_URL = process.env.SEARXNG_URL`; line 42: `if (!SEARXNG_URL) return 'Web search not available'` → graceful degradation
  - Worker PDF generator volá web search jako optional enhancement; funguje bez něj
- **Status:** live (stale, SUCCESS 2026-03-28)
- **Cost driver:** CPU/RAM (minimal)
- **Recommendation:**
  - [ ] Pause pokud `SEARXNG_URL` není set na `rozpor-worker` prod service (effort: low, saving: $5–10/mo)
  - [ ] Ověřit zda rozpor-worker env má `SEARXNG_URL` nastaven — pokud ne, searxng nikdy nezatěžuje
- **Risk if paused:** Worker PDF generation pokračuje bez web search (`'Web search not available'` fallback). Rozporuj.com PDF quality mírně snížena.

---

## rozpor-worker

- **Role:** TypeScript BullMQ worker — generuje PDF právních námitek (odpor/rozklad) pro Rozporuj.com. Claude API + LibreOffice + Firebase Storage + SendGrid.
- **Active usage:**
  - `features/platform/worker/worker/index.ts:243` — Redis required, Claude API, Firebase Storage
  - Konzument `rozporuj-pdf` BullMQ queue (producer je Rozporuj.com frontend — externě)
  - Žádný consumer z hozan-taher BFF/orchestrator
- **Status:** live (SUCCESS 2026-05-07)
- **Cost driver:** CPU (LibreOffice PDF, Claude API calls); intermittent spikes
- **Recommendation:**
  - [ ] Keep — aktivní product (Rozporuj.com)
  - [ ] Ověřit `SEARXNG_URL` env — pokud unset, searxng lze pausovat (viz searxng sekce)
- **Risk if removed:** Rozporuj.com PDF generace offline

---

## garaaage-redis

- **Role:** Redis instance pro garaaage (separate project).
- **Active usage:** Žádný hit v hozan-taher codebase (grep: 0 výsledků). Per memory `project_railway_db_scope` HARD RULE: **nesahat**.
- **Status:** unknown (belongs to external project)
- **Recommendation:** Neprovádět žádnou akci. Vlastník jiný projekt.

---

## garaaage-db-prod

- **Role:** PostgreSQL pro garaaage projekt (separate).
- **Active usage:** Žádný hit v hozan-taher codebase. Per HARD RULE: **nesahat**.
- **Status:** unknown (belongs to external project)
- **Recommendation:** Neprovádět žádnou akci.

---

## garaaage-db-test

- **Role:** PostgreSQL test DB (garaaage project nebo hozan-taher test).
- **Active usage:** Žádný hit na `garaaage-db-test` URL v codebase. `DATABASE_URL_TEST` env v Go services odkazuje na lokální nebo CI DB.
- **Status:** unknown (possibly unused in prod)
- **Cost driver:** minimal Postgres idle ($5–10/mo)
- **Recommendation:**
  - [ ] Ověřit zda jakýkoliv service má `DATABASE_URL_TEST=<railway-internal>` nastaven — pokud ne, smazat (effort: low, saving: $5–10/mo)
  - Per HARD RULE `project_railway_db_scope`: pokud náleží do hozan-taher, lze smazat po ověření; pokud jiný projekt, nesahat
- **Risk if removed:** CI/CD testy se mohou rozpadnout pokud Railway CI env odkazuje na tento DB

---

## Postgres (generic name)

- **Role:** Druhý PostgreSQL se generickým názvem. Per railway-services-triage.md (2026-05-07): "Investigate".
- **Active usage:** Není ověřen owner. Per billing screenshot: $23/měsíc = velký cost za "legacy" kandidáta.
- **Status:** unknown (legacy)
- **Recommendation:**
  - [ ] Ověřit: `railway variables --service Postgres` a zjistit jaký service má `DATABASE_URL` pointing sem (effort: low)
  - [ ] Pokud žádný hozan-taher service nepointuje, **DELETE po ověření** (effort: low, saving: $23/mo) — toto je třetí největší úspora!
- **Risk if removed:** Pokud je to legacy DB z dob Nuxt outreach-dashboard, je bezpečné smazat. **Nejprve ověřit žádný active connection.**

---

## Action Plan — seřazeno dle ROI

### Immediate (< 1h práce, high confidence)

1. **Pause ollama** — `railway down --service ollama` → **$49/mo ušetřeno**
   - Prereq: ověřit že `LLM_RUNNER_URL` není set na BFF prod (nebo llm-runner expected degraded)
   - Restart kdykoliv za < 15 min

2. **Delete garaaage-grafana** — `railway service delete garaaage-grafana` → **$10–20/mo**
   - Prereq: žádný; žádný programmatický volající

3. **Delete loki** — `railway service delete loki` → **$5–15/mo**
   - Prereq: mcp/scrapers/worker mají `if (LOKI_URL)` guard; fallback na stdout automaticky

4. **Investigate Postgres (generic)** → potenciálně **$23/mo**
   - `railway variables --service Postgres` + ověřit active connections
   - Smazat pokud žádný hozan-taher service nepoužívá

### Short-term (< 1 den práce)

5. **Pause searxng** — ověřit `SEARXNG_URL` env na rozpor-worker → **$5–10/mo**

6. **Pause privacy-gateway** — ověřit `DELIVERY_MODE=record-only` + `PRIVACY_GATEWAY_URL` unset → **~$5/mo**

7. **Delete garaaage-db-test** — ověřit owner + active refs → **$5–10/mo**

### Medium-term (requires investigation)

8. **PgBouncer / connection pooling pro outreach-db** → **$10–20/mo** na největší bill item
   - Railway managed Postgres nemá built-in PgBouncer; zvážit pgbouncer sidecar nebo snížit max_connections

9. **Downsize typesense plan** — audit query frequency → **$5–10/mo**

---

## Risks a omezení

- **Ollama volume:** model cache (20 GB) zůstane po pause; `railway down` pouze stopuje compute, ne volume. Smazání volume = model re-download při next start.
- **garaaage-redis / garaaage-db-prod / garaaage-db-test:** per HARD RULE `project_railway_db_scope` — tyto mohou patřit k jiným projektům v Railway workspace. **Nikdy neprovádět destruktivní akci bez explicitního ověření.**
- **llm-runner Railway service status:** ADR-006 je "Proposed" (ne Accepted). llm-runner Dockerfile a railway.toml existují, ale není ověřeno zda service je deployed v Railway projektu (není v railway-services-triage.md 2026-05-07 inventáři).
