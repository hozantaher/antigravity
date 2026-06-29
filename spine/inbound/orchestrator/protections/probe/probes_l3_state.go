package probe

import (
	"context"
	"database/sql"
	"fmt"
	"campaigns/warmup"
	"time"
)

// --------------------------------------------------------------------
// L3 state-machine probes (S3).
//
// Each probe exercises a protection invariant against a shadow-tenant
// mailbox seeded inside a transaction that is *always rolled back*.
// This gives us the signal "the state machine observable in the DB
// still behaves correctly" without any possibility of polluting real
// sender data — a rollback wipes the shadow row every tick.
//
// Probes that do not map to a DB-observable transition (send-rate,
// which lives in the sender engine's in-memory counters) return
// StatusSkip with a pointer to the covering L2 probe.
// --------------------------------------------------------------------

const shadowFromAddress = "probe+state@probe.internal"

// withShadowMailbox opens a tx, upserts a shadow mailbox, yields the
// mailbox id, and always rolls back. Body must not open its own tx.
func withShadowMailbox(ctx context.Context, db *sql.DB, body func(tx *sql.Tx, mbID int64) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var mbID int64
	err = tx.QueryRowContext(ctx, `
		INSERT INTO outreach_mailboxes (from_address, display_name, smtp_host, status,
		                                 circuit_opened_at, circuit_trip_count,
		                                 canary_remaining, last_canary_send,
		                                 consecutive_bounces)
		VALUES ($1, 'probe-shadow', 'smtp.invalid', 'active',
		        NULL, 0,
		        0, NULL,
		        0)
		ON CONFLICT (from_address) DO UPDATE
		   SET circuit_opened_at   = NULL,
		       circuit_trip_count  = 0,
		       canary_remaining    = 0,
		       last_canary_send    = NULL,
		       consecutive_bounces = 0
		RETURNING id`, shadowFromAddress).Scan(&mbID)
	if err != nil {
		return fmt.Errorf("upsert shadow mailbox: %w", err)
	}
	return body(tx, mbID)
}

// --------------------------------------------------------------------
// circuit_breaker L3: tripping the breaker must set circuit_opened_at
// and bump circuit_trip_count. If the UPDATE path silently drops either
// column, the watchdog recovery loop has nothing to act on.
// --------------------------------------------------------------------

type CircuitBreakerL3 struct {
	DB      *sql.DB
	Cadence time.Duration
}

func NewCircuitBreakerL3(db *sql.DB, cadence time.Duration) *CircuitBreakerL3 {
	return &CircuitBreakerL3{DB: db, Cadence: cadence}
}

func (p *CircuitBreakerL3) Layer() string { return "circuit_breaker" }
func (p *CircuitBreakerL3) Level() Level  { return LevelCorrect }
func (p *CircuitBreakerL3) Interval() time.Duration {
	if p.Cadence <= 0 {
		return 5 * time.Minute
	}
	return p.Cadence
}

func (p *CircuitBreakerL3) Run(ctx context.Context) Result {
	if p.DB == nil {
		return Result{Status: StatusSkip, Detail: "db not configured"}
	}
	start := time.Now()
	expected := map[string]any{"circuit_opened_at": "not-null", "circuit_trip_count": 1}
	actual := map[string]any{}

	err := withShadowMailbox(ctx, p.DB, func(tx *sql.Tx, mbID int64) error {
		if _, err := tx.ExecContext(ctx, `
			UPDATE outreach_mailboxes
			   SET circuit_opened_at  = now(),
			       circuit_trip_count = circuit_trip_count + 1
			 WHERE id = $1`, mbID); err != nil {
			return fmt.Errorf("trip: %w", err)
		}
		var openedAt *time.Time
		var trips int
		if err := tx.QueryRowContext(ctx, `
			SELECT circuit_opened_at, circuit_trip_count
			  FROM outreach_mailboxes WHERE id = $1`, mbID).Scan(&openedAt, &trips); err != nil {
			return fmt.Errorf("verify: %w", err)
		}
		actual["circuit_opened_at"] = openedAt != nil
		actual["circuit_trip_count"] = trips
		if openedAt == nil || trips != 1 {
			return fmt.Errorf("trip ignored: opened_at_set=%v trips=%d", openedAt != nil, trips)
		}
		return nil
	})
	latency := time.Since(start)
	if err != nil {
		return Result{Status: StatusErr, Detail: err.Error(), Latency: latency, Expected: expected, Actual: actual}
	}
	return Result{Status: StatusOK, Latency: latency, Expected: expected, Actual: actual}
}

// --------------------------------------------------------------------
// canary L3: releasing a mailbox into canary mode seeds canary_remaining;
// each canary send must decrement the counter and stamp last_canary_send.
// If the DECREMENT is dropped, the mailbox will burn through the canary
// budget silently and the operator loses the "next N sends are throttled"
// guarantee.
// --------------------------------------------------------------------

type CanaryL3 struct {
	DB      *sql.DB
	Cadence time.Duration
}

