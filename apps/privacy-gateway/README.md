# Privacy Gateway

Privacy-first email relay backend with alias management, content sanitization, and operator tooling. Go stdlib only, single binary.

## Quick Start

```bash
export LISTEN_ADDR=:8080
export ALIAS_DOMAIN=relay.local
export DATA_DIR=./data
export DELIVERY_MODE=record-only
export DEV_API_TOKEN=dev-token
export DEV_USER_ID=operator
export DEV_TENANT_ID=tenant-dev
export DEV_USER_EMAIL=operator@relay.local

go run ./cmd/privacy-gateway/
```

```bash
# Create alias
curl -X POST http://localhost:8080/v1/aliases \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"label":"testuser"}'

# Create submission
curl -X POST http://localhost:8080/v1/submissions \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"channel_id":"al_xxx","to":["recipient@example.com"],"subject":"Hello","text_body":"Test"}'

# Relay submission
curl -X POST http://localhost:8080/v1/submissions/sub_xxx/relay \
  -H "Authorization: Bearer dev-token"
```

## Features

- Alias creation with random suffix and configurable domain
- Content and header sanitization (strip client fingerprints)
- Outbound relay: record-only and SMTP modes
- IMAP inbound sync with incremental cursoring
- Identity vault with AES-256-GCM encryption at rest
- Operator dashboard, channel/submission/inbox timelines
- Local `/ui` shell for operator and intake read models, timelines, detail loaders, queue actions, native relay actions, and saved local filters
- Intake endpoint for anti-trace-relay bridge
- Activity-driven retention pruning
- Attachment metadata extraction with policy handling
- Audit trail with tenant-scoped filtering

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /ui | Local operator shell |
| GET | /healthz | Health check |
| GET | /v1/dashboard | Operator overview with problem/recent views and filters |
| GET/POST | /v1/aliases | List/create aliases |
| GET | /v1/aliases/{id} | Alias timeline |
| GET | /v1/channels | Channel summaries |
| GET | /v1/submissions | List submissions |
| GET | /v1/submissions/{id} | Submission detail |
| GET | /v1/submissions/{id}/timeline | Submission timeline |
| POST | /v1/submissions/{id}/relay | Relay one submission through the native path |
| POST | /v1/messages | Send outbound message (`legacy compat`) |
| GET | /v1/messages/outbox | Sent messages (`legacy compat`) |
| GET | /v1/messages/inbox | Received messages |
| POST | /v1/messages/inbox/sync | Trigger IMAP sync |
| GET | /v1/audit-events | Audit trail |
| GET/POST/DELETE | /v1/identity-links | Identity mappings |
| GET | /v1/relay-attempts | Relay attempt history |
| GET | /v1/relay-queue | Pending relay queue |
| POST | /v1/intake/submissions | Intake endpoint (separate auth) |
| GET | /v1/intake/dashboard | Intake operator overview with filters |
| GET | /v1/intake/queue | Intake queue candidates with filters |
| GET | /v1/intake/submissions/{id} | Intake-owned submission detail |
| POST | /v1/intake/submissions/{id}/queue | Intake-owned queue action |
| POST | /v1/intake/submissions/{id}/release | Intake-owned release action |
| POST | /v1/intake/submissions/{id}/relay | Intake-owned native relay action |
| GET | /v1/intake/submissions/{id}/timeline | Intake-owned submission timeline |
| GET | /v1/intake/status | Intake aggregate stats |
| GET | /v1/intake/timeline | Intake submission history with filters/summary |

## Delivery Modes

| Mode | Description |
|------|-------------|
| `record-only` | Store submissions, no outbound (safe for dev) |
| `smtp` | Real SMTP delivery through configured relay |

## Docker

```bash
docker build -t privacy-gateway:0.1.0 .
docker run -v ./data:/app/data --env-file .env -p 8080:8080 privacy-gateway:0.1.0
```

## Documentation

### Canonical SpecKit Surface

Use these as the active truth for the service:

- preferred outbound product path is `POST /v1/submissions` followed by `POST /v1/submissions/{id}/relay`
- `/v1/messages` remains supported only as a legacy compatibility bridge per ADR-003

- [README.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/README.md)
  - service purpose, run/test entrypoint, and canonical doc map
