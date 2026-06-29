# Branch + Worktree Cleanup — 2026-04-30

**Status:** Completed
**Trigger:** Post-consolidation cleanup after today's massive throughput (26 PRs merged on 2026-04-30; 60+ stale branches accumulated).
**Scope:** Local branches, remote branches, and worktree audit. No code change.

## Method

1. `git branch --merged origin/main` — local branches merged.
2. `git branch -r` — all remote branches.
3. `gh pr list --state=merged|open --limit 200` — PR association.
4. `git worktree list --porcelain` — branches checked out in any worktree.

Safety filters applied (intersection of conditions for deletion):
- Branch must have a **merged** PR (head ref matches a merged PR).
- Branch must **not** have any open PR.
- Branch must **not** be checked out in any worktree.
- Branch must **not** be infrastructure (`main`, `wm/development`, `wm/tests`,
  current cleanup branch).

## Worktree Audit (read-only — operator decides removal)

Total worktrees: 49 (3 infrastructure + 1 cleanup base + 45 agent worktrees).

All agent worktrees are `locked` — Claude Code instances may still hold them.
Listed below for operator reference; **no worktree was removed in this PR**.

### Ready-to-remove (PR merged)

| Worktree | Branch | PR |
|---|---|---|
| `agent-a002d04dad58c8a18` | `feat/kt-a9-multi-source-enrichment` | #348 |
| `agent-a050f50c256ec6cd2` | `feat/kt-b1-bff-go-contract-tests` | #351 |
| `agent-a07a51399b59f00c8` | `audit/duplicate-hunt-deep-2026-04-30` | #403 |
| `agent-a0c0f86f1e6da7dc0` | `feat/kt-a10-refresh-cron-tuning` | #344 |
| `agent-a30ba668cba6730da` | `test/kt-b15-scraping-chaos-v2` | #388 |
| `agent-a31bd93322df6a7e9` | `feat/kt-b4-operator-override-capture` | #385 |
| `agent-a42ddaf3eb514e660` | `chore/perf-baseline-2026-04-30` | #386 |
| `agent-a4d8818af9b7085e1` | `refactor/promote-unsub-token-canonical` | #408 |
| `agent-a4fdb976ed81ef764` | `test/bulk-env-restore-contract` | #373 |
| `agent-a5554ec98bc55252a` | `feat/kt-a8-1-healing-writer-only` | #360 |
| `agent-a596143eb9dc0c826` | `feat/kt-a5-staircase-v2` | #365 |
| `agent-a6323e67fc02454c9` | `feat/kt-b12-gdpr-audit` | #380 |
| `agent-a675e5b66cfcabcf6` | `test/kt-b7-adversarial-v2` | #363 |
| `agent-a6802ba68fec512ce` | `chore/audit-ratchet-sweep-2026-04-30-v2` | #400 |
| `agent-a68b89097d7fdf593` | `feat/dashboard-widgets-live-v1` | #376 |
| `agent-a72e5aa6fcc18bce0` | `test/kt-b3-full-reply-flow-e2e` | #384 |
| `agent-a8394582cc408fab3` | `feat/kt-a15-multi-step-sequences` | #354 |
| `agent-a85ccfa8e9183a65d` | `feat/kt-b5-lab-feedback-loop` | #375 |
| `agent-a99b7c879bd366dae` | `refactor/slogop-helper-extract` | #405 |
| `agent-a9cc4c36fc18cb8be` | `chore/envconfig-consolidate-2026-04-30` | #406 |
| `agent-a9d0c68d3eb4e372f` | `chore/delete-dead-common-token` | #404 |
| `agent-aa719f48b1b7a6593` | `feat/kt-a9-1-enrichment-cutover-v2` | #362 |
| `agent-aa93a4136ea5f3db4` | `test/cross-suite-pollution-cleanup` | #377 |
| `agent-ab26dc8653c96faf2` | `feat/kt-a13-threaddetail-context` | #347 |
| `agent-ac76c50bb7654e442` | `feat/kt-a8-block-detection` | #345 |
| `agent-ad65e07e52d736774` | `docs/claude-md-drift-sweep-2026-04-30` | #398 |
| `agent-adfbf607c7764f5ab` | `refactor/airtight-gate-unify` | #407 |
| `agent-af8fed2f5dcceb5ce` | `refactor/suppression-union-constant` | #409 |
| `kt-b14` (in lowercase root) | `test/kt-b14-replies-deep-v1` | #372 |