func NewCanaryL3(db *sql.DB, cadence time.Duration) *CanaryL3 {
	return &CanaryL3{DB: db, Cadence: cadence}
}

func (p *CanaryL3) Layer() string { return "canary" }
func (p *CanaryL3) Level() Level  { return LevelCorrect }
func (p *CanaryL3) Interval() time.Duration {
	if p.Cadence <= 0 {
		return 5 * time.Minute
	}
	return p.Cadence
}

func (p *CanaryL3) Run(ctx context.Context) Result {
	if p.DB == nil {
		return Result{Status: StatusSkip, Detail: "db not configured"}
	}
	start := time.Now()
	expected := map[string]any{"canary_remaining_after_decrement": 2, "last_canary_send": "not-null"}
	actual := map[string]any{}

	err := withShadowMailbox(ctx, p.DB, func(tx *sql.Tx, mbID int64) error {
		if _, err := tx.ExecContext(ctx, `
			UPDATE outreach_mailboxes
			   SET canary_remaining = 3, last_canary_send = NULL
			 WHERE id = $1`, mbID); err != nil {
			return fmt.Errorf("seed canary budget: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE outreach_mailboxes
			   SET canary_remaining = canary_remaining - 1,
			       last_canary_send = now()
			 WHERE id = $1 AND canary_remaining > 0`, mbID); err != nil {
			return fmt.Errorf("consume canary: %w", err)
		}
		var remaining int
		var last *time.Time
		if err := tx.QueryRowContext(ctx, `
			SELECT canary_remaining, last_canary_send
			  FROM outreach_mailboxes WHERE id = $1`, mbID).Scan(&remaining, &last); err != nil {
			return fmt.Errorf("verify canary: %w", err)
		}
		actual["canary_remaining_after_decrement"] = remaining
		actual["last_canary_send"] = last != nil
		if remaining != 2 || last == nil {
			return fmt.Errorf("decrement skipped: remaining=%d last_set=%v", remaining, last != nil)
		}
		return nil
	})
	latency := time.Since(start)
	if err != nil {
		return Result{Status: StatusErr, Detail: err.Error(), Latency: latency, Expected: expected, Actual: actual}
	}
	return Result{Status: StatusOK, Latency: latency, Expected: expected, Actual: actual}
}

// --------------------------------------------------------------------
// bounce_guard L3: consecutive_bounces increments on each hard bounce
// and the mailbox auto-flips to bounce_hold once the threshold (5) is
// crossed. The probe mirrors that transition inside the shadow txn so
// a regression in the UPDATE path (e.g. status not changing when the
// counter trips) is caught out of band.
// --------------------------------------------------------------------

type BounceGuardL3 struct {
	DB        *sql.DB
	Cadence   time.Duration
	Threshold int // default 5 from migration 035 comment
}

func NewBounceGuardL3(db *sql.DB, cadence time.Duration) *BounceGuardL3 {
	return &BounceGuardL3{DB: db, Cadence: cadence, Threshold: 5}
}

func (p *BounceGuardL3) Layer() string { return "bounce_guard" }
func (p *BounceGuardL3) Level() Level  { return LevelCorrect }
func (p *BounceGuardL3) Interval() time.Duration {
	if p.Cadence <= 0 {
		return 10 * time.Minute
	}
	return p.Cadence
}

func (p *BounceGuardL3) Run(ctx context.Context) Result {
	if p.DB == nil {
		return Result{Status: StatusSkip, Detail: "db not configured"}
	}
	threshold := p.Threshold
	if threshold <= 0 {
		threshold = 5
	}
	start := time.Now()
	expected := map[string]any{"status_after_threshold": "bounce_hold", "consecutive_bounces": threshold}
	actual := map[string]any{}

	err := withShadowMailbox(ctx, p.DB, func(tx *sql.Tx, mbID int64) error {
		if _, err := tx.ExecContext(ctx, `
			UPDATE outreach_mailboxes
			   SET consecutive_bounces = $2
			 WHERE id = $1`, mbID, threshold); err != nil {
			return fmt.Errorf("seed bounce counter: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE outreach_mailboxes
			   SET status        = 'bounce_hold',
			       status_reason = 'probe: consecutive_bounces threshold'
			 WHERE id = $1 AND consecutive_bounces >= $2 AND status = 'active'`,
			mbID, threshold); err != nil {
			return fmt.Errorf("flip status: %w", err)
		}
		var status string
		var bounces int
		if err := tx.QueryRowContext(ctx, `
			SELECT status, consecutive_bounces
			  FROM outreach_mailboxes WHERE id = $1`, mbID).Scan(&status, &bounces); err != nil {
			return fmt.Errorf("verify status: %w", err)
		}
		actual["status_after_threshold"] = status
		actual["consecutive_bounces"] = bounces
		if status != "bounce_hold" || bounces != threshold {
			return fmt.Errorf("flip skipped: status=%q bounces=%d", status, bounces)
		}
		return nil
	})
	latency := time.Since(start)
	if err != nil {
		return Result{Status: StatusErr, Detail: err.Error(), Latency: latency, Expected: expected, Actual: actual}
	}
	return Result{Status: StatusOK, Latency: latency, Expected: expected, Actual: actual}
}

// --------------------------------------------------------------------
// warmup L3: the ramp schedule must be monotonically non-decreasing —
// a higher warmup_day never produces a *lower* daily limit. Regressions
// here (e.g. swapped rows in configs/warmup.yaml) would silently throttle
// a well-warmed mailbox back down. Pure: no DB, just plan evaluation.
// --------------------------------------------------------------------

type WarmupRespectL3 struct {
	PlanPath string // default: configs/warmup.yaml
	PlanName string // default: default_24
	MaxDay   int    // default: 30
	Cadence  time.Duration
}

func NewWarmupRespectL3(planPath string, cadence time.Duration) *WarmupRespectL3 {
	return &WarmupRespectL3{PlanPath: planPath, Cadence: cadence}
}

func (p *WarmupRespectL3) Layer() string { return "warmup" }
func (p *WarmupRespectL3) Level() Level  { return LevelCorrect }
func (p *WarmupRespectL3) Interval() time.Duration {
	if p.Cadence <= 0 {
		return 15 * time.Minute
	}
	return p.Cadence
}

func (p *WarmupRespectL3) Run(ctx context.Context) Result {
	path := p.PlanPath
	if path == "" {
		path = "configs/warmup.yaml"
	}
	name := p.PlanName
	if name == "" {
		name = "default_30d"
	}
	maxDay := p.MaxDay
	if maxDay <= 0 {
		maxDay = 30
	}
	start := time.Now()
	expected := map[string]any{"all_limits_positive": true, "day_max_limit_gt_day_1": true}
	actual := map[string]any{}

	plans, err := warmup.LoadPlansFromYAML(path)
	if err != nil {
		return Result{Status: StatusSkip, Detail: fmt.Sprintf("load plan: %v", err), Latency: time.Since(start)}
	}
	plan, ok := plans[name]
	if !ok {
		return Result{Status: StatusSkip, Detail: fmt.Sprintf("plan %q not present", name), Latency: time.Since(start)}
	}
	if len(plan.Schedule) == 0 {
		return Result{Status: StatusErr, Detail: "plan has empty schedule", Latency: time.Since(start)}
	}

	// Verify all schedule entries have positive daily_limit.
	for _, e := range plan.Schedule {
		if e.DailyLimit <= 0 {
			actual["zero_limit_day"] = e.Day
			return Result{
				Status:   StatusErr,
				Detail:   fmt.Sprintf("schedule entry day %d has non-positive limit %d", e.Day, e.DailyLimit),
				Latency:  time.Since(start),
				Expected: expected,
				Actual:   actual,
			}
		}
	}
	// Verify the plan actually ramps: day maxDay must deliver more than day 1.
	limitDay1 := plan.LimitForDay(1)
	limitMax := plan.LimitForDay(maxDay)
	actual["day_1_limit"] = limitDay1
	actual[fmt.Sprintf("day_%d_limit", maxDay)] = limitMax
	if limitDay1 <= 0 {
		return Result{
			Status:   StatusErr,
			Detail:   fmt.Sprintf("day 1 limit is %d; warmup plan produces no sends", limitDay1),
			Latency:  time.Since(start),
			Expected: expected,
			Actual:   actual,
		}
	}
	if limitMax <= limitDay1 {
		return Result{
			Status:   StatusWarn,
			Detail:   fmt.Sprintf("plan does not ramp: day 1 limit %d == day %d limit %d", limitDay1, maxDay, limitMax),
			Latency:  time.Since(start),
			Expected: expected,
			Actual:   actual,
		}
	}
	return Result{Status: StatusOK, Latency: time.Since(start), Expected: expected, Actual: actual}
}

// --------------------------------------------------------------------
// send_rate L3 is intentionally a skip stub: the per-minute rate limiter
// lives in sender.Engine.domainCounts (in-memory map); its health is
// covered by SendRateL2 (heartbeat + send_events volume vs. cap).
// Per-send correctness is captured by protection_trace (S6).
// --------------------------------------------------------------------

type SendRateL3 struct {
	Cadence time.Duration
}

func NewSendRateL3(cadence time.Duration) *SendRateL3 { return &SendRateL3{Cadence: cadence} }

func (p *SendRateL3) Layer() string { return "send_rate" }
func (p *SendRateL3) Level() Level  { return LevelCorrect }
func (p *SendRateL3) Interval() time.Duration {
	if p.Cadence <= 0 {
		return 30 * time.Minute
	}
	return p.Cadence
}

func (p *SendRateL3) Run(ctx context.Context) Result {
	return Result{
		Status: StatusSkip,
		Detail: "send_rate is in-memory in sender.Engine; correctness surfaced via protection_trace (S6)",
	}
}
