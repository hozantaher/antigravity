# PORTS — canonical local-dev port map

**Status:** active
**Last review:** 2026-04-22

Všechny hozan-taher **application** procesy používají port range `18xxx`.
Tool procesy (Postgres, Redis, Mailpit) běží na standardních portech —
user si může upravit v docker-compose pokud koliduje se systémovým
instaním.

Range `18xxx` byla vybraná protože:
- Unused by common developer tools (Vite=5173, Next.js=3000, React=3000, Rails=3000)
- Snadno zapamatovatelné pattern `18<old-port>` (18175=was 5175, 18001=was 3001)
- `1024-49151` je registered range — žádný OS-reserved clash

## Hozan application ports (18xxx)

| Port | Aplikace | Kdo | Poznámky |
|---|---|---|---|
| **18175** | outreach-dashboard Vite dev server | `features/platform/outreach-dashboard` | `pnpm dev` |
| **18001** | outreach-dashboard BFF (Express) | `features/platform/outreach-dashboard/server.js` | proxied via Vite |
| **18002** | machinery-outreach Go (lokální bootstrap, pokud spustíš) | `modules/outreach/cmd/outreach` | prod je Railway-only |
| **18090** | relay lokální | `features/outreach/relay/cmd/relay` | |
| **18091** | privacy-gateway lokální | `features/compliance/privacy-gateway` | |
| **18003** | MCP HTTP (pokud HTTP mode) | `features/platform/mcp/mcp-server` | |
| **18004** | worker admin/health (future) | `features/platform/worker` | |

## Tool ports (standard, lze override v docker-compose)

| Port | Tool | Konflikt? |
|---|---|---|
| **5433** | Postgres outreach (local) | Kolize s systemovým Postgres 5432 vyřešená +1 |
| **5434** | Postgres firmy (local) | |
| **6379** | Redis | Pokud už user má Redis, override na 6380 |
| **1025** | Mailpit SMTP | |
| **1143** | Mailpit IMAP | |

## CORS allowlist

BFF `CORS_ORIGIN` default = `http://localhost:18175` (Vite dev). Přidat
production URL via env var (comma-separated).

## Když port koliduje s jinou app

1. Zjistit viníka: `lsof -iTCP:<port> -sTCP:LISTEN`
2. Zabít pokud bezpečné, nebo override port pro hozan:
   ```
   PORT=18501 pnpm --filter outreach-dashboard dev
   ```
3. Pokud trvalý konflikt → zvolit port uvnitř `18xxx` a updatovat tento dokument + všechny refs.

## Railway prod (DNS-only, žádný local konflikt)

Prod services jsou accessible pouze přes `*.railway.app` URL. Žádné
local-port dependencies.

| Service | Railway public URL |
|---|---|
| anti-trace-relay (repo: features/outreach/relay/) | https://anti-trace-relay-production-a706.up.railway.app |
| machinery-outreach | https://machinery-outreach-production.up.railway.app |
| outreach-dashboard | https://outreach-dashboard-production-e4ce.up.railway.app |

Railway interní DNS (service-to-service) používá `*.railway.internal` —
Railway managed, neaplikuje se na local-dev ports.

## Seznam ports v kódu / configu (zdroje, které MUSÍ match této tabulce)

1. `features/platform/outreach-dashboard/vite.config.js` — `server.port` + `proxy.target`
2. `features/platform/outreach-dashboard/package.json` — `"dev"` + `"dev:full"` scripts
3. `features/platform/outreach-dashboard/server.js` — `PORT` env default
4. `features/platform/outreach-dashboard/.env` / `.env.example` — `CORS_ORIGIN`, `PORT`
5. `features/outreach/relay/.env.example` — `PORT=18090`
6. `scripts/test-dashboard.sh` — smoke test
7. E2E Playwright configs — baseURL

Při update portu: grep + update všech míst najednou. Tabulka nahoře je
zdroj pravdy; kód se na ní musí approximate.

## Historie změn

- **2026-04-22:** Initial definition. Moved hozan app ports from
  `3001/5175/8090/8091` → `18xxx` range po konfliktu s user-machine
  `5173`. Tool ports (Postgres/Redis/Mailpit) zůstaly na standardu.
