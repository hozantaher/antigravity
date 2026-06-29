# Monorepo Stabilization Playbook

Last updated: 2026-04-04

## Purpose

This document is the repair guide for AI agents working in this repository.

Use it when the goal is:

- stabilize the monorepo after rapid growth
- reconcile git reality with documentation
- close missing onboarding, quality, and operational gaps
- avoid adding more product drift while finishing what already exists

## Current Diagnosis

The repository has grown into a real multi-service monorepo.

That growth is technically productive, but the governance and documentation layers have lagged behind.

The main problem is no longer lack of code.

The main problem is uneven service maturity:

- some services have strong code and tests but weak canonical docs
- some services have strong docs but outdated status reporting
- root repo guidance recently caught up, but service-level stabilization is still incomplete

## Non-Negotiable Rules For AI

1. Do not add new top-level product narratives until the current repo is stabilized.
2. Do not create more status documents when an existing one can be refreshed.
3. Always identify the target service first.
4. Prefer service-local README, ADR, and contract files over root docs for implementation detail.
5. Treat missing canonical docs as a first-class defect.
6. Before new feature work, check whether the service is already operable, testable, and documented.
7. If git history and docs disagree, trust git history first, then reconcile docs.

## Root-Level Findings

Current positives:

- root [README.md](/Users/messingtomas/Taher/hozan-taher/README.md) now describes the repo as a monorepo
- root [AGENTS.md](/Users/messingtomas/Taher/hozan-taher/AGENTS.md) now describes service-scoped work correctly
- the repo has a clean canonical root truth surface

Current gaps:

- only one visible CI workflow exists:
  - [garaaage-scrapers-docker.yml](/Users/messingtomas/Taher/hozan-taher/.github/workflows/garaaage-scrapers-docker.yml)
- there is no obvious repo-wide stabilization dashboard
- service maturity is inconsistent

Progress already completed:

- canonical README files were added for `outreach-dashboard`, `machinery-outreach`, `garaaage-mcp`, and `garaaage-worker`
- Batch 2 verification established that those services do not share the same local test posture, and docs should reflect that explicitly

## Service Inventory

### 1. privacy-gateway

Tech:

- Go
- Docker

Observed state:

- strong canonical docs
- strong sprint/status material
- strong operator and contract surface
- roughly 25 test files

Assessment:

- most mature service from governance point of view
- good candidate for “reference quality” inside the monorepo

Primary gaps:

- provider-backed verification still missing
- some local/read-model work continues beyond release track and should stay intentionally scoped

### 2. anti-trace-relay

Tech:

- Go
- Docker

Observed state:

- has README, changelog, deployment, ADRs
- roughly 30 test files
- strong self-description
- local `go test ./...` verification now passes in this workspace

Assessment:

- mature enough to be a primary product surface

Primary gaps:

- needs explicit alignment with root repo release/stability framing
- should keep socket-binding HTTP E2E documented as opt-in integration coverage

### 3. outreach-dashboard

Tech:

- Node
- Nuxt

Observed state:

- has package manifest and Nuxt config
- has a canonical service README
- unit test surface was verified locally
- no visible changelog or ADR at service root

Assessment:

- implementation likely moved ahead of documentation

Primary gaps:

- no ADR yet
- no changelog yet
- E2E verification still needs its own explicit pass

### 4. machinery-outreach

Tech:

- Go

Observed state:

- has `go.mod`
- has ADRs
- has a canonical service README
- no changelog
- roughly 24 test files
- local test verification now passes in this workspace

Assessment:

- architecture likely exists, but onboarding surface is incomplete

Primary gaps:

- no changelog
- operator/developer quickstart still needs deeper runbook treatment
- live DNS/MX validation is now opt-in integration coverage and should stay documented that way

### 5. garaaage-mcp

Tech:

- Node
- Docker

Observed state:

- package manifest present
- very large test surface
- has a canonical service README
- no changelog

Assessment:

- code and tests appear ahead of docs by a wide margin

Primary gaps:

- no changelog
- HTTP/E2E verification depends on an environment that allows local server binding
- deployment/runtime expectations still deserve a dedicated runbook

### 6. garaaage-worker

Tech:

- Node
- Docker

Observed state:

- package manifest present
- very large test surface
- has a canonical service README
- no changelog

Assessment:

- likely production-relevant internals with weak discovery/onboarding

Primary gaps:

- no changelog
- no ADR yet
- no dedicated deployment/runbook document yet

