# Photo Storage Deployment on Railway

Status: Ready for deployment  
Updated: 2026-05-01  
Owner: Platform team  

## Overview

The orchestrator service (`features/inbound/orchestrator`) persists inbound photo attachments to a Railway persistent volume as part of the photo-parse audit pipeline (Track E, photo_parse_audit, ROPA Činnost č. 6). This playbook documents the setup, retention policy, and cleanup procedures.

## Volume Configuration

### Mount Point
- **Path**: `/data/photos`
- **Size**: 10 GB
- **Retention**: Indefinite (delete only via DSR/Article 17 erasure)
- **Access mode**: Read-write by orchestrator service

### Volume Layout
```
/data/photos/
  {thread_id}/
    {message_id}/
      {sanitized_filename}
```

Example: `/data/photos/12345/abc-def-789/photo.jpg` where:
- `12345` = contact thread ID
- `abc-def-789` = inbound message ID
- `photo.jpg` = sanitized filename (alphanumeric, dash, underscore, dot only)

### Storage Capacity

Baseline calculation (as of 2026-05-01):
- Average photo size: ~600 KB
- Campaign cycle: 4-5 months
- New campaigns per month: ~10
- Photos per campaign: 500-1000
- Monthly growth: ~500 MB (conservative)

**10 GB provides ~20 month headroom.** Monitor storage usage via:
```bash
du -h /data/photos      # Local volume usage
df /data/photos         # Partition capacity
```

## Deployment Steps

### 1. Railway Configuration (Pre-deployment)

The volume is declared in `features/inbound/orchestrator/railway.toml`:

```toml
[[volumes]]
mountPath = "/data/photos"
size = "10Gi"
```

When deployed to Railway:
- The platform creates a persistent volume automatically
- Volume persists across service restarts and redeploys
- Data is not deleted when the service is removed (operator must delete explicitly)

### 2. Env Var Configuration

The orchestrator boot code reads:
```go
root := envconfig.GetOr("PHOTO_VOLUME_DIR", photostore.DefaultRoot)  // default: /data/photos
store := photostore.New(root)
```

No operator action required — the service uses the default mount path.

### 3. Pre-Deploy Sanity Checks

Run `scripts/deploy/preflight.sh` before deploying:

```bash
./scripts/deploy/preflight.sh
# Checks: env vars, DB ping, migrations, region, branch
# Exit code 0 = safe to deploy
```

If `PHOTO_VOLUME_DIR` is not set or is empty, the service falls back to `/data/photos` (the Railway mount).

### 4. Post-Deploy Verification

After the service restarts on Railway, verify:

1. Check service health:
   ```bash
   curl https://orchestrator-prod.railway.app/healthz
   ```
   Response should include `"status": "ok"` (or `"degraded"` if DB is unavailable).

2. Verify volume mount:
   ```bash
   # From orchestrator container or Railway SSH
   ls -la /data/photos
   mkdir -p /data/photos/test-thread/test-msg
   touch /data/photos/test-thread/test-msg/test.txt
   ls /data/photos/test-thread/test-msg/
   rm -rf /data/photos/test-thread  # cleanup
   ```

3. Run integration tests (local only; require `/data/photos` mounted):
   ```bash
   go test -tags=integration ./features/inbound/orchestrator/internal/photostore/
   ```

## Retention & Cleanup

### Indefinite Retention
By default, photos are never deleted. Blobs are indexed in `photo_parse_audit.blob_ref` and can be queried for 7+ years (legal hold for audits).

### GDPR Article 17 (Right to Erasure)

When a contact requests deletion or a thread is DSR'd:

1. **Database cleanup** (`web/handler_dsr.go`):
   - Rows deleted from `photo_parse_audit` (which reference `blob_ref`)
   - Cascade: associated threads and contacts also deleted