- [MVP.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP.md)
  - product boundary and intended MVP scope
- [POC-BACKLOG.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/POC-BACKLOG.md)
  - explicit experiment and uncertainty backlog
- [API-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/API-CONTRACT-FREEZE.md)
  - current public HTTP contract
- [docs/ADR-002-store-and-forward-release-policy.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-002-store-and-forward-release-policy.md)
  - accepted decision for queue and release semantics
- [docs/ADR-003-compat-layer-retirement.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-003-compat-layer-retirement.md)
  - accepted decision for legacy `/v1/messages` retirement path
- [docs/ADR-004-release-candidate-decision-boundary.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-004-release-candidate-decision-boundary.md)
  - accepted decision for first RC `GO / NO-GO` boundary
- [docs/ADR-005-persistence-model.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-005-persistence-model.md)
  - accepted decision for persistence evolution and migration triggers
- [docs/ADR-006-secret-management.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-006-secret-management.md)
  - accepted decision for secret management evolution and migration triggers
- [docs/ADR-INDEX.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-INDEX.md)
  - navigation map for accepted architecture decisions
- [OPERATOR-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-GUIDE.md)
  - deployment and runtime operations
- [CHANGELOG.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/CHANGELOG.md)
  - release history

Interpretation rule:

- if a sprint/status/release support document disagrees with one of the files above, reconcile toward the canonical surface instead of creating another document

### Reference Surface

These remain useful, but they are not the first source of current truth:

- [SPECKIT-DOC-MAP.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/SPECKIT-DOC-MAP.md)
- [RELEASE-ARTIFACT-INDEX.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RELEASE-ARTIFACT-INDEX.md)
- [CURRENT-STATUS.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/CURRENT-STATUS.md)
- [RELEASE-TRACK-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RELEASE-TRACK-MEMO.md)
- [VERIFICATION-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/VERIFICATION-GUIDE.md)
- [POC-BACKLOG.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/POC-BACKLOG.md)
- live verification plans, drafts, and report templates
- operator cookbooks and supporting notes

Use the reference surface for:

- navigation
- document classification during recovery
- reporting
- verification support
- operator convenience

Do not treat it as the primary definition of product scope or contract.

### Key Canonical Docs

| Document | Purpose |
|----------|---------|
| [MVP.md](MVP.md) | Product frame and MVP scope |
| [POC-BACKLOG.md](POC-BACKLOG.md) | Open uncertainty and experiment backlog |
| [OPERATOR-GUIDE.md](OPERATOR-GUIDE.md) | Deployment and configuration |
| [API-CONTRACT-FREEZE.md](API-CONTRACT-FREEZE.md) | Frozen HTTP contract |
| [docs/ADR-002-store-and-forward-release-policy.md](docs/ADR-002-store-and-forward-release-policy.md) | Queue/release lifecycle decision |
| [docs/ADR-003-compat-layer-retirement.md](docs/ADR-003-compat-layer-retirement.md) | Legacy compat retirement decision |
| [docs/ADR-004-release-candidate-decision-boundary.md](docs/ADR-004-release-candidate-decision-boundary.md) | RC `GO / NO-GO` decision rule |
| [docs/ADR-005-persistence-model.md](docs/ADR-005-persistence-model.md) | Persistence model and migration triggers |
| [docs/ADR-006-secret-management.md](docs/ADR-006-secret-management.md) | Secret management model and migration triggers |
| [docs/ADR-INDEX.md](docs/ADR-INDEX.md) | ADR navigation map |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [DEPLOYMENT-MODES.md](DEPLOYMENT-MODES.md) | Runtime mode reference |
| [RELEASE-ARTIFACT-INDEX.md](RELEASE-ARTIFACT-INDEX.md) | Reference index, not primary truth |

## Testing

```bash
go test ./... -race
```

One-command local stability check (from `services/privacy-gateway`):

```bash
./scripts/run-local-stability-check.sh
./scripts/run-local-stability-check.sh --strict-rc
./scripts/run-local-stability-check.sh --use-cache
```

16 packages, full coverage. SMTP delivery verified against MailHog.

## Fastmail Local Verification Shortcut

For assisted live verification flow (env preflight + start + operator pause + postcheck + stop):

```bash
./scripts/fastmail-live-assist.sh ./.env.fastmail.local
```