### 7. garaaage-scrapers

Tech:

- Node
- Docker

Observed state:

- has README
- decent script surface
- no visible changelog
- moderate test surface
- local test verification now passed in this workspace

Assessment:

- functionally present, but governance incomplete

Primary gaps:

- missing changelog or canonical status doc
- should declare what still belongs here vs what moved into decomposed services
- should keep the broad multi-surface README understandable as the service evolves

### 8. garaaage-extension

Tech:

- extension tooling

Observed state:

- has README
- has server-side test files
- canonical test script now exists in `server/package.json`
- local test verification now passed in this workspace
- no changelog

Assessment:

- likely usable, but not stabilized to the same standard as the stronger services

Primary gaps:

- missing release/packaging notes as canonical service docs
- should clarify relation to companion server and MCP stack
- release/packaging surface is still thinner than the stronger services even though the immediate dependency warning was resolved

## Priority Matrix

### Priority A: Stabilize Canonical Truth

Do first.

- refresh root service inventory only when services materially change
- keep root docs brief and service-local docs authoritative
- ensure each active service has a canonical README

Services most in need:

- cross-service run/test verification notes
- services without short changelog/status surfaces

### Priority B: Stabilize Build/Test/Run Discoverability

Do second.

For each active service, ensure there is a single obvious answer to:

- how to install
- how to run
- how to test
- what “healthy” means

### Priority C: Stabilize Release/Operational Posture

Do third.

- privacy-gateway: provider-backed verification
- anti-trace-relay: confirm deployment/runbook alignment with current code
- outreach services: define whether they are production, experimental, or internal tooling

## Required Deliverables Per Service

Each active service should end up with:

1. `README.md`
2. one canonical architecture/decision surface
   - ADR or contract doc
3. one canonical run/test section
4. a clear scope statement
5. a short “current maturity” statement

Optional:

- changelog
- deployment guide
- operator guide

## Stabilization Sequence For AI

Follow this exact order.

### Phase 1: Inventory Reconciliation

For each service:

- identify runtime stack
- identify whether README exists
- identify whether tests exist
- identify whether deployment/build entrypoints exist
- classify service as:
  - mature
  - active but under-documented
  - experimental

Do not edit code yet unless a documentation claim is provably false.

### Phase 2: Canonical README Closure

For every active service missing a README:

- create a minimal service-local README
- include:
  - purpose
  - stack
  - run
  - test
  - current scope
  - known limitations

Start with:

1. `services/outreach-dashboard`
2. `services/machinery-outreach`
3. `services/garaaage-mcp`
4. `services/garaaage-worker`

### Phase 3: Service Maturity Labels

For each service, explicitly mark one of:

- `production-facing`
- `internal tool`
- `experimental`
- `stabilizing`

Put this in the service-local README, not only in root docs.

### Phase 4: Build/Test Verification Pass

For each service, verify the minimal local contract:

- install/build command exists
- test command exists
- docs match actual commands

If commands differ from reality, fix docs first.

Only then fix code if the documented command is supposed to work and does not.

### Phase 5: Product-Specific Completion

Only after repo stabilization:

- continue `privacy-gateway` Sprint 7 or Sprint 5 execution
- continue anti-trace-relay hardening
- continue outreach/dashboard feature work

## What To Fix First

Immediate order:

1. create missing service READMEs
2. classify each service maturity level
3. align service run/test docs with actual package or go commands
4. refresh root README service inventory only if needed
5. then return to product delivery

## What Not To Do

- do not add more top-level narrative markdowns for status
- do not broaden product scope during stabilization
- do not treat all services as equally mature
- do not write root docs that duplicate service docs
- do not start with provider integration before service documentation is coherent

## Suggested First Execution Batch

Batch 1:

- `services/outreach-dashboard/README.md`
- `services/machinery-outreach/README.md`
- `services/garaaage-mcp/README.md`
- `services/garaaage-worker/README.md`

Batch 2:

- add maturity labels into those READMEs
- verify run/test commands against package.json or go.mod-based entrypoints

Batch 3:

- refresh root README service inventory if those new READMEs reveal scope changes
- reconcile verification posture for `garaaage-scrapers` and `garaaage-extension`

## Success Condition

The monorepo is considered stabilized when:

- every active service has a canonical README
- root docs no longer contradict service reality
- service-local run/test expectations are explicit
- repo growth no longer depends on chat memory to understand what each service is
