package campaign

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"sync"
	"time"
)

// PostgresLocker implements SchedulerLocker using Postgres advisory locks.
//
// pg_try_advisory_lock is **session-scoped** — it returns false if any
// session holds the lock, and true + sets the lock atomically. The
// critical word is "session": the lock is bound to the specific
// connection that issued the lock call, NOT to the *sql.DB pool.
//
// F2-3 (2026-04-29) — pre-fix this struct held only `*sql.DB`. Both
// TryAdvisoryLock and ReleaseAdvisoryLock pulled an arbitrary connection
// from the pool. That meant:
//
//   - Lock acquired on connection A; A returned to pool with lock still
//     held.
//   - ReleaseAdvisoryLock pulled connection B → pg_advisory_unlock(B)
//     returned false (B never held the lock) but didn't error → lock
//     stays held on A indefinitely (until A is closed by the pool).
//   - When A is reused by an unrelated goroutine, that goroutine
//     inherits the held lock — cross-tenant leakage.
//   - Worse: the audit row INSERT and the actual lock acquisition were
//     on different connections — two parallel Tick() callers could each
//     get a different connection where pg_try_advisory_lock returned
//     true (because the *prior* lock-holding connection had been
//     recycled and its session re-opened) and both proceed to send.
//
// Fix: pin a *sql.Conn for the lock lifetime. Acquire on the pinned
// conn, store it under the campaign id, release + close on the same
// conn when ReleaseAdvisoryLock is called.
type PostgresLocker struct {
	db          *sql.DB
	mu          sync.Mutex
	pinnedConns map[int64]*sql.Conn
}

func NewPostgresLocker(db *sql.DB) *PostgresLocker {
	return &PostgresLocker{db: db, pinnedConns: make(map[int64]*sql.Conn)}
}

func (l *PostgresLocker) TryAdvisoryLock(ctx context.Context, id int64) (bool, error) {
	conn, err := l.db.Conn(ctx)
	if err != nil {
		return false, fmt.Errorf("acquire conn for lock(%d): %w", id, err)
	}
	var ok bool
	if err := conn.QueryRowContext(ctx,
		`SELECT pg_try_advisory_lock($1)`, id).Scan(&ok); err != nil {
		_ = conn.Close()
		return false, fmt.Errorf("pg_try_advisory_lock(%d): %w", id, err)
	}
	if !ok {
		// Did not acquire the lock — return the conn to the pool.
		_ = conn.Close()
		return false, nil
	}

	// Lock acquired. Pin the conn so ReleaseAdvisoryLock unlocks the
	// SAME session.
	l.mu.Lock()
	if existing, ok := l.pinnedConns[id]; ok {
		// Defensive: shouldn't happen — TryAdvisoryLock just succeeded,
		// which means no other session holds it. If we already had a
		// pinned conn for this id, something is wrong upstream; close
		// the new conn and keep the old (avoid stranded conns).
		_ = conn.Close()
		l.mu.Unlock()
		return false, fmt.Errorf("lock(%d): already pinned (existing=%p)", id, existing)
	}
	l.pinnedConns[id] = conn
	l.mu.Unlock()

	// BF-E4 — best-effort audit row, on the SAME pinned conn so the row
	// shares the session that holds the lock. Failure here doesn't
	// invalidate the lock (the cleanup function reaps stale rows).
	host, _ := os.Hostname()
	host = host + ":" + fmt.Sprintf("%d", os.Getpid())
	if _, auditErr := conn.ExecContext(ctx,
		`INSERT INTO campaign_lock_audit(campaign_id, locked_at, host)
		   VALUES($1, now(), $2)
		 ON CONFLICT (campaign_id) DO UPDATE
		   SET locked_at = excluded.locked_at,
		       host      = excluded.host`,
		id, host,
	); auditErr != nil {
		_ = auditErr
	}
	return true, nil
}

func (l *PostgresLocker) ReleaseAdvisoryLock(ctx context.Context, id int64) error {
	l.mu.Lock()
	conn, hadPinned := l.pinnedConns[id]
	delete(l.pinnedConns, id)
	l.mu.Unlock()

	if !hadPinned {
		// Caller never went through TryAdvisoryLock here, or already
		// released. Best-effort: issue unlock on the pool (likely no-op
		// since the holding session is gone), so callers that double-
		// release don't panic.
		_, _ = l.db.ExecContext(ctx, `SELECT pg_advisory_unlock($1)`, id)
		return nil
	}

	// Unlock on the pinned conn (same session as the lock).
	_, unlockErr := conn.ExecContext(ctx, `SELECT pg_advisory_unlock($1)`, id)
	// BF-E4 — best-effort audit row removal, on the same pinned conn.
	_, _ = conn.ExecContext(ctx,
		`DELETE FROM campaign_lock_audit WHERE campaign_id = $1`, id)

	// ALWAYS return the conn to the pool, even if unlock errored. The
	// session ends when the conn is closed; either way the lock is
	// released.
	if closeErr := conn.Close(); unlockErr == nil && closeErr != nil {
		return fmt.Errorf("release lock(%d) close conn: %w", id, closeErr)
	}
	if unlockErr != nil {
		return fmt.Errorf("pg_advisory_unlock(%d): %w", id, unlockErr)
	}
	return nil
}

// StaleLockCheck reports campaign IDs whose audit rows are older than
// `ttl`. The caller decides what to do (warn, page on-call, force-cleanup
// via campaign_lock_audit_cleanup_stale()).
//
// BF-E4 — covers BF-D5 from v2 plan (advisory lock health check).
// Read-only — uses the pool directly (not a pinned conn).
func (l *PostgresLocker) StaleLockCheck(ctx context.Context, ttl time.Duration) ([]int64, error) {
	rows, err := l.db.QueryContext(ctx, `
		SELECT campaign_id FROM campaign_lock_audit
		WHERE locked_at < now() - ($1 || ' seconds')::interval
		ORDER BY campaign_id`,
		fmt.Sprintf("%d", int64(ttl.Seconds())),
	)
	if err != nil {
		return nil, fmt.Errorf("stale lock check: %w", err)
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	return ids, rows.Err()
}

// PostgresSchedulerDB implements SchedulerDB using the campaigns table.
type PostgresSchedulerDB struct {
	db *sql.DB
}

func NewPostgresSchedulerDB(db *sql.DB) *PostgresSchedulerDB {
	return &PostgresSchedulerDB{db: db}
}

func (d *PostgresSchedulerDB) ListRunningCampaigns(ctx context.Context) ([]schedulerCampaign, error) {
	rows, err := d.db.QueryContext(ctx, `SELECT id FROM campaigns WHERE status IN ('running', 'active')`)
	if err != nil {
		return nil, fmt.Errorf("list running campaigns: %w", err)
	}
	defer rows.Close()
	var out []schedulerCampaign
	for rows.Next() {
		var c schedulerCampaign
		if err := rows.Scan(&c.ID); err != nil {
			continue
		}
		c.Status = "running"
		out = append(out, c)
	}
	return out, rows.Err()
}
