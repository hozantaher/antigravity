// Package mailbox is the canonical registry and selection layer for the
// 24-mailbox operator cockpit (D2.1).
//
// Prior to this package, mailbox configuration lived in YAML and the warmup
// state in mailbox_warmup. Neither gave the sender engine a single queryable
// authority for "which mailboxes exist, what's their cap today, are they
// paused?". This package fills that gap with:
//
//   - Mailbox type mirroring the outreach_mailboxes row (migration 035)
//   - Store interface abstracting persistence for CLI, HTTP, and sender
//   - Selector — fair rotation primitive honoring status, daily cap, cooldown
//
// The Store implementation itself (Postgres-backed) is intentionally omitted
// here and lives alongside the other repository implementations. This file
// remains pure logic so the sender engine can be unit-tested without a DB.
package mailbox

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Status is the operational state of a mailbox. Values match the
// outreach_mailboxes.status CHECK constraint.
type Status string

const (
	// StatusActive mailboxes participate in sender rotation.
	StatusActive Status = "active"
	// StatusPaused was paused manually by an operator. Requires manual resume.
	StatusPaused Status = "paused"
	// StatusBounceHold was auto-held after consecutive bounces crossed the
	// backpressure threshold. May be auto-cleared once bounces decay.
	StatusBounceHold Status = "bounce_hold"
	// StatusRetired is permanently out of rotation (never selected).
	StatusRetired Status = "retired"
)

// Valid reports whether s is a recognised status.
func (s Status) Valid() bool {
	switch s {
	case StatusActive, StatusPaused, StatusBounceHold, StatusRetired:
		return true
	}
	return false
}

// Sendable reports whether a mailbox in status s may be selected for a new
// outbound send. Only active mailboxes are sendable; paused, on-hold, and
// retired mailboxes are excluded from rotation.
func (s Status) Sendable() bool {
	return s == StatusActive
}

// Mailbox mirrors a row of outreach_mailboxes. Counter fields
// (TotalSent, TotalBounced, ConsecutiveBounces, LastSendAt) are maintained by
// the send + bounce pipelines, not by the selector.
type Mailbox struct {
	ID                 int64
	FromAddress        string // lower-cased canonical address
	DisplayName        string
	SMTPHost           string
	SMTPPort           int
	SMTPUsername       string // "" → fall back to FromAddress at connect time
	IMAPHost           string
	IMAPPort           int
	IMAPUsername       string
	DailyCapOverride   *int // nil → defer to warmup daemon
	TZ                 string
	Locale             string
	Status             Status
	StatusReason       string
	LastSendAt         *time.Time
	ConsecutiveBounces int
	TotalSent          int64
	TotalBounced       int64
	CreatedAt          time.Time
	UpdatedAt          time.Time

	// Password is the SMTP/IMAP password. Empty = fall back to env
	// MAILBOX_N_PASSWORD (backwards-compat). Populated from
	// outreach_mailboxes.password (migration 038). Plaintext;
	// AES-GCM encryption is a planned follow-up.
	Password string

	// ProxyURL is the outbound SMTP proxy for IP diversity. Empty = direct TLS dial.
	// Supported schemes: socks5://user:pass@host:port, socks5h://..., http://host:port
	// Each mailbox should have its own proxy so reputation damage on one IP
	// does not cascade across the warmup pool. (migration 039)
	ProxyURL string

	// Environment is the deployment environment for this mailbox (migration 055).
	// Values: "production", "test", "dev", "staging".
	// All campaign send paths MUST only use mailboxes where Environment = "production".
	// Test mailboxes (e2e / @test.internal) are set to "test" so they cannot
	// contaminate production sends even if their Status is Active.
	Environment string

	// PreferredCountry is the ISO 3166-1 alpha-2 egress country pin for this
	// mailbox (migration 065). When set (e.g. "SK", "RO"), the wgpool picker
	// restricts candidate endpoints to that country. Empty = no preference.
	PreferredCountry string

	// LifecyclePhase is the warmup-ramp phase (migration 071; caps revised by
	// migration 116). Values: warmup_d0 (10/d), warmup_d3 (30/d),
	// warmup_d7 (70/d), warmup_d14 (120/d), production (180/d). Used by
	// ToConfig() to derive a non-zero default DailyLimit when DailyCapOverride
	// is nil, so DB-only mailboxes don't silently disable the engine
	// (memory project_tocfg_daily_limit_zero).
	LifecyclePhase string
}

