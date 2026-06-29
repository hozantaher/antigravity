# SERVICES — Railway service catalog & ownership playbook

> **Purpose**: Kanonický přehled všech Railway služeb projektu `garaaage-mcp`
> (env: `production`), jejich účelu, repo mapování, vlastnictví a incident
> playbooku. Slouží jako single source of truth pro "co běží, kdo to vlastní,
> kam kouknout když padne".
>
> **Kdy aktualizovat**:
> - při přidání/smazání Railway služby,
> - při změně vlastníka nebo účelu služby,
> - po změně healthcheck endpointu nebo interního DNS hostname,
> - po čistce env vars nebo legacy cleanup milestone,
> - minimálně při quarterly audit (viz **Ownership rules** níže).
>
> **Zdroj pravdy**: `railway status` + `railway variables --service <name> --kv`.
> Tabulka níže je **snapshot k 2026-04-22** — před redeploy / shutdown decision
> vždy ověř aktuální stav přes CLI.

---

## 1. Service catalog

| Service | Owner | Purpose | Repo path | Deploy target | Status | Last deploy | SLO |
|---|---|---|---|---|---|---|---|
| `anti-trace-relay` | outreach-go | SMTP/SOCKS relay s proxy poolem (Proxifly + geonode + proxyscrape) pro mailbox self-healing | `features/outreach/relay/` | Go binary (Dockerfile) | **active** | 2026-04-21 18:49 SUCCESS | 99.5% (stale pool <5 min) |
| `machinery-outreach` | outreach-go | Hlavní Go backend — kampaně, mailboxy, intelligence loop, scheduler (6h), `/healthz` + API chráněné `X-API-Key` | `modules/outreach/` | Go binary (Dockerfile) | **active** | 2026-04-22 12:31 SUCCESS | 99.5% |
| `outreach-dashboard` | outreach-dashboard | BFF (Express 5) + SPA (React 19 + Vite 6). **AKTUÁLNÍ PROD STÁLE NUXT** — v repo je React rewrite, Nuxt build v prod | `features/platform/outreach-dashboard/` | Node 20 (Dockerfile) | **degraded** — 5 FAILED deploys 2026-04-21 | 2026-04-17 21:16 SUCCESS (Nuxt); 2026-04-21 vše FAILED | 99% (po stabilizaci React) |
| `outreach-db` | outreach-go | PostgreSQL (outreach schema — campaigns, mailboxes, events) | n/a (managed) | Postgres 16 | **active** | 2026-04-04 04:07 SUCCESS | 99.9% (managed) |
| `redis` | outreach-go | Redis 7 — session store, BFF cache, rate limiter | n/a (managed) | Redis 7 | **active** | 2026-03-26 13:39 SUCCESS | 99.9% (managed) |
| `privacy-gateway` | outreach-go | Privacy gateway (legitimate B2B — public pixel/click redirect endpoint s per-request audit logem) | `features/compliance/privacy-gateway/` | Go binary (Dockerfile) | **active** | 2026-04-04 02:04 SUCCESS | 99.5% |
| `garaaage-scrapers` | scrapers | ARES + firmy.cz scraper (TypeScript) + Typesense indexer | `features/acquisition/scrapers/` | Node 20 | **active** (stale) | 2026-03-31 19:04 SUCCESS | 99% (běží na cron, ne request-path) |
| `garaaage-grafana` | ops | Grafana (observability — metriky, logy, alerty) | n/a | Grafana image | **active** (stale) | 2026-03-28 01:09 SUCCESS | best effort |
| `typesense` | scrapers | Typesense search engine — indexy pro MCP db lookup + scrapers firmy index | n/a (managed image) | Typesense 0.x | **active** (stale) | 2026-03-28 02:42 SUCCESS | 99% |
| `ollama` | outreach-go | Ollama — on-demand LLM pro intel loop / IMAP sentiment classifier | n/a (managed image) | Ollama image | **active** (stale) **UNUSED v prod** (`OLLAMA_URL` není set na `machinery-outreach`) | 2026-04-04 03:47 SUCCESS | n/a |

**Legenda statusů**:
- **active** — poslední deploy SUCCESS, služba vystavuje healthcheck 200.
- **active (stale)** — SUCCESS, ale >14 dní bez redeploy; owner musí quarterly potvrdit OK.
- **degraded** — poslední několik deploys FAILED, ale předchozí SUCCESS drží v prod (Railway zachová běžící instanci).
- **down** — žádný běžící deploy, služba vrací 5xx / nedostupná.

---

## 2. Per-service detail

### `anti-trace-relay`

