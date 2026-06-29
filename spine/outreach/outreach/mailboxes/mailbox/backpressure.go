package mailbox

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"common/config"
)

// WarmupResetter is the narrow interface the backpressure layer needs to
// pause and reset warmup when a mailbox enters or exits bounce_hold.
type WarmupResetter interface {
	Pause(ctx context.Context, address, reason string) error
	Reset(ctx context.Context, address string) error
}

// HoldReleaser is the interface the intelligence loop uses to auto-release
// stale bounce_hold mailboxes. Implemented by StoreBackpressure.
type HoldReleaser interface {
	ReleaseHold(ctx context.Context, address string) error
}

// Backpressure is the narrow interface the send pipeline (sender.Engine,
// bounce.Processor) uses to keep the outreach_mailboxes registry in sync
// with real-world SMTP/bounce traffic. It is intentionally smaller than
// Store so call sites don't need to reach for full CRUD.
//
// All methods are safe to call fire-and-forget from hot send loops — they
// log and swallow registry-unavailable errors so an untimely outage of the
// registry never blocks delivery.
type Backpressure interface {
	// RecordSuccess marks a successful send against the named mailbox.
	// Touches last_send_at, increments total_sent, resets consecutive_bounces.
	RecordSuccess(ctx context.Context, fromAddress string, sentAt time.Time)

	// RecordBounce increments the bounce counters and, if the consecutive
	// threshold is reached, flips the mailbox into StatusBounceHold with the
	// given reason. Returns whether an auto-hold was triggered (for telemetry).
	RecordBounce(ctx context.Context, fromAddress, reason string) (held bool)

	// ActiveAddresses returns the set of from_addresses whose status is
	// StatusActive. Used by the sender's pickMailbox to filter out
	// paused/held/retired mailboxes before round-robin. The returned map
	// uses NormaliseAddress() keys. A non-nil error means "registry
	// unreachable — caller should fall through to config-only behaviour".
	ActiveAddresses(ctx context.Context) (map[string]struct{}, error)
}

// StoreBackpressure adapts a Store into the Backpressure interface.
// A nil Store makes every method a no-op, which is the desired behaviour
// when the registry is not configured (e.g. migrations not applied).
type StoreBackpressure struct {
	Store  Store
	Warmup WarmupResetter // optional; nil = no warmup integration
}

// NewBackpressure wraps a Store.
func NewBackpressure(s Store) *StoreBackpressure {
	return &StoreBackpressure{Store: s}
}

// RecordSuccess implements Backpressure.
func (b *StoreBackpressure) RecordSuccess(ctx context.Context, fromAddress string, sentAt time.Time) {
	if b == nil || b.Store == nil {
		return
	}
	addr := NormaliseAddress(fromAddress)
	m, err := b.Store.GetByAddress(ctx, addr)
	if err != nil {
		if !errors.Is(err, ErrMailboxNotFound) {
			slog.Warn("mailbox backpressure: GetByAddress failed", "address", addr, "error", err)
		}
		return
	}
	if err := b.Store.TouchLastSend(ctx, m.ID, sentAt); err != nil {
		slog.Warn("mailbox backpressure: TouchLastSend failed", "address", addr, "error", err)
	}
}

// RecordBounce implements Backpressure. Returns true when a hold was applied.
func (b *StoreBackpressure) RecordBounce(ctx context.Context, fromAddress, reason string) bool {
	if b == nil || b.Store == nil {
		return false
	}
	addr := NormaliseAddress(fromAddress)
	m, err := b.Store.GetByAddress(ctx, addr)
	if err != nil {
		if !errors.Is(err, ErrMailboxNotFound) {
			slog.Warn("mailbox backpressure: GetByAddress failed", "address", addr, "error", err)
		}
		return false
	}
	updated, err := b.Store.IncrementBounce(ctx, m.ID)
	if err != nil {
		slog.Warn("mailbox backpressure: IncrementBounce failed", "address", addr, "error", err)
		return false
	}
	if !ShouldAutoHold(updated) {
		return false
	}
	held := "auto-hold: " + reason
	if _, err := b.Store.UpdateStatus(ctx, m.ID, StatusBounceHold, held); err != nil {
		slog.Warn("mailbox backpressure: UpdateStatus(bounce_hold) failed", "address", addr, "error", err)
		return false
	}
	slog.Warn("mailbox auto-held after consecutive bounces",
		"address", addr, "consecutive", updated.ConsecutiveBounces, "reason", reason)
	if b.Warmup != nil {
		if err := b.Warmup.Pause(ctx, addr, "bounce_hold"); err != nil {
			slog.Warn("mailbox backpressure: warmup.Pause failed", "address", addr, "error", err)
		}
	}
	return true
}

