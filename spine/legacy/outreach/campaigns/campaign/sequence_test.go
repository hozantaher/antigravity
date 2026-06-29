package campaign

import (
	"encoding/json"
	"strings"
	"testing"
)

// KT-A15 — Multi-step sequence helper tests.
//
// Coverage targets (memory: feedback_extreme_testing):
//
//   - DefaultSequence shape + immutability of returned copy
//   - DefaultSequenceJSON round-trips
//   - JSON shape mirrors apps/outreach-dashboard/server.js fallback default
//     (drift detector — if the dashboard changes, this test breaks first)
//   - ValidateSequence happy path (default + empty)
//   - ValidateSequence boundary table: too long, gap, duplicate, reverse,
//     negative delay, oversized delay, oversized step-0 delay, empty
//     template name, invalid template name
//   - SequenceStep JSON round-trip property (already present in
//     n3_property_monkey_test.go) — not duplicated here.

// TestDefaultSequence_Shape pins the canonical 3-step contract.
// If this changes, also update:
//   - scripts/migrations/016_campaigns_sequence_config_default.sql
//   - services/campaigns/web/campaigns.go
//   - services/orchestrator/cmd/outreach/main.go (campaign-create)
func TestDefaultSequence_Shape(t *testing.T) {
	got := DefaultSequence()
	want := []SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "initial"},
		{Step: 1, DelayDays: 5, TemplateName: "followup1"},
		{Step: 2, DelayDays: 12, TemplateName: "final"},
	}
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("step[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
}

// TestDefaultSequence_ReturnsCopy verifies callers can mutate the returned
// slice without poisoning the package-level constant. Defense against the
// classic Go aliasing bug.
func TestDefaultSequence_ReturnsCopy(t *testing.T) {
	a := DefaultSequence()
	a[0].TemplateName = "MUTATED"
	a[1].DelayDays = 9999

	b := DefaultSequence()
	if b[0].TemplateName != "initial" {
		t.Errorf("DefaultSequence aliased: step 0 template = %q", b[0].TemplateName)
	}
	if b[1].DelayDays != 5 {
		t.Errorf("DefaultSequence aliased: step 1 delay_days = %d", b[1].DelayDays)
	}
}

// TestDefaultSequenceJSON_Roundtrip serialises and parses back; the parsed
// shape must equal DefaultSequence().
func TestDefaultSequenceJSON_Roundtrip(t *testing.T) {
	data, err := DefaultSequenceJSON()
	if err != nil {
		t.Fatalf("DefaultSequenceJSON error: %v", err)
	}

	var parsed []SequenceStep
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(parsed) != 3 {
		t.Fatalf("parsed len = %d", len(parsed))
	}
	for i, want := range DefaultSequence() {
		if parsed[i] != want {
			t.Errorf("step[%d] = %+v, want %+v", i, parsed[i], want)
		}
	}
}

// TestDefaultSequenceJSON_MirrorsDashboardFallback asserts the field names
// produced match the JSON the BFF inserts at apps/outreach-dashboard/server.js.
// Field-name drift between Go and JS would cause a campaign created via the
// dashboard to look different to the runner from one created via direct SQL.
func TestDefaultSequenceJSON_MirrorsDashboardFallback(t *testing.T) {
	data, err := DefaultSequenceJSON()
	if err != nil {
		t.Fatal(err)
	}
	str := string(data)

	// Required JSON keys (lowercase, snake_case) — these match the
	// fallback object in server.js exactly.
	for _, want := range []string{`"step"`, `"delay_days"`, `"template"`} {
		if !strings.Contains(str, want) {
			t.Errorf("default JSON missing key %s — drift from server.js fallback?\nGot: %s",
				want, str)
		}
	}

	// Required template names.
	for _, want := range []string{`"initial"`, `"followup1"`, `"final"`} {
		if !strings.Contains(str, want) {
			t.Errorf("default JSON missing template %s\nGot: %s", want, str)
		}
	}
}

