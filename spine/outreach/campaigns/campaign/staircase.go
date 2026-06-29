package campaign

import (
	"encoding/json"
	"fmt"
	"time"
)

// KT-A5 — Staircase launch helpers.
//
// The operator's first-campaign-launch playbook
// (docs/playbooks/first-campaign-launch.md) walks the staircase
// 0 → 1 → 5 → 20 → 100 deliberately so a problem catches at 1 (cheap)
// instead of 100 (expensive). This file owns the in-memory math; the
// gate decision is "should the runner advance from step N to step N+1?"
//
// Storage shape: campaigns.staircase_max_per_step is a JSONB array of
// non-negative integers (see migration 017). Index 0 = dry-run cap
// (always 0 in spirit, but recorded as 1 in the default for backwards
// compatibility with legacy single-shot campaigns). Index N = how many
// recipients step N is allowed to touch before the next step opens.
//
// Soak window: AdvanceStep also enforces a 1-hour minimum since the
// step's last send. Operator wants to see deliverability + reply
// signal before scaling up — staircase isn't just a cap, it's a pause
// before scale.
//
// HARD-RULE alignment (memory feedback_campaign_send): NOTHING in this
// file invokes sender.Engine.Send(). It is pure math + storage.

// DefaultStaircase mirrors the SQL default in migration 017. Returned
// as a fresh slice so callers can mutate it safely (immutability rule
// in coding-style.md).
//
// Why these numbers:
//   - 1: single contact (operator's own address) for DKIM/SPF smoke.
//   - 5: known-friendly (people who reply, not flag spam).
//   - 20: first real segment — LAUNCH-CAMPAIGN-001 scope.
//   - 100: scaled but still below daily cap of a single warm mailbox.
//
// Operators override per-campaign by writing the JSONB column.
func DefaultStaircase() []int {
	return []int{1, 5, 20, 100}
}

// MinStaircaseSoakDuration is how long a step must marinate before the
// next one opens, even if its quota is already satisfied. One hour is
// the operator's documented "wait, inspect, gate" interval (playbook
// step 1 → step 2 explicitly mentions reply rate signal from the prior
// step). The 1h figure is documented in
// docs/playbooks/first-campaign-launch.md.
const MinStaircaseSoakDuration = time.Hour

// MaxStaircaseSteps caps the array length. 12 mirrors MaxSequenceSteps
// in sequence.go — a staircase longer than the sequence itself is
// nonsensical.
const MaxStaircaseSteps = 12

// MaxStaircasePerStep guards against an operator typo
// (staircase_max_per_step = [1_000_000]). 100k per step is well past
// any legitimate B2B segment.
const MaxStaircasePerStep = 100_000

// ParseStaircase decodes a JSONB-encoded staircase. Empty input or
// `null` returns the default — the runner must always have a usable
// cap, so we never fail closed.
//
// Returns ([]int, nil) on success or (nil, err) on a structurally
// invalid shape (e.g. nested arrays, non-integer entries) — the
// caller decides whether to fall back or surface the error.
func ParseStaircase(raw []byte) ([]int, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return DefaultStaircase(), nil
	}
	var arr []int
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil, fmt.Errorf("parse staircase: %w", err)
	}
	if len(arr) == 0 {
		return DefaultStaircase(), nil
	}
	return arr, nil
}

// ValidateStaircase reports whether a staircase array is operator-safe.
// Returns nil if persistable; otherwise a wrapped error pointing at the
// first violation. Mirrors the contract of ValidateSequence in
// sequence.go.
//
// Rules:
//  1. Length ≤ MaxStaircaseSteps.
//  2. Every entry ≥ 0 (a negative cap is a typo, not a "block all").
//  3. Every entry ≤ MaxStaircasePerStep.
//  4. The sequence must be non-decreasing — going [5, 1, 20] is a
//     misconfig (operator probably reordered rows in a UI). The runner
//     would still respect the cap, but flag it.
func ValidateStaircase(stair []int) error {
	if len(stair) > MaxStaircaseSteps {
		return fmt.Errorf("staircase has %d steps (max %d)", len(stair), MaxStaircaseSteps)
	}
	prev := -1
	for i, n := range stair {
		if n < 0 {
			return fmt.Errorf("staircase[%d]: cap = %d (must be ≥ 0)", i, n)
		}
		if n > MaxStaircasePerStep {
			return fmt.Errorf("staircase[%d]: cap = %d (max %d)", i, n, MaxStaircasePerStep)
		}
		if n < prev {
			return fmt.Errorf("staircase[%d]: cap = %d but previous step = %d (must be non-decreasing)", i, n, prev)
		}
		prev = n
	}
	return nil
}

