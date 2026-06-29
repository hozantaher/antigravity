# Dev Setup — Hozan Taher

Od fresh clone po running stack v ~15 minut. Pro per-service detaily descend do
`services/<name>/CLAUDE.md` (každá Go služba má jeden) a
`features/platform/outreach-dashboard/CLAUDE.md`.

## Předpoklady

- Go 1.25+ (Go workspace; viz `go.work`)
- Node 22+, pnpm 10+
- Docker + Docker Compose
- gh CLI (volitelné — pro PR + issue ops)

Ověření:

```bash
go version          # go1.25.x
node -v             # v22.x
pnpm -v             # 10.x
docker info         # running
```

## 1. Clone + závislosti

```bash
git clone https://github.com/messingdev/hozan-taher.git
cd hozan-taher

# Node workspace
pnpm install

# Go workspace (8 modulů — viz go.work)
go work sync
```

## 2. Env soubory

Pro minimální dev stack (dashboard + orchestrator) stačí dva soubory:

```bash
cp infra/docker/.env.example             infra/docker/.env
cp features/platform/outreach-dashboard/.env.example  features/platform/outreach-dashboard/.env.local
```

Pro každou další službu, kterou spouštíš, je `.env.example` vedle source kódu
(`features/outreach/relay/`, `features/compliance/privacy-gateway/`, `features/platform/mcp/`,
`features/platform/worker/`, `features/acquisition/scrapers/`, `features/outreach/mailboxes/`,
`features/acquisition/contacts/`, `features/inbound/inbox/`). Knihovny (`mailboxes`/`contacts`/`inbox`
nemají vlastní binárku) potřebují env jen pro testy.

Klíčové hodnoty, které musíš sjednotit napříč službami:

- `OUTREACH_API_KEY` — stejná hodnota v `infra/docker/.env`,
  `features/platform/outreach-dashboard/.env.local` a v env orchestratoru.
  BFF ji předává jako `X-API-Key` při proxy do Go.
- Ostatní dev defaulty fungují as-is.

## 3. Start infra (Docker)

Lokální infra: outreach-db (Postgres :5433), firmy-db (Postgres :5434),
redis, mailpit (catch-all SMTP :1025 + UI :8025), greenmail (test SMTP+IMAP).

```bash
docker compose -f infra/docker/docker-compose.yml up -d \
  outreach-db firmy-db redis mailpit greenmail

# Health
docker compose -f infra/docker/docker-compose.yml ps
```

Plný stack (privacy-gateway + anti-trace-relay + mcp + worker + parsedmarc) je
zatím orchestrován per-service v Railway; lokálně spouštěj selektivně.

## 4. Migrace (orchestrator DB)

Migrations žijí v `scripts/migrations/`. Spouštěj přes runner (BF-G3):

```bash
export DATABASE_URL=postgres://outreach:outreach@localhost:5433/outreach?sslmode=disable
bash scripts/migrations/run.sh --dry-run    # plán
bash scripts/migrations/run.sh              # aplikuj pending v pořadí
```

Runner odmítne aplikovat migraci pokud chybí předchůdce (exit 3) nebo
detekuje drift v už aplikované migraci (exit 4). Plný popis:
`docs/playbooks/migration-rollout-plan.md`.

## 5. Start služeb

Spusť každou v separátním terminálu (jen ty, co potřebuješ):

```bash
# Outreach orchestrator (port :8080) — Go
cd features/inbound/orchestrator
go run ./cmd/outreach server

# Dashboard — Vite :18175 + Express BFF :3100
cd features/platform/outreach-dashboard
pnpm dev

# Privacy gateway — Go (port :8080 v dockeru, lokálně viz .env)
cd features/compliance/privacy-gateway
go run ./cmd/privacy-gateway

# Anti-trace relay — Go (port :8090)
cd features/outreach/relay
go run ./cmd/relay

# MCP server (HTTP :3002) — TS
cd features/platform/mcp
pnpm mcp:remote

# PDF worker — TS (BullMQ consumer)
cd features/platform/worker
pnpm start

# Scrapers — TS (CLI per scraper)
cd features/acquisition/scrapers
pnpm run scrape:firmy-cz -- --phase=all
```