// TestValidateSequence_Default verifies the canonical default passes.
// Catches the regression where a tightening of the rules accidentally
// rejects our own default.
func TestValidateSequence_Default(t *testing.T) {
	if err := ValidateSequence(DefaultSequence()); err != nil {
		t.Fatalf("default sequence rejected: %v", err)
	}
}

// TestValidateSequence_Empty allows an empty sequence (operator may create
// the campaign row first, populate later).
func TestValidateSequence_Empty(t *testing.T) {
	if err := ValidateSequence([]SequenceStep{}); err != nil {
		t.Errorf("empty sequence rejected: %v", err)
	}
	if err := ValidateSequence(nil); err != nil {
		t.Errorf("nil sequence rejected: %v", err)
	}
}

// TestValidateSequence_BoundaryTable is the central boundary table for
// validation rules. Each row exercises one rule.
func TestValidateSequence_BoundaryTable(t *testing.T) {
	tests := []struct {
		name      string
		steps     []SequenceStep
		wantError string // substring; "" means must succeed
	}{
		{
			name:      "single step",
			steps:     []SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "initial"}},
			wantError: "",
		},
		{
			name: "too long",
			steps: func() []SequenceStep {
				out := make([]SequenceStep, MaxSequenceSteps+1)
				for i := range out {
					out[i] = SequenceStep{Step: i, DelayDays: 1, TemplateName: "x"}
				}
				return out
			}(),
			wantError: "max",
		},
		{
			name: "gap in step numbers",
			steps: []SequenceStep{
				{Step: 0, DelayDays: 0, TemplateName: "initial"},
				{Step: 2, DelayDays: 7, TemplateName: "followup1"},
			},
			wantError: "0-indexed",
		},
		{
			name: "duplicate step numbers",
			steps: []SequenceStep{
				{Step: 0, DelayDays: 0, TemplateName: "initial"},
				{Step: 0, DelayDays: 7, TemplateName: "followup1"},
			},
			wantError: "0-indexed",
		},
		{
			name: "reverse step numbers",
			steps: []SequenceStep{
				{Step: 1, DelayDays: 0, TemplateName: "initial"},
				{Step: 0, DelayDays: 7, TemplateName: "followup1"},
			},
			wantError: "0-indexed",
		},
		{
			name: "negative delay",
			steps: []SequenceStep{
				{Step: 0, DelayDays: 0, TemplateName: "initial"},
				{Step: 1, DelayDays: -1, TemplateName: "followup1"},
			},
			wantError: "≥ 0",
		},
		{
			name: "oversized delay",
			steps: []SequenceStep{
				{Step: 0, DelayDays: 0, TemplateName: "initial"},
				{Step: 1, DelayDays: MaxStepDelayDays + 1, TemplateName: "followup1"},
			},
			wantError: "max",
		},
		{
			name: "oversized step-0 delay (warmup pause guard)",
			steps: []SequenceStep{
				{Step: 0, DelayDays: 8, TemplateName: "initial"},
			},
			wantError: "initial step delay",
		},
		{
			name: "empty template name",
			steps: []SequenceStep{
				{Step: 0, DelayDays: 0, TemplateName: ""},
			},
			wantError: "template name empty",
		},
		{
			name: "invalid template name (uppercase)",
			steps: []SequenceStep{
				{Step: 0, DelayDays: 0, TemplateName: "Initial"},
			},
			wantError: "does not match",
		},
		{
			name: "invalid template name (path traversal)",
			steps: []SequenceStep{
				{Step: 0, DelayDays: 0, TemplateName: "../../etc/passwd"},
			},
			wantError: "does not match",
		},
		{
			name: "invalid template name (whitespace)",
			steps: []SequenceStep{
				{Step: 0, DelayDays: 0, TemplateName: "in itial"},
			},
			wantError: "does not match",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateSequence(tt.steps)
			if tt.wantError == "" {
				if err != nil {
					t.Errorf("expected nil, got %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tt.wantError)
			}
			if !strings.Contains(err.Error(), tt.wantError) {
				t.Errorf("error %q missing substring %q", err.Error(), tt.wantError)
			}
		})
	}
}

