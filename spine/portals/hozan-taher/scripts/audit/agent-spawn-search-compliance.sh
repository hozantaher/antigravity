#!/usr/bin/env bash
# Audit script — per T2.3 from synthesis PR #428.
#
# Scanuje recent merged PRs (last 24h) + extrahuje compliance score
# pro `feedback_search_before_implement` rule:
#   - Per PR: regex match na "search-first" / "git grep" / "search_code"
#     v PR description nebo body
#   - Output: compliance % + per-PR list (PR # | compliant Y/N)
#
# Cíl: trend ↑ z 29 % baseline (per PR #422 inventory) na 70%+.
#
# Usage:
#   bash scripts/audit/agent-spawn-search-compliance.sh
#   bash scripts/audit/agent-spawn-search-compliance.sh --since "2 days ago"
#
# Reference: docs/audits/2026-04-30-deep-inventory-autonomous-dev.md

set -euo pipefail

SINCE="${1:-1 day ago}"

# Pattern co indikuje search-first compliance
SEARCH_PATTERNS=(
  "search-first"
  "search_before_implement"
  "git grep"
  "search_code"
  "claude-context"
)

# Build extended grep alternation
PATTERN=$(IFS='|'; echo "${SEARCH_PATTERNS[*]}")

# Compute cutoff timestamp (ISO 8601). Filter via jq post-fetch.
# Note: known limitation — gh pr list ordered by created date so older
# PRs may slip through if today's batch >200 merges. For weekly trend
# this is OK; for tighter accuracy, iterate paginated fetch.
if cutoff=$(date -v-1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null); then
  : # macOS BSD date
else
  cutoff=$(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)  # GNU date
fi
PRS_JSON=$(gh pr list --state=merged --limit 200 --json number,title,body,mergedAt 2>/dev/null \
  | jq --arg cutoff "$cutoff" '[.[] | select(.mergedAt != null and .mergedAt >= $cutoff)]' 2>/dev/null \
  || echo '[]')

TOTAL=0
COMPLIANT=0

# Header
printf "%-6s %-3s %s\n" "PR" "OK" "Title"
printf '%s\n' "----------------------------------------------------------------------"

# Process each PR
echo "$PRS_JSON" | jq -c '.[]' | while read -r row; do
  num=$(echo "$row" | jq -r '.number')
  title=$(echo "$row" | jq -r '.title' | head -c 60)
  body=$(echo "$row" | jq -r '.body // ""')

  if echo "$body" | grep -qE "$PATTERN"; then
    flag="Y"
  else
    flag="N"
  fi

  printf "%-6s %-3s %s\n" "#$num" "$flag" "$title"
done | tee /tmp/search-compliance.txt

echo
echo "Computing summary…"

# Count rows; strip trailing whitespace from numeric output. Use if/then
# so failed grep doesn't produce concatenated value.
if [[ -s /tmp/search-compliance.txt ]]; then
  TOTAL=$(grep -c '^#' /tmp/search-compliance.txt | tr -d '[:space:]')
  COMPLIANT=$(awk '$2=="Y"' /tmp/search-compliance.txt | wc -l | tr -d '[:space:]')
else
  TOTAL=0
  COMPLIANT=0
fi

if [[ "$TOTAL" -gt 0 ]]; then
  PCT=$(( COMPLIANT * 100 / TOTAL ))
else
  PCT=0
fi

echo
echo "===================================================================="
echo "Search-first compliance: $COMPLIANT / $TOTAL PRs ($PCT %)"
echo "Baseline (PR #422 audit): 29 %"
echo "Target: ≥70 %"
echo "===================================================================="

# Append JSONL audit row
AUDIT_FILE="docs/audits/search-compliance.jsonl"
mkdir -p "$(dirname "$AUDIT_FILE")"
printf '{"ts":"%s","since":"%s","total":%d,"compliant":%d,"pct":%d}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SINCE" "$TOTAL" "$COMPLIANT" "$PCT" \
  >> "$AUDIT_FILE"

# Exit code: 0 if ≥70%, 1 if 50-69%, 2 if <50%
if [[ "$PCT" -ge 70 ]]; then exit 0
elif [[ "$PCT" -ge 50 ]]; then exit 1
else exit 2
fi
