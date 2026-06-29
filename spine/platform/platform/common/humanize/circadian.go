package humanize

import (
	"crypto/rand"
	"encoding/binary"
	"math"
	"time"
)

// CircadianEngine models a real Czech businessperson's daily email rhythm.
// Emails are sent in clusters (3-7) with short gaps (2-6 min), separated
// by long breaks (45-120 min). No emails during lunch (12:00-13:30).
type CircadianEngine struct {
	loc             *time.Location
	morningStart    int // hour, default 8
	lunchStart      int // hour, default 12
	lunchEnd        int // hour, default 13 (13:30 in practice)
	eveningEnd      int // hour, default 17
	clusterMin      int // min emails per cluster
	clusterMax      int // max emails per cluster
	clusterGapMin   int // min minutes between clusters
	clusterGapMax   int // max minutes between clusters
	skipDayProb     float64
	weeklyMultiplier [7]float64 // Sun=0..Sat=6
}

// NewCircadianEngine creates a circadian engine with Czech defaults.
func NewCircadianEngine() *CircadianEngine {
	loc, _ := time.LoadLocation("Europe/Prague")
	if loc == nil {
		loc = time.UTC
	}
	return &CircadianEngine{
		loc:           loc,
		morningStart:  8,
		lunchStart:    12,
		lunchEnd:      13,
		eveningEnd:    17,
		clusterMin:    3,
		clusterMax:    7,
		clusterGapMin: 45,
		clusterGapMax: 120,
		skipDayProb:   0.10,
		weeklyMultiplier: [7]float64{
			0.0,  // Sunday
			1.0,  // Monday
			1.15, // Tuesday (peak)
			0.97, // Wednesday
			0.85, // Thursday
			0.55, // Friday
			0.0,  // Saturday
		},
	}
}

// SendWindow represents a time window when sending is allowed.
type SendWindow struct {
	Start time.Time
	End   time.Time
	Type  string // "morning_peak", "pre_lunch", "afternoon", "wind_down"
}

// DayPlan generates the sending plan for a given day.
// Returns the scheduled send times for each email in the day.
type DayPlan struct {
	Date       time.Time
	SkipDay    bool
	SendTimes  []time.Time
	Multiplier float64
}

// PlanDay generates a complete day plan with clustered send times.
func (c *CircadianEngine) PlanDay(date time.Time, baseCount int) DayPlan {
	date = date.In(c.loc)
	dow := date.Weekday()

	plan := DayPlan{
		Date:       date,
		Multiplier: c.weeklyMultiplier[dow],
	}

	// Weekend = no sends
	if plan.Multiplier == 0 {
		plan.SkipDay = true
		return plan
	}

	// Skip day probability
	if cryptoRandFloat() < c.skipDayProb {
		plan.SkipDay = true
		return plan
	}

	// Adjusted count for day of week
	dayCount := int(math.Round(float64(baseCount) * plan.Multiplier))
	if dayCount < 1 {
		dayCount = 1
	}

	// Add variance: ±30%
	variance := 1.0 + (cryptoRandFloat()-0.5)*0.6
	dayCount = int(math.Round(float64(dayCount) * variance))
	if dayCount < 1 {
		dayCount = 1
	}

	// Generate send windows
	windows := c.dayWindows(date)

	// Distribute emails across windows in clusters
	plan.SendTimes = c.distributeClusters(windows, dayCount)

	return plan
}

// dayWindows returns the available sending windows for a day.
func (c *CircadianEngine) dayWindows(date time.Time) []SendWindow {
	y, m, d := date.Date()

	return []SendWindow{
		{
			Start: time.Date(y, m, d, c.morningStart, randMinute(15, 30), 0, 0, c.loc),
			End:   time.Date(y, m, d, 9, 45, 0, 0, c.loc),
			Type:  "morning_peak",
		},
		{
			Start: time.Date(y, m, d, 10, randMinute(0, 30), 0, 0, c.loc),
			End:   time.Date(y, m, d, c.lunchStart, 0, 0, 0, c.loc),
			Type:  "pre_lunch",
		},
		// 12:00-13:30 is DEAD (lunch)
		{
			Start: time.Date(y, m, d, c.lunchEnd, randMinute(30, 45), 0, 0, c.loc),
			End:   time.Date(y, m, d, 15, 30, 0, 0, c.loc),
			Type:  "afternoon",
		},
		{
			Start: time.Date(y, m, d, 15, 30, 0, 0, c.loc),
			End:   time.Date(y, m, d, c.eveningEnd, 0, 0, 0, c.loc),
			Type:  "wind_down",
		},
	}
}

