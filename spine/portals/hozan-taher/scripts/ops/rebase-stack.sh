#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# rebase-stack — automate post-merge rebase chore for stacked PRs
# ════════════════════════════════════════════════════════════════════════
#
# When the bottom PR of a long stack merges into main, every PR above it
# needs three steps: rebase its branch onto current main, retarget its
# GH base-ref to main, and force-with-lease push. For a 17-deep stack
# that's error-prone and tedious to do by hand. This walks the chain
# starting from --head, descends via baseRefName, and performs all three
# steps for every PR whose parent has been merged. It stops as soon as
# it hits a parent that is still open (can't safely rebase further).
#
# Usage:
#   scripts/ops/rebase-stack.sh --head feat/ml2.7-operator-reset
#   scripts/ops/rebase-stack.sh --head feat/ml2.7-operator-reset --dry-run
#   scripts/ops/rebase-stack.sh --head feat/ml2.7-operator-reset --limit 3
#
# Prerequisites:
#   - git, gh, jq on PATH
#   - clean working tree (no unstaged or staged changes)
#   - origin remote, default branch main
#   - bash 3.2+ (macOS default; uses parallel arrays, no `declare -A`)
#
# Algorithm:
#   1. Build a parent map from gh pr list.
#   2. Walk down from --head via baseRefName until main or an open parent.
#   3. For each PR whose parent is MERGED:
#        a. fetch origin main
#        b. checkout <head>
#        c. git rebase --onto origin/main <oldbase> <head>
#        d. git push --force-with-lease origin <head>
#        e. gh pr edit <num> --base main
#   4. On rebase conflict: abort, log the PR# for manual handling, exit 2.
#
# Safety:
#   - Refuses to operate on main, master, develop, wm/* branches directly.
#   - Refuses to run with a dirty working tree.
#   - Always uses --force-with-lease (never plain --force).
#   - Never touches main directly.
#
# Exit codes:
#   0  ok (or nothing to do)
#   1  generic failure (bad args, missing tools, dirty tree, etc.)
#   2  rebase conflict — manual intervention required for a specific PR
# ════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── CLI ─────────────────────────────────────────────────────────────────

HEAD_BRANCH=""
DRY_RUN=0
LIMIT=0  # 0 = unlimited

