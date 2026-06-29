# garaaage-scrapers
![Version](https://img.shields.io/badge/version-v1.1.1-blue)


Scrapers for Czech vehicle marketplaces, business directories, court decisions, and legislation. Each scraper follows a two-phase pipeline (discovery + detail), stores results in per-scraper SQLite databases in `data/`, and shares common utilities for rate limiting, retries, and progress tracking.

Also includes an MCP server (deployed on Railway), a legal document generator, a Claude Desktop extension, a PDF generation worker for [rozporuj.com](https://rozporuj.com), and database optimization tools.

## Maturity

Current state: `stabilizing`

This service has broad scope and substantial code coverage, but its canonical README still mixes multiple product surfaces and its local verification posture depends on whether dependencies are installed.

## Documentation

### Canonical SpecKit Surface

Use these as the active truth for the service:

- [README.md](/Users/messingtomas/Taher/hozan-taher/services/garaaage-scrapers/README.md)
  - mixed-surface service identity, run/test surface, architecture overview, production posture, and current gaps
- [scripts/README.md](/Users/messingtomas/Taher/hozan-taher/services/garaaage-scrapers/scripts/README.md)
  - canonical detail for the `generate:terms` script only

Interpretation rule:

- if a support note, harness note, or historical audit disagrees with the README, reconcile toward the README unless the disagreement is specifically about `generate:terms`, where `scripts/README.md` is the narrower canonical source

### Reference Surface

These are useful, but they are not the first source of service truth:

- [SPECKIT-DOC-MAP.md](/Users/messingtomas/Taher/hozan-taher/services/garaaage-scrapers/SPECKIT-DOC-MAP.md)
- [CLAUDE.md](/Users/messingtomas/Taher/hozan-taher/services/garaaage-scrapers/CLAUDE.md)
- [docs/bugy.md](/Users/messingtomas/Taher/hozan-taher/services/garaaage-scrapers/docs/bugy.md)
- [package.json](/Users/messingtomas/Taher/hozan-taher/services/garaaage-scrapers/package.json)
- [Dockerfile](/Users/messingtomas/Taher/hozan-taher/services/garaaage-scrapers/Dockerfile)

Use the reference surface for:

- document role classification
- harness-specific coding context
- historical audit context
- implementation lookup

### Scope Clarification

This service currently combines several adjacent runtime surfaces in one repo:

- scrapers
- MCP server
- legal document generation scripts
- worker runtime

Treat this README as the mixed-surface service entrypoint.

Do not assume every sub-surface is an independently documented product yet.

## Scrapers

### Vehicle Marketplaces

| Scraper | Source | Discovery | Parsing | DB |
|---------|--------|-----------|---------|-----|
| **autoline** | [autoline.cz](https://autoline.cz) | XML sitemap | Cheerio + JSON-LD | `data/autoline.db` |
| **mascus-cz** | [mascus.cz](https://www.mascus.cz) | XML sitemap | Cheerio + JSON-LD | `data/mascus.db` |
| **mobile-de** | [mobile.de](https://www.mobile.de) | Playwright search crawl | Playwright + Cheerio | `data/mobile-de.db` |

### Legal Data

| Scraper | Source | Discovery | Parsing | DB |
|---------|--------|-----------|---------|-----|
| **judikaty** | Czech court decisions (4 courts) | REST APIs | JSON + HTML | `data/judikaty.db` |
| **esbirka** | [e-Sbírka](https://www.e-sbirka.cz) — Czech legislation | SPARQL + REST API | JSON (XHTML fragments) | `data/esbirka.db` |

### Business Directory

| Scraper | Source | Discovery | Parsing | DB |
|---------|--------|-----------|---------|-----|
| **firmy-cz** | [firmy.cz](https://www.firmy.cz) — 1.08M Czech businesses | XML sitemap (.gz) | Cheerio + JSON-LD (SSR via SeznamBot UA) | `data/firmy-cz.db` |

## Quick Start

```bash
cd /Users/messingtomas/Taher/hozan-taher/services/garaaage-scrapers
pnpm install

# Vehicle scrapers
pnpm run scrape:autoline -- --phase=all
pnpm run scrape:mascus -- --phase=all
pnpm run scrape:mobile-de -- --phase=search --headless=false

# Court decisions (4 sources: justice, usoud, nssoud, nsoud)
pnpm run scrape:judikaty -- --source=all --phase=all

# Czech legislation (Sbírka zákonů + mezinárodní smlouvy)
pnpm run scrape:esbirka -- --phase=all

# Czech business directory (1.08M businesses)
pnpm run scrape:firmy-cz -- --phase=all

# Generate legal T&C document (requires MCP server + Anthropic API key)
pnpm run generate:terms -- --phase=all

# Optimize all databases (FTS5 indexes, regular indexes, ANALYZE)
pnpm run optimize:db

# Benchmark MCP server performance
MCP_SECRET=<secret> pnpm run benchmark:mcp
```

## Test

```bash
cd /Users/messingtomas/Taher/hozan-taher/services/garaaage-scrapers
pnpm test
```

Verification status:

- `pnpm test` is the canonical local test command from `package.json`
- it was verified locally during stabilization on `2026-04-04`
- observed result: `23` test files passed, `305` tests passed
- this service now has a confirmed local verification pass in this workspace

## Common CLI Options

All scrapers accept:

| Option | Default | Description |
|--------|---------|-------------|
| `--phase` | `all` | Pipeline phase (`all`, `sitemap`/`discovery`/`search`, `detail`) |
| `--concurrency` | `2`–`5` | Parallel workers |
| `--delay` | `100`–`2000` | Base delay between requests (ms) |
| `--max-retries` | `3` | Retry attempts for failed requests |
| `--limit` | `0` | Max items to process (0 = unlimited) |
| `--db` | `data/<name>.db` | SQLite database path |

Scraper-specific options:

| Scraper | Option | Description |
|---------|--------|-------------|
| mobile-de | `--categories` | `Car`, `Motorbike`, `Truck`, `MotorHome` |
| mobile-de | `--headless` | `true`/`false` — show browser window |
| mobile-de | `--reset-search` | Clear search progress and restart |
| judikaty | `--source` | `justice`, `usoud`, `nssoud`, `nsoud`, or `all` |
| esbirka | `--collection` | `sb` (laws), `sm` (treaties), or `all` |
| firmy-cz | `--delay` | Default `2000` (conservative for SeznamBot UA) |

## Architecture

```
lib/                          # Shared utilities
├── utils.ts                 # Rate limiter, retry, progress tracker, shutdown handler
├── fetch.ts                 # HTTP fetch with rotated headers/user agents
└── types.ts                 # Base interfaces (ScraperConfigBase, ProgressStats)

scrapers/<name>/             # Per-scraper modules
├── index.ts                 # CLI entry point, args parsing, phase orchestration
├── db.ts                    # SQLite schema + closure-based data access API
├── scraper.ts               # Detail phase (parsing + worker pool)
├── sitemap.ts / search.ts   # Discovery phase
└── types.ts                 # Scraper-specific types

scripts/                     # Utility scripts
├── generate-terms.ts        # AI-powered legal document generator (Sonnet + Opus)
├── mcp-benchmark.ts         # MCP server performance benchmark (19 queries)
├── e2e-extension.sh         # E2E test: Claude Code + extension + PDF → legal analysis
├── optimize-db.ts           # FTS5 + index optimizer for all databases
├── sqlite-to-postgres.ts    # SQLite → PostgreSQL migration
├── index-meilisearch.ts     # Index judikaty + esbirka → Typesense
├── docker-entrypoint.sh     # Container startup
└── lib/
    ├── mcp-client.ts        # HTTP MCP client with OAuth/PKCE
    └── docx-writer.ts       # Markdown → .docx converter

mcp-server/                  # MCP server (stdio + HTTP mode)
├── index.ts                 # Entry point (stdio/HTTP mode switch)
├── tools.ts                 # 7 MCP tools: query, search, read_paragraphs, get_decision, get_law_context, get_stats, get_schema
├── db.ts                    # PostgreSQL queries, Typesense search, ILIKE fallback, gzip decompression
├── auth.ts                  # OAuth2 provider (PKCE, DCR)
└── http.ts                  # Express HTTP transport with pino-http logging

worker/                      # Rozporuj.com PDF generation worker (BullMQ)
├── index.ts                 # Worker entry point, job orchestration
├── generate-odpor.ts        # Claude API agentic loop + MCP tools → legal document
├── queue.ts                 # Queue name, job/result types, Redis connection
├── firebase.ts              # Firebase Storage download/upload
├── email.ts                 # SendGrid email delivery
└── pdf.ts                   # DOCX → PDF via LibreOffice headless

desktop-extension/           # Claude Desktop extension (.mcpb)
├── manifest.json            # MCPB manifest (7 tools, 12 prompts, user_config)
├── server/index.js          # Proxy MCP server + 12 legal prompts + knowledge tools
├── server/utils.js          # Prompts, DB schema hints, file utilities
└── build.sh                 # Build .mcpb package

.github/workflows/docker.yml # CI: build + push Docker images to GHCR
Dockerfile                   # Multi-stage: deps → app-base → mcp (slim) / worker / full (Playwright)
Dockerfile.worker            # Standalone worker Dockerfile (Railway doesn't support --target)
data/                        # SQLite databases (gitignored)
```

### Two-Phase Pipeline

Each scraper runs independently controllable phases:

1. **Discovery** — collect URLs/identifiers (sitemap parsing, search crawling, or API enumeration)
2. **Detail** — fetch and parse each item, store in SQLite

Phases coordinate via the shared `urls` table. URL statuses: `pending` → `scraped` | `failed` | `gone`.

### Shared Utilities

- **Adaptive rate limiter** — backs off on 429s (exponential up to 10x), recovers after 20 successes, ±30% jitter
- **Retry with backoff** — exponential backoff with configurable max retries
- **Progress tracker** — real-time ETA, rate/s, periodic reporting every 30s
- **Graceful shutdown** — SIGINT/SIGTERM handling with cleanup callbacks

### Storage

- **SQLite** with WAL mode, 64MB cache, `INSERT OR IGNORE`/`INSERT OR REPLACE` for idempotency
- **FTS5** full-text search indexes on local SQLite databases (via `pnpm run optimize:db`)
- **Typesense** full-text search on production (judikaty + esbirka), with ILIKE fallback for other sources
- Raw data (JSON-LD, API responses, specs) stored alongside parsed fields for reprocessing
- Safe to restart mid-run — no duplicates

## MCP Server

An MCP server exposes all scraped data for querying via tools.

```bash
pnpm mcp                  # stdio mode (Claude Code integration)
pnpm mcp:remote           # HTTP mode with OAuth (production)
```

### Production Deployment (Railway)

The MCP server runs on Railway at `https://garaaage-scrapers-production.up.railway.app`.

**Available sources:**

| Source | Records | Content |
|--------|---------|---------|
| judikaty | 685K | Czech court decisions (NS, ÚS, NSS, justice.cz) |
| esbirka | 8.8K | Czech laws (eSbírka zákonů) |
| autoline | 302K | Vehicle/machinery listings |
| mascus | 6.7K | Agricultural equipment listings |
| mobile-de | 58K | German vehicle listings |
| firmy-cz | 1.08M | Czech business directory |

**MCP Tools (7):**

| Tool | Purpose |
|------|---------|
| `query` | Raw SQL SELECT (100KB cap) |
| `search` | Typesense full-text search (judikaty/esbirka) + ILIKE fallback for others |
| `read_paragraphs` | Extract §§ from Czech laws |
| `get_decision` | Court decision by case number, ECLI, or file number |
| `get_law_context` | Law metadata, amendments, relationships |
| `get_stats` | Row counts per table |
| `get_schema` | CREATE TABLE/INDEX statements |

**Env vars (HTTP mode):**

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `TYPESENSE_URL` | Typesense URL (search falls back to ILIKE without it) |
| `TYPESENSE_API_KEY` | Typesense API key |
| `MCP_PORT` | Server port (default: 3002) |
| `MCP_ISSUER_URL` | OAuth issuer URL (e.g. `https://...up.railway.app`) |
| `MCP_SECRET` | OAuth approval secret |
| `REDIS_URL` | Redis for OAuth state persistence (optional) |
| `LOKI_URL` | Grafana Loki URL for log shipping (optional) |

### Benchmark Results

```
Auth + init:          558 ms (one-time)
Average latency:      354 ms
Fastest:               42 ms (tools/list)
Slowest:             4714 ms (ILIKE on esbirka full_text — use search tool instead)
Typesense search:     125 ms (multi-word, 6 words, judikaty)
```

Run: `MCP_URL=<url> MCP_SECRET=<secret> pnpm run benchmark:mcp`

## Key Canonical Docs

| Document | Purpose |
|----------|---------|
| [README.md](README.md) | Mixed-surface service identity, run/test surface, architecture, and production posture |
| [scripts/README.md](scripts/README.md) | Canonical detail for `generate:terms` workflow |
| [package.json](package.json) | Script surface and dependency definition |
| [mcp-server/index.ts](mcp-server/index.ts) | MCP runtime entrypoint |
| [worker/index.ts](worker/index.ts) | Worker runtime entrypoint |
| [Dockerfile](Dockerfile) | Container build/runtime variants |

## Known Gaps

- the README currently spans scrapers, MCP server, worker, and extension concerns in one document
- there is no short service-local changelog or current status artifact
- the extension concern described here is now partly historical because the standalone extension lives in [services/garaaage-extension](/Users/messingtomas/Taher/hozan-taher/services/garaaage-extension)

## Scripts

### generate:terms — Legal Document Generator

Two-phase AI pipeline for generating Czech Terms & Conditions:
1. **Research (Sonnet)** — queries MCP for legislation + court decisions
2. **Drafting (Opus)** — generates the document with streaming

```bash
pnpm run generate:terms                       # both phases
pnpm run generate:terms -- --phase=research   # research only (~$1.60)
pnpm run generate:terms -- --phase=draft      # draft from existing research (~$2)
```

Requires `.env` with `ANTHROPIC_API_KEY`, `MCP_URL`, `MCP_SECRET`, `OBSIDIAN_VAULT_PATH`. See `.env.example`.

Full documentation: [scripts/README.md](scripts/README.md)

### optimize:db — Local Database Optimizer

Creates FTS5 full-text search indexes, regular indexes, and runs ANALYZE on local SQLite databases in `data/`. (Production MCP server uses Typesense instead.)

```bash
pnpm run optimize:db
```

### benchmark:mcp — MCP Performance Test

End-to-end benchmark: OAuth, tools/list, various SQL queries, concurrent queries, cache test.

```bash
MCP_SECRET=<secret> pnpm run benchmark:mcp
```

## Claude Desktop Extension

The `desktop-extension/` directory contains a `.mcpb` package for Claude Desktop.

**Features:**
- 12 pre-configured legal prompts (T&C, privacy policy, NDA, purchase agreement, legal research, etc.)
- Knowledge folder support (.md, .pdf, .docx) with list/read tools
- Proxies 7 tools to the Railway MCP server via OAuth
- Authoritative DB schema hints to prevent column hallucination

**Install:** double-click `desktop-extension.mcpb` in Claude Desktop.

**Build:** `cd desktop-extension && ./build.sh`

Full documentation: [desktop-extension/README.md](desktop-extension/README.md)

## Rozporuj.com Worker

BullMQ worker that generates legal objection PDFs for [rozporuj.com](https://rozporuj.com). Deployed on Railway as a separate service.

**Job flow:** Download files from Firebase → Claude API agentic loop with MCP tools → Markdown → DOCX → PDF → Upload to Firebase → Email via SendGrid

**Features:**
- Claude Sonnet 4.6 agentic loop with 5 MCP tools (search, read_paragraphs, get_decision, get_law_context, query)
- Self-reflection review pass (Opus 4.6) for quality improvement
- Prompt caching for cost reduction (~90% savings on repeated system prompt)
- Concurrent-safe LibreOffice conversion with per-invocation profiles
- Conversation log saved to Firebase for diagnostics

**Env vars:**

| Variable | Description |
|----------|-------------|
| `REDIS_URL` | Redis connection (shared with rozporuj-com frontend) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `MCP_REMOTE_URL` | Railway MCP server URL |
| `MCP_REMOTE_SECRET` | OAuth secret for MCP |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Base64-encoded Firebase service account |
| `FIREBASE_STORAGE_BUCKET` | Firebase Storage bucket name |
| `SENDGRID_API_KEY` | SendGrid API key |

## Docker

Multi-stage Dockerfile with three targets:

| Target | Base | Size | Use case |
|--------|------|------|----------|
| `mcp` | node:22-bookworm-slim | ~420 MB | MCP server (no Playwright) |
| `worker` | node:22-bookworm-slim + LibreOffice | ~600 MB | Rozporuj.com PDF worker |
| `full` | playwright:v1.58.0-noble | ~1.3 GB | All scrapers + Playwright |

Note: Railway doesn't support `--target`, so the worker uses a standalone `Dockerfile.worker`.

```bash
# Build locally
docker build --target mcp -t garaaage-scrapers:mcp .

# Run MCP server with volume-mounted data
docker run -d \
  -v ./data:/app/data \
  -e MCP_PORT=3002 \
  -e MCP_ISSUER_URL=http://localhost:3000 \
  -e MCP_SECRET=<secret> \
  -p 3002:3002 \
  garaaage-scrapers:mcp

# Pull from GHCR
docker pull ghcr.io/danielkrul97/garaaage-scrapers:latest
```

### CI/CD

GitHub Actions (`.github/workflows/docker.yml`) builds and pushes both targets to GHCR on every push to `main`. Uses BuildKit layer caching.

### Data Volume

Databases (27 GB total) are not included in the Docker image. Options:
- **Volume mount** — `docker run -v ./data:/app/data`
- **Cloudflare R2** — set `R2_BUCKET_URL` env var, entrypoint downloads on first start

```bash
# Upload databases to R2
./scripts/upload-data.sh

# Download happens automatically in container if R2_BUCKET_URL is set
```

## Tech Stack

- **TypeScript** (ESM, strict mode, NodeNext resolution) via `tsx`
- **pnpm** package manager
- **PostgreSQL** (MCP server, Railway) + **better-sqlite3** (scrapers, local)
- **Typesense** — full-text search for judikaty + esbirka (typo-tolerant, fast)
- **Pino** + **pino-loki** + **pino-http** — structured logging → Grafana + Loki
- **Cheerio** — HTML parsing (autoline, mascus, firmy-cz)
- **Playwright** — headless Chrome (mobile.de)
- **fast-xml-parser** — XML sitemap parsing
- **@anthropic-ai/sdk** — Claude API (generate-terms, worker)
- **@modelcontextprotocol/sdk** — MCP server + extension
- **docx** — .docx document generation
- **BullMQ** + **ioredis** — job queue (worker)
- **Firebase Admin SDK** — file storage (worker)
- **@sendgrid/mail** — email delivery (worker)
- **Express** — MCP HTTP transport
- **zod** — runtime validation
- **vitest** — testing (473 tests)
- **eslint** + **prettier** — linting/formatting
- **Docker** + **GitHub Actions** — CI/CD to GHCR

## Development

```bash
npx tsc --noEmit          # Type-check
pnpm test                 # Run tests
pnpm test:coverage        # Run tests with coverage
pnpm lint                 # Lint
pnpm lint:fix             # Lint + auto-fix
pnpm run optimize:db      # Create FTS5 indexes on all databases
```
