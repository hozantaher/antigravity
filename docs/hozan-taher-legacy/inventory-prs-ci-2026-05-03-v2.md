# Open PRs & CI Workflow Health — 2026-05-03

**Status**: 2 open PRs, 4 chronic CI failures across main branch

## Open PRs (sorted by age)

| # | Title | Age | Branch | Status |
|---|-------|-----|--------|--------|
| 116 | S4 — Mailbox ↔ Campaigns cross-link | 5 days | feat/mailbox-campaigns-cross-link-s4 | Pending |
| 626 | fix(relay): wgsocks pin WG UDP listen port (Railway PAT defense) | 2 days | fix/wgsocks-listen-port | Pending |

**Key observations**:
- PR #116 aging — no review decision recorded
- PR #626 recent, infrastructure-focused
- Zero blocked PRs; zero dependabot

## CI Workflow Health

**Last 20 runs** (main branch):

| Workflow | PASS | FAIL | Pass Rate | Latest Status |
|----------|------|------|-----------|---------------|
| Triage CI failures | 11 | 0 | 100% | ✓ success |
| Dashboard Real-Backend Smoke | 0 | 4 | 0% | ✗ failure |
| Go Services CI | 0 | 4 | 0% | ✗ failure |
| Build & Push to GHCR | 0 | 4 | 0% | ✗ failure |
| CodeQL Security Analysis | 0 | 5 | 0% | ✗ failure |
| Reprioritize backlog | 0 | 1 | 0% | ✗ failure |
| Bot worker | 0 | 1 | 0% | ⊘ skipped |

**Chronic failures** (3+ consecutive):
- **CodeQL Security Analysis** — 5 consecutive failures (0% on latest run set)
- **Go Services CI** — 4 consecutive failures
- **Dashboard Real-Backend Smoke** — 4 consecutive failures
- **Build & Push to GHCR** — 4 consecutive failures (upstream of above)

Triage automation runs frequently and passes 100%, but root causes remain unresolved.

## Branch Hygiene

- **Total remote branches**: 253
- **Recent merge velocity**: 61 commits to main in last 24h (active)
- **Worktree overhead**: 24 agent worktrees (16 locked, 8 active) + 3 named sibling worktrees
- **Recent branch density**: 30/253 branches merged or updated in last 24h (high turnover)

## Recommended Actions

1. **Immediate** (blocking main CI):
   - Investigate CodeQL failure — inspect latest run logs
   - Fix Go build / Dashboard smoke root cause (likely upstream in Go Services)
   - Unblock Build & Push once Go Services CI passes

2. **Near-term** (PR velocity):
   - Review PR #116 (S4 mailbox cross-link, 5 days old)
   - Monitor PR #626 merge once CI green

3. **Hygiene**:
   - Prune stale agent worktrees (16 locked; cleanup policy unclear)
   - Document branch retention SLA (230+ branches may indicate merge strategy drift)

---
**Generated**: 2026-05-03 17:30 UTC | **Branch**: docs/inventory-prs-ci-v2
