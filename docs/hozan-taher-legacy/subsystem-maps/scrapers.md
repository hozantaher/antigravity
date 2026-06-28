# Subsystem Map — Scrapers (Contact Data Ingestion)

**Version:** 2026-05-02
**Owner:** features/acquisition/scrapers
**Last verified:** 2026-05-02 (no code changes since 2026-05-01; commit 586fbda4)
**Refresh:** 2026-05-02 G5.2 header sync

`features/acquisition/scrapers` is a standalone TypeScript/Node.js service that harvests business and vehicle data from Czech public sources, storing raw data into SQLite and eventually PostgreSQL. It exposes a BullMQ worker (queue-based, currently dormant — no producer calls `scrapeQueue.add`) plus an MCP server and a Claude Desktop extension. The service is deployed on Railway.

> **Mandatory read:** before adding a new scraper source, wiring the BullMQ producer, or changing the data pipeline into `outreach_companies`/`outreach_contacts`.

## Components

| Component | File | Role |
|-----------|------|------|
| Entry point | `features/acquisition/scrapers/src/index.ts:1` | Starts BullMQ worker + health HTTP server |
| `startWorker` | `features/acquisition/scrapers/src/queue/scrape-worker.ts:300` | Creates BullMQ `Worker` on queue `scrape-jobs`; concurrency=1 |
| `processJob` | `features/acquisition/scrapers/src/queue/scrape-worker.ts:233` | Dispatcher: rate-limit → switch scraper → record result |
| `scrapeQueue` | `features/acquisition/scrapers/src/queue/scrape-queue.ts:64` | BullMQ Queue definition (`scrape-jobs`); **no producer wired** |
| `rateLimit(domain)` | `features/acquisition/scrapers/src/util/rate-limiter.ts:23` | In-process 2000ms minimum inter-request interval per domain |
| `recordJobResult` | `features/acquisition/scrapers/src/queue/scrape-worker.ts:14` | INSERT into `scrape_runs` table on job completion |
| firmy-cz scraper | `features/acquisition/scrapers/scrapers/firmy-cz/` | Sitemap + detail phases; SeznamBot User-Agent |
| autoline scraper | `features/acquisition/scrapers/scrapers/autoline/` | Sitemap + detail phases; Czech vehicle marketplace |
| mascus-cz scraper | `features/acquisition/scrapers/scrapers/mascus-cz/` | Sitemap + detail phases; heavy machinery marketplace |
| mobile-de scraper | `features/acquisition/scrapers/scrapers/mobile-de/` | Search + detail phases; Playwright headless Chrome |
| judikaty scraper | `features/acquisition/scrapers/scrapers/judikaty/` | 4 Czech court sources (justice/usoud/nssoud/nsoud); discovery + detail |
| esbirka scraper | `features/acquisition/scrapers/scrapers/esbirka/` | Czech legislation API; discovery + detail |
| Health server | `features/acquisition/scrapers/lib/health.ts` | GET `/healthz` on `HEALTH_PORT` (default 8090) |
| MCP server | `features/acquisition/scrapers/mcp-server/` | 7 tools over PostgreSQL; stdio + HTTP OAuth modes |

## Scraper phases

Each scraper runs in two sequential phases:

| Phase | What it does |
|-------|-------------|
| Sitemap / Discovery / Search | Enumerate URLs/IDs from index pages or XML sitemaps |
| Detail | Fetch + parse each URL; upsert into SQLite `data/garaaage.db` with prefixed table names |

Phase can be targeted independently via `params.phase` (`'all' | 'sitemap' | 'detail'`).

## Job dispatch (scrape-worker)

```
BullMQ job dequeued
  → rateLimit(SCRAPER_DOMAIN[type])   // in-process, 2s minimum, NOT Redis-backed
  → switch(type)
      firmy      → runFirmy(params, isShuttingDown)
      autoline   → runAutoline(params, isShuttingDown)
      mascus     → runMascus(params, isShuttingDown)
      mobile-de  → runMobileDe(params, isShuttingDown)
      judikaty   → runJudikaty(params, isShuttingDown)
      esbirka    → runEsbirka(params, isShuttingDown)
  → recordJobResult → INSERT scrape_runs (if DATABASE_URL set)
```

