# Deploy Hygiene Playbook

## Overview

Incident (2026-05-11): `railway up` failed 5+ times with "Failed to create code snapshot". Root cause: 45GB `.claude/worktrees/` (138 agent worktrees) uploaded as tarball during deployment.

This playbook documents repository size governance, cleanup procedures, and pre-deployment checks.

## .railwayignore

Located at `.railwayignore`, this file lists patterns to exclude from the Railway deployment tarball:

```
.claude/worktrees/       # Agent worktrees (ephemeral, not production state)
.claude/scheduled_tasks.lock
.claude/settings.local.json
node_modules/            # Pnpm modules (reinstalled by Railway)
*.log                    # Transient logs
.DS_Store                # macOS metadata
_archive/                # Decommissioned doc archives
```

**Do not commit development artifacts to version control.** These directories should remain untracked or ignored.

## Size Limits

- **Preflight threshold**: 500MB. `scripts/deploy/preflight.sh` exits 7 if exceeded.
- **Audit ratchet threshold**: 1GB. `tests/audit/repo_size_audit_test.js` fails the test suite.

## Pre-Deploy Checklist

```bash
# Run preflight locally before pushing
scripts/deploy/preflight.sh

# If size check fails:
rm -rf .claude/worktrees          # Remove agent worktrees
git clean -fd                      # Clean untracked files

# Check worktree count (should be ≤ 5 normal; ≥ 100 is red flag)
git worktree list | wc -l

# Re-run preflight
scripts/deploy/preflight.sh
```

## Cleanup: Stale Worktrees

Manual cleanup for >100 worktrees:

```bash
# List all agent worktrees
git worktree list | grep agent-

# Remove all agent worktrees (force)
for w in $(git worktree list | grep agent- | awk '{print $1}'); do
  git worktree remove -f -f "$w"
done

# Verify cleanup
git worktree list
```

## CI/CD Integration

The audit ratchet (`tests/audit/repo_size_audit_test.js`) runs as part of the test suite:

```bash
# Local
npm test         # Runs audit ratchet + all other tests

# CI (via pnpm test in root or per-service)
# Fails if repo size > 1GB
```

## Operator Escalation

If preflight size check fires:

1. Check for `.claude/worktrees/` accumulation: `git worktree list | wc -l`
2. If count > 100: run manual cleanup (see above)
3. Check for uncommitted large files: `git status --porcelain`
4. Clean and re-run: `git clean -fd && scripts/deploy/preflight.sh`
5. If still failing, escalate to operator for manual review of untracked files

## Memory: Session Worktree Discipline

To prevent accumulation:

- **Agent isolation policy** (`feedback_agent_isolation_default`): all commit-capable agents use `isolation:"worktree"` (SpawnAgent automatically manages cleanup)
- **End-of-session purge**: on `ExitWorktree`, select `action: "remove"` for completed work
- **Manual inventory**: Before long sessions, run `git worktree list` to identify stale worktrees

## References

- `.railwayignore` — Tarball exclusion patterns
- `scripts/deploy/preflight.sh` — Pre-deploy gates (exit codes 0–7)
- `tests/audit/repo_size_audit_test.js` — Baseline size enforcement
- `CLAUDE.md` § "Agent isolation default" — Worktree lifecycle policy