Operator removal command: `git worktree remove <path>` (after verifying no live agent).

### Keep (open PR)

| Worktree | Branch | PR |
|---|---|---|
| `agent-ad0920acadaf9464b` | `perf/reduce-vendor-sentry-bundle` | #401 (open) |

### Skip (no PR association)

These worktrees have branches with no merged or open PR — likely speculative
work or abandoned. Operator should investigate before removal.

| Worktree | Branch |
|---|---|
| `agent-a40c4f48daadcf7ad` | `worktree-agent-a40c4f48daadcf7ad` |
| `agent-a688ec0569324fa80` | `feat/kt-a5-staircase-send` |
| `agent-a84be18c4551fd514` | `test/kt-b2-llm-classifier-accuracy-v2` |
| `agent-a97beaa3245368fc7` | `chore/a11y-gate-ratchet` |
| `agent-aa1ddc6a4b78283c8` | `fix/route-inventory-add-3` |
| `agent-aa7f396bab834383c` | `worktree-agent-aa7f396bab834383c` |
| `agent-ace2db14087568fa2` | `test/kt-b2-llm-classifier-accuracy` |
| `agent-ace748b7d8d8249b8` | `worktree-agent-ace748b7d8d8249b8` |
| `agent-ad667aa6ea53941b5` | `feat/kt-a8-1-healing-recovery` |
| `agent-ad728eaf38ed1ee7c` | `feat/mailboxes-ui-declutter` |
| `agent-aeb36446801fdb8a1` | `test/kt-b15-scraping-chaos` |
| `agent-af0a11e40e77f0654` | `test/kt-b11-self-healing-validation` |
| `agent-af35502ae25a331fa` | `verify-auth` |
| `kt-a9-1` | `feat/kt-a9-1-enrichment-cutover` |
| `kt-b10` | `test/kt-b10-load-1000-replies` |

### Infrastructure (do not remove)

- `/Users/messingtomas/Documents/Projekty/hozan-taher` — main worktree (cleanup branch base).
- `/Users/messingtomas/Documents/Projekty/hozan-taher-dev` — `wm/development`.
- `/Users/messingtomas/Documents/Projekty/hozan-taher-tests` — `wm/tests`.
- `agent-a6fae3a686851993b` — `main` (locked).

## Local branches deleted

61 branches deleted via `git branch -D`. Each had a merged PR, no open PR, and
no worktree binding.

See PR diff for the complete list (this section is the full audit log).

## Remote branches deleted

36 remote branches deleted via `git push origin --delete`. Each had a merged
PR, no open PR, and no worktree binding (deleting remote refs of branches still
checked out in worktrees was skipped to preserve the option to push).

## Skipped (with reason)

- All branches with open PRs (21 branches) — see open PR list at time of cleanup.
- All branches checked out in any worktree (30 branches) — local copy retained
  to keep the worktree functional; operator can run a follow-up sweep after
  removing the worktrees.
- All branches with no PR association (no merged or open PR) — speculative or
  abandoned, requires manual triage.

## Hard rules respected

- Single PR for the cleanup operation.
- No code change, no behavior change.
- No deletion of `main`, `wm/development`, `wm/tests`.
- No deletion of branches with open PRs.
- No deletion of branches checked out in any worktree.
- No `git worktree remove` calls — worktree removal left to operator since
  Claude Code instances may still hold locks.
