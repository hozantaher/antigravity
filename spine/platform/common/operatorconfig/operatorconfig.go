// Package operatorconfig provides a cached loader for the operator_settings
// key-value table. Values are refreshed from Postgres at most every cacheTTL
// (default 60 s), so an SQL UPDATE to controller_name is visible within 60 s
// without a code change or restart.
//
// Designed as a leaf dependency: it only imports database/sql and stdlib.
// Any service that already holds a *sql.DB can call operatorconfig.New(db).
package operatorconfig

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// DefaultTTL is the default cache TTL used by New.
const DefaultTTL = 60 * time.Second

// Loader is a thread-safe, TTL-cached loader for operator_settings rows.
// The zero value is not usable — construct with New.
type Loader struct {
	db       *sql.DB
	mu       sync.RWMutex
	cache    map[string]string
	cachedAt time.Time
	ttl      time.Duration
}

// New returns a Loader backed by db, with the default 60-second cache TTL.
func New(db *sql.DB) *Loader {
	return &Loader{db: db, ttl: DefaultTTL}
}

// NewWithTTL returns a Loader with a custom TTL (useful in tests).
func NewWithTTL(db *sql.DB, ttl time.Duration) *Loader {
	return &Loader{db: db, ttl: ttl}
}

// Get returns the current value for key, refreshing the cache when stale.
// Returns ("", nil) for a key that exists in the table but has an empty value,
// and ("", nil) for a key not present in the table — callers should use the
// fallback value in either case. Returns a non-nil error only on DB failure.
func (l *Loader) Get(ctx context.Context, key string) (string, error) {
	l.mu.RLock()
	if l.cache != nil && time.Since(l.cachedAt) < l.ttl {
		v := l.cache[key]
		l.mu.RUnlock()
		return v, nil
	}
	l.mu.RUnlock()

	return l.refreshAndGet(ctx, key)
}

// MustGet returns the value for key, panicking if the DB refresh fails or the
// key is absent. Intended for startup-time invariant checks where a missing
// config is a programming error.
func (l *Loader) MustGet(ctx context.Context, key string) string {
	v, err := l.Get(ctx, key)
	if err != nil {
		panic(fmt.Sprintf("operatorconfig.MustGet(%q): %v", key, err))
	}
	if v == "" {
		panic(fmt.Sprintf("operatorconfig.MustGet(%q): key not found in operator_settings", key))
	}
	return v
}

// GetAll returns a snapshot of all key-value pairs, refreshing when stale.
func (l *Loader) GetAll(ctx context.Context) (map[string]string, error) {
	l.mu.RLock()
	if l.cache != nil && time.Since(l.cachedAt) < l.ttl {
		out := make(map[string]string, len(l.cache))
		for k, v := range l.cache {
			out[k] = v
		}
		l.mu.RUnlock()
		return out, nil
	}
	l.mu.RUnlock()

	if err := l.refresh(ctx); err != nil {
		return nil, err
	}

	l.mu.RLock()
	out := make(map[string]string, len(l.cache))
	for k, v := range l.cache {
		out[k] = v
	}
	l.mu.RUnlock()
	return out, nil
}

// refreshAndGet refreshes the cache and returns the requested key.
func (l *Loader) refreshAndGet(ctx context.Context, key string) (string, error) {
	if err := l.refresh(ctx); err != nil {
		return "", err
	}
	l.mu.RLock()
	v := l.cache[key]
	l.mu.RUnlock()
	return v, nil
}

// refresh fetches all rows from operator_settings and updates the in-memory cache.
func (l *Loader) refresh(ctx context.Context) error {
	rows, err := l.db.QueryContext(ctx, `SELECT key, value FROM operator_settings`)
	if err != nil {
		return fmt.Errorf("operatorconfig: query operator_settings: %w", err)
	}
	defer rows.Close()

	m := make(map[string]string)
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return fmt.Errorf("operatorconfig: scan row: %w", err)
		}
		m[k] = v
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("operatorconfig: rows error: %w", err)
	}

	l.mu.Lock()
	l.cache = m
	l.cachedAt = time.Now()
	l.mu.Unlock()

	slog.Debug("operatorconfig: cache refreshed", "keys", len(m))
	return nil
}

// InvalidateCache forces the next Get/GetAll call to re-fetch from the DB.
// Useful after an operator_settings UPDATE to surface changes immediately.
func (l *Loader) InvalidateCache() {
	l.mu.Lock()
	l.cachedAt = time.Time{} // zero time → always stale
	l.mu.Unlock()
}