// ReleaseHold transitions a mailbox from StatusBounceHold back to StatusActive,
// resets its consecutive bounce counter, and re-ramps warmup from day 0.
// It is idempotent: calling it on an already-active mailbox is a no-op.
func (b *StoreBackpressure) ReleaseHold(ctx context.Context, address string) error {
	if b == nil || b.Store == nil {
		return nil
	}
	addr := NormaliseAddress(address)
	m, err := b.Store.GetByAddress(ctx, addr)
	if err != nil {
		return fmt.Errorf("mailbox: ReleaseHold: %w", err)
	}
	if m.Status != StatusBounceHold {
		return nil // idempotent — nothing to do
	}
	if _, err := b.Store.UpdateStatus(ctx, m.ID, StatusActive, "auto_released"); err != nil {
		return fmt.Errorf("mailbox: ReleaseHold UpdateStatus: %w", err)
	}
	if err := b.Store.ResetBounce(ctx, m.ID); err != nil {
		slog.Warn("mailbox: ReleaseHold: ResetBounce failed", "address", addr, "error", err)
	}
	if b.Warmup != nil {
		if err := b.Warmup.Reset(ctx, addr); err != nil {
			slog.Warn("mailbox: ReleaseHold: warmup.Reset failed", "address", addr, "error", err)
		}
	}
	slog.Info("mailbox released from bounce_hold", "address", addr)
	return nil
}

// ActiveAddresses implements Backpressure. Returns nil + error on registry
// failure so the sender can fall through to config-only behaviour.
func (b *StoreBackpressure) ActiveAddresses(ctx context.Context) (map[string]struct{}, error) {
	if b == nil || b.Store == nil {
		return nil, errors.New("mailbox: backpressure has no store")
	}
	mboxes, err := b.Store.List(ctx, Filter{Status: []Status{StatusActive}, Limit: 1000})
	if err != nil {
		return nil, err
	}
	set := make(map[string]struct{}, len(mboxes))
	for _, m := range mboxes {
		set[NormaliseAddress(m.FromAddress)] = struct{}{}
	}
	return set, nil
}

// MailboxLister is an optional companion to Backpressure that returns full
// MailboxConfig records for every active mailbox, not just their addresses.
// The sender engine type-asserts on this interface to refresh its in-memory
// cfg.Mailboxes view at send time so a transient boot-time OverlayRegistry
// failure (e.g. the 2026-05-13 NULL Scan crash) no longer permanently locks
// the engine into an empty mailbox list. Implementations MUST return rows
// only for mailboxes that survive the StatusActive filter — the engine
// trusts this list as the strict-mode allow set.
//
// Kept separate from Backpressure to avoid breaking the three existing
// test fakes (engine_registry_test.fakeBackpressure,
// adaptive_release_sqlmock_test.fakeBackpressure, processor_registry_test.
// fakeRegistry) and any external implementers.
type MailboxLister interface {
	ActiveMailboxes(ctx context.Context) ([]config.MailboxConfig, error)
}

// ActiveMailboxes implements MailboxLister. Returns the full MailboxConfig
// for every mailbox whose status is StatusActive, mirroring ActiveAddresses
// but with enough information for the sender engine to dispatch sends
// without a separate cfg.Mailboxes lookup. Errors are propagated verbatim
// so callers can apply the same strict-mode semantics as ActiveAddresses.
func (b *StoreBackpressure) ActiveMailboxes(ctx context.Context) ([]config.MailboxConfig, error) {
	if b == nil || b.Store == nil {
		return nil, errors.New("mailbox: backpressure has no store")
	}
	mboxes, err := b.Store.List(ctx, Filter{Status: []Status{StatusActive}, Limit: 1000})
	if err != nil {
		return nil, err
	}
	out := make([]config.MailboxConfig, 0, len(mboxes))
	for _, m := range mboxes {
		out = append(out, m.ToConfig())
	}
	return out, nil
}

// Compile-time assertions.
var _ Backpressure = (*StoreBackpressure)(nil)
var _ HoldReleaser = (*StoreBackpressure)(nil)
var _ MailboxLister = (*StoreBackpressure)(nil)