- **Dependencies**: Redis (pool state), proxy sources (Proxifly primary, geonode + proxyscrape secondary).
- **Env**: 48 vars, žádné NUXT_*/BOOTSTRAP_*. `RAILWAY_PUBLIC_DOMAIN=anti-trace-relay-production-a706.up.railway.app`.
- **Healthcheck**: `GET /healthz` → `{"status":"ok"}` (200).
- **Incident playbook**: Pokud down → check `railway logs --service anti-trace-relay`; stale pool (neobnovený >5 min) → viz [`MAILBOXES-SELF-HEALING-SPRINTS.md`](MAILBOXES-SELF-HEALING-SPRINTS.md). Pool refresh bug byl hotfixed 2026-04-21 (ctx.Background v `pool.refresh()`).

### `machinery-outreach`

- **Dependencies**: `outreach-db` (Postgres), `redis`, `anti-trace-relay` (egress), optional `ollama` (LLM).
- **Env**: 62 vars, žádné NUXT_*/BOOTSTRAP_*. `API_KEY` + `PORT=8080`. `RAILWAY_PUBLIC_DOMAIN=machinery-outreach-production.up.railway.app`.
- **Healthcheck**: `GET /healthz` → 200 (`{"status":"ok"}`). `/api/health` **neexistuje** (404) — nepoužívat.
- **Incident playbook**: Scheduler padl (intel loop, 6h) → `railway logs | grep "intelligence loop"`. Duplicate-send risk v `campaign/runner` — viz MEMORY `project_outreach_go_quality_debt`. DB down → check `outreach-db`.

### `outreach-dashboard` ⚠️ KRITICKY ROZBITÉ

- **Dependencies**: `machinery-outreach` (Go BFF proxy), `outreach-db`, `redis`.
- **Env**: 37 vars — **14× legacy `NUXT_*` + 2× `NUXT_AUTH_BOOTSTRAP_*`**. Prod stále serve-uje **Nuxt build** (poslední SUCCESS 2026-04-17), v repo je ale React 19 + Vite 6 + Express 5 BFF. 5/5 deploys 2026-04-21 FAILED.
- **Healthcheck**: `GET /` → 302 (redirect na login), `GET /api/health` → 200 (Express BFF). Po React rewrite switch: `/api/health` zůstává kanonický healthcheck.
- **Incident playbook**:
  - Pokud nelze loginovat → check Redis (session store) + `NUXT_AUTH_SECRET` (po React rewrite: `AUTH_SECRET` bez prefixu).
  - Pokud BFF vrací 502 pro outreach routes → check `machinery-outreach` a `NUXT_GO_SERVER_URL` (po rewrite: `GO_SERVER_URL`).
  - **Legacy vars cleanup** (P1-4): po úspěšném React deploy smazat všech 14 `NUXT_*` + 2 `NUXT_AUTH_BOOTSTRAP_*`, přidat non-prefixed ekvivalenty:
    - `NUXT_GO_SERVER_URL` → `GO_SERVER_URL`
    - `NUXT_GO_API_KEY` → `OUTREACH_API_KEY`
    - `NUXT_OUTREACH_DSN` → `OUTREACH_DSN`
    - `NUXT_REDIS_URL` → `REDIS_URL`
    - `NUXT_FIRMY_DSN` → `FIRMY_DSN`
    - `NUXT_AUTH_SECRET` → `AUTH_SECRET`
    - `NUXT_AUTH_PASSWORD` → (remove — nahrazeno Redis session store)
    - `NUXT_AUTH_BOOTSTRAP_EMAIL` / `_PASSWORD` → (remove — seed-only, patří do seed jobu)
    - `NUXT_MAIL_DRIVER` / `NUXT_MAIL_FROM` → (remove — mail goes přes `machinery-outreach`)
    - `NUXT_PUBLIC_APP_URL` → `APP_URL`
    - `NUXT_PUBLIC_MVP_MODE` / `NUXT_PUBLIC_SKIP_2FA_GATE` → `MVP_MODE` / `SKIP_2FA_GATE`

### `outreach-db`

- **Dependencies**: none (managed Postgres).
- **Env**: 30 vars, pouze Railway-generated + Postgres credentials. Žádné NUXT_*.
- **Healthcheck**: TCP connectivity přes `outreach-db.railway.internal:5432`.
- **Incident playbook**: Pokud `machinery-outreach` hlásí DB down → Railway dashboard → service → Observability → check CPU/memory/disk. `DB_SSL_MODE=require` v prod (CLAUDE.md).

### `redis`

- **Dependencies**: none.
- **Env**: 1 var (jen Railway internals). Žádné NUXT_*.
- **Healthcheck**: TCP connectivity přes `redis.railway.internal:6379`.
- **Incident playbook**: Pokud session lost / rate limiter fail → check connectivity; Redis persistence disabled by default (session loss při restart je expected).

### `privacy-gateway`

