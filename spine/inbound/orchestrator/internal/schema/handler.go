package schema

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// CacheTTL is how long a built manifest is reused before regeneration.
// 60s matches the prompt's "regenerate every 60s, hot endpoint" target.
const CacheTTL = 60 * time.Second

// cache holds the most recent manifest + the wall-clock instant at which it
// expires. Access is serialised by a mutex; the regenerate window is short
// enough that a single in-flight rebuild is acceptable (no thundering herd
// — only one goroutine refreshes; readers wait on the mutex).
type cache struct {
	mu        sync.Mutex
	manifest  *Manifest
	expiresAt time.Time
	now       func() time.Time // injectable for tests
}

func newCache() *cache {
	return &cache{now: time.Now}
}

// get returns a cached manifest, regenerating it if expired.
//
// The build call holds the mutex — long DB stalls would block readers, but
// the alternative (singleflight) adds a dependency for a 1-QPS endpoint.
// If this becomes hot we'll revisit.
func (c *cache) get(ctx context.Context, db *sql.DB) (*Manifest, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.manifest != nil && c.now().Before(c.expiresAt) {
		return c.manifest, nil
	}

	m, err := BuildManifest(ctx, db)
	if err != nil {
		return nil, err
	}
	c.manifest = m
	c.expiresAt = c.now().Add(CacheTTL)
	return m, nil
}

// Handler returns an http.HandlerFunc serving the schema manifest as JSON.
//
// The endpoint is read-only metadata (no row data, no counts) — auth is the
// caller's responsibility. The default wiring in cmd/outreach/main.go does
// NOT gate /schema with X-API-Key; if you need to restrict it, wrap the
// returned handler with apiKeyAuth.
func Handler(db *sql.DB) http.HandlerFunc {
	c := newCache()
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		m, err := c.get(r.Context(), db)
		if err != nil {
			// Don't leak schema-introspection errors to callers — log and
			// return a generic 500. Callers retry; operators check Sentry.
			slog.Error("schema manifest build failed",
				"op", "schema.Handler/build",
				"error", err,
			)
			http.Error(w, "schema unavailable", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=60")
		w.Header().Set("X-Manifest-Hash", m.ManifestHash)

		if r.Method == http.MethodHead {
			return
		}

		enc := json.NewEncoder(w)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(m); err != nil {
			// Encoding failure after headers — best-effort log. Avoid
			// double-writing the body since we've already started.
			if !errors.Is(err, http.ErrBodyNotAllowed) {
				slog.Warn("schema manifest encode failed",
					"op", "schema.Handler/encode",
					"error", err,
				)
			}
		}
	}
}
