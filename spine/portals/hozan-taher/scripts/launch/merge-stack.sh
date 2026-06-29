#!/usr/bin/env bash
# merge-stack.sh — operator helper for 2026-05-05 launch merge window (v4).
#
# Merges 50-PR stack (foundation + dedup axes + CRM + replay validation + guard panel)
# in dependency-DAG order with `gh pr merge --admin --squash`. CI billing-red is
# admin-overridden per memory feedback_no_ci_nag.
#
# Usage:
#   scripts/launch/merge-stack.sh           # interactive (per-PR confirm)
#   scripts/launch/merge-stack.sh --yes     # batch (no confirms)
#   scripts/launch/merge-stack.sh --dry-run # print intent only, no merges
#
# Exit codes:
#   0  — all PRs merged (or skipped if already merged)
#   1  — at least one merge failed; aborts on first failure
#   2  — invocation error (gh not authed, wrong cwd)
#
# HARD RULE memory feedback_campaign_send: this script does NOT send
# email. It only merges PRs. The campaign launch itself requires a
# separate explicit operator action (UPDATE campaigns SET status='active').

set -euo pipefail

# ── Pre-flight ──────────────────────────────────────────────────────────
if ! command -v gh >/dev/null 2>&1; then
  echo "✗ gh CLI not installed. Install: https://cli.github.com/" >&2
  exit 2
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "✗ gh not authenticated. Run: gh auth login" >&2
  exit 2
fi
if [ ! -f .githooks/pre-push ] && [ ! -d .git ]; then
  echo "✗ Not in repo root. cd to /Users/messingtomas/Documents/Projekty/hozan-taher/" >&2
  exit 2
fi

# ── Args ────────────────────────────────────────────────────────────────
DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    -h|--help)
      head -n 22 "$0" | tail -n 21
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# ── Stack definition ────────────────────────────────────────────────────
# Order = dependency DAG. Each row is "PR#  short label". A PR depends on
# everything ABOVE it in this list. Stack notes:
#   - #757 stacks on #752; merge in order so its base auto-retargets.
#   - #765 stacks on #761; same.
#   - #762 (ADR-012) is doc-only and references #752–#761 retroactively;
#     position late so the references resolve.
#   - #784–#786 (dedup axes C1–C4); #795 (replay validation); #798 (guard panel).
#   - #792–#800 (CRM import + active client + badge + UI + classifier + admin).
declare -a STACK=(
  "723   fix(relay/sanitizer)            ROOT CAUSE delivery 25-60%"
  "740   fix(relay/HELO)                 egress identity"
  "748   chore(launch-sanity-sweep)"
  "749   fix(bff/boot-invariant)"
  "750   fix(verify-launch-3-bugs)"
  "751   docs(audits/cohort-state)       operator decides Option A/B separately"
  "754   docs(audits/sequence-config)    PASS"
  "755   docs(audits/pr-triage)"
  "756   feat(relay/obs op fields)"
  "761   fix(verify-launch BFF prereq)   closes #586"
  "765   test(verify-launch tests)       stack on 761"
  "752   feat(launch-monitor widget)"
  "757   feat(per-step pill)             stack on 752"
  "758   feat(ramp staircase)"
  "759   feat(synthetic probe scaffold)  default off"
  "760   feat(preflight panel UI)"
  "764   feat(cmd/outreach slog 126→0)"
  "766   feat(intelligence slog 50→0)"
  "768   feat(final 9-pkg slog 26→0)"
  "767   fix(send-test 503)"
  "762   docs(adr-012 launch observability)"
  "753   docs(obs-log template)"
  "783   feat(dedup) + docs(post-purge):  foundation + migration 049"
  "784   feat(sender/dedup):             bounce cluster axis (C1)"
  "785   feat(sender/dedup):             region rate limit axis (C3)"
  "786   feat(post-purge-rebuild):       full A+C1-C4 stack + CLI"
  "795   feat(scripts/audits):           replay validation"
  "792   feat(crm):                      eWAY import + suppression backfill"
  "793   feat(sender/dedup):             CRM active client (CRM-5)"
  "794   feat(dashboard/crm):            CRM badge on drawer (CRM-6)"
  "796   feat(dashboard/crm):            /crm/clients page (CRM-7)"
  "797   feat(orchestrator/thread):      reply classifier auto-DNT"
  "798   feat(dashboard):                dedup-guard operator (F1)"
  "799   feat(dashboard/crm):            XLSX import UI"
  "800   feat(crm):                      stale-data warning + freshness"
  "789   chore(deps):                    bump @anthropic-ai/sdk 0.91→0.93"
)

# ── Confirm ────────────────────────────────────────────────────────────
echo ""
echo "Merge stack — ${#STACK[@]} PRs in dependency DAG order:"
echo "─────────────────────────────────────────────────────────────────────"
for entry in "${STACK[@]}"; do echo "  #${entry}"; done
echo "─────────────────────────────────────────────────────────────────────"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run — no merges performed."
  exit 0
fi
if [ "$ASSUME_YES" -ne 1 ]; then
  read -r -p "Proceed with admin-merge? [y/N] " ans
  case "$ans" in y|Y) ;; *) echo "Aborted."; exit 0 ;; esac
fi

# ── Merge loop ─────────────────────────────────────────────────────────
FAILED=0
SKIPPED=0
MERGED=0
for entry in "${STACK[@]}"; do
  pr_num=$(awk '{print $1}' <<<"$entry")
  label=$(cut -d' ' -f2- <<<"$entry" | sed 's/^ *//')

  state=$(gh pr view "$pr_num" --json state -q .state 2>/dev/null || echo "UNKNOWN")
  if [ "$state" = "MERGED" ]; then
    echo "⊙ #$pr_num  $label  — already merged, skip"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  if [ "$state" = "CLOSED" ]; then
    echo "⊙ #$pr_num  $label  — closed (not merged), skip"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  if [ "$state" != "OPEN" ]; then
    echo "✗ #$pr_num  $label  — unexpected state: $state"
    FAILED=$((FAILED + 1))
    break
  fi

  echo ""
  echo "→ Merging #$pr_num  $label"
  if gh pr merge "$pr_num" --admin --squash --delete-branch=false 2>&1 | tail -3; then
    echo "✓ #$pr_num merged"
    MERGED=$((MERGED + 1))
  else
    echo "✗ #$pr_num merge failed — investigate before continuing"
    FAILED=$((FAILED + 1))
    break
  fi
done

# ── Summary ────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────────────────────────────"
echo "Merged: $MERGED  Skipped: $SKIPPED  Failed: $FAILED"
if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
echo "All ready PRs merged. Next: pnpm verify:launch --campaign-id=1"