2. **Volume cleanup** (must be wired in DSR handler):
   ```go
   // In photoparse or DSR cleanup routine:
   threadDir := filepath.Join(store.Root(), strconv.FormatInt(threadID, 10))
   if err := os.RemoveAll(threadDir); err != nil {
       log.Errorf("photo cleanup failed: %v", err)
       // Log the error but don't block the DSR — DB is the authority
   }
   ```

   - Removes all photos for the thread, regardless of message ID
   - Safe to call even if photos were never stored (dir doesn't exist)

### Capacity Management

If volume approaches capacity:

1. **Identify large threads**:
   ```bash
   du -h /data/photos/ | sort -rh | head -20
   ```

2. **Find orphaned photos** (blob_ref not in DB):
   ```sql
   -- In orchestrator container:
   SELECT COUNT(*) FROM photo_parse_audit;
   
   -- Compare to filesystem:
   find /data/photos -type f | wc -l
   
   -- If file count >> row count, investigate filesystem leaks
   ```

3. **Manual cleanup** (use with extreme caution):
   ```bash
   # Backup first
   tar -czf /tmp/photos-backup.tar.gz /data/photos
   
   # Remove specific thread (after DSR confirmation):
   rm -rf /data/photos/12345
   
   # Verify cleanup in DB (blob_ref should not exist):
   SELECT COUNT(*) FROM photo_parse_audit WHERE blob_ref LIKE '/data/photos/12345/%';
   ```

## Monitoring & Alerts

### Metrics to Watch

- **Volume capacity**: `df /data/photos`
  - Alert if > 80% full
  - Alert if remaining space < 1 GB

- **Photo count growth**:
  ```sql
  SELECT DATE(created_at), COUNT(*) 
  FROM photo_parse_audit 
  GROUP BY DATE(created_at) 
  ORDER BY DATE(created_at) DESC 
  LIMIT 30;
  ```
  - Baseline: ~10-20 photos/day
  - Alert if > 100 photos/day (possible runaway campaign)

- **Parse failures**:
  ```sql
  SELECT COUNT(*) FROM photo_parse_audit WHERE extracted = '{}';
  ```
  - These are normal (LLM unavailable, non-image attachment, etc.)
  - Alert only if > 50% failure rate

### Sentry Integration

Photo storage errors are logged via `slog` with `op="photoparse.Save"` and reported to Sentry. Check release dashboard for:
- `Error: mkdir failed`
- `Error: write-temp-rename failed`
- `Error: path traversal protection`

## Rollback & Recovery

### Scenario: Volume Corrupted or Full

1. **Temporary workaround** (disable photo pipeline):
   ```bash
   # Set env var in Railway
   PHOTO_PIPELINE=false
   
   # Restart service; inbound photos will be skipped
   # photo_parse_audit rows still INSERT'd with extracted={}
   ```

2. **Investigate and cleanup** (offline):
   ```bash
   # From Railway SSH or backup
   du -h /data/photos/ | sort -rh
   find /data/photos -name "*.tmp" | xargs rm -f  # cleanup temp files
   ```

3. **Restore and re-enable**:
   ```bash
   PHOTO_PIPELINE=true
   # Redeploy; new photos will be captured
   # Old blobs are still available (recovery from the DSR backlog if needed)
   ```

### Scenario: Data Loss (Volume Deleted)

1. **Detection**: Service starts, mkdir fails, photos cannot be stored.
   - `photo_parse_audit` rows still INSERT'd with `extracted={}` (best-effort)
   - Sentry alerts on repeated `mkdir` errors

2. **Recovery**:
   - Railway: recreate volume with same name and size
   - Verify permissions: `chmod 755 /data/photos`
   - Resume service: photos written going forward

3. **Historical photos**: Lost (no backup by default). Use Sentry release history to identify affected campaigns.

## Testing

### Unit Tests
```bash
go test ./features/inbound/orchestrator/internal/photostore/
```
- Path traversal protection
- Sanitization (alphanumeric + dash/underscore/dot only)
- Empty data rejection

### Integration Tests
```bash
go test -tags=integration ./features/inbound/orchestrator/internal/photostore/
```
- Volume mount exists and is writable
- Files persist across invocations
- Cleanup (DSR directory removal) works

**Note**: Integration tests require `/data/photos` to be mounted. They skip gracefully if unavailable.

### Manual Testing (Local)
```bash
# Create mock volume
mkdir -p /data/photos

# Run integration tests
PHOTO_VOLUME_DIR=/data/photos go test -tags=integration ./features/inbound/orchestrator/internal/photostore/

# Verify files
ls -la /data/photos/*/
```

## Troubleshooting

### Service won't start: `mkdir: permission denied`
- Verify volume mount: `ls -ld /data/photos`
- Expected: `drwxr-xr-x root root`
- Fix: `chmod 755 /data/photos` (from Railway SSH)

### Photos stored but never parsed (LLM unavailable)
- Check `photo_parse_audit.extracted = '{}'`
- Verify `llm-runner` service is reachable: `curl http://llm-runner:3000/v1/parse-photo` (from orchestrator container)
- Fallback: photos are retained; retry job can re-process when LLM is available

### Volume full: `ENOSPC (no space left on device)`
- Check usage: `du -h /data/photos`
- Identify large threads: `find /data/photos -type f | xargs du -h | sort -rh | head -20`
- Verify orphaned files: `find /data/photos -type f -mtime +180 -size +10M` (old and large)
- Consider capacity upgrade or archive + cleanup

### Discrepancy: DB rows vs filesystem files
- Count DB rows: `SELECT COUNT(*) FROM photo_parse_audit WHERE blob_ref IS NOT NULL`
- Count files: `find /data/photos -type f | wc -l`
- If files > rows: orphaned files (possible cleanup failure); safe to remove
- If rows > files: missing blobs (volume deleted or corrupted); mark in Sentry

## References

- **Schema**: `photo_parse_audit` table in `features/inbound/orchestrator` schema
- **Code**: `features/inbound/orchestrator/internal/photostore/photostore.go`, `photoparse.go`
- **ADR**: ADR-006 §D2 (vision contract for photo parsing)
- **Track E**: Track E migration 019 (photo_parse_audit, ROPA Činnost č. 6)
