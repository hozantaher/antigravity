package campaign

import (
	"encoding/json"
	"fmt"
	"regexp"
)

// KT-A15 — Multi-step sequence helpers.
//
// The Runner already understands SequenceConfig (see runner.go); this file
// adds:
//
//   - DefaultSequence(): the canonical 3-step shape that mirrors the SQL
//     default set by migration 014_campaigns_sequence_config_default.sql,
//     so operator and Go-side share one source of truth.
//
//   - ValidateSequence(): boundary check enforced at write time
//     (e.g. by future BFF endpoints that mutate sequence_config). We do NOT
//     wire it into RunCampaign — the runner is read-only on the schema and
//     must tolerate operator-supplied data; validation belongs at the
//     operator-input boundary, not the send hot-path.
//
// Why these live in a separate file:
//   runner.go is already 800+ LOC. Per coding-style.md (file <800), new
//   surface area lands in its own file unless it intrinsically belongs to
//   the per-tick orchestrator.

// defaultSequenceSteps is the single source of truth for the 3-step
// default. Mirror of:
//
//	scripts/migrations/016_campaigns_sequence_config_default.sql
//	services/campaigns/web/campaigns.go
//	services/orchestrator/cmd/outreach/main.go (campaign-create)
//
// Keep these three in sync — drift means a campaign created via one path
// looks different from another. The DefaultSequenceJSON test ratchets this.
var defaultSequenceSteps = []SequenceStep{
	{Step: 0, DelayDays: 0, TemplateName: "initial"},
	{Step: 1, DelayDays: 5, TemplateName: "followup1"},
	{Step: 2, DelayDays: 12, TemplateName: "final"},
}

// DefaultSequence returns a fresh copy of the canonical 3-step sequence
// (initial → +5d followup1 → +12d final). The returned slice is independent
// of the package-level constant so callers can mutate it safely (per the
// immutability rule in coding-style.md, but this is a defensive copy in
// case a caller forgets and mutates).
func DefaultSequence() []SequenceStep {
	out := make([]SequenceStep, len(defaultSequenceSteps))
	copy(out, defaultSequenceSteps)
	return out
}

// templateNameRe duplicates the production vocabulary check from
// content/template.go: lowercase letters, digits, hyphen, underscore.
// Re-declaring it here avoids a back-import (campaign → content → campaign)
// and keeps this validation usable in dependency-free contexts (e.g.
// migration tooling).
var templateNameRe = regexp.MustCompile(`^[a-z0-9_-]+$`)

// MaxSequenceSteps caps how many steps a single campaign may carry.
//
// Picked at 12 because:
//   - 12 steps × 7 days minimum spacing = ~3 months of pursuit; longer
//     than that and the operator is past the point where re-engagement
//     ROI > complaint risk.
//   - Keeps the sequence_config JSONB cell well under any
//     reasonable Postgres TOAST threshold (each step is ~50 bytes).
//
// MaxStepDelayDays prevents an operator typo (delay_days: 365_000) from
// silently postponing the campaign past the heat-death of the sun. The
// ceiling is 90 days — well past every real outreach cadence.
const (
	MaxSequenceSteps = 12
	MaxStepDelayDays = 90
)

// ValidateSequence reports whether a SequenceStep slice is operator-safe.
// It returns nil if the sequence can be persisted, or a wrapped error
// describing the first violation found.
//
// Rules:
//  1. Empty sequence is allowed (campaign with no sends — operator may
//     create the row first, populate later).
//  2. Length ≤ MaxSequenceSteps.
//  3. Step numbers MUST start at 0 and increment by 1 (no gaps, no
//     duplicates, no reverse). The CAS in RunCampaign keys on
//     `current_step = $oldStep` — gap-tolerance there is dangerous.
//  4. delay_days MUST be ≥ 0 (negative = scheduled-in-past = always-fire,
//     undermines the sequence pacing).
//  5. delay_days ≤ MaxStepDelayDays (typo guard).
//  6. Step 0 SHOULD have delay_days == 0 — an initial-step delay is
//     usually a misconfiguration. We tolerate up to 7 days here (operator
//     may want a "warmup" pause), but reject anything larger.
//  7. TemplateName must match the production vocabulary (matches
//     content/template.go's `validTemplateName`).
//
// All violations carry the offending index so the operator UI can
// highlight the bad row.
func ValidateSequence(steps []SequenceStep) error {
	if len(steps) == 0 {
		return nil
	}
	if len(steps) > MaxSequenceSteps {
		return fmt.Errorf("sequence has %d steps (max %d)", len(steps), MaxSequenceSteps)
	}
	for i, s := range steps {
		if s.Step != i {
			return fmt.Errorf("step[%d]: step number = %d, expected %d (sequence must be 0-indexed and contiguous)", i, s.Step, i)
		}
		if s.DelayDays < 0 {
			return fmt.Errorf("step[%d]: delay_days = %d (must be ≥ 0)", i, s.DelayDays)
		}
		if s.DelayDays > MaxStepDelayDays {
			return fmt.Errorf("step[%d]: delay_days = %d (max %d)", i, s.DelayDays, MaxStepDelayDays)
		}
		if i == 0 && s.DelayDays > 7 {
			return fmt.Errorf("step[0]: delay_days = %d (initial step delay > 7 — likely misconfiguration)", s.DelayDays)
		}
		if s.TemplateName == "" {
			return fmt.Errorf("step[%d]: template name empty", i)
		}
		if !templateNameRe.MatchString(s.TemplateName) {
			return fmt.Errorf("step[%d]: template name %q does not match [a-z0-9_-]+", i, s.TemplateName)
		}
	}
	return nil
}

// DefaultSequenceJSON returns the canonical 3-step sequence serialized
// as compact JSON, suitable for direct embedding into Postgres JSONB
// inserts. Mirrors what migration 014 writes as the column default.
func DefaultSequenceJSON() ([]byte, error) {
	return json.Marshal(DefaultSequence())
}
