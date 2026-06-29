package audit

import "time"

// Entry is a single operator audit log record.
type Entry struct {
	ID         int64
	Action     string
	Actor      string
	EntityType string
	EntityID   string
	Details    map[string]any
	CreatedAt  time.Time
}

// Common action constants.
const (
	ActionCampaignCreated = "campaign.created"
	ActionCampaignStarted = "campaign.started"
	ActionCampaignPaused  = "campaign.paused"
	ActionCampaignResumed = "campaign.resumed"
	ActionContactSuppress = "contact.suppressed"
	ActionImportCompleted = "import.completed"
	ActionSeedRun         = "seed.run"
	ActionSeedCleared     = "seed.cleared"

	// AW7-4 — engine panic atomic rollback (sister to AW7 PR #1186, AW6-2 PR #1194).
	// Emitted whenever the orchestrator's send-callback or Engine.Run goroutine
	// panics and the recovery path runs RevertFailedStep / BulkRevertInFlight
	// to take a contact out of `in_flight` so it cannot stay stuck.
	ActionEnginePanicRecovered = "engine.panic_recovered"
)
