#!/bin/bash
# ════════════════════════════════════════════════════════════════════════
# outreach-db automated backup script
# ════════════════════════════════════════════════════════════════════════
#
# Triggered daily by ~/Library/LaunchAgents/com.hozan.outreach-backup.plist
# Uses pg_dump 16 (matches server version). Rotates after 30 days.
#
# Per memory `feedback_verify_volume_before_db_restart` HARD RULE — this
# is the "backup snapshot check" prerequisite for any DB-touching op.
#
# Exit codes:
#   0 — backup OK
#   1 — pg_dump failed
#   2 — backup file unexpectedly small (< 1 MB suggests truncation)
# ════════════════════════════════════════════════════════════════════════

set -eu

BACKUP_DIR="$HOME/outreach-backups"
LOG_FILE="$BACKUP_DIR/backup.log"
RETENTION_DAYS=30
PG_DUMP="/opt/homebrew/opt/postgresql@16/bin/pg_dump"

mkdir -p "$BACKUP_DIR"

# Source DATABASE_URL from .env (avoid hardcoding password)
ENV_FILE="$HOME/Documents/Projekty/hozan-taher/features/platform/outreach-dashboard/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR .env not found at $ENV_FILE" >> "$LOG_FILE"
  exit 1
fi

DATABASE_URL=$(grep '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_FILE="$BACKUP_DIR/outreach-$TIMESTAMP.sql.gz"

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) START backup → $BACKUP_FILE" >> "$LOG_FILE"

if ! "$PG_DUMP" "$DATABASE_URL" --no-owner --no-acl --clean --if-exists 2>>"$LOG_FILE" | gzip -9 > "$BACKUP_FILE"; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) FAILED pg_dump" >> "$LOG_FILE"
  rm -f "$BACKUP_FILE"
  exit 1
fi

# Sanity check: file should be > 1 MB
SIZE_BYTES=$(stat -f%z "$BACKUP_FILE" 2>/dev/null || stat -c%s "$BACKUP_FILE")
if [ "$SIZE_BYTES" -lt 1048576 ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) FAILED file too small ($SIZE_BYTES bytes)" >> "$LOG_FILE"
  rm -f "$BACKUP_FILE"
  exit 2
fi

SIZE_HUMAN=$(du -h "$BACKUP_FILE" | cut -f1)
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) OK backup $SIZE_HUMAN" >> "$LOG_FILE"

# Rotate — delete files older than RETENTION_DAYS
find "$BACKUP_DIR" -name "outreach-*.sql.gz" -type f -mtime +"$RETENTION_DAYS" -delete

# Log keep count
KEPT=$(find "$BACKUP_DIR" -name "outreach-*.sql.gz" -type f | wc -l | tr -d ' ')
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ROTATE kept=$KEPT files retention_days=$RETENTION_DAYS" >> "$LOG_FILE"

exit 0
