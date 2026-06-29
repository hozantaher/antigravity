package campaign

import (
	"context"
	"log/slog"
	"common/envconfig"
	"strconv"
	"time"
)

// SchedulerRunner is the minimal interface the Scheduler needs from a campaign runner.
type SchedulerRunner interface {
	RunCampaign(ctx context.Context, id int64) error
}

// SchedulerLocker acquires and releases Postgres advisory locks.
type SchedulerLocker interface {
	TryAdvisoryLock(ctx context.Context, id int64) (bool, error)
	ReleaseAdvisoryLock(ctx context.Context, id int64) error
}

// SchedulerDB lists campaigns ready to run.
type SchedulerDB interface {
	ListRunningCampaigns(ctx context.Context) ([]schedulerCampaign, error)
}

type schedulerCampaign struct {
	ID     int64
	Status string
}

// Scheduler polls for running campaigns and executes each under an advisory lock.
// Multiple Scheduler instances across daemon replicas are safe — only one wins
// the advisory lock per campaign per tick.
type Scheduler struct {
	db     SchedulerDB
	runner SchedulerRunner
	locker SchedulerLocker
}

// NewScheduler creates a Scheduler. Interval is configured via Start().
func NewScheduler(db SchedulerDB, runner SchedulerRunner, locker SchedulerLocker) *Scheduler {
	return &Scheduler{db: db, runner: runner, locker: locker}
}

// Start runs the scheduler loop until ctx is cancelled.
// Interval defaults to SCHEDULER_INTERVAL_SEC env (default 60s).
func (s *Scheduler) Start(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = defaultInterval()
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.tick(ctx)
		}
	}
}

// Tick is one scheduler iteration. Exported so main.go can wrap it with
// panic recovery and health reporting.
func (s *Scheduler) Tick(ctx context.Context) { s.tick(ctx) }

func (s *Scheduler) tick(ctx context.Context) {
	campaigns, err := s.db.ListRunningCampaigns(ctx)
	if err != nil {
		slog.Error("scheduler: list running campaigns", "op", "scheduler.tick", "error", err)
		return
	}
	for _, c := range campaigns {
		s.runOne(ctx, c.ID)
	}
}

func (s *Scheduler) runOne(ctx context.Context, id int64) {
	// Inner-scope panic recovery: a panicking RunCampaign (e.g. nil deref in
	// template render, malformed sequence_config, panic in PreSendHook) MUST
	// NOT abort sibling campaigns in the same tick. The outer cmd/outreach
	// wrapper has its own recovery, but that fires AFTER skipping the rest
	// of the loop. Defensive recovery here keeps the tick going.
	defer func() {
		if p := recover(); p != nil {
			slog.Error("scheduler: campaign run panic recovered",
				"op", "scheduler.runOne/recover",
				"campaign_id", id,
				"recover", p)
		}
	}()

	locked, err := s.locker.TryAdvisoryLock(ctx, id)
	if err != nil {
		slog.Error("scheduler: advisory lock error", "op", "scheduler.runOne/lock", "campaign_id", id, "error", err)
		return
	}
	if !locked {
		return // another instance holds it
	}
	defer func() {
		if rerr := s.locker.ReleaseAdvisoryLock(ctx, id); rerr != nil {
			slog.Error("scheduler: release lock", "op", "scheduler.runOne/release", "campaign_id", id, "error", rerr)
		}
	}()

	start := time.Now()
	if err := s.runner.RunCampaign(ctx, id); err != nil {
		slog.Error("scheduler: run campaign", "op", "scheduler.runOne", "campaign_id", id, "duration_ms", time.Since(start).Milliseconds(), "error", err)
		return
	}
	slog.Info("scheduler: campaign done", "campaign_id", id, "duration_ms", time.Since(start).Milliseconds())
}

func defaultInterval() time.Duration {
	if v := envconfig.GetOr("SCHEDULER_INTERVAL_SEC", ""); v != "" {
		if sec, err := strconv.Atoi(v); err == nil && sec > 0 {
			return time.Duration(sec) * time.Second
		}
	}
	return 60 * time.Second
}