- **Dependencies**: `outreach-db` (audit log), Redis (rate limit).
- **Env**: 31 vars, žádné NUXT_*. `RAILWAY_PUBLIC_DOMAIN=privacy-gateway-production-3335.up.railway.app`.
- **Healthcheck**: `GET /healthz` → 200.
- **Incident playbook**: Stale deploy (>18 dní); owner musí potvrdit OK nebo redeploy. Pokud pixel/click 5xx → check `machinery-outreach` downstream.

### `garaaage-scrapers`

- **Dependencies**: `typesense` (indexer target), `outreach-db`, ARES API, firmy.cz sitemap.
- **Env**: 29 vars, žádné NUXT_*. `TYPESENSE_URL=http://typesense.railway.internal:8108`.
- **Healthcheck**: `GET /healthz` → **404** (service neexponuje HTTP healthcheck — je cron-driven). Monitoring přes scheduled job success.
- **Incident playbook**: 2 HIGH z audit 2026-04-21 (firmy-cz sitemap no-timeout, `scrapeQueue` never enqueued) — viz MEMORY `project_scrapers_quality_debt`.

### `garaaage-grafana`

- **Dependencies**: Prometheus / log sources (interní).
- **Env**: 28 vars, žádné NUXT_*. `RAILWAY_PUBLIC_DOMAIN=garaaage-grafana-production.up.railway.app`.
- **Healthcheck**: `GET /` → 302 (redirect na login) — Grafana live.
- **Incident playbook**: Observability only — pokud down, neovlivní prod traffic. Owner: `ops` (zatím shared Tomáš).

### `typesense`

- **Dependencies**: persistentní volume (index data).
- **Env**: 25 vars, žádné NUXT_*.
- **Healthcheck**: `GET /health` → 200.
- **Consumers**: `features/acquisition/scrapers/` (indexer), `features/platform/mcp/mcp-server/db.ts` (query engine — `engine: 'typesense'`). **Používá se.**
- **Incident playbook**: Pokud index prázdný → reindex přes `features/acquisition/scrapers/scripts/index-meilisearch.ts`.

### `ollama`

- **Dependencies**: žádné (samostatný LLM runtime).
- **Env**: 23 vars, žádné NUXT_*. `RAILWAY_PUBLIC_DOMAIN=ollama-production-51cd.up.railway.app`.
- **Healthcheck**: `GET /` → 200 (Ollama root).
- **Consumers**: `modules/outreach/cmd/outreach/main.go` (6× reference na `OLLAMA_URL`), `modules/outreach/internal/llm/client.go`. **Kód je wired, ale `OLLAMA_URL` env v `machinery-outreach` NENÍ SET** → v prod se LLM enrichment nevolá (všech 6 `if ollamaURL != ""` větví ne-vstupuje). Viz **Shutdown decisions** níže.
- **Incident playbook**: Pokud někdo zapne `OLLAMA_URL` a classifier začne selhávat → `ollama unreachable` / `ollama HTTP xxx` v logu `machinery-outreach`.

---

## 3. Ownership rules

1. **Každá služba má named owner** (sloupec *Owner* v tabulce). Owner odpovídá za:
   - healthcheck + response time,
   - úspěšný deploy po merge do relevantní cesty v repo,
   - env vars cleanup (žádné legacy/stale secrets),
   - incident response.
2. **Failed deploy policy**: owner má **24 h** na fix nebo rollback (`railway down` / `railway redeploy <last-success>`). Po 24 h neřešeného failed deploy se service přepne na `degraded` → `down` statusem v tabulce.
3. **Stale deploy policy** (>14 dní bez redeploy): owner **quarterly potvrzuje** OK ve zprávě v `docs/handoff/BOARD.md`. Pokud ne → service je kandidát na shutdown (viz sekce 4).
4. **Quarterly audit**: min. 1× za čtvrtletí owner projde celou svou column a:
   - ověří healthcheck endpoint (manuální curl),
   - projde env vars a smaže nepoužité,
   - aktualizuje *Status* + *Last deploy* sloupec v tomto dokumentu.
5. **Destruktivní operace** (shutdown, delete, mass unset env) — vždy přes PR + schválení od Tomáše. Nikdy `railway variables --unset` bez review.

### Ownership map (2026-04-22)

| Owner tag | Osoba | Služby |
|---|---|---|
| `outreach-go` | Tomáš | anti-trace-relay, machinery-outreach, outreach-db, redis, privacy-gateway, ollama |
| `outreach-dashboard` | Tomáš | outreach-dashboard |
| `scrapers` | Tomáš | garaaage-scrapers, typesense |
| `ops` | Tomáš | garaaage-grafana |

(Všechny dočasně vlastní Tomáš — po přidání team members přemapovat.)

---

## 4. Shutdown decisions

### ✅ KEEP (9/10 služeb)

Všechny kromě `ollama` mají aktivního consumer nebo jsou managed infra dependency.

### 🟡 KANDIDÁT NA SHUTDOWN: `ollama`

