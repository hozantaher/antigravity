# Hozan Taher

Platform monorepo: privacy systems, outreach pipelines, browser tooling, and AI-assisted workflow infrastructure.

## What This Repo Is

Top-level layout:

- `apps/` — user-facing applications (dashboard, browser extension)
- `modules/` — business-logic modules (outreach Go pipeline)
- `services/` — deployable services (privacy-gateway, anti-trace-relay, mcp, worker, scrapers)
- `packages/` — reserved for shared libraries
- `infra/` — docker compose stack, macOS sandbox POC
- `specs/`, `tasks/`, `scripts/`, `docs/` — planning, governance, tooling

Use this file as the root map, not as deep product documentation.

## Canonical Root Documents

- [README.md](./README.md)
- [AGENTS.md](./AGENTS.md)
- [CLAUDE.md](./CLAUDE.md)
- [docs/development-plan.md](./docs/development-plan.md)
- [docs/superplan.md](./docs/superplan.md)
- [docs/playbooks/MVP-ADR-POC-RULES.md](./docs/playbooks/MVP-ADR-POC-RULES.md)
- [docs/playbooks/routing-playbook.md](./docs/playbooks/routing-playbook.md)
- [.specify/memory/constitution.md](./.specify/memory/constitution.md)
- [docs/initiatives/2026-04-22-discipline-and-domain-migration.md](./docs/initiatives/2026-04-22-discipline-and-domain-migration.md)
- [docs/recovery/SPECKIT-RECOVERY-PLAN.md](./docs/recovery/SPECKIT-RECOVERY-PLAN.md)
- [docs/recovery/SPECKIT-RECOVERY-STATUS.md](./docs/recovery/SPECKIT-RECOVERY-STATUS.md)
- [docs/recovery/SPECKIT-RECOVERY-MEMO.md](./docs/recovery/SPECKIT-RECOVERY-MEMO.md)

For implementation, always descend into the target app/module/service after reading the root map.

## Services, Modules, Apps

### Privacy + Relay

- [features/compliance/privacy-gateway](./features/compliance/privacy-gateway)
  Privacy-first email relay backend with submissions, audit, identity links, inbox/outbox, timelines, dashboard, and operator tooling.
  Canonical docs:
  [README.md](./features/compliance/privacy-gateway/README.md),
  [API-CONTRACT-FREEZE.md](./features/compliance/privacy-gateway/API-CONTRACT-FREEZE.md),
  [OPERATOR-GUIDE.md](./features/compliance/privacy-gateway/OPERATOR-GUIDE.md)

- [features/outreach/anti-trace-relay](./features/outreach/anti-trace-relay)
  Anti-trace relay and amnesic submit flow with privacy hardening and deployment material.
  Canonical docs:
  [README.md](./features/outreach/anti-trace-relay/README.md),
  [ADR.md](./features/outreach/anti-trace-relay/ADR.md),
  [DEPLOYMENT.md](./features/outreach/anti-trace-relay/DEPLOYMENT.md)
  Current note:
  local `go test ./...` verification now passes; socket-binding HTTP E2E remains opt-in.

### Outreach + Enrichment

- [modules/outreach](./modules/outreach)
  Go-based outreach system and related runtime logic.
  Current note: canonical README now exists and local test verification now passes; live DNS/MX validation was moved into opt-in integration coverage.

- [features/platform/outreach-dashboard](./features/platform/outreach-dashboard)
  React 19 + Vite 6 dashboard for outreach/operator-facing workflows.
  Current note: canonical README now exists; unit test surface was verified locally in stabilization.

- [features/acquisition/scrapers](./features/acquisition/scrapers)
  Scraping and enrichment-oriented service set.
  Current note: README exists and local test verification now passed in this workspace.

- [features/platform/worker](./features/platform/worker)
  Worker/runtime support for processing pipelines.
  Current note: canonical README now exists; test suite was verified locally in stabilization.

### Tooling + Integration

- [features/platform/mcp](./features/platform/mcp)
  MCP/server-side integration tooling.
  Current note: canonical README now exists; test suite needs a bind-permissive environment for HTTP/E2E verification.

- [apps/extension](./apps/extension)
  Browser extension and companion server assets.
  Current note: README exists, the server-side test command is explicit, and local test verification now passed in this workspace.

## How To Work In This Repo

1. identify the target app/module/service
2. open that surface's local README or primary ADR/contract
3. confirm current sprint/status docs are still true enough
4. make scoped changes
5. update only the nearest canonical docs needed

Do not treat root docs as the place for every product detail.

## Project Structure

```text
hozan-taher/
  apps/                    # User-facing applications (dashboard, extension)
  modules/                 # Business-logic modules (outreach)
  services/                # Deployable services (privacy-gateway, anti-trace-relay, mcp, worker, scrapers)
  packages/                # Shared libraries (reserved)
  infra/                   # Docker compose, sandbox POC
  specs/                   # Spec Kit feature artifacts
  tasks/                   # Task files per surface
  scripts/                 # Repo-wide tooling
  docs/                    # Playbooks, architecture, recovery
  .specify/                # Constitution and Specify assets
  .github/                 # CI workflows
  .claude/                 # Launch configs, project-local skills
  README.md                # Root navigation
  AGENTS.md                # Monorepo working rules
  CLAUDE.md                # AI working rules
```

## Documentation Rules

- Root docs explain repo shape and governance.
- Service/module/app docs explain product behavior and operations.
- ADRs capture durable architectural choices.
- POCs reduce uncertainty before it becomes durable product truth.
- Sprint/status docs summarize execution state, but should not redefine the repo.

