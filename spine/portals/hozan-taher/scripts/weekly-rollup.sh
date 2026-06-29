#!/usr/bin/env bash
# weekly-rollup.sh — draft a weekly project rollup from gh CLI + git log.
#
# Purpose: Populate docs/rollups/YYYY-WW-weekly.md from TEMPLATE-weekly.md with
# real PRs / commits / CI pass rate / issue counts. Reviewer must still fill in
# the interpretive sections (Notable, Blockers, Next week focus, Audit delta).
#
# Usage:
#   scripts/weekly-rollup.sh                        # defaults: today-7d .. today
#   scripts/weekly-rollup.sh 2026-04-15 2026-04-21  # explicit dates
#
# Output:
#   docs/rollups/YYYY-WW-weekly.md (drafted, not committed)
#
# Deps: bash 3.2+, gh CLI (authenticated), git, date (BSD or GNU).
# Non-zero exit on dependency missing, template missing, or write failure.
# Reviewer must: (1) verify numbers, (2) fill in analysis, (3) commit manually.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

TEMPLATE="docs/rollups/TEMPLATE-weekly.md"
ROLLUP_DIR="docs/rollups"

# --- deps check --------------------------------------------------------------

for bin in gh git; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "error: missing dependency '$bin'" >&2
    exit 2
  fi
done

if [[ ! -f "$TEMPLATE" ]]; then
  echo "error: template not found at $TEMPLATE" >&2
  exit 2
fi

# --- date handling (portable across BSD/GNU date) ----------------------------

date_7d_ago() {
  if date -v-7d +%Y-%m-%d >/dev/null 2>&1; then
    date -v-7d +%Y-%m-%d
  else
    date -d "7 days ago" +%Y-%m-%d
  fi
}

date_next_friday() {
  if date -v+7d +%Y-%m-%d >/dev/null 2>&1; then
    date -v+7d +%Y-%m-%d
  else
    date -d "7 days" +%Y-%m-%d
  fi
}

START_DATE="${1:-$(date_7d_ago)}"
END_DATE="${2:-$(date +%Y-%m-%d)}"
WEEK="$(date +%G-W%V)"
GENERATED_AT="$(date +%Y-%m-%d\ %H:%M)"
AUTHOR="$(git config user.name || echo 'unknown')"
NEXT_FRIDAY="$(date_next_friday)"
OUT="$ROLLUP_DIR/${WEEK}-weekly.md"

mkdir -p "$ROLLUP_DIR"

if [[ -f "$OUT" ]]; then
  echo "warn: $OUT already exists — overwriting draft" >&2
fi

cp "$TEMPLATE" "$OUT"

# --- data collection ---------------------------------------------------------

echo "→ collecting data for $START_DATE .. $END_DATE"

MERGED_PRS_ROWS=""
MERGED_COUNT=0
if gh auth status >/dev/null 2>&1; then
  MERGED_PRS_JSON="$(gh pr list --state merged --limit 100 \
    --search "merged:>=${START_DATE}" \
    --json number,title,author,additions,deletions 2>/dev/null || echo '[]')"
  MERGED_PRS_ROWS="$(echo "$MERGED_PRS_JSON" | \
    jq -r '.[] | "| #\(.number) | \(.title | gsub("\\|"; "\\|")) | \(.author.login) | +\(.additions)/-\(.deletions) | _(fill in)_ |"' \
    2>/dev/null || echo '')"
  MERGED_COUNT="$(echo "$MERGED_PRS_JSON" | jq 'length' 2>/dev/null || echo 0)"

  OPEN_PRS_JSON="$(gh pr list --state open --limit 50 \
    --json number,title,createdAt,isDraft,mergeable 2>/dev/null || echo '[]')"
  # age > 3 days filter
  OPEN_PRS_ROWS="$(echo "$OPEN_PRS_JSON" | jq -r --arg now "$(date +%s)" '
    .[] |
    ((($now | tonumber) - ((.createdAt | fromdateiso8601))) / 86400 | floor) as $age |
    select($age > 3) |
    "| #\(.number) | \($age) | \(if .isDraft then "draft" else .mergeable end) | _(fill in)_ |"
  ' 2>/dev/null || echo '')"
  OPEN_COUNT="$(echo "$OPEN_PRS_JSON" | jq 'length' 2>/dev/null || echo 0)"

  ISSUES_CLOSED="$(gh issue list --state closed --limit 100 \
    --search "closed:>=${START_DATE}" --json number 2>/dev/null | \
    jq 'length' 2>/dev/null || echo 0)"
  ISSUES_OPENED="$(gh issue list --state all --limit 100 \
    --search "created:>=${START_DATE}" --json number 2>/dev/null | \
    jq 'length' 2>/dev/null || echo 0)"
  ISSUES_DELTA=$((ISSUES_OPENED - ISSUES_CLOSED))

  # CI pass rate
  CI_JSON="$(gh run list --limit 100 --created ">=${START_DATE}" \
    --json conclusion 2>/dev/null || echo '[]')"
  CI_GREEN="$(echo "$CI_JSON" | jq '[.[] | select(.conclusion=="success")] | length' 2>/dev/null || echo 0)"
  CI_TOTAL="$(echo "$CI_JSON" | jq '[.[] | select(.conclusion!=null and .conclusion!="")] | length' 2>/dev/null || echo 0)"
  if [[ "$CI_TOTAL" -gt 0 ]]; then
    CI_PASS_RATE=$(( (CI_GREEN * 100) / CI_TOTAL ))
  else
    CI_PASS_RATE=0
  fi
