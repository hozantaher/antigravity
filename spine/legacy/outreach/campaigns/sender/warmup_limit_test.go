package sender

import (
	"fmt"
	"testing"

	"common/config"
)

// Default warmup schedule lives in engine.warmupLimit: day→limit mapping.
// These tests lock in the curve so any accidental regression is caught.

func TestWarmupLimit_DefaultSchedule(t *testing.T) {
	e := &Engine{sending: config.SendingConfig{}}
	cases := []struct {
		day  int
		want int
	}{
		{0, 10},
		{1, 10},
		{2, 20},
		{3, 40},
		{4, 60},
		{5, 80},
		{6, 100},
		{7, 120},
		{8, 120},
		{13, 120},
		{14, 150},
		{15, 150},
		{30, 150},
		{100, 150},
		{-1, 10},
		{-1000, 10},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("day=%d", c.day), func(t *testing.T) {
			if got := e.warmupLimit(c.day); got != c.want {
				t.Errorf("day=%d got=%d want=%d", c.day, got, c.want)
			}
		})
	}
}

func TestWarmupLimit_MonotonicNonDecreasing(t *testing.T) {
	e := &Engine{sending: config.SendingConfig{}}
	prev := -1
	for day := 0; day <= 30; day++ {
		got := e.warmupLimit(day)
		if got < prev {
			t.Errorf("day=%d limit=%d < prev=%d (schedule must be monotonic)", day, got, prev)
		}
		prev = got
	}
}

func TestWarmupLimit_CustomScheduleOverrides(t *testing.T) {
	e := &Engine{sending: config.SendingConfig{
		WarmupSchedule: map[int]int{
			1:  5,
			3:  25,
			10: 100,
			20: 200,
		},
	}}
	// warmupLimit keeps a floor of 10 and only upgrades when a schedule
	// entry beats it — day 1 with custom=5 stays at floor, day 3 hits 25.
	cases := []struct {
		day, want int
	}{
		{0, 10},
		{1, 10},
		{2, 10},
		{3, 25},
		{9, 25},
		{10, 100},
		{19, 100},
		{20, 200},
		{100, 200},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("day=%d", c.day), func(t *testing.T) {
			if got := e.warmupLimit(c.day); got != c.want {
				t.Errorf("day=%d custom got=%d want=%d", c.day, got, c.want)
			}
		})
	}
}

func TestWarmupLimit_EmptyCustomScheduleFallsBackToMin(t *testing.T) {
	e := &Engine{sending: config.SendingConfig{
		WarmupSchedule: map[int]int{},
	}}
	// Empty map → schedule selection leaves best at 10 for all days.
	// (Current implementation: schedule map replaces default; range over it produces nothing.)
	for day := 0; day <= 60; day++ {
		if got := e.warmupLimit(day); got < 10 {
			t.Errorf("day=%d got=%d, expected >= 10 floor", day, got)
		}
	}
}

func TestWarmupLimit_SingleDayEntry(t *testing.T) {
	e := &Engine{sending: config.SendingConfig{
		WarmupSchedule: map[int]int{1: 99},
	}}
	cases := []struct {
		day, want int
	}{
		{0, 10},
		{1, 99},
		{2, 99},
		{1000, 99},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("day=%d", c.day), func(t *testing.T) {
			if got := e.warmupLimit(c.day); got != c.want {
				t.Errorf("day=%d got=%d want=%d", c.day, got, c.want)
			}
		})
	}
}