If two docs disagree, reconcile them instead of adding a third doc.

## MVP / ADR / POC Rule

Before meaningful new work, classify it as one of:

- `MVP`
- `ADR`
- `POC`

Use:

- [docs/playbooks/MVP-ADR-POC-RULES.md](./docs/playbooks/MVP-ADR-POC-RULES.md)

Short version:

- `MVP` defines scope
- `ADR` records decisions
- `POC` reduces uncertainty

If the work is still uncertain, do not jump straight into product truth.
Use a `POC` first.

## Development Notes

This repo mixes Go, Node, React/Vite, browser-extension, and MCP work.

Examples:

```bash
# Go service tests
cd features/compliance/privacy-gateway && go test ./...
cd features/outreach/anti-trace-relay && go test ./...
cd modules/outreach && go test ./...

# Docker compose (full stack)
docker compose -f infra/docker/docker-compose.yml up -d

# Privacy monorepo stability entrypoint (from repo root)
./scripts/run-privacy-stability.sh
./scripts/run-privacy-stability.sh --strict-rc

# Privacy RC readiness and postrun wrappers (from repo root)
./scripts/show-privacy-rc-readiness.sh
./scripts/show-privacy-rc-readiness.sh --strict
./scripts/run-privacy-rc-postrun.sh
./scripts/run-privacy-rc-postrun.sh --apply

# Node/Vite service work happens in the surface-local package setup
cd features/platform/outreach-dashboard
cd features/platform/mcp
```

Always use the target surface's local scripts, package manager, and runbooks instead of assuming one repo-wide workflow.

### Dev workflow proti Mail Labu

Pro denní vývoj a testy běž **Mail Lab** — sealed lokální stack co simuluje real Seznam/Gmail/Outlook (Postfix + Dovecot + Rspamd + OpenDKIM, vlastní DNS, Roundcube webmail).

```bash
# 1. Bootstrap (poprvé pull image ~500MB)
bash scripts/mail-lab/up.sh

# 2. Dashboard → lab profile
cd features/platform/outreach-dashboard
cp .env.lab.example .env.local
pnpm dev   # http://localhost:18175
```

Operator pak vidí Roundcube na <http://localhost:28080> (login `operator@seznam.lab` / `lab-demo-only`). Plný runbook + admin API katalog v [docs/playbooks/mail-lab-quickstart.md](docs/playbooks/mail-lab-quickstart.md).

Pravidlo: **vyvíjej proti Mail Labu, ne proti prod**. Prod creds patří jen do post-deploy synthetic monitoring.

## Operating Model

Backlog je **GitHub Issues** + Project "Hozan Ops". Signály plynou automaticky:

- Sentry runtime errors → issue (native integration + `scripts/sentry-triage.mjs` cron)
- CI test failures → issue (`.github/workflows/triage-failures.yml`, dedup hashem)
- Weekly health drift → issue (`scripts/test-health.mjs`)

Algoritmický **reprioritizer** (`scripts/reprioritize.mjs`, cron */30 min) přepočítává `priority/p0..p3` labels podle scoring rules. Audit comment v issue za každou změnu.

**Bot worker** (`.github/workflows/bot-worker.yml`, cron */30 min) v off-hours claimuje top-priority issue s explicit `automation/ok` labelem, otevírá PR. **Nikdy nemerguje.** Hard limity: 3 open `[bot]` PRs, 20 runs/den. Pause: `echo paused > .agent-status`.

Detail:
- [ADR-002 — Autonomous Ops Architecture](./docs/decisions/ADR-002-autonomous-ops-architecture.md)
- [Bot Operations Playbook](./docs/playbooks/bot-operations.md)
- [Initiative: 2026-04-27-autonomous-ops](./docs/initiatives/2026-04-27-autonomous-ops.md)

## Running tests

Default flipped (#70): `pnpm test` in `features/platform/outreach-dashboard` runs the
**Full** test scope (`TEST_SCOPE=all`) so CI gates and local dev hit the
same surface. Use `pnpm test:fast` for tight inner-loop iteration.

| Script | Scope | Notes |
|--------|-------|-------|
| `pnpm test` | full (`TEST_SCOPE=all`) | unit + audit + chaos + property + contract + integration |
| `pnpm test:fast` | narrow | unit + audit + chaos + property — old default |
| `pnpm test:contract` | contract only | BFF contract tests with mocked pool |
| `pnpm test:integration` | integration only | pg-mem-backed real-DB tests |
| `pnpm test:full` | full | back-compat alias for `pnpm test` |
| `pnpm test:all` | full | preserved alias (was equivalent before flip) |
| `pnpm e2e` | Playwright | end-to-end browser specs |

Test taxonomy (single test root under `features/platform/outreach-dashboard/tests/`):

- `tests/unit/` — fast unit (lib/, components/, pages/, hooks/, legacy/)
- `tests/integration/` — real backend (pg-mem)
- `tests/contract/` — BFF contract (vi.mock pool, supertest)
- `tests/property/` — fast-check properties
- `tests/chaos/` — Markov sims + multi-entity invariants
- `tests/audit/` — discipline ratchet checks (observability, explanation)
- `tests/synthetic/` — PROD continuous monitoring (Phase 3, planned)
- `tests/regression/` — incident replay (Phase 4, planned)
- `tests/e2e/` — Playwright specs

## Governance

This repository uses the Spec Kit + ECC + Agency operating model:

- [docs/playbooks/routing-playbook.md](./docs/playbooks/routing-playbook.md)
- [.specify/memory/constitution.md](./.specify/memory/constitution.md)
- [AGENTS.md](./AGENTS.md)
