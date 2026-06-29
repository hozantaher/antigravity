<!-- TEMPLATE: kopíruj tento soubor do services/<domain>/README.md a vyplň. -->
<!-- TEMPLATE: viz docs/playbooks/DOMAIN-MIGRATION.md pro plný postup. -->

# `<service-name>`

> 1-2 větný popis, co doména dělá a proč existuje.

## Purpose

- Proč tato doména existuje.
- Jaký konkrétní business problém řeší.
- Jak zapadá do větší architektury (upstream/downstream v jedné větě).

## Owner

- Primary: `<owner>` (GitHub handle / jméno)
- Backup: `<backup>` (kdo převezme, když primary není dostupný)
- Escalation: `<team/manager>`

## Public API

<!-- Uveď všechny 3 sekce, i kdyby prázdné (s "žádné"). -->

### REST

- `GET /api/<service>/...` — popis
- `POST /api/<service>/...` — popis

### Events

- `<service>.<event_name>` — payload shape (odkaz na schema)

### Schemas

- OpenAPI spec: [`schemas/openapi.yaml`](./schemas/openapi.yaml)

## Invariants

Co musí vždy platit (pokud některé selže = bug):

1. **<Invariant 1>** — krátký popis a proč.
2. **<Invariant 2>** — krátký popis a proč.

## Getting Started

```bash
# Clone + enter
cd services/<service>/

# Install deps
# <go mod tidy | pnpm install | pip install -e .>

# Setup env
cp .env.example .env
# Vyplnit hodnoty

# Run lokálně
# <příkaz na start>
```

## Tests

```bash
# Unit
# <go test ./... | pnpm test | pytest>

# Integration
# <docker compose up + go test -tags=integration>

# E2E
# <pnpm playwright test | ...>
```

Coverage cíl: 80 % (per `docs/playbooks/DISCIPLINE.md`).

## Deploy

- Railway service name: `<railway-service-name>`
- Deploy target: `<railway|sub-service|library>`
- Trigger: auto na merge do `main`
- Health check: `<path>`
- Rollback: `docs/playbooks/SERVICES.md#<service>`

## Related Docs

- [`service.yaml`](./service.yaml) — manifest s owner, deps, SLO
- [DOMAIN-MAP.md](../../docs/architecture/DOMAIN-MAP.md) — kde v doménové mapě
- [Migration playbook](../../docs/playbooks/DOMAIN-MIGRATION.md)
- ADRs: `docs/decisions/ADR-NNN-<slug>.md` (pokud existují)
- Runbooks: `docs/playbooks/runbook-<service>-*.md` (pokud existují)
