# machinery-outreach — deploy procedure

> Captures the working Railway config after the 2026-04-27 deploy debugging
> chain. Use this when the service won't deploy cleanly OR when adding a new
> environment.

## Service config (Railway dashboard or GraphQL)

| Setting | Value | Why |
|---|---|---|
| Project | `garaaage-mcp` | shared project |
| Environment | `production` | only one |
| Service name | `machinery-outreach` | Go orchestrator |
| Builder | `RAILPACK` (auto) | Railway picks Dockerfile when present |
| Root Directory | `/` (repo root) | needed because Dockerfile COPYs services/* |
| Railway Config File | `features/inbound/orchestrator/railway.toml` | per-service overrides |

To set rootDirectory + railwayConfigFile via GraphQL (CLI doesn't expose them):

```bash
TOKEN=$(cat ~/.railway/config.json | python3 -c "import json,sys; print(json.load(sys.stdin)['user']['accessToken'])")
SVC_ID="7f0aac34-e229-4f42-b65d-eac56507f833"
ENV_ID="8928c792-6e8f-4039-add5-cbea8dcd2412"

curl -s -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { serviceInstanceUpdate(serviceId: \\\"$SVC_ID\\\", environmentId: \\\"$ENV_ID\\\", input: { rootDirectory: \\\"/\\\", railwayConfigFile: \\\"features/inbound/orchestrator/railway.toml\\\" }) }\"}"
```

## features/inbound/orchestrator/railway.toml

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "features/inbound/orchestrator/Dockerfile"

[deploy]
# Migrations run via scripts/migrations/run.sh OUTSIDE the binary.
# Binary serves HTTP only — no in-process migrate at boot.
startCommand = "/app/outreach server"
healthcheckPath = "/healthz"
healthcheckTimeout = 300
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

## features/inbound/orchestrator/Dockerfile

Multi-stage build with **all 8 workspace modules** copied — go build resolves
go.work which lists `use ./services/...` for every module, so missing any one
breaks the build:

```dockerfile
# Builder stage
FROM golang:1.25-alpine AS builder
RUN apk add --no-cache ca-certificates git
WORKDIR /workspace

COPY go.work go.work.sum* ./

# All 8 workspace modules
COPY features/inbound/orchestrator/   features/inbound/orchestrator/
COPY features/outreach/campaigns/      features/outreach/campaigns/
COPY features/platform/common/         features/platform/common/
COPY features/outreach/relay/          features/outreach/relay/
COPY features/compliance/privacy-gateway/ features/compliance/privacy-gateway/
COPY features/outreach/mailboxes/      features/outreach/mailboxes/
COPY features/acquisition/contacts/       features/acquisition/contacts/
COPY features/inbound/inbox/          features/inbound/inbox/

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" \
    -o /outreach \
    ./features/inbound/orchestrator/cmd/outreach/

# Runtime stage
FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -g 10001 -S outreach && adduser -u 10001 -S outreach -G outreach -h /app -s /sbin/nologin
WORKDIR /app
COPY --from=builder /outreach /app/outreach
# Email templates from modules/outreach/configs/ — runner reads from filesystem at /app/configs/templates/
COPY modules/outreach/configs/ /app/configs/
RUN chown -R outreach:outreach /app
USER outreach
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -q --spider http://localhost:${PORT:-8080}/healthz || exit 1
```

## Required env vars

Set on machinery-outreach service:

| Env | Value | Purpose |
|---|---|---|
| `DATABASE_URL` | postgres internal URL | Railway internal DNS |
| `OUTREACH_API_KEY` | shared key | dashboard auth |
| `ANTI_TRACE_RELAY_URL` | http://anti-trace-relay.railway.internal:8080 | sender → relay |
| `ANTI_TRACE_RELAY_TOKEN` | actor token from relay env `ANTI_TRACE_TOKEN` | bearer auth |
| `TEMPLATES_DIR` | /app/configs/templates | optional override |
| `SENDING_WINDOW_START` | 8 | Mon-Fri 08:00 |
| `SENDING_WINDOW_END` | 17 | sends stop at 16:59 |
| `MAILBOX_N_*` | per mailbox | from_address, smtp/imap host/port, password (NOTE: memory rule says DB only — these env entries are legacy + will be removed per S5 rotation) |
| `OUTREACH_DASHBOARD_URL` | UNSET | watchdog auto-swap requires real BFF — leave unset until BFF deployed |
| `SENTRY_DSN_GO` | optional | Sentry release tag built from GIT_SHA |

## Common boot failures + fixes

### 1. Healthcheck timeout, no slog output

Symptom: container starts, "BOOT_START" prints, then nothing for 5 minutes,
healthcheck fails.

Cause (fixed in commit 2cc15dd 2026-04-27): `slog.SetDefault` wrapping
`slog.Default().Handler()` deadlocks because std `log` package re-routes
through slog under SetDefault, creating recursive Logger.output mutex
contention.

Fix: pass `slog.NewJSONHandler(os.Stderr, nil)` as inner handler.

### 2. "features/platform/common: not found" during build

Symptom: `failed to compute cache key: failed to calculate checksum of ref X: "/features/platform/common": not found`

Cause: rootDirectory is `modules/outreach` (or a subdirectory), so COPY
features/platform/common steps see services outside build context.

Fix: rootDirectory=/ via GraphQL mutation above.

### 3. "Dockerfile `/Dockerfile` does not exist"

Cause: rootDirectory is `/` but railway.toml's `dockerfilePath` is
`Dockerfile` (relative — falls back to `/Dockerfile`).

Fix: set `dockerfilePath = "features/inbound/orchestrator/Dockerfile"` (absolute path
from rootDir).

### 4. Migrate hangs on missing /app/internal/db/migrations

Cause: legacy startCommand was `outreach migrate; outreach server`. The
`migrate` step expected a directory that doesn't exist in the new image.

Fix (commit 4d43510): drop in-process migrate. Run `scripts/migrations/run.sh`
externally if schema changes are needed. Binary just serves HTTP.

### 5. `cannot load module features/outreach/relay listed in go.work file`

Cause: only some workspace modules COPYd. Go workspace requires every `use`
path resolvable.

Fix (commit b07b860): COPY all 8 modules.

## Deploy procedure

```bash
# 1. Push to main (Railway auto-deploys)
git push origin main

# 2. Or force redeploy without code change
railway service machinery-outreach
railway redeploy --yes

# 3. Or upload from local repo (overrides git source)
railway up --detach --ci --service machinery-outreach

# 4. Watch deploy status
railway deployment list --json | jq -r '.[0:3][] | "\(.createdAt)  \(.status)  \(.id[0:8])"'

# 5. Check health post-deploy
curl -s -H "X-API-Key: $OUTREACH_API_KEY" \
     "https://machinery-outreach-production.up.railway.app/health" | jq

# 6. Tail logs
railway logs | tail -50
```

## Post-deploy verification

| Check | Expected |
|---|---|
| `/health` | status=ok, db=ok |
| `/healthz` | 200 (no auth) |
| Daemons | campaign_daemon, imap_poll, intel_loop in /health |
| Templates | `railway ssh ls /app/configs/templates/` shows intro_machinery.tmpl, followup_1.tmpl, followup_2.tmpl |
| First scheduler tick | `railway logs | grep "scheduler: campaign done"` |

## Last-known-good state (2026-04-27 evening)

- Commit on main: `cc6072c` (self-send guard + Schema A/B graceful)
- Railway deploy ID: `a6dcb4e2`
- Templates v35 baked, slog deadlock fixed, all 8 modules COPYd
