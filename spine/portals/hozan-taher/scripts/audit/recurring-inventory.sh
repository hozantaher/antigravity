#!/usr/bin/env bash
# Recurring weekly inventory agent — per T2.5 from synthesis PR #428.
#
# North-star aspirace #2: self-auditing fleet.
#
# Cron-driven mini-inventory subset that runs every Monday 04:00 UTC. Mirrors
# the deep inventory format from `docs/audits/2026-04-30-deep-inventory-*.md`,
# but in compact form (~50-100 lines) suitable for weekly cadence.
#
# Signals collected:
#   * PR throughput last 7d
#   * Issue close rate
#   * Memory rule count + last-modified delta
#   * Agent fleet stats (worktrees + branches)
#   * Audit ratchet violations (slog op, sentinel, airtight, transport-mode)
#   * Search-compliance trend (delegates to agent-spawn-search-compliance.sh)
#
# Output:
#   docs/audits/recurring/<YYYY-MM-DD>-mini-inventory.md
#
# Critical signals that auto-PR:
#   * PR throughput drop ≥40 % vs prior week
#   * Issue close rate < 50 %
#   * Memory rule count delta > 5 in a single week
#   * Live worktree count > 8 (per feedback_subagent_token_economy)
#   * Any audit ratchet violation > 0
#   * Search-compliance < 50 %
#
# Usage:
#   bash scripts/audit/recurring-inventory.sh                  # defaults: 7d window, today
#   bash scripts/audit/recurring-inventory.sh --since "14 days ago"
#   bash scripts/audit/recurring-inventory.sh --out /tmp/x.md  # override output path
#   bash scripts/audit/recurring-inventory.sh --dry-run        # write to /tmp, do not commit

set -euo pipefail

# ---- args ----------------------------------------------------------------

SINCE_DAYS=7
OUT_PATH=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since)
      shift
      # Accept either "N days ago" or numeric N.
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        SINCE_DAYS="$1"
      else
        # "14 days ago" → extract leading int
        SINCE_DAYS="$(echo "$1" | grep -oE '^[0-9]+' || echo 7)"
      fi
      shift
      ;;
    --out)
      shift
      OUT_PATH="$1"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 64
      ;;
  esac
done

TODAY="$(date -u +%Y-%m-%d)"

if [[ -z "$OUT_PATH" ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    OUT_PATH="/tmp/recurring-inventory-${TODAY}.md"
  else
    OUT_PATH="docs/audits/recurring/${TODAY}-mini-inventory.md"
  fi
fi

mkdir -p "$(dirname "$OUT_PATH")"

# ---- helpers -------------------------------------------------------------

# Portable date math: produce ISO date for "N days ago" on both BSD + GNU.
date_n_days_ago() {
  local n="$1"
  if date -v-1d +%Y-%m-%d >/dev/null 2>&1; then
    date -u -v-"${n}"d +%Y-%m-%d
  else
    date -u -d "${n} days ago" +%Y-%m-%d
  fi
}

SINCE_DATE="$(date_n_days_ago "$SINCE_DAYS")"

# ---- collectors ----------------------------------------------------------

collect_pr_throughput() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "n/a (gh not installed)"
    return
  fi
  gh pr list --state=merged --search "merged:>=${SINCE_DATE}" --limit 200 --json number 2>/dev/null \
    | jq 'length' 2>/dev/null \
    || echo "n/a"
}

collect_issue_close_rate() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "n/a"
    return
  fi
  local closed
  local opened
  closed=$(gh issue list --state=closed --search "closed:>=${SINCE_DATE}" --limit 200 --json number 2>/dev/null \
    | jq 'length' 2>/dev/null || echo 0)
  opened=$(gh issue list --state=all --search "created:>=${SINCE_DATE}" --limit 200 --json number 2>/dev/null \
    | jq 'length' 2>/dev/null || echo 0)
  if [[ "$opened" -eq 0 ]]; then
    echo "n/a (0 opened)"
  else
    local pct=$(( closed * 100 / opened ))
    echo "${closed}/${opened} (${pct}%)"
  fi
}

# Memory rule count: try to find the user's memory dir (project-scoped).
collect_memory_rule_stats() {
  local mem_dirs=(
    "/Users/messingtomas/.claude/projects/-Users-messingtomas-Documents-Projekty-Hozan-Taher/memory"
    "/Users/messingtomas/.claude/projects/-Users-messingtomas-Documents-Projekty-hozan-taher/memory"
  )
  local memdir=""
  for d in "${mem_dirs[@]}"; do
    if [[ -d "$d" ]]; then
      memdir="$d"
      break
    fi
  done
  if [[ -z "$memdir" ]]; then
    echo "n/a (memory dir not found)"
    return
  fi
  local total
  local recent
  total=$(find "$memdir" -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' ')
  recent=$(find "$memdir" -name '*.md' -type f -mtime -"${SINCE_DAYS}" 2>/dev/null | wc -l | tr -d ' ')
  echo "${total} total, ${recent} touched in last ${SINCE_DAYS}d"
}