Source: `features/acquisition/scrapers/src/queue/scrape-worker.ts:233-292`

## Domain → rate-limit mapping

| Scraper | Domain | Cadence |
|---------|--------|---------|
| autoline | `autoline.cz` | 2000ms minimum |
| mascus | `mascus.cz` | 2000ms minimum |
| mobile-de | `mobile.de` | 2000ms minimum |
| firmy | `firmy.cz` | 2000ms minimum (explicit `--delay=2000` in CLI) |
| judikaty | `justice.cz` | 2000ms minimum |
| esbirka | `api.eselektron.cz` | 2000ms minimum |

Source: `features/acquisition/scrapers/src/queue/scrape-worker.ts:28-35`

## BullMQ queue state (DORMANT)

The `scrapeQueue` object is defined and the worker consumer is wired, but **no producer calls `scrapeQueue.add(...)` anywhere in the codebase** as of 2026-05-01. Scrapers are currently invoked as cron-triggered CLI scripts via `features/acquisition/scrapers/scripts/`. The queue infrastructure exists for future horizontal autoscaling.

Source: `features/acquisition/scrapers/src/queue/scrape-queue.ts:1-18` (top comment)

## Rate limiter limitation (M-S3)

The `rateLimit` function uses an **in-process `Map`**. Under horizontal scaling (multiple Railway replicas) each instance has its own map and two replicas can hit the same domain simultaneously. The current deployment uses `concurrency: 1` and a single replica, making this safe. **Do NOT increase concurrency > 1 without replacing with a Redis-backed token bucket.**

Source: `features/acquisition/scrapers/src/util/rate-limiter.ts:1-11`

## Output schema

Scrapers write to SQLite (`data/garaaage.db`) with prefixed tables. Mapping:

| Scraper | Table prefix |
|---------|-------------|
| autoline | `autoline_` |
| mascus | `mascus_cz_` |
| mobile-de | `mobile_de_` |
| firmy-cz | `firmy_cz_` |
| judikaty | `judikaty_` |
| esbirka | `esbirka_` |

Migration to PostgreSQL via `scripts/sqlite-to-postgres.ts`. The MCP server reads from PostgreSQL.

## Public API

| Surface | Endpoint | Description |
|---------|----------|-------------|
| Health | `GET /healthz` | `{ status, uptime_seconds, service: "scrapers", timestamp }` |
| MCP (stdio) | `pnpm mcp` | 7 tools: query, search, read_paragraphs, get_decision, get_law_context, get_stats, get_schema |
| MCP (HTTP) | `pnpm mcp:remote` | Same tools over Express with OAuth |
| Job queue | `scrapeQueue.add(...)` | **Not yet wired** — see dormant comment |

## Dependencies

| Dependency | What is consumed |
|------------|-----------------|
| `REDIS_URL` | BullMQ Redis connection (`scrape-queue.ts:22`) |
| `DATABASE_URL` | PostgreSQL for `scrape_runs` recording + MCP server reads |
| `HEALTH_PORT` | Health server port (default 8090) |
| `TYPESENSE_URL` + `TYPESENSE_API_KEY` | Full-text search (optional; ILIKE fallback) |
| better-sqlite3 | Per-scraper SQLite storage |
| Playwright | mobile-de scraper only |
| Cheerio | autoline, mascus, firmy-cz |
| fast-xml-parser | Sitemap XML parsing |

## Open questions (unresolved as of 2026-05-01)

1. **firmy-cz → outreach pipeline** — does data from `firmy_cz_*` SQLite tables flow directly into `outreach_contacts`/`outreach_companies`, or only after PG migration + enrichment? Pipeline is not visible in scrapers codebase.
2. **BullMQ producer wiring** — which service or cron should call `scrapeQueue.add()` to activate the queue? Not documented in any CLAUDE.md.
3. **robots.txt compliance** — CLAUDE.md mentions it but no explicit robots.txt check was found in the source files read. May be documented in scraper implementations not read.

## Cross-references

- Memory: `project_dockerized_lockfiles.md` — `features/acquisition/scrapers` has own `pnpm-lock.yaml`
- CLAUDE.md: `features/acquisition/scrapers/CLAUDE.md` — full architecture overview
- Initiative: `docs/initiatives/2026-05-01-codebase-awareness-discipline.md`
- Issue: #560