// distributeClusters creates clustered send times within windows.
func (c *CircadianEngine) distributeClusters(windows []SendWindow, totalEmails int) []time.Time {
	var times []time.Time
	remaining := totalEmails

	// Weight windows: morning_peak gets 40%, pre_lunch 25%, afternoon 25%, wind_down 10%
	weights := map[string]float64{
		"morning_peak": 0.40,
		"pre_lunch":    0.25,
		"afternoon":    0.25,
		"wind_down":    0.10,
	}

	for _, w := range windows {
		if remaining <= 0 {
			break
		}

		weight := weights[w.Type]
		windowCount := int(math.Round(float64(totalEmails) * weight))
		if windowCount > remaining {
			windowCount = remaining
		}
		if windowCount < 1 {
			continue
		}

		// Generate cluster within this window
		clusterTimes := c.generateCluster(w.Start, w.End, windowCount)
		times = append(times, clusterTimes...)
		remaining -= len(clusterTimes)
	}

	return times
}

// generateCluster creates a burst of emails with realistic inter-email timing.
// Pattern: first email slowest (warmup), middle fastest (flow), last slows (fatigue).
func (c *CircadianEngine) generateCluster(start, end time.Time, count int) []time.Time {
	if count <= 0 {
		return nil
	}

	available := end.Sub(start)
	if available < time.Minute {
		return nil
	}

	times := make([]time.Time, 0, count)
	current := start.Add(time.Duration(randMinute(0, 5)) * time.Minute)

	for i := 0; i < count; i++ {
		if current.After(end) {
			break
		}
		times = append(times, current)

		// Inter-email gap based on position in cluster
		var gapMin, gapMax int
		switch {
		case i == 0:
			gapMin, gapMax = 3, 6 // warmup: slower
		case i == count-1:
			gapMin, gapMax = 4, 7 // fatigue: slowing
		default:
			gapMin, gapMax = 2, 4 // flow: faster
		}
		gap := time.Duration(randMinute(gapMin, gapMax)) * time.Minute
		// Add seconds-level jitter (humans don't send on exact minutes)
		gap += time.Duration(randMinute(10, 50)) * time.Second
		current = current.Add(gap)
	}

	return times
}

// IsBusinessHour returns true if the time falls within sending hours.
func (c *CircadianEngine) IsBusinessHour(t time.Time) bool {
	t = t.In(c.loc)
	hour := t.Hour()
	min := t.Minute()

	// Dead lunch zone
	if hour == c.lunchStart || (hour == c.lunchEnd && min < 30) {
		return false
	}

	return hour >= c.morningStart && hour < c.eveningEnd
}

// NextBusinessTime returns the next available sending time.
func (c *CircadianEngine) NextBusinessTime(after time.Time) time.Time {
	t := after.In(c.loc)

	for i := 0; i < 14; i++ { // max 2 weeks lookahead
		if c.weeklyMultiplier[t.Weekday()] > 0 && c.IsBusinessHour(t) {
			return t
		}

		// Advance to next morning
		y, m, d := t.Date()
		t = time.Date(y, m, d+1, c.morningStart, randMinute(15, 30), 0, 0, c.loc)
	}

	return after.Add(24 * time.Hour) // fallback
}

func randMinute(min, max int) int {
	if max <= min {
		return min
	}
	var buf [4]byte
	rand.Read(buf[:])
	return min + int(binary.BigEndian.Uint32(buf[:])%uint32(max-min))
}

func cryptoRandFloat() float64 {
	var buf [8]byte
	rand.Read(buf[:])
	return float64(binary.BigEndian.Uint64(buf[:])) / float64(math.MaxUint64)
}
