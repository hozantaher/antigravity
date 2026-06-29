#!/usr/bin/env bash
# Decide if user is "active" (don't run bot) or "idle" (bot may run).
#
# Output:
#   "active" + exit 0 = bot must NOT run (user has recent commits)
#   "paused" + exit 1 = manual override via .agent-status (bot must NOT run)
#   "idle"   + exit 0 = bot may run
#
# Decision rules:
#   1. .agent-status contains "paused" → paused
#   2. Latest commit by GIT_USER on tracked branches < THRESHOLD_MIN → active
#   3. Otherwise → idle
#
# Override env:
#   PRESENCE_THRESHOLD_MIN  (default 90)
#   GIT_USER                (default "Tomáš Messing")

set -euo pipefail

THRESHOLD_MIN="${PRESENCE_THRESHOLD_MIN:-90}"
GIT_USER="${GIT_USER:-Tomáš Messing}"

# 1. Manual kill switch
if [ -f .agent-status ] && grep -qi paused .agent-status; then
  echo paused
  exit 1
fi

# 2. Recent human commit detection across all branches
threshold_epoch=$(( $(date +%s) - THRESHOLD_MIN * 60 ))
last_human_epoch=$(git log --all --author="$GIT_USER" --since="${THRESHOLD_MIN} minutes ago" -1 --format=%ct 2>/dev/null || true)

if [ -n "${last_human_epoch:-}" ] && [ "$last_human_epoch" -ge "$threshold_epoch" ]; then
  echo active
  exit 0
fi

# 3. Idle
echo idle
exit 0
