# Restructure Plan: `spec-kit-codex-stack` → `hozan-taher`

**Status**: In progress on branch `restructure/hozan-taher`.
**Target**: Consolidate platform under unified name, clean structure, single git repo.
**Owner**: Tomáš Messing.

## Goal

Transform the current fragmented layout (nested git repos, flat service list, scattered docs) into a clean platform monorepo hosting multiple products around a central memory layer.

- **Repo slug**: `hozan-taher` (GitHub), display "Hozan Taher"
- **Dir**: `/Users/messingtomas/Documents/Projekty/Hozan Taher/`
- **Structure**: `apps/` + `modules/` + `services/` + `packages/` + `infra/` + `docs/`

## Current pain points (verified 2026-04-19)

1. **Two nested git repos**: outer `Garaaage Outreach/.git` (no remote, 279+ meta-commits, hosts claude-squad worktrees) + inner `spec-kit-codex-stack/.git` (GitHub-backed, authoritative code).
2. **Root bloat**: 16 markdown files at inner repo root (ADR, playbooks, recovery memos, architecture briefs).
3. **Naming inconsistency**: `garaaage-*` prefix used unevenly; product names (`machinery-outreach`) mixed with infra names (`privacy-gateway`, `anti-trace-relay`); repo called `spec-kit-codex-stack` (tooling name, not product).
4. **Mystery artifacts**: `watch_20260406-211854` (stale log), `services/machinery-outreach/=` (typo artifact), `services/machinery-outreach/_archiv` (unclear).
5. **Duplicate `claude-sandbox/`** at both outer and inner levels.

## Target structure

```
hozan-taher/
├── apps/
│   ├── outreach-dashboard/       # from services/machinery-outreach/dashboard
│   └── extension/                # from services/garaaage-extension
├── modules/
│   └── outreach/                 # from services/machinery-outreach (minus dashboard)
├── services/
│   ├── privacy-gateway/          # keep
│   ├── anti-trace-relay/         # keep
│   ├── mcp/                      # from services/garaaage-mcp
│   ├── worker/                   # from services/garaaage-worker
│   └── scrapers/                 # from services/garaaage-scrapers
├── packages/
│   └── memory/                   # central memory layer (new, post-MVP)
├── infra/
│   ├── sandbox/                  # from claude-sandbox (deduped)
│   └── docker/                   # from docker-compose.yml
├── specs/  tasks/  scripts/  docs/  .claude/  .github/
├── AGENTS.md  CLAUDE.md  README.md
├── pnpm-workspace.yaml  go.work  package.json
└── .gitignore
```

## Naming rules

- **apps/** = user-facing UI (frontend, extension)
- **modules/** = business domains (outreach now; law, billing, etc. later)
- **services/** = backend platform services (no `garaaage-` prefix for infra)
- **packages/** = shared libs incl. central memory
- **infra/** = deploy, sandbox, docker
- Product-branded services keep brand (e.g., `apps/extension` may later become `apps/hozan-extension`)

## Phases

| Phase | Scope | Risk | Est. |
|-------|-------|------|------|
| 0 | Safety net (backup, audit, branch) | low | 30 min |
| 1 | Doc cleanup in-place + mystery files | low | 30 min |
| 2 | GitHub repo rename | low | 10 min |
| 3 | Merge outer .git content into inner + delete outer .git + physical dir rename | medium | 45 min |
| 4 | Top-level reorg (apps/modules/services/packages/infra) | medium | 2-3 h |
| 5 | Refactor Go/TS paths, Docker, CI, scripts | high | 3-4 h |
| 6 | Build + test verify | high | 1-2 h |
| 7 | Claude env migration (memory dir, CLAUDE.md, launch.json) | low | 30 min |
| 8 | Push + merge restructure branch | low | 30 min |

**Total**: ~8-10 h (1.5 working day w/ buffer).

## Risks

| Risk | Mitigation |
|------|------------|
| Import path breaks after `git mv` | Atomic commit per move, `go build ./...` + `pnpm build` after each |
| CI fails after repo rename | GH redirect auto; update `.github/workflows/*.yml` paths |
| DB schema refs `machinery_outreach` | Keep DB naming unchanged; only touch code refs |
| Outer `.git` has unique commits | Audit log first (done: none authoritative) |
| claude-squad worktrees invalidate on outer .git delete | Accept: claude-squad must reinit in Hozan Taher dir |
| `.env` hardcodes paths | Grep `.env*` and update manually |

## Rollback

Each phase is an atomic commit on `restructure/hozan-taher`. Reverting = `git reset --hard <prev-commit>` or `git revert`. Tarball backup at `~/backups/garaaage-outreach-<date>.tar.gz` covers catastrophic rollback.

## Decision log

- **2026-04-19** Start restructure on branch `restructure/hozan-taher`.
- **2026-04-19** Repo name decided: `hozan-taher` (slug), "Hozan Taher" (display).
- **2026-04-19** Outer `.git` audit: no unique code, no remote, 279+ meta-commits. Safe to delete after unique file extraction.
- **2026-04-19** claude-squad worktrees on outer accepted as collateral: reinit in new dir post-migration.
