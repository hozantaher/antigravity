# garaaage-scrapers

## Stack
TypeScript, Node.js, Playwright, Cheerio, PostgreSQL (pg), Redis (ioredis), MCP SDK, Zod, vitest, 6 scrapers + MCP server + Claude Desktop extension + BullMQ worker

## Commands
- Test: `pnpm test`
- Coverage: `pnpm test:coverage`
- MCP (stdio): `pnpm mcp`
- MCP (HTTP): `pnpm mcp:remote`
- Worker: `pnpm start:worker`
- Type-check: `npx tsc --noEmit`

## Health endpoint
- Worker service: GET `/healthz` on port `HEALTH_PORT` (default 8090)
- Returns JSON: `{ status: "ok", uptime_seconds: <int>, service: "scrapers", timestamp: "<ISO>" }`
- Used by Docker HEALTHCHECK

## Rules
- Each scraper is an independent entry point — do not share mutable state between scrapers
- Raw HTML columns must be compressed after bulk scrape runs: `pnpm compress:raw`
- Database connection uses `DATABASE_URL` (PostgreSQL, Railway) — never hardcode hostnames or credentials
- MCP table names are unprefixed (e.g. `decisions`); prefixing is automatic based on `source` param

---

## Project Overview

Scrapers for Czech vehicle marketplaces, business directories, court decisions, and legislation. Includes an MCP server (deployed on Railway), a Claude Desktop extension, database optimization tools, and a legal document generator.

**6 scrapers:** autoline, mascus-cz, mobile-de (vehicles), judikaty (685K court decisions), esbirka (8.8K Czech laws), firmy-cz (1.08M Czech businesses).

**MCP server** with 7 tools: `query`, `search` (Typesense + ILIKE), `read_paragraphs`, `get_decision`, `get_law_context`, `get_stats`, `get_schema`.

**Rozporuj.com worker** — BullMQ worker that generates legal objection PDFs (odpor/rozklad) via Claude API agentic loop + MCP tools. Deployed on Railway as a separate service.

## Commands

```bash
pnpm install                                           # Install dependencies

# Scrapers
pnpm run scrape:autoline -- --phase=sitemap            # Autoline sitemap phase
pnpm run scrape:autoline -- --phase=detail --limit=10  # Scrape 10 detail pages
pnpm run scrape:mascus -- --phase=all                  # Full mascus pipeline
pnpm run scrape:mobile-de -- --phase=search --headless=false  # mobile.de with visible browser
pnpm run scrape:judikaty -- --source=all --phase=all   # All 4 court sources
pnpm run scrape:esbirka -- --phase=all                 # Czech legislation
pnpm run scrape:firmy-cz -- --phase=all                # Czech business directory

# MCP server
pnpm run mcp                                           # stdio mode (Claude Code)
pnpm run mcp:remote                                    # HTTP mode with OAuth

# Data pipeline
pnpm run migrate:postgres                              # SQLite → PostgreSQL migration
pnpm run index:meili                                   # Index judikaty + esbirka into Typesense
pnpm run optimize:db                                   # Create FTS5 indexes + regular indexes + ANALYZE
pnpm run compress:raw                                  # Gzip compress raw columns + VACUUM
pnpm run benchmark:mcp                                 # Performance test on production MCP (needs MCP_URL + MCP_SECRET)

# E2E test (Claude Code + extension + PDF → legal analysis)
./scripts/e2e-extension.sh test-pdfs/pokuta.pdf "rozporuj tuto výzvu"
./scripts/e2e-extension.sh test-pdfs/zaloba.pdf "analyzuj žalobu"  # needs MCP_REMOTE_URL + MCP_REMOTE_SECRET

# Development
npx tsc --noEmit                                       # Type-check
pnpm test                                              # Run tests (500+ test cases)
pnpm lint                                              # Lint
pnpm lint:fix                                          # Lint + auto-fix
```

All scrapers accept: `--phase`, `--concurrency`, `--delay`, `--max-retries`, `--limit`, `--db`. Additional options: mobile-de (`--categories`, `--headless`, `--reset-search`), judikaty (`--source`), esbirka (`--collection`), firmy-cz (default `--delay=2000`).

## Architecture

