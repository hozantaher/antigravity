# Merge Gate — P2-1 Setup

**Task:** #90. Status: **workflow shipped**. Branch-protection config is a user-side GitHub setting (below).

## What lands in-repo

`.github/workflows/merge-gate.yml` — 4 jobs on every PR → main:

1. **no-conflicts** — attempt `git merge --no-ff origin/main`; fail if conflicts
2. **docs-only** — detect if PR touches ONLY `docs/handoff/*.md`, `CLAUDE.md`, `docs/initiatives/*.md`, `docs/playbooks/*.md` (exposes `docs_only` output)
3. **ci-checks-green** — poll GitHub Checks API for `Go Services CI` + `Node Services CI` completion; skipped for docs-only PRs
4. **merge-ready** — final aggregator; green only when all other gates pass

## User-side GitHub config (manual, one-time)

Once the workflow is merged, enable branch protection on `main`:

```
Repository → Settings → Branches → Add branch protection rule

  Branch name pattern: main

  ✓ Require status checks to pass before merging
    Required checks:
      - merge-ready

  ✓ Require branches to be up to date before merging
  ✓ Require conversation resolution before merging
  ✓ Do not allow bypassing the above settings (except admins)
  ✓ Restrict who can push to matching branches
      (only admins + merge-gate automation)
```

**Why only `merge-ready` is required:** it aggregates the 3 others. If any
sub-gate fails, `merge-ready` exits 1 and blocks merge. This keeps the GitHub
UI clean — one required check instead of four.

## Docs-only fast-path behavior

PRs touching only `docs/handoff/*.md`, `CLAUDE.md`, `docs/initiatives/*.md`,
or `docs/playbooks/*.md` skip the full CI matrix and merge through
merge-ready immediately after no-conflicts passes. This preserves the
BOARD sync velocity described in `CLAUDE.md`:

> **Exception z "no direct push to main":** `docs/handoff/*.md` + `CLAUDE.md`
> doc-pointer edits (drobné chore, text-only, low-risk) lze pushnout přímo
> na main.

The workflow formalizes this: text-only PRs still go through PR review but
don't wait on Go/Node CI (which can be ≥10 min).

## Verifying the gate

After merging this workflow to `main`:

1. Open a test PR with one Go file change → observe all 4 jobs run.
   - `merge-ready` should complete after ~1 min no-conflicts + ~10 min CI.
2. Open a BOARD-only PR → observe docs-only=true, ci-checks-green skipped,
   merge-ready completes in ~1 min.
3. Open a PR with a deliberate merge conflict (rebase stale against main) →
   `no-conflicts` fails red → merge-ready fails → GitHub UI blocks merge.

## Rollback

If the gate causes false-positive blocks:

1. Temporarily remove `merge-ready` from required checks in branch protection.
2. Investigate the gate logic in the workflow.
3. Re-enable once fixed.

The workflow is additive — existing Go/Node CI workflows continue to run
independently and are not affected.

## References

- CLAUDE.md BOARD exception: `docs/handoff/*.md` + `CLAUDE.md`
- Existing CI: `.github/workflows/go-services-ci.yml`, `node-services-ci.yml`
- DoD: `docs/playbooks/DISCIPLINE.md` (P1-1 #70)
