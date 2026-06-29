package watchdog

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"

	"mailboxes/mailbox"
)

// CircuitBreakerConfig controls per-mailbox SMTP failure circuit breaking.
// The design mirrors a classic circuit breaker: N failures in a time window
// trip the breaker, pausing sender rotation for the mailbox. After a cool-off
// interval the breaker auto-closes. Distinct from bounce_hold (recipient-side
// signal, day-scale window) — this is sender-side, minute-scale.
type CircuitBreakerConfig struct {
	FailThreshold int           // SMTP fails in window to trip; default 5
	Window        time.Duration // counting window; default 15m
	PauseDuration time.Duration // cool-off before auto-close; default 15m
}

func (c CircuitBreakerConfig) withDefaults() CircuitBreakerConfig {
	if c.FailThreshold <= 0 {
		c.FailThreshold = 5
	}
	if c.Window <= 0 {
		c.Window = 15 * time.Minute
	}
	if c.PauseDuration <= 0 {
		c.PauseDuration = 15 * time.Minute
	}
	return c
}

// CircuitBreakerState captures the DB-side columns added by migration 040.
// Kept separate from mailbox.Mailbox because the struct is written by
// different code paths and we don't want to balloon the core type.
type CircuitBreakerState struct {
	MailboxID        int64
	CircuitOpenedAt  *time.Time
	CircuitTripCount int
}

// CircuitBreakerStore is the narrow persistence interface the breaker needs.
// Implemented by the Postgres-backed one below, fakeable in tests.
type CircuitBreakerStore interface {
	GetState(ctx context.Context, mailboxID int64) (CircuitBreakerState, error)
	TripCircuit(ctx context.Context, mailboxID int64, at time.Time) error
	CloseCircuit(ctx context.Context, mailboxID int64) error
}

// EvaluateCircuit decides whether a mailbox should trip or close based on
// the most recent SMTP auth-fail count. Pure function — safe to unit test.
//
//   - If already open AND more than cfg.PauseDuration has elapsed since
//     CircuitOpenedAt → close (mailbox eligible for resume).
//   - If closed AND fails >= cfg.FailThreshold → trip.
//   - Otherwise → no action.
func EvaluateCircuit(state CircuitBreakerState, failsInWindow int, now time.Time, cfg CircuitBreakerConfig) (action CircuitAction, reason string) {
	cfg = cfg.withDefaults()
	if state.CircuitOpenedAt != nil {
		if now.Sub(*state.CircuitOpenedAt) >= cfg.PauseDuration {
			return CircuitClose, fmt.Sprintf("cooldown_elapsed_%s", cfg.PauseDuration)
		}
		return CircuitNone, ""
	}
	if failsInWindow >= cfg.FailThreshold {
		return CircuitTrip, fmt.Sprintf("%d_fails_in_%s", failsInWindow, cfg.Window)
	}
	return CircuitNone, ""
}

// CircuitAction is the decision emitted by EvaluateCircuit.
type CircuitAction int

const (
	CircuitNone CircuitAction = iota
	CircuitTrip
	CircuitClose
)

// PGCircuitBreakerStore is the Postgres-backed CircuitBreakerStore.
// A nil db makes every method a no-op so tests / dev runs without the
// migration applied don't crash.
type PGCircuitBreakerStore struct {
	DB *sql.DB
}

func (s *PGCircuitBreakerStore) GetState(ctx context.Context, mailboxID int64) (CircuitBreakerState, error) {
	if s == nil || s.DB == nil {
		return CircuitBreakerState{MailboxID: mailboxID}, nil
	}
	var st CircuitBreakerState
	st.MailboxID = mailboxID
	err := s.DB.QueryRowContext(ctx,
		`SELECT circuit_opened_at, circuit_trip_count FROM outreach_mailboxes WHERE id = $1`,
		mailboxID,
	).Scan(&st.CircuitOpenedAt, &st.CircuitTripCount)
	if err != nil {
		return st, fmt.Errorf("circuit breaker: get state: %w", err)
	}
	return st, nil
}

func (s *PGCircuitBreakerStore) TripCircuit(ctx context.Context, mailboxID int64, at time.Time) error {
	if s == nil || s.DB == nil {
		return nil
	}
	_, err := s.DB.ExecContext(ctx,
		`UPDATE outreach_mailboxes
		    SET circuit_opened_at  = $2,
		        circuit_trip_count = circuit_trip_count + 1
		  WHERE id = $1`,
		mailboxID, at,
	)
	if err != nil {
		return fmt.Errorf("circuit breaker: trip: %w", err)
	}
	return nil
}