```
lib/                          # Shared utilities
├── utils.ts                 # Rate limiter, retry, progress tracker, shutdown handler, tryGunzip
├── fetch.ts                 # HTTP fetch with rotated headers/user agents
├── types.ts                 # Base interfaces (ScraperConfigBase, ProgressStats)
├── db-prefix.ts             # Source → table prefix mapping
├── logger.ts                # Pino logger with pino-loki transport (Grafana + Loki)
└── meilisearch.ts           # Typesense client, index config (judikaty, esbirka)

scrapers/<name>/             # Per-scraper modules (autoline, mascus-cz, mobile-de, judikaty, esbirka, firmy-cz)
├── index.ts                 # CLI entry point
├── db.ts                    # SQLite schema + closure-based data access API
├── scraper.ts               # Detail phase (parsing + worker pool)
├── sitemap.ts / search.ts   # Discovery phase
└── types.ts                 # Scraper-specific types

mcp-server/                  # MCP server (stdio + HTTP), reads from PostgreSQL
├── tools.ts                 # 7 tools: query, search, read_paragraphs, get_decision, get_law_context, get_stats, get_schema
├── db.ts                    # PostgreSQL queries, Typesense search, ILIKE fallback, gzip decompression
├── auth.ts                  # OAuth2 (PKCE, DCR)
└── http.ts                  # Express HTTP transport with pino-http request logging

desktop-extension/           # Claude Desktop extension (.mcpb)
├── server/index.js          # Proxy MCP server + 12 legal prompts + knowledge tools
├── server/utils.js          # Prompts, DB schema hints, file utilities
└── manifest.json            # MCPB manifest (7 tools, 12 prompts, user_config)

worker/                      # Rozporuj.com PDF generation worker (BullMQ)
├── index.ts                 # Worker entry point, job orchestration
├── generate-odpor.ts        # Claude API agentic loop + MCP tools
├── queue.ts                 # Queue name, job/result types, Redis connection
├── firebase.ts              # Firebase Storage download/upload
├── email.ts                 # SendGrid email delivery
└── pdf.ts                   # DOCX → PDF via LibreOffice headless

scripts/                     # Utility scripts
├── sqlite-to-postgres.ts    # Migrate garaaage.db → PostgreSQL (batch INSERT)
├── index-meilisearch.ts     # Index judikaty + esbirka from PG → Typesense
├── optimize-db.ts           # FTS5 + index creation for SQLite databases
├── compress-raw.ts          # Gzip compression of raw columns + VACUUM
├── mcp-benchmark.ts         # Production MCP performance test (19 queries, all 7 tools)
├── e2e-extension.sh         # E2E test: Claude Code CLI + extension server + PDF → legal analysis
└── docker-entrypoint.sh     # Container startup

data/                        # SQLite databases (gitignored, used by scrapers)
```

## MCP Server — 7 Tools

| Tool | Purpose | Example |
|------|---------|---------|
| `query` | Raw SQL SELECT (100KB cap) | `query(source="judikaty", sql="SELECT COUNT(*) FROM decisions")` |
| `search` | Typesense (judikaty/esbirka) + ILIKE fallback | `search(source="judikaty", table="decisions", query="zprostředkování", columns=["pravni_veta","vyrok"])` |
| `read_paragraphs` | Extract §§ from Czech laws (no limit) | `read_paragraphs(source="esbirka", citace="89/2012 Sb.", paragraphs=["2445","2446"])` |
| `get_decision` | Court decision by case number | `get_decision(source="judikaty", identifier="33 Cdo 2675/2007")` |
| `get_law_context` | Law metadata, amendments, relationships | `get_law_context(source="esbirka", citace="89/2012 Sb.")` |
| `get_stats` | Row counts per table | `get_stats()` |
| `get_schema` | CREATE TABLE/INDEX statements | `get_schema(source="judikaty")` |

Sources: `judikaty` (685K decisions), `esbirka` (8.8K laws), `autoline` (302K listings), `mascus` (6.7K), `mobile-de` (58K), `firmy-cz` (1.08M businesses).

## Key Technical Details