else
  echo "warn: gh CLI not authenticated — skipping PR/issue/CI fetch" >&2
  OPEN_COUNT=0
  ISSUES_OPENED=0
  ISSUES_CLOSED=0
  ISSUES_DELTA=0
  CI_GREEN=0
  CI_TOTAL=0
  CI_PASS_RATE=0
fi

# Commits on main
COMMITS_COUNT="$(git log --since="$START_DATE" --until="$END_DATE" \
  --oneline main 2>/dev/null | wc -l | tr -d ' ')"
COMMITS_SAMPLE="$(git log --since="$START_DATE" --until="$END_DATE" \
  --pretty=format:'- %h %s' main 2>/dev/null | head -10 || echo '_(no commits)_')"

# --- template substitution (portable sed — write via awk to avoid escape hell)-

python3 - "$OUT" <<PYEOF
import sys, pathlib
path = pathlib.Path(sys.argv[1])
txt = path.read_text()
subs = {
    "{{WEEK}}": """${WEEK}""",
    "{{START_DATE}}": """${START_DATE}""",
    "{{END_DATE}}": """${END_DATE}""",
    "{{GENERATED_AT}}": """${GENERATED_AT}""",
    "{{AUTHOR}}": """${AUTHOR}""",
    "{{NEXT_FRIDAY}}": """${NEXT_FRIDAY}""",
    "{{MERGED_PRS_ROWS}}": """${MERGED_PRS_ROWS}""" or "| _(none)_ | | | | |",
    "{{MERGED_COUNT}}": """${MERGED_COUNT}""",
    "{{OPEN_PRS_ROWS}}": """${OPEN_PRS_ROWS}""" or "| _(none)_ | | | |",
    "{{OPEN_COUNT}}": """${OPEN_COUNT}""",
    "{{COMMITS_COUNT}}": """${COMMITS_COUNT}""",
    "{{COMMITS_SAMPLE}}": """${COMMITS_SAMPLE}""" or "_(no commits)_",
    "{{CI_GREEN}}": """${CI_GREEN}""",
    "{{CI_TOTAL}}": """${CI_TOTAL}""",
    "{{CI_PASS_RATE}}": """${CI_PASS_RATE}""",
    "{{ISSUES_OPENED}}": """${ISSUES_OPENED}""",
    "{{ISSUES_CLOSED}}": """${ISSUES_CLOSED}""",
    "{{ISSUES_DELTA}}": """${ISSUES_DELTA}""",
    "{{TASK_ID}}": "_(fill in)_",
    "{{TASK_TITLE}}": "_(fill in)_",
    "{{REVIEWED_AT}}": "_(fill in on review)_",
}
for k, v in subs.items():
    txt = txt.replace(k, v)
path.write_text(txt)
PYEOF

echo ""
echo "drafted: $OUT"
echo ""
echo "next steps:"
echo "  1. review numbers + fill in analysis sections"
echo "  2. git add $OUT"
echo "  3. git commit -m 'chore(rollup): week $WEEK'"
