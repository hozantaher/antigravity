package contact

import "time"

type Status string

const (
	// Lifecycle
	StatusNew        Status = "new"
	StatusValidating Status = "validating"
	StatusValid      Status = "valid"
	StatusInvalid    Status = "invalid"
	StatusActive     Status = "active"

	// Send outcomes
	StatusSent    Status = "sent"
	StatusOpened  Status = "opened"
	StatusReplied Status = "replied"

	// Operational exclusions — campaign runner (internal/campaign/runner.go)
	// filters these out. Migration 036 is the current source of truth for
	// the CHECK constraint vocabulary.
	StatusBounced      Status = "bounced"
	StatusBlacklisted  Status = "blacklisted"
	StatusUnsubscribed Status = "unsubscribed"
)

// ExcludedStatuses returns statuses that MUST NOT receive outbound mail
// (anti-spam / deliverability protection — operational, not legal).
func ExcludedStatuses() []Status {
	return []Status{
		StatusBounced,
		StatusBlacklisted,
		StatusInvalid,
		StatusUnsubscribed,
	}
}

type Contact struct {
	ID               int64
	Email            string
	EmailHash        string
	FirstName        string
	LastName         string
	CompanyName      string
	ICO              string
	Region           string
	Industry         string
	CompanySize      string
	Score            int
	Status           Status
	ValidationResult *ValidationResult
	Source           string
	ImportedAt       time.Time
	ValidatedAt      *time.Time
	LastContacted    *time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

type ValidationResult struct {
	SyntaxValid  bool   `json:"syntax_valid"`
	MXExists     bool   `json:"mx_exists"`
	SMTPValid    *bool  `json:"smtp_valid,omitempty"`
	IsCatchAll   bool   `json:"is_catch_all"`
	IsDisposable bool   `json:"is_disposable"`
	RiskLevel    string `json:"risk_level"`
}

type SegmentFilter struct {
	Regions     []string
	Industries  []string
	MinScore    *int
	MaxScore    *int
	Statuses    []Status
	CompanySize []string
}