// PhaseDailyCap returns the warmup-ramp daily-send cap for a given
// lifecycle_phase value. Mirrors the Postgres compute_phase_cap() function
// (migration 116 — operator target 180/mb/day in production, warmup phases
// scaled proportionally) so DB-only mailboxes without daily_cap_override still
// resolve to the correct phase ceiling at engine pickMailbox time.
// Unknown / empty phase falls back to warmup_d0 (10) — the safest floor.
func PhaseDailyCap(phase string) int {
	switch phase {
	case "production":
		return 180
	case "warmup_d14":
		return 120
	case "warmup_d7":
		return 70
	case "warmup_d3":
		return 30
	case "warmup_d0", "":
		return 10
	default:
		return 10
	}
}

// NormaliseAddress returns the canonical form used in persistence and
// comparisons: lower-cased, surrounding whitespace trimmed.
func NormaliseAddress(addr string) string {
	return strings.ToLower(strings.TrimSpace(addr))
}

// Validate reports whether m carries the minimum configuration required to
// insert it into the registry. Counter fields are not validated — they are
// maintained post-insert.
func (m Mailbox) Validate() error {
	if NormaliseAddress(m.FromAddress) == "" {
		return errors.New("mailbox: FromAddress is required")
	}
	if m.FromAddress != NormaliseAddress(m.FromAddress) {
		return fmt.Errorf("mailbox: FromAddress %q must be lower-cased and trimmed", m.FromAddress)
	}
	if strings.TrimSpace(m.DisplayName) == "" {
		return errors.New("mailbox: DisplayName is required")
	}
	if strings.TrimSpace(m.SMTPHost) == "" {
		return errors.New("mailbox: SMTPHost is required")
	}
	if m.SMTPPort < 1 || m.SMTPPort > 65535 {
		return fmt.Errorf("mailbox: SMTPPort %d out of range", m.SMTPPort)
	}
	if m.IMAPHost != "" && (m.IMAPPort < 1 || m.IMAPPort > 65535) {
		return fmt.Errorf("mailbox: IMAPPort %d out of range", m.IMAPPort)
	}
	if m.DailyCapOverride != nil && *m.DailyCapOverride < 0 {
		return fmt.Errorf("mailbox: DailyCapOverride %d must be >= 0", *m.DailyCapOverride)
	}
	if !m.Status.Valid() {
		return fmt.Errorf("mailbox: unknown Status %q", m.Status)
	}
	return nil
}

// CooldownExpired reports whether the per-mailbox cooldown has elapsed.
// A mailbox with LastSendAt == nil has never sent, so cooldown is always
// considered expired. This is purely a time check — it does not consult
// status or daily caps.
func (m Mailbox) CooldownExpired(now time.Time, cooldown time.Duration) bool {
	if m.LastSendAt == nil {
		return true
	}
	return now.Sub(*m.LastSendAt) >= cooldown
}

// Store is the persistence contract for the mailbox registry. Implementations
// typically wrap a *sql.DB; tests use an in-memory fake.
type Store interface {
	List(ctx context.Context, filter Filter) ([]Mailbox, error)
	Get(ctx context.Context, id int64) (Mailbox, error)
	GetByAddress(ctx context.Context, fromAddress string) (Mailbox, error)
	UpsertFromConfig(ctx context.Context, m Mailbox) (Mailbox, error)
	UpdateStatus(ctx context.Context, id int64, status Status, reason string) (Mailbox, error)
	TouchLastSend(ctx context.Context, id int64, sentAt time.Time) error
	IncrementBounce(ctx context.Context, id int64) (Mailbox, error)
	ResetBounce(ctx context.Context, id int64) error

	// Create inserts a new mailbox row from dashboard input. Fails with
	// a duplicate-key error if from_address already exists.
	Create(ctx context.Context, m Mailbox) (Mailbox, error)
	// Update modifies configuration-owned fields (display,
	// SMTP/IMAP host/port/user, daily cap, tz, locale, password). Empty
	// password is treated as "no change" so form submits that omit the
	// field don't wipe the stored credential. Counters and status
	// lifecycle are not touched.
	Update(ctx context.Context, id int64, m Mailbox) (Mailbox, error)
	// Delete removes the mailbox row. Fails with an FK error if still
	// referenced by an active campaign.
	Delete(ctx context.Context, id int64) error
}

// Filter is the query shape used by cockpit list endpoints.
type Filter struct {
	Status      []Status
	Limit       int    // zero → 100
	Environment string // exact match on environment; "" → any (use "production" for campaign paths)
}