// AdvanceStep decides whether the runner may move from currentStep to
// the next staircase rung.
//
// Inputs:
//   - currentStep: which rung of the staircase we are on (0-indexed).
//   - sentForStep: how many distinct recipients have already received
//     a send_event for this step (caller pulls this from send_events).
//   - lastSentAt: the most recent successful send timestamp for this
//     step. Zero value means "no sends yet".
//   - now: clock injected for test determinism.
//   - stair: the staircase array (use ParseStaircase upstream).
//
// Returns:
//   - next: the step index the runner SHOULD operate on (currentStep
//     itself if quota not yet filled OR soak not elapsed; currentStep+1
//     when both gates pass; len(stair) if we're past the last rung).
//   - allowed: true when the runner may dispatch a send right now.
//     false means "stay on this step but don't send" (quota reached,
//     waiting for soak) — the runner skips its enqueue branch.
//
// Boundary semantics (documented for tests):
//   - currentStep < 0 → treated as 0 (defensive — never panic).
//   - currentStep >= len(stair) → next = len(stair), allowed = false
//     (campaign exhausted the staircase; operator must extend it or
//     campaign closes). The runner reads "exhausted" as "completed".
//   - cap == 0 (first rung in spirit, dry-run) → next = currentStep+1
//     immediately, allowed = false. Caller routes to dry-run path.
//   - sentForStep < cap → next = currentStep, allowed = true.
//     Runner keeps sending on this rung.
//   - sentForStep >= cap AND soak not elapsed → next = currentStep,
//     allowed = false. Runner waits.
//   - sentForStep >= cap AND soak elapsed → next = currentStep+1,
//     allowed = true. Runner moves up the staircase.
//
// HARD RULE: this function does NOT call sender.Engine.Send(). It is a
// pure decision function. Tests assert behaviour via the (next, allowed)
// pair only.
func AdvanceStep(currentStep, sentForStep int, lastSentAt, now time.Time, stair []int) (next int, allowed bool) {
	if currentStep < 0 {
		currentStep = 0
	}
	if len(stair) == 0 {
		stair = DefaultStaircase()
	}
	if currentStep >= len(stair) {
		// Past the last rung — campaign is done with the staircase.
		// Runner treats this as "completed" status transition.
		return len(stair), false
	}

	cap := stair[currentStep]

	// cap == 0: rung intentionally locked. Move past it without
	// sending. Used by operators who want a forced dry-run pause as
	// step 0 even though the SQL default starts at 1.
	if cap == 0 {
		return currentStep + 1, false
	}

	// Quota not yet satisfied — keep firing on this rung.
	if sentForStep < cap {
		return currentStep, true
	}

	// Quota satisfied. Decide on the soak window.
	if lastSentAt.IsZero() {
		// Quota satisfied but we never recorded a send — operator
		// likely forced sentForStep manually for a soft launch.
		// Be permissive: allow advance.
		return currentStep + 1, true
	}
	soakDeadline := lastSentAt.Add(MinStaircaseSoakDuration)
	if now.Before(soakDeadline) {
		// Quota satisfied but soak not yet elapsed — pause.
		return currentStep, false
	}
	// Both gates pass.
	return currentStep + 1, true
}

// CapForStep returns the cap configured for step N, or the cap of the
// last rung when N runs past the array (operator extended the sequence
// without extending the staircase — fall back to the highest known cap
// rather than 0, which would block all sends).
//
// Returns -1 when stair is empty (caller must not have skipped
// ParseStaircase upstream).
func CapForStep(step int, stair []int) int {
	if len(stair) == 0 {
		return -1
	}
	if step < 0 {
		return stair[0]
	}
	if step >= len(stair) {
		return stair[len(stair)-1]
	}
	return stair[step]
}