**Důvod**:
- Kód v `modules/outreach/cmd/outreach/main.go` reference-uje `OLLAMA_URL` 6× + `internal/llm/client.go`, ale v prod **není `OLLAMA_URL` nastaven** na `machinery-outreach`.
- Všech 6 větví `if ollamaURL := os.Getenv("OLLAMA_URL"); ollamaURL != ""` v prod NIKDY nevstoupí → LLM enrichment + sentiment classifier + summarizer jsou **wired, ale nikdy volaní**.
- Last deploy ollama 2026-04-04 (18 dní stale), běží volně bez consumer traffic.

**Doporučení** (pro separate P1 task):
- **Option A — Shutdown**: `railway down --service ollama`, ponechat kód wired ale inaktivní. LLM features lze kdykoli reenablovat novou deploy + `OLLAMA_URL` env.
- **Option B — Enable**: nastavit `OLLAMA_URL=http://ollama.railway.internal:11434` na `machinery-outreach` → intel loop + IMAP classifier se reálně spustí. Vyžaduje ověření latence + cost (ollama instance běží, takže marginal cost).
- **Default recommendation**: **Option A (shutdown)**. Kód zůstává, ale ušetří se běžící instance. Pokud LLM features budou potřeba, re-enable trvá <5 min (redeploy ollama + set env).

**Rozhodnutí**: čeká na Tomáše (nepůsobit destruktivně bez potvrzení).

### 🟡 KANDIDÁT NA SHUTDOWN: žádný další

`typesense` má aktivní consumers (`features/acquisition/scrapers/` + `features/platform/mcp/mcp-server/db.ts`) → **KEEP**.

---

## 5. Env vars cleanup list (pro P1-4)

| Service | Var | Akce | Důvod |
|---|---|---|---|
| outreach-dashboard | `NUXT_AUTH_BOOTSTRAP_EMAIL` | **DELETE** | Seed-only, nepatří do prod env |
| outreach-dashboard | `NUXT_AUTH_BOOTSTRAP_PASSWORD` | **DELETE** | Seed-only, nepatří do prod env |
| outreach-dashboard | `NUXT_AUTH_PASSWORD` | **DELETE** | Nahrazeno Redis session store (React rewrite) |
| outreach-dashboard | `NUXT_AUTH_SECRET` | **RENAME → `AUTH_SECRET`** | React BFF pattern |
| outreach-dashboard | `NUXT_FIRMY_DSN` | **RENAME → `FIRMY_DSN`** | Non-prefixed |
| outreach-dashboard | `NUXT_GO_API_KEY` | **RENAME → `OUTREACH_API_KEY`** | Per CLAUDE.md service-local rules |
| outreach-dashboard | `NUXT_GO_SERVER_URL` | **RENAME → `GO_SERVER_URL`** | Per CLAUDE.md service-local rules |
| outreach-dashboard | `NUXT_MAIL_DRIVER` | **DELETE** | Mail goes přes machinery-outreach |
| outreach-dashboard | `NUXT_MAIL_FROM` | **DELETE** | Mail goes přes machinery-outreach |
| outreach-dashboard | `NUXT_OUTREACH_DSN` | **RENAME → `OUTREACH_DSN`** | Non-prefixed |
| outreach-dashboard | `NUXT_PUBLIC_APP_URL` | **RENAME → `APP_URL`** | No Nuxt public runtime config |
| outreach-dashboard | `NUXT_PUBLIC_MVP_MODE` | **RENAME → `MVP_MODE`** | No Nuxt public runtime config |
| outreach-dashboard | `NUXT_PUBLIC_SKIP_2FA_GATE` | **RENAME → `SKIP_2FA_GATE`** | No Nuxt public runtime config |
| outreach-dashboard | `NUXT_REDIS_URL` | **RENAME → `REDIS_URL`** | Non-prefixed |

**Celkem cleanup**: 14 vars (5 DELETE + 9 RENAME). **Akce**: až po úspěšném React deploy, ne před.

---

## 6. Vazby na ostatní dokumenty

- [`docs/handoff/BOARD.md`](../handoff/BOARD.md) — průběžný stav sprintů; quarterly audit status se propisuje sem.
- [`docs/playbooks/DISCIPLINE.md`](DISCIPLINE.md) — obecná operational disciplína.
- [`docs/playbooks/EGRESS-FIREWALL-OPS.md`](EGRESS-FIREWALL-OPS.md) — specifická pro `anti-trace-relay`.
- [`docs/playbooks/MAILBOXES-SELF-HEALING-SPRINTS.md`](MAILBOXES-SELF-HEALING-SPRINTS.md) — proxy pool recovery.
- [`docs/decisions/`](../decisions/) — ADRs (některé relevantní pro deployment strategy).
- [`CLAUDE.md`](../../CLAUDE.md) — service-local rules per-service.
