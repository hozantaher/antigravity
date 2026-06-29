package model

import "time"

// Envelope is the core unit of communication flowing through the relay pipeline.
// After sealing, SealedContent is opaque to all relay components.
type Envelope struct {
	ID            string    `json:"id"`
	AliasToken    string    `json:"alias_token"`
	TenantID      string    `json:"tenant_id"`
	SealedContent []byte    `json:"sealed_content"`
	SizeClass     int       `json:"size_class"`
	BucketedAt    time.Time `json:"bucketed_at"`
	IntakeChannel string    `json:"intake_channel"`
	Status        string    `json:"status"`
	ScheduledAt   time.Time `json:"scheduled_at,omitempty"`
	RelayedAt     time.Time `json:"relayed_at,omitempty"`
	ExitChannelID string    `json:"exit_channel_id,omitempty"`
	IsCover       bool      `json:"is_cover"`
	// Routing fields (not sealed, needed for bridge/SMTP delivery)
	Recipient   string `json:"recipient,omitempty"`
	Subject     string `json:"subject,omitempty"`
	FromAddress string `json:"from_address,omitempty"` // selects SMTP account from pool
	// InlineCreds carries per-request SMTP credentials when set.
	// Non-empty only during the in-process pipeline; never persisted across restarts.
	InlineCreds InlineSMTPCreds `json:"inline_creds,omitempty"`
	// PreferredCountry pins egress to a specific ISO 3166-1 alpha-2 country.
	// Passed through from IntakeRequest; consumed by wgpool.Pool.Pick.
	// Empty = no preference (hash-based rotation continues unchanged).
	PreferredCountry string `json:"preferred_country,omitempty"`
	// MailboxID is the numeric outreach_mailboxes.id as a decimal string.
	// Set by the submitter when using per-mailbox credentials (inline creds path).
	// Used by egress observation to correlate egress events to a mailbox row.
	// Empty = no mailbox association (e.g. static SMTP pool).
	MailboxID string `json:"mailbox_id,omitempty"`
	// Attempts is the count of delivery attempts that have been started for
	// this envelope. Incremented at attempt-start time; persists across drain
	// cycles when the envelope is re-queued by the greylist auto-retry path
	// (Sprint AW7-5). Zero means no attempt has started yet.
	Attempts int `json:"attempts,omitempty"`
	// LastError, when non-empty, is the most recent delivery error string
	// truncated to a safe length (no PII; SMTP reply codes only). Used for
	// retry diagnosis and audit logs; cleared on successful delivery.
	LastError string `json:"last_error,omitempty"`
	// NextAttemptAt, when non-zero, is the earliest UTC time at which the
	// envelope may be re-attempted after a transient failure. Set by the
	// retry path; the scheduler uses it as the new ScheduledAt.
	NextAttemptAt time.Time `json:"next_attempt_at,omitempty"`
}

// Envelope statuses.
const (
	StatusAccepted  = "accepted"
	StatusQueued    = "queued"
	StatusSanitized = "sanitized"
	StatusSealed    = "sealed"
	StatusScheduled = "scheduled"
	StatusRelayed   = "relayed"
	StatusFailed    = "failed"
	StatusBlocked   = "blocked"
)

// Size classes for fixed-size padding (bytes).
const (
	SizeClass512  = 512
	SizeClass2K   = 2048
	SizeClass8K   = 8192
	SizeClass32K  = 32768
)

// SizeClasses returns all valid size classes in ascending order.
func SizeClasses() []int {
	return []int{SizeClass512, SizeClass2K, SizeClass8K, SizeClass32K}
}

// SelectSizeClass returns the smallest size class that fits the given length.
func SelectSizeClass(length int) int {
	for _, sc := range SizeClasses() {
		if length <= sc {
			return sc
		}
	}
	return SizeClass32K
}

// AliasMapping links an opaque alias token to an encrypted real identity reference.
// The EncryptedRef is encrypted with the vault's own key, separate from the data key.
type AliasMapping struct {
	AliasToken    string    `json:"alias_token"`
	TenantID      string    `json:"tenant_id"`
	EncryptedRef  []byte    `json:"encrypted_ref"`
	Purpose       string    `json:"purpose"`
	CreatedBucket time.Time `json:"created_bucket"`
	ExpiresAt     time.Time `json:"expires_at,omitempty"`
	RevokedAt     time.Time `json:"revoked_at,omitempty"`
	Revoked       bool      `json:"revoked"`
}

// AuditEntry records a minimal event with no content, no IPs, no real identities.
type AuditEntry struct {
	ID         string    `json:"id"`
	TenantID   string    `json:"tenant_id"`
	EventType  string    `json:"event_type"`
	EnvelopeID string    `json:"envelope_id"`
	BucketedAt time.Time `json:"bucketed_at"`
	// Outcome and HTTPStatus are set for bridge delivery events only.
	// Outcome is "success" or "failure"; HTTPStatus is the downstream HTTP status code.
	Outcome    string `json:"outcome,omitempty"`
	HTTPStatus int    `json:"http_status,omitempty"`
}

// Audit event types.
const (
	EventIntakeAccepted  = "intake_accepted"
	EventSanitized       = "sanitized"
	EventIdentityIssued  = "identity_issued"
	EventSealed          = "sealed"
	EventRelayScheduled  = "relay_scheduled"
	EventRelayCompleted  = "relay_completed"
	EventRelayFailed     = "relay_failed"
	EventBlocked         = "blocked"
	EventIdentityRevoked = "identity_revoked"
	EventBridgeDelivered = "bridge_delivered"
	EventBridgeFailed    = "bridge_failed"
	// EventRelayRetryScheduled is emitted when a transient (4xx) SMTP failure
	// triggers a re-queue of the envelope for a later attempt. The audit row
	// carries the envelope ID; structured retry metadata (attempt number, code,
	// next_attempt_at) is logged via minlog and not persisted in the audit
	// table to keep entries minimal (model.AuditEntry has no metadata field).
	EventRelayRetryScheduled = "relay_retry_scheduled"
)

