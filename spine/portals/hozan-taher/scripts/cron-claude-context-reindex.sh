#!/usr/bin/env bash

# claude-context daily auto-reindex cron script
# Triggered daily at 03:00 Prague time via launchd/crontab
# Purpose: Keep semantic code search index fresh (max 24h stale)

set -euo pipefail

# Config
CODEBASE_PATH="/Users/messingtomas/Documents/Projekty/hozan-taher"
LOG_FILE="${HOME}/.cache/claude-context-reindex.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Ensure log dir exists
mkdir -p "$(dirname "$LOG_FILE")"

# Log function
log() {
  echo "[${TIMESTAMP}] $*" >> "$LOG_FILE"
}

# Main reindex operation
main() {
  log "========== claude-context reindex started =========="

  # Validate codebase exists
  if [ ! -d "$CODEBASE_PATH" ]; then
    log "ERROR: Codebase not found at $CODEBASE_PATH"
    exit 1
  fi

  # Check if claude CLI is available
  if ! command -v claude &> /dev/null; then
    log "ERROR: claude CLI not found in PATH"
    exit 2
  fi

  # Run reindex with force flag
  # This invokes the MCP tool mcp__claude-context__index_codebase
  if claude-context-reindex "$CODEBASE_PATH" --force 2>&1 | tee -a "$LOG_FILE"; then
    log "SUCCESS: Index refreshed"
    exit 0
  else
    log "ERROR: Reindex failed with exit code $?"
    exit 3
  fi
}

main "$@"
