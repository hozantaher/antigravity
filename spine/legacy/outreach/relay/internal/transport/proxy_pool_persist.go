package transport

import (
	"encoding/json"
	"log/slog"
	"time"

	"os"

	"common/envconfig"
)

// jsonMarshal is the json.Marshal seam. Tests override this to inject errors.
var jsonMarshal = json.Marshal

const defaultPersistPath = "/app/data/proxy_pool_cache.json"

type persistedPool struct {
	Entries []persistedEntry `json:"entries"`
	SavedAt time.Time        `json:"saved_at"`
}

type persistedEntry struct {
	Addr      string `json:"addr"`
	LatencyMs int64  `json:"latency_ms"`
	Country   string `json:"country"`
	Source    string `json:"source"`
}

// persistPath returns the effective path, respecting PROXY_POOL_PERSIST_PATH env override.
func persistPath() string {
	if p := envconfig.GetOr("PROXY_POOL_PERSIST_PATH", ""); p != "" {
		return p
	}
	return defaultPersistPath
}

// savePool writes working proxies to disk. Non-fatal: logs error on failure.
func savePool(entries []proxyEntry) {
	data := persistedPool{SavedAt: time.Now()}
	for _, e := range entries {
		data.Entries = append(data.Entries, persistedEntry{
			Addr:      e.addr,
			LatencyMs: e.latency.Milliseconds(),
			Country:   e.country,
			Source:    e.source,
		})
	}
	b, err := jsonMarshal(data)
	if err != nil {
		slog.Warn("proxy_pool: failed to marshal pool for persistence", "op", "transport.savePool/marshal", "error", err)
		return
	}
	// W2-E (2026-04-29): atomic write — pre-fix os.WriteFile was a
	// single non-atomic call. SIGKILL or out-of-disk mid-write left the
	// file partially written; loadPool then unmarshals partial JSON,
	// fails, and returns nil — wiping the previous good state. The
	// cmd/relay/main path persists every refresh, so a partial write
	// after a healthy refresh would corrupt the cache silently.
	//
	// Pattern: write to <path>.tmp + os.Rename. Rename within a single
	// filesystem is atomic on POSIX (kernel-level inode swap); a crash
	// either leaves the old file intact OR completes the swap, never
	// half-written. Same shape used by services/relay/internal/audit/
	// service.go and friends.
	path := persistPath()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0600); err != nil {
		slog.Warn("proxy_pool: failed to write tmp pool", "op", "transport.savePool/writeTmp", "error", err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		slog.Warn("proxy_pool: failed to rename tmp pool", "op", "transport.savePool/rename", "error", err)
		// Best-effort cleanup of the dangling .tmp; harmless if it
		// already doesn't exist.
		_ = os.Remove(tmp)
		return
	}
}

// loadPool reads persisted proxies. Returns nil if file missing or stale (>maxAgeH hours).
func loadPool(maxAgeH int) []proxyEntry {
	path := persistPath()
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var data persistedPool
	if err := json.Unmarshal(b, &data); err != nil {
		slog.Warn("proxy_pool: failed to parse persisted pool", "op", "transport.loadPool/unmarshal", "error", err)
		return nil
	}
	if time.Since(data.SavedAt) > time.Duration(maxAgeH)*time.Hour {
		slog.Info("proxy_pool: persisted pool is stale, ignoring",
			"age", time.Since(data.SavedAt).Round(time.Second))
		return nil
	}
	entries := make([]proxyEntry, 0, len(data.Entries))
	for _, e := range data.Entries {
		entries = append(entries, proxyEntry{
			addr:    e.Addr,
			latency: time.Duration(e.LatencyMs) * time.Millisecond,
			country: e.Country,
			source:  e.Source,
		})
	}
	slog.Info("proxy_pool: loaded persisted pool",
		"count", len(entries),
		"age", time.Since(data.SavedAt).Round(time.Second))
	return entries
}
