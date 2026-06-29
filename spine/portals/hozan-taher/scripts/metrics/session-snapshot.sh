#!/usr/bin/env bash
# session-snapshot.sh — emit a daily measurement of repo / agent / dev velocity
#
# Purpose: build baseline so "are we improving autonomous development?" becomes
# answerable with data instead of vibes.
#
# Output: docs/audits/sessions/YYYY-MM-DD.md (one row per day)
# Run: ./scripts/metrics/session-snapshot.sh
# Cron: daily at 23:55 UTC (or whenever the orchestrator wraps up)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

DATE_UTC="$(date -u +%Y-%m-%d)"
TIME_UTC="$(date -u +%H:%M:%SZ)"
OUT_DIR="docs/audits/sessions"
OUT_FILE="$OUT_DIR/$DATE_UTC.md"

mkdir -p "$OUT_DIR"

# --- repo stats (fast, deterministic) -------------------------------------

# 24h commit window on origin/main
COMMITS_24H=$(git log --since="24 hours ago" --pretty=oneline origin/main 2>/dev/null | wc -l | tr -d ' ')

# 7d commit window
COMMITS_7D=$(git log --since="7 days ago" --pretty=oneline origin/main 2>/dev/null | wc -l | tr -d ' ')

# Open PR counts (depends on gh auth; fall back to "?")
OPEN_PRS=$(gh pr list --state open --json number 2>/dev/null | jq 'length' 2>/dev/null || echo "?")
MERGED_24H=$(gh pr list --state merged --search "merged:>=$(date -u -v-24H +%Y-%m-%d 2>/dev/null || date -u --date='24 hours ago' +%Y-%m-%d)" --json number 2>/dev/null | jq 'length' 2>/dev/null || echo "?")
MERGED_7D=$(gh pr list --state merged --search "merged:>=$(date -u -v-7d +%Y-%m-%d 2>/dev/null || date -u --date='7 days ago' +%Y-%m-%d)" --json number 2>/dev/null | jq 'length' 2>/dev/null || echo "?")

# Open issues with KT-A* / KT-B* labels (kampaň výkupu techniky)
KT_OPEN=$(gh issue list --state open --search "KT-A in:title OR KT-B in:title" --json number 2>/dev/null | jq 'length' 2>/dev/null || echo "?")

# Conflicting PRs (drift signal)
CONFLICTING_PRS=$(gh pr list --state open --json mergeable 2>/dev/null | jq '[.[] | select(.mergeable=="CONFLICTING")] | length' 2>/dev/null || echo "?")

# CI failure rate last 24h (proxy for billing/infra issues)
CI_FAIL_24H=$(gh run list --status failure --limit 100 --json conclusion,createdAt 2>/dev/null | jq "[.[] | select(.createdAt > \"$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u --date='24 hours ago' +%Y-%m-%dT%H:%M:%SZ)\")] | length" 2>/dev/null || echo "?")

# Memory entries count (proxy for "what we've learned")
MEMORY_DIR="$HOME/.claude/projects/-Users-messingtomas-Documents-Projekty-hozan-taher/memory"
if [ -d "$MEMORY_DIR" ]; then
  MEMORY_FILES=$(find "$MEMORY_DIR" -maxdepth 1 -name "*.md" -not -name "MEMORY.md" | wc -l | tr -d ' ')
else
  MEMORY_FILES="?"
fi

# Initiative docs (active plans)
INIT_DOCS=$(find docs/initiatives -maxdepth 1 -name "*.md" -not -name "README.md" 2>/dev/null | wc -l | tr -d ' ')

# --- write snapshot --------------------------------------------------------

cat > "$OUT_FILE" <<EOF
# Session snapshot — $DATE_UTC

Generated $TIME_UTC by \`scripts/metrics/session-snapshot.sh\`.

## Repo velocity

| Metric | Value |
|---|---|
| Commits on origin/main (24h) | $COMMITS_24H |
| Commits on origin/main (7d) | $COMMITS_7D |
| Open PRs | $OPEN_PRS |
| Merged PRs (24h) | $MERGED_24H |
| Merged PRs (7d) | $MERGED_7D |
| CONFLICTING PRs (drift signal) | $CONFLICTING_PRS |
| CI runs failed (24h) | $CI_FAIL_24H |

## Active initiative

| Metric | Value |
|---|---|
| Open KT-* issues (kampaň výkupu techniky) | $KT_OPEN |
| Initiative docs in docs/initiatives/ | $INIT_DOCS |

## Memory state

| Metric | Value |
|---|---|
| Memory files in user/feedback/project/reference | $MEMORY_FILES |

## Manual fields (fill at end of session)

- **Interventions count** (times user redirected/corrected): _TBD_
- **Stuck agents** (background agents that did not complete cleanly): _TBD_
- **Notable decisions** (1-3 bullet points): _TBD_

## Honest reflection

What slowed us down today (be specific, no platitudes):

_TBD — fill at end of session_

What worked (be specific):

_TBD_

EOF

echo "Wrote $OUT_FILE"
echo ""
echo "--- 24h summary ---"
echo "Commits: $COMMITS_24H | Merged: $MERGED_24H | Open: $OPEN_PRS | Conflicting: $CONFLICTING_PRS | CI fail: $CI_FAIL_24H"