while [[ $# -gt 0 ]]; do
  case "$1" in
    --head)    HEAD_BRANCH="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --limit)   LIMIT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,45p' "$0"
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$HEAD_BRANCH" ]]; then
  echo "ERROR: --head <branch> is required" >&2
  exit 1
fi

# ── Logging helpers (mirror scripts/migrations/run.sh style) ────────────

log()      { echo "[rebase-stack] $*"; }
log_warn() { echo "[rebase-stack] WARN: $*" >&2; }
log_err()  { echo "[rebase-stack] ERROR: $*" >&2; }

# ── Tool checks ─────────────────────────────────────────────────────────

for tool in git gh jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    log_err "$tool not found on PATH"
    exit 1
  fi
done

# ── Locate repo root, cd in ─────────────────────────────────────────────
#
# Try cwd first; if not in a repo, fall back to the script's own location
# (it lives in scripts/ops/ inside the repo, so two levels up is root).
# This lets the script run from anywhere — `acceptance: runs from any
# directory`.

if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  :
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if ROOT="$(cd "$SCRIPT_DIR/../.." && git rev-parse --show-toplevel 2>/dev/null)"; then
    :
  else
    log_err "not inside a git repository, and script-relative path is not one either"
    exit 1
  fi
fi
cd "$ROOT"

# ── Safety: forbidden branches ──────────────────────────────────────────

is_protected_branch() {
  case "$1" in
    main|master|develop) return 0 ;;
    wm/*)                return 0 ;;
    *)                   return 1 ;;
  esac
}

if is_protected_branch "$HEAD_BRANCH"; then
  log_err "refusing to operate on protected branch: $HEAD_BRANCH"
  exit 1
fi

# ── Safety: clean working tree ──────────────────────────────────────────

if ! git diff --quiet HEAD 2>/dev/null; then
  log_err "working tree is dirty (uncommitted changes); commit or stash first"
  exit 1
fi
if ! git diff --cached --quiet 2>/dev/null; then
  log_err "index has staged changes; commit or reset first"
  exit 1
fi

# Remember where we started so we can return on exit.
ORIGINAL_REF="$(git rev-parse --abbrev-ref HEAD)"
restore_original() {
  if [[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo)" != "$ORIGINAL_REF" ]]; then
    git checkout -q "$ORIGINAL_REF" 2>/dev/null || true
  fi
}
trap restore_original EXIT

# ── Build parent map from gh pr list ────────────────────────────────────
#
# gh pr list returns JSON. We parse it once into 4 parallel arrays keyed
# by index: PR_HEADS / PR_BASES / PR_NUMS / PR_STATES. Bash 3.2 has no
# associative arrays, so we look things up via linear scan helpers.
# That's fine — even a 60-PR repo is trivially small.

log "fetching PR list from origin via gh…"
PR_JSON="$(gh pr list --state=all --limit 500 \
  --json number,title,headRefName,baseRefName,state,mergedAt 2>/dev/null)"

PR_HEADS=()
PR_BASES=()
PR_NUMS=()
PR_STATES=()
PR_TITLES=()

# jq emits one TSV row per PR — robust against weird titles because we
# don't include title in the delimited output.
while IFS=$'\t' read -r n h b s; do
  [[ -z "$n" ]] && continue
  PR_NUMS+=("$n")
  PR_HEADS+=("$h")
  PR_BASES+=("$b")
  PR_STATES+=("$s")
done < <(echo "$PR_JSON" | jq -r '.[] | [.number, .headRefName, .baseRefName, .state] | @tsv')

# Same loop for titles (kept separate so a tab-in-title can't desync).
while IFS= read -r t; do
  PR_TITLES+=("$t")
done < <(echo "$PR_JSON" | jq -r '.[].title')

if [[ ${#PR_NUMS[@]} -eq 0 ]]; then
  log_err "no PRs returned by gh — nothing to do"
  exit 1
fi

# Helpers — linear scan over PR_HEADS to find a PR by its head branch.

# pr_index_for_head <branch> → echoes the index, or empty string.
pr_index_for_head() {
  local target="$1" i
  for i in "${!PR_HEADS[@]}"; do
    if [[ "${PR_HEADS[$i]}" == "$target" ]]; then
      echo "$i"
      return 0
    fi
  done
  echo ""
}

# pr_num_for_branch <branch> → echoes PR number, or empty string.
pr_num_for_branch() {
  local target="$1" i
  for i in "${!PR_HEADS[@]}"; do
    if [[ "${PR_HEADS[$i]}" == "$target" ]]; then
      echo "${PR_NUMS[$i]}"
      return 0
    fi
  done
  echo ""
  return 1
}

# Summary table — uses the SUMMARY_* arrays populated in the main loop.
# Defined here (before the loop) so the loop can call it on early-exit.
print_summary() {
  echo
  echo "──────────────────────────────────────────────────────────────"
  printf '%-7s %-15s %-30s %s\n' "PR" "Status" "Old base" "New base"
  echo "──────────────────────────────────────────────────────────────"
  local i
  for i in "${!SUMMARY_NUMS[@]}"; do
    printf '#%-6s %-15s %-30s %s\n' \
      "${SUMMARY_NUMS[$i]}" \
      "${SUMMARY_STATUS[$i]}" \
      "${SUMMARY_OLDBASE[$i]}" \
      "${SUMMARY_NEWBASE[$i]}"
  done
  echo "──────────────────────────────────────────────────────────────"
}

# ── Walk the chain ──────────────────────────────────────────────────────
#
# Starting from HEAD_BRANCH, descend via baseRefName until we hit main
# (no more parent) or an OPEN parent (we shouldn't rebase past those —
# they aren't merged yet, so rewriting them would lose work).

CHAIN_HEADS=()
CHAIN_NUMS=()
CHAIN_OLDBASES=()
CHAIN_PARENT_STATES=()

current="$HEAD_BRANCH"
while :; do
  idx="$(pr_index_for_head "$current")"
  if [[ -z "$idx" ]]; then
    log_warn "no PR found with head=$current — chain ends here"
    break
  fi

  parent="${PR_BASES[$idx]}"
  num="${PR_NUMS[$idx]}"

  CHAIN_HEADS+=("$current")
  CHAIN_NUMS+=("$num")
  CHAIN_OLDBASES+=("$parent")

  # Parent state — main has no PR, treat as "MERGED" virtually.
  if [[ "$parent" == "main" ]]; then
    CHAIN_PARENT_STATES+=("MAIN")
    break
  fi

  parent_idx="$(pr_index_for_head "$parent")"
  if [[ -z "$parent_idx" ]]; then
    # Parent branch isn't tied to a PR — treat as terminal/unknown.
    CHAIN_PARENT_STATES+=("UNKNOWN")
    break
  fi
  parent_state="${PR_STATES[$parent_idx]}"
  CHAIN_PARENT_STATES+=("$parent_state")

  if [[ "$parent_state" != "MERGED" ]]; then
    # Parent isn't merged — we cannot rebase further down. Stop walking.
    # We still keep this entry in the chain so the summary shows it.
    break
  fi

  # Continue walking: the parent's parent (if any).
  current="$parent"
done

if [[ ${#CHAIN_NUMS[@]} -eq 0 ]]; then
  log "no chain found from --head $HEAD_BRANCH; nothing to do"
  exit 0
fi

log "chain depth: ${#CHAIN_NUMS[@]} PR(s)"

# ── Determine which PRs are eligible for rebase ─────────────────────────
#
# A PR is eligible iff its parent state is MERGED (parent branch is gone
# from origin after the squash-merge). Parents in MAIN/UNKNOWN/OPEN are
# skipped — main means already correctly based, OPEN means we'd rewrite
# someone else's still-open work, UNKNOWN we can't reason about.
#
# Apply --limit here.

# Status is one of: rebased | conflict | skipped | dry-run-rebase
SUMMARY_NUMS=()
SUMMARY_STATUS=()
SUMMARY_OLDBASE=()
SUMMARY_NEWBASE=()

git fetch -q origin main

processed=0
for i in "${!CHAIN_NUMS[@]}"; do
  num="${CHAIN_NUMS[$i]}"
  head="${CHAIN_HEADS[$i]}"
  oldbase="${CHAIN_OLDBASES[$i]}"
  pstate="${CHAIN_PARENT_STATES[$i]}"

  if [[ "$pstate" != "MERGED" ]]; then
    SUMMARY_NUMS+=("$num")
    SUMMARY_OLDBASE+=("$oldbase")
    if [[ "$pstate" == "MAIN" ]]; then
      SUMMARY_STATUS+=("skipped")
      SUMMARY_NEWBASE+=("main (no change)")
    else
      # Parent OPEN/UNKNOWN — flag clearly.
      SUMMARY_STATUS+=("skipped")
      SUMMARY_NEWBASE+=("$oldbase ($(echo "$pstate" | tr '[:upper:]' '[:lower:]'))")
    fi
    continue
  fi

  # Parent is MERGED — eligible.
  if [[ $LIMIT -gt 0 && $processed -ge $LIMIT ]]; then
    log "limit $LIMIT reached — stopping further rebases"
    SUMMARY_NUMS+=("$num")
    SUMMARY_STATUS+=("skipped")
    SUMMARY_OLDBASE+=("$oldbase")
    SUMMARY_NEWBASE+=("(over --limit)")
    continue
  fi

  log "PR #$num: parent #$(pr_num_for_branch "$oldbase" 2>/dev/null || echo "?") ($oldbase) merged → rebasing onto main"

  if is_protected_branch "$head"; then
    log_warn "PR #$num head is a protected branch ($head); skipping"
    SUMMARY_NUMS+=("$num")
    SUMMARY_STATUS+=("skipped")
    SUMMARY_OLDBASE+=("$oldbase")
    SUMMARY_NEWBASE+=("PROTECTED")
    continue
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    # Dry-run — describe what we would do, don't touch anything.
    log "  dry-run: git fetch origin main"
    log "  dry-run: git checkout $head"
    log "  dry-run: git rebase --onto origin/main $oldbase $head"
    log "  dry-run: git push --force-with-lease origin $head"
    log "  dry-run: gh pr edit $num --base main"
    SUMMARY_NUMS+=("$num")
    SUMMARY_STATUS+=("dry-run-rebase")
    SUMMARY_OLDBASE+=("$oldbase")
    SUMMARY_NEWBASE+=("main")
    processed=$((processed + 1))
    continue
  fi

  # ── Real run ──
  # Make sure local branch tracks origin's tip so we don't rebase a stale copy.
  git fetch -q origin "$head:$head" 2>/dev/null || true
  if ! git checkout -q "$head" 2>/dev/null; then
    log_err "PR #$num: failed to checkout $head"
    SUMMARY_NUMS+=("$num")
    SUMMARY_STATUS+=("conflict")
    SUMMARY_OLDBASE+=("$oldbase")
    SUMMARY_NEWBASE+=("CHECKOUT FAILED — manual rebase")
    exit 2
  fi

  # Rebase. --onto origin/main <oldbase> <head> = "take commits between
  # <oldbase> and <head>, replay onto origin/main".
  if ! git rebase --onto origin/main "$oldbase" "$head"; then
    log_err "PR #$num: rebase conflict against origin/main"
    log_err "  aborting rebase; resolve manually:"
    log_err "    git checkout $head && git rebase --onto origin/main $oldbase $head"
    git rebase --abort 2>/dev/null || true
    SUMMARY_NUMS+=("$num")
    SUMMARY_STATUS+=("conflict")
    SUMMARY_OLDBASE+=("$oldbase")
    SUMMARY_NEWBASE+=("SKIPPED — manual rebase")
    print_summary
    exit 2
  fi

  # Push (force-with-lease — never plain force).
  if ! git push --force-with-lease origin "$head"; then
    log_err "PR #$num: force-with-lease push failed (remote moved?)"
    SUMMARY_NUMS+=("$num")
    SUMMARY_STATUS+=("conflict")
    SUMMARY_OLDBASE+=("$oldbase")
    SUMMARY_NEWBASE+=("PUSH FAILED — manual rebase")
    print_summary
    exit 2
  fi

  # Retarget the GH PR base.
  if ! gh pr edit "$num" --base main >/dev/null 2>&1; then
    log_warn "PR #$num: gh pr edit --base main failed (already main?); continuing"
  fi

  SUMMARY_NUMS+=("$num")
  SUMMARY_STATUS+=("rebased")
  SUMMARY_OLDBASE+=("$oldbase")
  SUMMARY_NEWBASE+=("main")
  processed=$((processed + 1))
done

print_summary
exit 0
