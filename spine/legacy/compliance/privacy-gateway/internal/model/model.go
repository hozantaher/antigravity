package model

import "time"

type Actor struct {
	ID           string `json:"id"`
	TenantID     string `json:"tenant_id"`
	PrimaryEmail string `json:"primary_email"`
}

type Alias struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	TenantID  string    `json:"tenant_id"`
	Email     string    `json:"email"`
	Label     string    `json:"label"`
	CreatedAt time.Time `json:"created_at"`
}

type CreateAliasInput struct {
	Label string `json:"label"`
}

type SendMessageInput struct {
	AliasID  string   `json:"alias_id"`
	To       []string `json:"to"`
	Subject  string   `json:"subject"`
	TextBody string   `json:"text_body"`
	HTMLBody string   `json:"html_body,omitempty"`
}

type CreateSubmissionInput struct {
	ChannelID        string                        `json:"channel_id"`
	SanitizerProfile string                        `json:"sanitizer_profile,omitempty"`
	Subject          string                        `json:"subject"`
	TextBody         string                        `json:"text_body"`
	HTMLBody         string                        `json:"html_body,omitempty"`
	To               []string                      `json:"to,omitempty"`
	Attachments      []SubmissionAttachmentSummary `json:"attachments,omitempty"`
}

type CreateIdentityLinkInput struct {
	AliasID         string    `json:"alias_id"`
	RealIdentityRef string    `json:"real_identity_ref"`
	Purpose         string    `json:"purpose,omitempty"`
	ExpiresAt       time.Time `json:"expires_at,omitempty"`
}

type SanitizedMessage struct {
	Actor     Actor     `json:"actor"`
	Alias     Alias     `json:"alias"`
	To        []string  `json:"to"`
	Subject   string    `json:"subject"`
	TextBody  string    `json:"text_body"`
	CreatedAt time.Time `json:"created_at"`
}

type MessageRecord struct {
	ID        string    `json:"id"`
	AliasID   string    `json:"alias_id"`
	UserID    string    `json:"user_id"`
	TenantID  string    `json:"tenant_id"`
	Sender    string    `json:"sender"`
	To        []string  `json:"to"`
	Subject   string    `json:"subject"`
	TextBody  string    `json:"text_body"`
	CreatedAt time.Time `json:"created_at"`
}

type SubmissionStatus string

const (
	SubmissionStatusAccepted  SubmissionStatus = "accepted"
	SubmissionStatusQueued    SubmissionStatus = "queued"
	SubmissionStatusSanitized SubmissionStatus = "sanitized"
	SubmissionStatusRelayed   SubmissionStatus = "relayed"
	SubmissionStatusFailed    SubmissionStatus = "failed"
	SubmissionStatusBlocked   SubmissionStatus = "blocked"
)

type SubmissionAttachmentSummary struct {
	Filename    string `json:"filename,omitempty"`
	ContentType string `json:"content_type,omitempty"`
	SizeBytes   int    `json:"size_bytes,omitempty"`
}

type Submission struct {
	ID                      string                        `json:"id"`
	TenantID                string                        `json:"tenant_id"`
	ChannelID               string                        `json:"channel_id"`
	SubmittedBy             string                        `json:"submitted_by"`
	IntakeChannel           string                        `json:"intake_channel,omitempty"`
	MetadataProfile         string                        `json:"metadata_profile,omitempty"`
	ContentProtection       string                        `json:"content_protection,omitempty"`
	DeliveryBoundary        string                        `json:"delivery_boundary,omitempty"`
	SourcePath              string                        `json:"source_path,omitempty"`
	To                      []string                      `json:"to,omitempty"`
	Subject                 string                        `json:"subject"`
	TextBody                string                        `json:"text_body"`
	AttachmentsSummary      []SubmissionAttachmentSummary `json:"attachments_summary,omitempty"`
	Status                  SubmissionStatus              `json:"status"`
	RelayProvider           string                        `json:"relay_provider,omitempty"`
	RelayAttemptID          string                        `json:"relay_attempt_id,omitempty"`
	RelayFailureClass       string                        `json:"relay_failure_class,omitempty"`
	RelayFailureDisposition string                        `json:"relay_failure_disposition,omitempty"`
	RelayFailureReason      string                        `json:"relay_failure_reason,omitempty"`
	RelayedAt               time.Time                     `json:"relayed_at,omitempty"`
	FailedAt                time.Time                     `json:"failed_at,omitempty"`
	CreatedAt               time.Time                     `json:"created_at"`
}

type SanitizationResult struct {
	Status            SubmissionStatus `json:"status"`
	NormalizedSubject string           `json:"normalized_subject,omitempty"`
	NormalizedText    string           `json:"normalized_text,omitempty"`
	HasHTML           bool             `json:"has_html,omitempty"`
	HasBlockedContent bool             `json:"has_blocked_content,omitempty"`
	Notes             []string         `json:"notes,omitempty"`
}

type RelayAttempt struct {
	TenantID           string    `json:"tenant_id"`
	ActorID            string    `json:"actor_id,omitempty"`
	ID                 string    `json:"id"`
	SubmissionID       string    `json:"submission_id"`
	AliasID            string    `json:"alias_id,omitempty"`
	Provider           string    `json:"provider,omitempty"`
	DeliveryBoundary   string    `json:"delivery_boundary,omitempty"`
	Status             string    `json:"status"`
	FailureClass       string    `json:"failure_class,omitempty"`
	FailureDisposition string    `json:"failure_disposition,omitempty"`
	FailureReason      string    `json:"failure_reason,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
}

type IdentityLink struct {
	ID              string    `json:"id"`
	TenantID        string    `json:"tenant_id"`
	AliasID         string    `json:"alias_id"`
	RealIdentityRef string    `json:"real_identity_ref"`
	Purpose         string    `json:"purpose,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	ExpiresAt       time.Time `json:"expires_at,omitempty"`
	RevokedAt       time.Time `json:"revoked_at,omitempty"`
}

type AuditEvent struct {
	ID         string            `json:"id"`
	TenantID   string            `json:"tenant_id"`
	ActorID    string            `json:"actor_id,omitempty"`
	EventType  string            `json:"event_type"`
	ResourceID string            `json:"resource_id,omitempty"`
	Metadata   map[string]string `json:"metadata,omitempty"`
	CreatedAt  time.Time         `json:"created_at"`
}

type InboxAttachment struct {
	Filename     string `json:"filename,omitempty"`
	ContentType  string `json:"content_type,omitempty"`
	Disposition  string `json:"disposition,omitempty"`
	SizeBytes    int    `json:"size_bytes,omitempty"`
	PolicyAction string `json:"policy_action,omitempty"`
	PolicyReason string `json:"policy_reason,omitempty"`
}

type InboxMessage struct {
	ID              string            `json:"id"`
	UserID          string            `json:"user_id"`
	TenantID        string            `json:"tenant_id"`
	AliasEmail      string            `json:"alias_email"`
	AliasID         string            `json:"alias_id,omitempty"`
	SubmissionID    string            `json:"submission_id,omitempty"`
	From            string            `json:"from"`
	To              []string          `json:"to"`
	Subject         string            `json:"subject"`
	TextBody        string            `json:"text_body"`
	Attachments     []InboxAttachment `json:"attachments,omitempty"`
	AttachmentCount int               `json:"attachment_count,omitempty"`
	ReceivedAt      time.Time         `json:"received_at"`
	ProviderUID     string            `json:"provider_uid,omitempty"`
}