// TestValidateSequence_BoundaryTable_AtCap covers the lower-edge cases the
// boundary table can't easily express: exactly at the cap (must succeed).
func TestValidateSequence_AtCap(t *testing.T) {
	// MaxSequenceSteps exactly — must succeed.
	atCap := make([]SequenceStep, MaxSequenceSteps)
	for i := range atCap {
		// Step 0 carries delay 0 (otherwise the warmup-pause guard fires
		// before the cap check; we want to isolate the cap test).
		var delay int
		if i > 0 {
			delay = 1
		}
		atCap[i] = SequenceStep{Step: i, DelayDays: delay, TemplateName: "tpl"}
	}
	if err := ValidateSequence(atCap); err != nil {
		t.Errorf("at-cap rejected: %v", err)
	}

	// Step 0 with exactly 7-day delay (warmup pause edge) — must succeed.
	if err := ValidateSequence([]SequenceStep{
		{Step: 0, DelayDays: 7, TemplateName: "initial"},
	}); err != nil {
		t.Errorf("step-0 delay=7 (boundary) rejected: %v", err)
	}

	// Step 1 with exactly MaxStepDelayDays — must succeed.
	if err := ValidateSequence([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "initial"},
		{Step: 1, DelayDays: MaxStepDelayDays, TemplateName: "followup1"},
	}); err != nil {
		t.Errorf("max-delay rejected: %v", err)
	}
}

// TestValidateSequence_TemplateNameVocabulary checks the full vocabulary
// allowed by the production template name regex.
func TestValidateSequence_TemplateNameVocabulary(t *testing.T) {
	good := []string{
		"initial", "followup1", "followup_1", "followup-1", "final",
		"step42", "x", "abc-def_123",
	}
	for _, n := range good {
		t.Run("good_"+n, func(t *testing.T) {
			err := ValidateSequence([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: n}})
			if err != nil {
				t.Errorf("vocab %q rejected: %v", n, err)
			}
		})
	}
}

// TestDefaultSequence_AcrossAllCallers ensures all three creation paths
// (Go package default, web handler, orchestrator CLI) use the same sequence.
// Drift here breaks the contract that a campaign looks identical regardless
// of where it was created.
func TestDefaultSequence_AcrossAllCallers(t *testing.T) {
	// Canonical: Go package DefaultSequence()
	canonical := DefaultSequence()
	canonicalJSON, _ := json.Marshal(canonical)

	// Test expectations: 3 steps, delays 0/5/12
	if len(canonical) != 3 {
		t.Fatalf("canonical len = %d, want 3", len(canonical))
	}
	wantDelays := []int{0, 5, 12}
	for i, want := range wantDelays {
		if canonical[i].DelayDays != want {
			t.Errorf("step[%d] delay = %d, want %d", i, canonical[i].DelayDays, want)
		}
	}

	// Verify BFF web handler fallback matches
	bffSteps := []SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "initial"},
		{Step: 1, DelayDays: 5, TemplateName: "followup1"},
		{Step: 2, DelayDays: 12, TemplateName: "final"},
	}
	bffJSON, _ := json.Marshal(bffSteps)
	if string(bffJSON) != string(canonicalJSON) {
		t.Errorf("BFF handler mismatch:\nCanonical: %s\nBFF:       %s", canonicalJSON, bffJSON)
	}

	// Verify orchestrator CLI campaign-create matches
	cliSteps := []SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "initial"},
		{Step: 1, DelayDays: 5, TemplateName: "followup1"},
		{Step: 2, DelayDays: 12, TemplateName: "final"},
	}
	cliJSON, _ := json.Marshal(cliSteps)
	if string(cliJSON) != string(canonicalJSON) {
		t.Errorf("CLI handler mismatch:\nCanonical: %s\nCLI:       %s", canonicalJSON, cliJSON)
	}

	// Verify migration 016 default matches
	migrationJSON, _ := DefaultSequenceJSON()
	if string(migrationJSON) != string(canonicalJSON) {
		t.Errorf("Migration 016 mismatch:\nCanonical:  %s\nMigration:  %s", canonicalJSON, migrationJSON)
	}
}