## 6. Ověření

| URL | Co | Očekáváno |
|---|---|---|
| http://localhost:18175 | Dashboard (Vite) | UI |
| http://localhost:3100/api/health/system | BFF system health | JSON s `egress_mode`, `proxy_pool_size`, `alerts` |
| http://localhost:8080/healthz | Orchestrator (no auth) | `{"status":"ok"}` |
| http://localhost:8025 | Mailpit catch-all | Web UI |
| http://localhost:3002 | MCP server | health OK |

## Branch model (3 worktree)

Plný popis: `CLAUDE.md` § "Branch model + 3-worktree workflow".

| Branch | Účel | Push |
|---|---|---|
| `main` | Stable, production | jen PR (drobné doc-pointer edits přes `.githooks/pre-push` exception) |
| `wm/development` | Feature kód + happy-path unit | volný push |
| `wm/tests` | E2E, integration, kontrakt, property/fuzz | volný push |

Feature branche cílí na `main` přes PR — ne přímý push.

## Git hooky

Repo používá `.githooks/` (pre-commit + pre-push). Aktivace po clonu:

```bash
git config core.hooksPath .githooks
```

`pre-commit` blokuje přidání SMTP/IMAP hostů a mail portů (`:25/465/587/993/143`)
mimo `features/outreach/relay/` a `features/compliance/privacy-gateway/` — viz hard rule
`feedback_no_direct_smtp` (zabránit direct egress z hlavní app).

Self-test:

```bash
bash .githooks/pre-commit.test.sh
```

Legitimní výjimka (auditovaná):

```bash
SKIP_EGRESS_GUARD=1 EGRESS_GUARD_REASON="proč" git commit ...
```

## Testy

Plný popis: `README.md` § "Running tests".

```bash
bash scripts/test-all.sh                  # všechno (Go + JS/TS + audit + smoke)
bash scripts/test-all.sh --filter=go      # jen Go suites
bash scripts/test-all.sh --skip-smoke     # bez smoke (need live env)

# Per-area shortcuts
go test ./services/...                                  # všechny Go suite
cd features/platform/outreach-dashboard && pnpm test                 # full scope
cd features/platform/outreach-dashboard && pnpm test:fast            # narrow scope
cd features/platform/outreach-dashboard && pnpm test:contract        # BFF contract
cd features/platform/outreach-dashboard && pnpm test:integration     # pg-mem
cd features/platform/outreach-dashboard && pnpm e2e                  # Playwright
```

## Testing against Mail Lab

Místo prod Seznamu/Gmailu vyvíjíme proti **Mail Labu** — sealed lokální stack co se chová 1:1 jako reálný mail provider (Postfix + Dovecot + Rspamd + OpenDKIM, vlastní DNS resolver, Roundcube webmail).

Plný runbook: [`docs/playbooks/mail-lab-quickstart.md`](playbooks/mail-lab-quickstart.md).
Iniciativa: [`docs/initiatives/2026-04-29-mail-lab.md`](initiatives/2026-04-29-mail-lab.md).

### Quick start

```bash
# 1. Bootstrapni Mail Lab (poprvé pull image ~500MB, pak <2 min)
bash scripts/mail-lab/up.sh

# 2. Dashboard → lab profile (BFF :3100, orchestrator :8080)
cd features/platform/outreach-dashboard
cp .env.lab.example .env.local
pnpm dev          # Vite :18175
```

Endpointy po `up.sh`:

| URL | Co | Test creds |
|---|---|---|
| http://localhost:18175 | Dashboard (Vite) | — |
| http://localhost:28080 | Roundcube webmail | `operator@seznam.lab` / `lab-demo-only` |
| http://localhost:8090/healthz | mail-lab-api REST | `X-Lab-Api-Key: lab-demo-only` |
| `localhost:25025` | SMTP plain | — |
| `localhost:25587` | SMTP submission | `operator@seznam.lab` / `lab-demo-only` |
| `localhost:25143` | IMAP | `prospect[1-5]@seznam.lab` / `lab-demo-only` |

