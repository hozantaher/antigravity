// Package warmup advances mailbox sending limits on a multi-day ramp.
//
// The warmup daemon is meant to be invoked once per business day via cron
// or a Kubernetes CronJob — not as a continuous process. One-shot execution
// keeps the blast radius tight: if it crashes, the next day's tick still
// advances the ramp.
//
// Plans are defined in configs/warmup.yaml as an ordered list of
// {day, daily_limit} entries per plan name. This package avoids pulling a
// YAML dependency by parsing a tiny subset of YAML that is sufficient for
// the shape we emit. Callers that want richer YAML support should parse
// with gopkg.in/yaml.v3 upstream and pass the decoded Plan struct directly
// via NewPlanner.
package warmup

import (
	"bufio"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ScheduleEntry represents one step in a warmup plan.
type ScheduleEntry struct {
	Day         int
	DailyLimit  int
}

// Plan is an ordered, ascending-by-day set of ScheduleEntries.
type Plan struct {
	Name        string
	Description string
	Schedule    []ScheduleEntry
}

// LimitForDay returns the daily limit for a mailbox whose warmup_day = day.
// It returns the limit for max(entry.Day) where entry.Day <= day, or the
// first entry when day < first.Day.
func (p Plan) LimitForDay(day int) int {
	if len(p.Schedule) == 0 {
		return 0
	}
	best := p.Schedule[0].DailyLimit
	for _, e := range p.Schedule {
		if e.Day <= day && e.DailyLimit > best {
			best = e.DailyLimit
		}
	}
	return best
}

// IsComplete returns true when day >= last entry in the plan.
func (p Plan) IsComplete(day int) bool {
	if len(p.Schedule) == 0 {
		return true
	}
	last := p.Schedule[len(p.Schedule)-1]
	return day >= last.Day
}

// LoadPlansFromYAML parses configs/warmup.yaml. This is a narrow parser
// that only supports the subset our file uses (no anchors, flow style
// scalars are tolerated, multi-line strings are preserved as-is).
//
// Callers that need full YAML compliance should parse the file with a
// real YAML library and build Plan values directly.
func LoadPlansFromYAML(path string) (map[string]Plan, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	plans := make(map[string]Plan)
	var currentPlan *Plan
	var inSchedule bool
	var inPlansBlock bool
	var inDescription bool

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))

		// Top-level "plans:" key.
		if indent == 0 && strings.HasPrefix(trimmed, "plans:") {
			inPlansBlock = true
			continue
		}
		if !inPlansBlock {
			continue
		}
		if indent == 0 {
			// Left the plans block.
			break
		}

		// Plan name at indent 2: "default_30d:"
		if indent == 2 && strings.HasSuffix(trimmed, ":") {
			if currentPlan != nil {
				plans[currentPlan.Name] = *currentPlan
			}
			name := strings.TrimSuffix(trimmed, ":")
			currentPlan = &Plan{Name: name}
			inSchedule = false
			inDescription = false
			continue
		}
		if currentPlan == nil {
			continue
		}

		// "description: |" or "schedule:" at indent 4.
		if indent == 4 {
			inDescription = false
			inSchedule = false
			if strings.HasPrefix(trimmed, "description:") {
				inDescription = true
			} else if strings.HasPrefix(trimmed, "schedule:") {
				inSchedule = true
			}
			continue
		}

		if inDescription && indent >= 6 {
			if currentPlan.Description != "" {
				currentPlan.Description += "\n"
			}
			currentPlan.Description += strings.TrimSpace(line)
			continue
		}

		if inSchedule && strings.HasPrefix(trimmed, "- ") {
			entry, err := parseScheduleEntry(trimmed[2:])
			if err != nil {
				return nil, fmt.Errorf("parse plan %q: %w", currentPlan.Name, err)
			}
			currentPlan.Schedule = append(currentPlan.Schedule, entry)
			continue
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if currentPlan != nil {
		plans[currentPlan.Name] = *currentPlan
	}

	// Sort each plan's schedule by ascending day.
	for k, p := range plans {
		sort.Slice(p.Schedule, func(i, j int) bool { return p.Schedule[i].Day < p.Schedule[j].Day })
		plans[k] = p
	}

	if len(plans) == 0 {
		return nil, fmt.Errorf("no plans found in %s", path)
	}
	return plans, nil
}