func (s *PGCircuitBreakerStore) CloseCircuit(ctx context.Context, mailboxID int64) error {
	if s == nil || s.DB == nil {
		return nil
	}
	_, err := s.DB.ExecContext(ctx,
		`UPDATE outreach_mailboxes SET circuit_opened_at = NULL WHERE id = $1`,
		mailboxID,
	)
	if err != nil {
		return fmt.Errorf("circuit breaker: close: %w", err)
	}
	return nil
}

// runCircuitBreaker is invoked once per daemon tick for each active (or
// circuit-paused) mailbox. It takes the recent auth-fail count and applies
// Trip/Close transitions via the Store. All DB errors are logged and
// swallowed so a misbehaving DB doesn't block other mailboxes from being
// processed.
func (d *Daemon) runCircuitBreaker(ctx context.Context, m mailbox.Mailbox, failsInWindow int) (tripped, closed bool) {
	if d.cfg.Circuit == nil {
		return false, false
	}
	state, err := d.cfg.Circuit.GetState(ctx, m.ID)
	if err != nil {
		slog.Warn("watchdog: circuit state lookup failed", "op", "watchdog.circuitBreakerTick/getState", "id", m.ID, "error", err)
		return false, false
	}
	now := time.Now()
	action, reason := EvaluateCircuit(state, failsInWindow, now, d.cfg.CircuitCfg)
	switch action {
	case CircuitTrip:
		// Only active mailboxes can trip. A paused mailbox isn't sending, so
		// any recent auth-fails are stale; tripping it would overwrite the
		// operator's status_reason with "circuit_breaker:..." and let the
		// 15-min auto-close flip it back to active — reversing the pause.
		// (CircuitClose still runs for paused mailboxes so genuinely
		// circuit-tripped ones can resume.)
		if m.Status != mailbox.StatusActive {
			return false, false
		}
		if err := d.cfg.Circuit.TripCircuit(ctx, m.ID, now); err != nil {
			slog.Warn("watchdog: trip circuit failed", "op", "watchdog.circuitBreakerTick/trip", "id", m.ID, "error", err)
			return false, false
		}
		if _, err := d.cfg.Store.UpdateStatus(ctx, m.ID, mailbox.StatusPaused, "circuit_breaker:"+reason); err != nil {
			slog.Warn("watchdog: pause after trip failed", "op", "watchdog.circuitBreakerTick/pauseAfterTrip", "id", m.ID, "error", err)
		}
		_ = d.cfg.Events.Record(ctx, Event{
			MailboxID: &m.ID, Type: EventCircuitBreaker, AutoHealed: true,
			Reason: reason,
			Metadata: map[string]any{
				"fails_in_window": failsInWindow,
				"window_sec":      int(d.cfg.CircuitCfg.withDefaults().Window.Seconds()),
				"pause_sec":       int(d.cfg.CircuitCfg.withDefaults().PauseDuration.Seconds()),
			},
		})
		return true, false
	case CircuitClose:
		if err := d.cfg.Circuit.CloseCircuit(ctx, m.ID); err != nil {
			slog.Warn("watchdog: close circuit failed", "op", "watchdog.circuitBreakerTick/close", "id", m.ID, "error", err)
			return false, false
		}
		// Only resume to active if the current pause reason is circuit_breaker;
		// an operator-paused mailbox should stay paused.
		if m.Status == mailbox.StatusPaused && hasPrefix(m.StatusReason, "circuit_breaker:") {
			if _, err := d.cfg.Store.UpdateStatus(ctx, m.ID, mailbox.StatusActive, "circuit_auto_closed"); err != nil {
				slog.Warn("watchdog: resume after close failed", "op", "watchdog.circuitBreakerTick/resumeAfterClose", "id", m.ID, "error", err)
			}
		}
		_ = d.cfg.Events.Record(ctx, Event{
			MailboxID: &m.ID, Type: EventCircuitBreaker, AutoHealed: true,
			Reason: reason,
			Metadata: map[string]any{
				"action": "closed",
			},
		})
		return false, true
	}
	return false, false
}

func hasPrefix(s, pfx string) bool {
	if len(s) < len(pfx) {
		return false
	}
	return s[:len(pfx)] == pfx
}