### Workflow diagram

```
operator (browser)
    │
    ▼ http://localhost:18175
┌────────────────┐
│ Vite dev :18175│  React + Zustand
└───────┬────────┘
        │ /api/* proxy
        ▼ http://localhost:3100
┌────────────────┐
│ Express BFF    │  X-API-Key auth, lab profile
└───────┬────────┘
        │ /health, /campaigns, /api/v1/*
        ▼ http://localhost:8080
┌────────────────┐
│ Go orchestrator│  outreach binary, ./cmd/outreach server
└───┬────────┬───┘
    │ SMTP   │ IMAP
    ▼        ▼
mx.seznam.lab (10.20.0.10) ← lab DNS resolver (10.20.0.2)
    │
    └─→ Roundcube (10.20.0.20) — operator inspect mail visually
```

### Mail Lab vs prod — kdy co

| | **Mail Lab (vždy v dev)** | **Prod (jen synthetic monitoring)** |
|---|---|---|
| Endpoint | seznam.lab / gmail.lab / outlook.lab | seznam.cz / gmail.com / outlook.com |
| Acceptance pravidla | Per-profile (rate, quota, bounce simulator) | Real-world reputation system |
| DKIM keys | Test-only v repo | Per-tenant secret v Railway |
| Egress | Sealed (DNS resolver SERVFAIL pro non-lab) | Real internet |
| Kdy ano | Daily dev, debug, repro bug, contract testy | Post-deploy validation, alerting |

### Common workflows

**Pošli test mail:**

```bash
swaks --to prospect1@seznam.lab \
      --from operator@seznam.lab \
      --auth LOGIN \
      --auth-user operator@seznam.lab \
      --auth-password lab-demo-only \
      --server localhost:25587 \
      --header 'Subject: Hello from lab'
# → otevři http://localhost:28080 → login prospect1 → vidíš mail
```

**Vytvoř novou schránku přes admin API:**

```bash
curl -X POST http://localhost:8090/v1/mailbox \
  -H "X-Lab-Api-Key: lab-demo-only" \
  -H "Content-Type: application/json" \
  -d '{"address":"alice@seznam.lab","password":"hunter2"}'
```

**Reset state:**

```bash
bash scripts/mail-lab/down.sh --clean   # wipe všechny lab volumes
bash scripts/mail-lab/up.sh             # fresh seed (postmaster + 5 prospects)
```

## Troubleshooting

**Dashboard 503 — Database not available:** zkontroluj
`features/platform/outreach-dashboard/.env.local` — `GO_SERVER_URL` musí ukazovat na
běžící orchestrator a `OUTREACH_API_KEY` musí matchovat orchestrator env.

**`go run ./cmd/outreach server` selhává s `connection refused`:**
`outreach-db` kontejner není zdravý nebo `DB_SSL_MODE` špatně. Pro dev je
default `disable`; v prod `require`. Ověř `docker compose ps`.

**4 testy v modules/outreach/internal/llm padají:**
Normální — vyžadují běžící Ollama. Skip přes `go test -run TestXxx ./...` nebo nastav `OLLAMA_URL`.

**Mail Lab — `wait-healthy timeout`:**
První pull stahuje ~500MB image; při slabém netu může 5min timeout dorazit. Re-run obvykle pomůže (image už cached). Plný runbook v `docs/playbooks/mail-lab-quickstart.md`.

**Mail Lab — port 28080 connection refused:**
Roundcube ještě nestartoval. Po `bash scripts/mail-lab/up.sh` čekej 60-90s na healthy. Verifikuj `docker compose -f infra/docker/mail-lab.yml ps`.

**Mail Lab — `seznam.lab` nelze resolvit z hosta:**
Mail Lab DNS běží na docker bridge (10.20.0.2) — z host shell nedosažitelný. Buď připoj přes lab kontejner (`docker exec mail-lab-dns drill ...`), nebo přidej `127.0.0.1 mx.seznam.lab` do `/etc/hosts` pro host přístup.