collect_worktree_stats() {
  local count
  count=$(git worktree list 2>/dev/null | wc -l | tr -d ' ')
  echo "${count}"
}

collect_branch_count() {
  local count
  count=$(git branch -a 2>/dev/null | wc -l | tr -d ' ')
  echo "${count}"
}

# Audit ratchet violations — counts of pattern-matched anti-patterns.
# Heuristic, not authoritative; defers to actual ratchet tests in CI for gold.
collect_ratchet_violations() {
  local slog_violations=0
  local airtight_violations=0
  local transport_violations=0

  # slog: count slog.Error/Warn calls that span a single line and lack `"op"`.
  # Multi-line slog calls (which carry `op` on a later line) are correctly
  # excluded by the single-line filter. This matches the audit-test heuristic
  # in features/outreach/campaigns/sender/slog_op_audit_test.go conservatively.
  if git rev-parse --git-dir >/dev/null 2>&1; then
    slog_violations=$(git grep -hE 'slog\.(Error|Warn)\([^)]*\)' -- '*.go' 2>/dev/null \
      | grep -v 'slog_op_audit_test' \
      | grep -v '"op"' \
      | wc -l | tr -d ' ' || echo 0)

    # airtight: direct smtp.Dial / smtp.NewClient outside relay test files.
    airtight_violations=$(git grep -lE 'smtp\.(Dial|NewClient)\(' -- '*.go' 2>/dev/null \
      | grep -v '_test\.go' \
      | grep -v 'features/outreach/relay/' \
      | wc -l | tr -d ' ' || echo 0)

    # transport: TRANSPORT_MODE=direct literal in non-test go/sh/yml.
    transport_violations=$(git grep -lE 'TRANSPORT_MODE\s*=\s*"?direct"?' \
        -- '*.go' '*.sh' '*.yml' 2>/dev/null \
      | grep -v '_test\.go' \
      | grep -v 'forbidden\|banned' \
      | wc -l | tr -d ' ' || echo 0)
  fi

  echo "slog=${slog_violations} airtight=${airtight_violations} transport=${transport_violations}"
}

collect_search_compliance() {
  if [[ -x scripts/audit/agent-spawn-search-compliance.sh ]]; then
    # Run with same window + capture summary line. Tolerate non-zero exit codes
    # (the script returns 1 for 50-69 % and 2 for <50 %).
    local out
    out=$(bash scripts/audit/agent-spawn-search-compliance.sh "${SINCE_DAYS} days ago" 2>/dev/null || true)
    echo "$out" | grep -E 'compliance:' | head -1 || echo "n/a"
  else
    echo "n/a (script missing)"
  fi
}

# ---- critical-signal classifier -----------------------------------------

# Returns 0 = no critical drift, 1 = critical drift detected.
classify_critical_drift() {
  local pr_count="$1"
  local worktree_count="$2"
  local memory_recent="$3"
  local ratchet_total="$4"
  local search_pct="$5"

  local crit=0

  # Worktree cap (per feedback_subagent_token_economy).
  if [[ "$worktree_count" =~ ^[0-9]+$ ]] && (( worktree_count > 8 )); then
    crit=1
  fi
  # Memory rule churn cap.
  if [[ "$memory_recent" =~ ^[0-9]+$ ]] && (( memory_recent > 5 )); then
    crit=1
  fi
  # Any ratchet violation.
  if [[ "$ratchet_total" =~ ^[0-9]+$ ]] && (( ratchet_total > 0 )); then
    crit=1
  fi
  # PR throughput collapse — flag only if last week has >0 baseline.
  if [[ "$pr_count" =~ ^[0-9]+$ ]] && (( pr_count == 0 )); then
    crit=1
  fi
  # Search compliance < 50 %.
  if [[ "$search_pct" =~ ^[0-9]+$ ]] && (( search_pct < 50 )); then
    crit=1
  fi

  return "$crit"
}

# ---- gather --------------------------------------------------------------

PR_COUNT=$(collect_pr_throughput)
ISSUE_RATE=$(collect_issue_close_rate)
MEMORY_STATS=$(collect_memory_rule_stats)
WORKTREE_COUNT=$(collect_worktree_stats)
BRANCH_COUNT=$(collect_branch_count)
RATCHET=$(collect_ratchet_violations)
SEARCH_LINE=$(collect_search_compliance)