- **MCP server reads from PostgreSQL** (Railway) via `DATABASE_URL`, not SQLite
- **Typesense** for full-text search on judikaty + esbirka (typo-tolerant, fast). ILIKE fallback for other sources.
- **Scrapers write to SQLite** (`data/garaaage.db` with prefixed tables), then data is migrated to PG via `migrate:postgres`
- **Gzip compression** on raw/large columns (transparent — MCP server auto-decompresses via `tryGunzip`)
- **Judikaty data quality**: nsoud has `pravni_veta`, usoud/nssoud/justice have `vyrok` + `oduvodneni`. `get_decision` uses parallel exact-match queries (spisova_znacka, ecli, jednaci_cislo) then LIKE prefix fallback. Column `jednaci_cislo` exists in PG but is not exposed in the extension DB_SCHEMA_HINT (internal to get_decision only).
- **Structured logging** via pino → pino-loki (Grafana + Loki on Railway)
- **firmy-cz** uses SeznamBot User-Agent for SSR content (no Playwright needed)
- **mobile-de** uses Playwright (headless Chrome) with anti-detection

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | MCP server | PostgreSQL connection string |
| `TYPESENSE_URL` | Optional | Typesense URL (search falls back to ILIKE without it) |
| `TYPESENSE_API_KEY` | With TYPESENSE_URL | Typesense API key |
| `LOKI_URL` | Optional | Grafana Loki URL for log shipping |
| `LOG_LEVEL` | Optional | Pino log level (default: `info`) |
| `MCP_ISSUER_URL` | HTTP mode | OAuth issuer URL |
| `MCP_SECRET` | HTTP mode | OAuth approval secret |
| `REDIS_URL` | Optional | Redis for OAuth state persistence + BullMQ |
| `ANTHROPIC_API_KEY` | Worker | Claude API key |
| `MCP_REMOTE_URL` | Worker | Railway MCP server URL |
| `MCP_REMOTE_SECRET` | Worker | OAuth secret for MCP |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Worker | Base64-encoded Firebase service account |
| `FIREBASE_STORAGE_BUCKET` | Worker | Firebase Storage bucket name |
| `SENDGRID_API_KEY` | Worker | SendGrid API key for email delivery |

## Conventions

- All scraper entry points filter out bare `--` from argv (pnpm injects it before script args)
- All scraper data in unified `data/garaaage.db` with prefixed tables (e.g. `judikaty_decisions`, `esbirka_acts`)
- MCP tools accept unprefixed table names (e.g. `decisions`) — rewriting is automatic based on `source`
- Table prefix mapping: autoline→`autoline_`, mascus→`mascus_cz_`, mobile-de→`mobile_de_`, judikaty→`judikaty_`, esbirka→`esbirka_`, firmy-cz→`firmy_cz_`
- URL statuses follow: `pending` → `scraped` | `failed` | `gone`
- Raw data stored alongside parsed fields for reprocessing (may be gzip-compressed as BLOB/BYTEA)
- SQLite (scrapers): WAL mode, 64MB cache, `INSERT OR IGNORE`/`INSERT OR REPLACE` for idempotency
- Desktop extension: all generated documents include AI disclaimer
- Worker queue name: `rozporuj-pdf` (must match rozporuj-com frontend)
- Worker job flow: download files → Claude API agentic loop → markdown → DOCX → PDF → upload → email
- Worker uses prompt caching (`cache_control: ephemeral`) on system prompt + last tool definition

## Tech Stack

- TypeScript (ESM, NodeNext module resolution) executed via `tsx`
- pnpm package manager
- PostgreSQL (MCP server, Railway) + better-sqlite3 (scrapers, local)
- Typesense — full-text search for judikaty + esbirka
- Pino + pino-loki + pino-http — structured logging → Grafana + Loki
- Cheerio (autoline, mascus, firmy-cz), Playwright (mobile-de), fast-xml-parser (sitemaps)
- @modelcontextprotocol/sdk — MCP server + extension
- Express — MCP HTTP transport
- zod — runtime validation
- BullMQ + ioredis — job queue (worker)
- Firebase Admin SDK — file storage (worker)
- @sendgrid/mail — email delivery (worker)
- LibreOffice headless — DOCX → PDF conversion (worker)
- Docker + GitHub Actions — CI/CD to GHCR