// ApplyDefault normalises zero-valued fields so callers can pass an empty
// filter for "everything".
func (f Filter) ApplyDefault() Filter {
	if f.Limit <= 0 {
		f.Limit = 100
	}
	return f
}

// ErrMailboxNotFound is returned by Store implementations when the requested
// id / address does not exist.
var ErrMailboxNotFound = errors.New("mailbox: not found")

// ErrNoSendable is returned by Selector.Pick when no mailbox in the pool is
// eligible to send right now (everything paused / over cap / in cooldown).
var ErrNoSendable = errors.New("mailbox: no sendable candidate")

// CapacityFunc returns the remaining daily capacity for a mailbox at a given
// moment. The selector defers to this function so callers can wire in the
// warmup daemon (for mailboxes with DailyCapOverride == nil) or any other
// rate-limiter oracle.
//
// Returning a non-positive value means "no capacity left today" — the
// selector will skip that mailbox.
type CapacityFunc func(ctx context.Context, m Mailbox, now time.Time) (int, error)

// Selector picks the next mailbox from a candidate pool using fair rotation:
// the active, capacity-having, cooldown-expired mailbox with the oldest
// LastSendAt wins. This gives every mailbox a chance before any one mailbox
// sends twice.
type Selector struct {
	// Cooldown is the minimum delay between two consecutive sends from the
	// same mailbox. Enforced even when daily cap would otherwise allow it,
	// to spread sends over the day and avoid obvious burstiness.
	Cooldown time.Duration

	// Capacity is the capacity oracle. Required.
	Capacity CapacityFunc
}

// Pick returns the next mailbox to use from pool. Selection rules, in order:
//
//  1. Drop mailboxes whose Status is not Sendable.
//  2. Drop mailboxes whose cooldown has not elapsed.
//  3. Drop mailboxes whose Capacity oracle reports <= 0 remaining.
//  4. Of the survivors, prefer the one with the oldest LastSendAt
//     (nil LastSendAt sorts first — "has never sent, give it a turn").
//  5. Tiebreak by id ascending for determinism.
//
// Returns ErrNoSendable if nothing qualifies.
func (sel Selector) Pick(ctx context.Context, pool []Mailbox, now time.Time) (Mailbox, error) {
	if sel.Capacity == nil {
		return Mailbox{}, errors.New("mailbox: Selector.Capacity is nil")
	}

	survivors := make([]Mailbox, 0, len(pool))
	for _, m := range pool {
		if !m.Status.Sendable() {
			continue
		}
		if !m.CooldownExpired(now, sel.Cooldown) {
			continue
		}
		remaining, err := sel.Capacity(ctx, m, now)
		if err != nil {
			return Mailbox{}, fmt.Errorf("mailbox: capacity oracle failed for %s: %w", m.FromAddress, err)
		}
		if remaining <= 0 {
			continue
		}
		survivors = append(survivors, m)
	}

	if len(survivors) == 0 {
		return Mailbox{}, ErrNoSendable
	}

	sort.SliceStable(survivors, func(i, j int) bool {
		li, lj := survivors[i].LastSendAt, survivors[j].LastSendAt
		switch {
		case li == nil && lj == nil:
			return survivors[i].ID < survivors[j].ID
		case li == nil:
			return true
		case lj == nil:
			return false
		case li.Equal(*lj):
			return survivors[i].ID < survivors[j].ID
		default:
			return li.Before(*lj)
		}
	})
	return survivors[0], nil
}

// StaticCapacity returns a CapacityFunc that always reports the same remaining
// capacity regardless of mailbox identity. Useful for tests and as a sane
// default when no warmup daemon is wired.
func StaticCapacity(remaining int) CapacityFunc {
	return func(_ context.Context, _ Mailbox, _ time.Time) (int, error) {
		return remaining, nil
	}
}

// BackpressureThreshold is the default number of consecutive bounces after
// which a mailbox should be moved to StatusBounceHold. Exported so the
// bounce pipeline and cockpit dashboard agree on the threshold.
const BackpressureThreshold = 5

// ShouldAutoHold reports whether a mailbox's consecutive-bounce count has
// crossed BackpressureThreshold and it should be auto-moved to bounce_hold.
// Idempotent: returns false for mailboxes already on hold or retired.
func ShouldAutoHold(m Mailbox) bool {
	if m.Status != StatusActive {
		return false
	}
	return m.ConsecutiveBounces >= BackpressureThreshold
}