// parseScheduleEntry parses "{ day: 3, daily_limit: 40 }" (whitespace-tolerant).
func parseScheduleEntry(s string) (ScheduleEntry, error) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "{")
	s = strings.TrimSuffix(s, "}")
	var e ScheduleEntry
	parts := strings.Split(s, ",")
	for _, part := range parts {
		kv := strings.SplitN(part, ":", 2)
		if len(kv) != 2 {
			continue
		}
		key := strings.TrimSpace(kv[0])
		val := strings.TrimSpace(kv[1])
		n, err := strconv.Atoi(val)
		if err != nil {
			return e, fmt.Errorf("non-integer value for %s: %q", key, val)
		}
		switch key {
		case "day":
			e.Day = n
		case "daily_limit":
			e.DailyLimit = n
		}
	}
	if e.Day <= 0 || e.DailyLimit <= 0 {
		return e, fmt.Errorf("invalid entry %q: day and daily_limit must be positive", s)
	}
	return e, nil
}

// Daemon runs the warmup tick against a mailbox_warmup table.
type Daemon struct {
	db    *sql.DB
	plans map[string]Plan
	now   func() time.Time
}

// NewDaemon constructs a Daemon with the given DB and plan set.
func NewDaemon(db *sql.DB, plans map[string]Plan) *Daemon {
	return &Daemon{db: db, plans: plans, now: time.Now}
}

// Tick advances warmup_day by 1 for every non-paused mailbox whose
// last_advanced_at is older than 20 hours. Returns the number of rows advanced.
// Intended to be invoked once per business day from cron.
//
// D-3 — accepts context.Context (was a stripped-down interface) so a
// stuck UPDATE during the daily tick is cancellable. Callers that
// don't have a deadline can pass context.Background().
func (d *Daemon) Tick(ctx context.Context) (int, error) {
	res, err := d.db.ExecContext(ctx, `
		UPDATE mailbox_warmup
		   SET warmup_day       = warmup_day + 1,
		       last_advanced_at = now()
		 WHERE is_paused = false
		   AND last_advanced_at < now() - interval '20 hours'
	`)
	if err != nil {
		return 0, fmt.Errorf("update mailbox_warmup: %w", err)
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// EnrollMailbox registers a new mailbox for warmup with the given plan.
// Idempotent — does nothing if the mailbox is already enrolled.
//
// D-3 — accepts context for cancellation propagation.
func (d *Daemon) EnrollMailbox(ctx context.Context, address, planName string) error {
	if _, ok := d.plans[planName]; !ok {
		return fmt.Errorf("unknown plan %q", planName)
	}
	_, err := d.db.ExecContext(ctx, `
		INSERT INTO mailbox_warmup (mailbox_address, plan_name)
		VALUES ($1, $2)
		ON CONFLICT (mailbox_address) DO NOTHING
	`, address, planName)
	return err
}

// Pause marks a mailbox as paused with a reason; the daemon will skip
// advancement until Resume is called.
//
// D-3 — accepts context for cancellation propagation.
func (d *Daemon) Pause(ctx context.Context, address, reason string) error {
	_, err := d.db.ExecContext(ctx, `
		UPDATE mailbox_warmup
		   SET is_paused = true, pause_reason = $2
		 WHERE mailbox_address = $1
	`, address, reason)
	return err
}

// Resume clears paused state.
//
// D-3 — accepts context for cancellation propagation.
func (d *Daemon) Resume(ctx context.Context, address string) error {
	_, err := d.db.ExecContext(ctx, `
		UPDATE mailbox_warmup
		   SET is_paused = false, pause_reason = NULL
		 WHERE mailbox_address = $1
	`, address)
	return err
}

// Reset resets warmup_day to 0 and clears paused state.
// Called when a mailbox is released from bounce_hold so it re-ramps from scratch.
//
// D-3 — accepts context for cancellation propagation.
func (d *Daemon) Reset(ctx context.Context, address string) error {
	_, err := d.db.ExecContext(ctx, `
		UPDATE mailbox_warmup
		   SET warmup_day = 0, is_paused = false, pause_reason = NULL,
		       last_advanced_at = now()
		 WHERE mailbox_address = $1
	`, address)
	return err
}

// LimitForMailbox reads the current warmup state for a mailbox and returns
// the current daily limit. Falls back to fallbackLimit if no warmup row or
// the plan is unknown.
//
// D-3 — accepts context for cancellation propagation.
func (d *Daemon) LimitForMailbox(ctx context.Context, address string, fallbackLimit int) (int, error) {
	var (
		day       int
		planName  string
		isPaused  bool
	)
	err := d.db.QueryRowContext(ctx, `
		SELECT warmup_day, plan_name, is_paused
		  FROM mailbox_warmup
		 WHERE mailbox_address = $1
	`, address).Scan(&day, &planName, &isPaused)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fallbackLimit, nil
		}
		return 0, err
	}
	plan, ok := d.plans[planName]
	if !ok {
		return fallbackLimit, nil
	}
	if isPaused {
		// Paused mailboxes stay at the current limit.
		return plan.LimitForDay(day), nil
	}
	return plan.LimitForDay(day), nil
}