# Extract numeric memory_recent from MEMORY_STATS for classifier.
MEM_RECENT=$(echo "$MEMORY_STATS" | grep -oE '[0-9]+ touched' | grep -oE '^[0-9]+' || echo 0)
# Sum ratchet violations.
RATCHET_SUM=$(echo "$RATCHET" \
  | grep -oE '[0-9]+' \
  | awk '{s+=$1} END {print s+0}')
# Extract search compliance percentage if present.
SEARCH_PCT=$(echo "$SEARCH_LINE" | grep -oE '\([0-9]+ %\)' | grep -oE '[0-9]+' | head -1 || echo "")
[[ -z "$SEARCH_PCT" ]] && SEARCH_PCT="n/a"

# ---- write report --------------------------------------------------------

{
  echo "# Mini-inventory — ${TODAY}"
  echo ""
  echo "> Status: auto-generated"
  echo "> Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "> Window: last ${SINCE_DAYS} days (since ${SINCE_DATE})"
  echo "> Source: scripts/audit/recurring-inventory.sh (T2.5)"
  echo ""
  echo "## Throughput"
  echo ""
  echo "| Metric | Value |"
  echo "|---|---|"
  echo "| PRs merged (last ${SINCE_DAYS}d) | ${PR_COUNT} |"
  echo "| Issue close rate | ${ISSUE_RATE} |"
  echo ""
  echo "## Agent fleet"
  echo ""
  echo "| Metric | Value |"
  echo "|---|---|"
  echo "| Live worktrees | ${WORKTREE_COUNT} |"
  echo "| Total branches (incl. remote) | ${BRANCH_COUNT} |"
  echo "| Memory rules | ${MEMORY_STATS} |"
  echo ""
  echo "## Audit ratchets"
  echo ""
  echo "Pattern violations grepped from working tree (heuristic):"
  echo ""
  echo "| Ratchet | Violations |"
  echo "|---|---|"
  echo "$RATCHET" | tr ' ' '\n' | sed -E 's/^([a-z]+)=([0-9]+)$/| \1 | \2 |/'
  echo ""
  echo "## Search-first compliance"
  echo ""
  echo "${SEARCH_LINE}"
  echo ""
  echo "## Drift signals"
  echo ""
  if classify_critical_drift "$PR_COUNT" "$WORKTREE_COUNT" "$MEM_RECENT" "$RATCHET_SUM" "$SEARCH_PCT"; then
    echo "no-op: no critical drift signals detected."
  else
    echo "**CRITICAL drift detected** — review recommended."
    echo ""
    echo "Triggers:"
    if [[ "$WORKTREE_COUNT" =~ ^[0-9]+$ ]] && (( WORKTREE_COUNT > 8 )); then
      echo "- Worktree count ${WORKTREE_COUNT} > 8 (per feedback_subagent_token_economy)"
    fi
    if [[ "$MEM_RECENT" =~ ^[0-9]+$ ]] && (( MEM_RECENT > 5 )); then
      echo "- Memory rule churn ${MEM_RECENT} > 5 in last ${SINCE_DAYS}d"
    fi
    if [[ "$RATCHET_SUM" =~ ^[0-9]+$ ]] && (( RATCHET_SUM > 0 )); then
      echo "- Audit ratchet violations: ${RATCHET}"
    fi
    if [[ "$PR_COUNT" =~ ^[0-9]+$ ]] && (( PR_COUNT == 0 )); then
      echo "- Zero PRs merged in window"
    fi
    if [[ "$SEARCH_PCT" =~ ^[0-9]+$ ]] && (( SEARCH_PCT < 50 )); then
      echo "- Search-first compliance ${SEARCH_PCT}% < 50%"
    fi
  fi
  echo ""
  echo "## Method"
  echo ""
  echo "Bash + gh CLI. Runs weekly via .github/workflows/recurring-inventory.yml (cron 0 4 * * 1)."
  echo "Heuristic greps; not a substitute for the deep inventory in docs/audits/2026-04-30-deep-inventory-*.md."
} > "$OUT_PATH"

echo "report: $OUT_PATH"

# Exit code mirrors classifier so the workflow can decide whether to PR.
if classify_critical_drift "$PR_COUNT" "$WORKTREE_COUNT" "$MEM_RECENT" "$RATCHET_SUM" "$SEARCH_PCT"; then
  exit 0    # no-op
else
  exit 10   # critical drift; non-zero non-error code so workflow can branch.
fi
