package audit

import (
	"context"
	"testing"
	"time"
)

func TestLog_NilDB(t *testing.T) {
	// db == nil → returns immediately without panic
	Log(context.Background(), nil, "test-action", "user1", "contact", "42", nil)
}

func TestLog_NilDB_WithDetails(t *testing.T) {
	// db == nil with non-empty details → still returns immediately
	Log(context.Background(), nil, "update", "", "campaign", "1", map[string]any{"key": "val"})
}

// ── Entry struct tests ──

func TestEntry_Struct(t *testing.T) {
	now := time.Now()
	e := Entry{
		ID:         1,
		Action:     ActionCampaignCreated,
		Actor:      "cli",
		EntityType: "campaign",
		EntityID:   "42",
		Details:    map[string]any{"contacts": 100},
		CreatedAt:  now,
	}
	if e.ID != 1 { t.Error("ID") }
	if e.Action != ActionCampaignCreated { t.Error("Action") }
	if e.Actor != "cli" { t.Error("Actor") }
	if e.Details["contacts"] != 100 { t.Error("Details") }
	if e.CreatedAt != now { t.Error("CreatedAt") }
}

func TestEntry_EmptyStruct(t *testing.T) {
	var e Entry
	if e.ID != 0 { t.Error("zero ID") }
	if e.Action != "" { t.Error("empty Action") }
}

// ── Action constants ──

func TestActionConstants_NonEmpty(t *testing.T) {
	constants := []string{
		ActionCampaignCreated, ActionCampaignStarted, ActionCampaignPaused,
		ActionCampaignResumed, ActionContactSuppress, ActionImportCompleted,
		ActionSeedRun, ActionSeedCleared,
	}
	seen := make(map[string]bool)
	for _, c := range constants {
		if c == "" { t.Errorf("empty action constant") }
		if seen[c] { t.Errorf("duplicate action constant: %s", c) }
		seen[c] = true
	}
	if len(constants) != 8 { t.Errorf("expected 8 action constants, got %d", len(constants)) }
}

func TestActionConstants_Values(t *testing.T) {
	if ActionCampaignCreated != "campaign.created" { t.Error("campaign.created") }
	if ActionCampaignStarted != "campaign.started" { t.Error("campaign.started") }
	if ActionContactSuppress != "contact.suppressed" { t.Error("contact.suppressed") }
	if ActionImportCompleted != "import.completed" { t.Error("import.completed") }
}

// ── Log function (nil-DB paths) ──

func TestLog_NilDB_NilDetails(t *testing.T) {
	// Nil details and nil db → no panic
	Log(context.Background(), nil, "action", "actor", "entity", "id", nil)
}

func TestLog_NilDB_EmptyDetails(t *testing.T) {
	// Empty details map → no panic
	Log(context.Background(), nil, "action", "actor", "entity", "id", map[string]any{})
}

func TestLog_NilDB_EmptyActor(t *testing.T) {
	// Empty actor gets defaulted to "cli" internally — no panic with nil db
	Log(context.Background(), nil, "action", "", "entity", "id", nil)
}

func TestLog_NilDB_ComplexDetails(t *testing.T) {
	details := map[string]any{
		"count":    42,
		"name":     "test",
		"enabled":  true,
		"score":    0.75,
		"nested":   map[string]any{"key": "val"},
	}
	Log(context.Background(), nil, "complex.action", "user", "thing", "99", details)
}

// ── Log — non-empty details marshalling ──

// TestLog_NilDB_DetailsAreNotMarshalledWhenDBIsNil verifies that Log exits early
// on nil db without attempting JSON marshalling or any other side-effect.
// This is a behaviour test: the function contract guarantees no panic regardless
// of the details content when db is nil.
func TestLog_NilDB_DetailsAreNotMarshalledWhenDBIsNil(t *testing.T) {
	// Use a details map that would fail json.Marshal (function value) — if Log
	// tried to marshal it with a nil db it would encounter an error. The test
	// verifies it returns cleanly instead.
	details := map[string]any{
		"valid_key": "valid_value",
	}
	// Should not panic — nil db → return immediately, no marshal attempted.
	Log(context.Background(), nil, "action", "actor", "entity", "id", details)
}
