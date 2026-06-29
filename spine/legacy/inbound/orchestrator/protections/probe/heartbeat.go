package probe

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"
)

// Heartbeat writes outreach_config[key] = now() on a fixed cadence.
// The sender_engine L2 probe reads the latest updated_at to decide
// whether the sender loop is still alive — a tick-based signal is
// cheaper and simpler than wiring a DB handle through Engine.Run
// and records liveness independently of whether any message is sent
// in the current window (quiet hours, empty queue, etc.).
type Heartbeat struct {
	DB       *sql.DB
	Key      string
	Cadence  time.Duration
}

// NewHeartbeat constructs a Heartbeat; zero values default to
// key='sender_heartbeat_at' and 30s cadence.
func NewHeartbeat(db *sql.DB, key string, cadence time.Duration) *Heartbeat {
	if key == "" {
		key = "sender_heartbeat_at"
	}
	if cadence <= 0 {
		cadence = 30 * time.Second
	}
	return &Heartbeat{DB: db, Key: key, Cadence: cadence}
}

// Run blocks until ctx is cancelled, upserting the heartbeat row on
// every tick. Write failures are logged and skipped — the next tick
// retries.
func (h *Heartbeat) Run(ctx context.Context) {
	if h == nil || h.DB == nil {
		return
	}
	t := time.NewTicker(h.Cadence)
	defer t.Stop()
	h.write(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.write(ctx)
		}
	}
}

func (h *Heartbeat) write(ctx context.Context) {
	if err := h.writeErr(ctx); err != nil {
		slog.Warn("probe heartbeat write failed", "op", "Heartbeat.write/writeFail", "key", h.Key, "error", err)
	}
}

func (h *Heartbeat) writeErr(ctx context.Context) error {
	_, err := h.DB.ExecContext(ctx, `
		INSERT INTO outreach_config (key, value, updated_at)
		VALUES ($1, $2, now())
		ON CONFLICT (key) DO UPDATE
		  SET value = EXCLUDED.value,
		      updated_at = EXCLUDED.updated_at
	`, h.Key, time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		return fmt.Errorf("probe heartbeat upsert: %w", err)
	}
	return nil
}