// Delivery outcome values used in AuditEntry.Outcome.
const (
	OutcomeSuccess = "success"
	OutcomeFailure = "failure"
)

// ExitChannel defines a verified outbound delivery target.
type ExitChannel struct {
	ID        string `json:"id"`
	TenantID  string `json:"tenant_id"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Verified  bool   `json:"verified"`
	PublicKey []byte `json:"public_key,omitempty"`
	Endpoint  string `json:"endpoint,omitempty"`
}

// Exit channel types.
const (
	ExitTypeSMTP    = "smtp"
	ExitTypeWebhook = "webhook"
	ExitTypeDrop    = "drop"
)

// Actor represents an authenticated user.
type Actor struct {
	ID       string `json:"id"`
	TenantID string `json:"tenant_id"`
}

// InlineSMTPCreds holds per-request SMTP credentials for dynamic delivery.
// When all three fields (SMTPHost, SMTPUsername, SMTPPassword) are present,
// the relay builds a one-off SMTPDeliverer instead of using the static pool.
// SMTPPort defaults to 587 when zero.
//
// AW7-9 — IMAPHost/IMAPPort were added to carry the sender mailbox's IMAP
// coordinates so the relay drain can perform the post-send "Sent folder"
// APPEND inside the relay container (where wgsocks runs). The orchestrator
// container has no wgsocks instance, so the original AW7-7 wiring failed
// with "dial tcp 127.0.0.1:1080: connect: connection refused". Username/
// Password are shared between SMTP submission and IMAP login for Seznam +
// every other major provider we target, so they are not duplicated here.
// Empty IMAPHost == "skip APPEND".
type InlineSMTPCreds struct {
	SMTPHost     string `json:"smtp_host"`
	SMTPPort     int    `json:"smtp_port,omitempty"`
	SMTPUsername string `json:"smtp_username"`
	SMTPPassword string `json:"smtp_password"`
	IMAPHost     string `json:"imap_host,omitempty"`
	IMAPPort     int    `json:"imap_port,omitempty"`
}

// IsComplete returns true when all three required fields are non-empty.
func (c InlineSMTPCreds) IsComplete() bool {
	return c.SMTPHost != "" && c.SMTPUsername != "" && c.SMTPPassword != ""
}

// HasIMAP returns true when both IMAP host + port are non-zero and the
// shared SMTP credentials (username + password) are also present. The
// drain uses this gate to decide whether to attempt a post-send APPEND.
func (c InlineSMTPCreds) HasIMAP() bool {
	return c.IMAPHost != "" && c.IMAPPort > 0 && c.SMTPUsername != "" && c.SMTPPassword != ""
}

// IntakeRequest is the raw submission received from a submitter.
type IntakeRequest struct {
	Recipient    string            `json:"recipient"`
	Subject      string            `json:"subject"`
	Body         string            `json:"body"`
	BodyHTML     string            `json:"body_html,omitempty"`    // HTML alternative part for multipart/alternative
	Headers      map[string]string `json:"headers,omitempty"`      // pre-built fingerprint headers (Date, Message-ID, X-Mailer…)
	FromAddress  string            `json:"from_address,omitempty"` // sending account; selects SMTP account from pool
	RecipientKey []byte            `json:"recipient_key,omitempty"`
	// Inline SMTP credentials — when present, bypass the static account pool.
	SMTPHost     string `json:"smtp_host,omitempty"`
	SMTPPort     int    `json:"smtp_port,omitempty"`
	SMTPUsername string `json:"smtp_username,omitempty"`
	SMTPPassword string `json:"smtp_password,omitempty"`
	// AW7-9 — IMAP coordinates of the sender mailbox. When present and
	// non-zero, the drain attempts a best-effort APPEND of the wireMIME
	// to the mailbox's "Sent" folder over the same SOCKS5 layer used for
	// SMTP delivery. Username/Password are shared with the SMTP fields.
	IMAPHost string `json:"imap_host,omitempty"`
	IMAPPort int    `json:"imap_port,omitempty"`
	// PreferredCountry pins egress to a specific ISO 3166-1 alpha-2 country
	// (e.g. "SK", "RO"). When set, the wgpool picker filters active endpoints
	// to that country first. Empty string = no preference (hash-based rotation).
	PreferredCountry string `json:"preferred_country,omitempty"`
	// MailboxID is the numeric outreach_mailboxes.id as a decimal string.
	// When set, recorded in mailbox_egress_observation after successful delivery.
	MailboxID string `json:"mailbox_id,omitempty"`
}

// InlineCreds extracts the inline SMTP credentials from the request.
// Returns the zero value when credentials are incomplete.
func (r IntakeRequest) InlineCreds() InlineSMTPCreds {
	return InlineSMTPCreds{
		SMTPHost:     r.SMTPHost,
		SMTPPort:     r.SMTPPort,
		SMTPUsername: r.SMTPUsername,
		SMTPPassword: r.SMTPPassword,
		IMAPHost:     r.IMAPHost,
		IMAPPort:     r.IMAPPort,
	}
}

// SanitizationResult holds the outcome of content and metadata sanitization.
type SanitizationResult struct {
	Status            string   `json:"status"`
	NormalizedSubject string   `json:"normalized_subject"`
	NormalizedBody    string   `json:"normalized_body"`
	HasHTML           bool     `json:"has_html"`
	HasBlockedContent bool     `json:"has_blocked_content"`
	Notes             []string `json:"notes,omitempty"`
}
