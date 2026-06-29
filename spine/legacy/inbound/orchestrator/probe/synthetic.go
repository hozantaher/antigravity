package probe

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strconv"

	"campaigns/sender"
	"common/envconfig"
)

// ErrDisabled is returned when SYNTHETIC_PROBE_ENABLED is false.
var ErrDisabled = errors.New("synthetic probe is disabled")

// ErrInternalMailboxValidation is returned when probe would target a non-internal mailbox.
var ErrInternalMailboxValidation = errors.New("probe mailbox is not internal (mb1-mb4)")

// SyntheticProbeConfig holds the configuration for the synthetic probe.
type SyntheticProbeConfig struct {
	Enabled         bool
	FromMailboxID   int64
	ToMailboxID     int64
	RelayURL        string
	RelayToken      string
	SendingMailbox  string // the actual email address to send from
}

// Mailbox represents a mailbox row from the database.
type Mailbox struct {
	ID       int64
	Address  string
	Password string
	SMTPHost string
	SMTPPort int
	SMTPUser string
}

// loadSyntheticProbeConfig reads env vars and returns the config.
func loadSyntheticProbeConfig() (*SyntheticProbeConfig, error) {
	enabled := envconfig.BoolOr("SYNTHETIC_PROBE_ENABLED", false)
	if !enabled {
		return &SyntheticProbeConfig{Enabled: false}, nil
	}

	fromStr := envconfig.GetOr("SYNTHETIC_PROBE_FROM_MAILBOX_ID", "")
	toStr := envconfig.GetOr("SYNTHETIC_PROBE_TO_MAILBOX_ID", "")

	if fromStr == "" {
		return nil, errors.New("SYNTHETIC_PROBE_FROM_MAILBOX_ID not set")
	}
	if toStr == "" {
		return nil, errors.New("SYNTHETIC_PROBE_TO_MAILBOX_ID not set")
	}

	fromID, err := strconv.ParseInt(fromStr, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("SYNTHETIC_PROBE_FROM_MAILBOX_ID parse: %w", err)
	}

	toID, err := strconv.ParseInt(toStr, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("SYNTHETIC_PROBE_TO_MAILBOX_ID parse: %w", err)
	}

	relayURL := envconfig.GetOr("ANTI_TRACE_RELAY_URL", "")
	if relayURL == "" {
		return nil, errors.New("ANTI_TRACE_RELAY_URL not set")
	}

	relayToken := envconfig.GetOr("ANTI_TRACE_RELAY_TOKEN", "")
	if relayToken == "" {
		return nil, errors.New("ANTI_TRACE_RELAY_TOKEN not set")
	}

	return &SyntheticProbeConfig{
		Enabled:       true,
		FromMailboxID: fromID,
		ToMailboxID:   toID,
		RelayURL:      relayURL,
		RelayToken:    relayToken,
	}, nil
}

// resolveMailbox fetches a mailbox by ID from the database.
func resolveMailbox(ctx context.Context, db *sql.DB, mailboxID int64) (*Mailbox, error) {
	row := db.QueryRowContext(ctx,
		`SELECT id, address, password, smtp_host, smtp_port, smtp_user
		 FROM outreach_mailboxes WHERE id = $1`,
		mailboxID)

	var mb Mailbox
	err := row.Scan(&mb.ID, &mb.Address, &mb.Password, &mb.SMTPHost, &mb.SMTPPort, &mb.SMTPUser)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("mailbox id %d not found", mailboxID)
		}
		return nil, fmt.Errorf("query mailbox: %w", err)
	}
	return &mb, nil
}

// isInternalMailbox checks if an address belongs to the internal test set (mb1–mb4).
func isInternalMailbox(address string) bool {
	// Match mb1@*, mb2@*, mb3@*, mb4@*
	for i := 1; i <= 4; i++ {
		prefix := fmt.Sprintf("mb%d@", i)
		if len(address) > len(prefix) && address[:len(prefix)] == prefix {
			return true
		}
	}
	return false
}

// Run executes a single synthetic probe: dispatches a test email from the
// FROM mailbox to the TO mailbox via the anti-trace relay, and returns
// an error if any step fails. When SYNTHETIC_PROBE_ENABLED is false, returns
// ErrDisabled. Caller is responsible for checking the flag before invoking.
func Run(ctx context.Context, db *sql.DB, cfg *SyntheticProbeConfig) error {
	const op = "probe.synthetic.Run"

	if !cfg.Enabled {
		return ErrDisabled
	}

	log := slog.With("op", op)

	// Resolve FROM mailbox
	fromMB, err := resolveMailbox(ctx, db, cfg.FromMailboxID)
	if err != nil {
		log.Error("resolve from mailbox failed",
			"error", err,
			"from_mailbox_id", cfg.FromMailboxID)
		return fmt.Errorf("resolve from mailbox: %w", err)
	}

	// Resolve TO mailbox
	toMB, err := resolveMailbox(ctx, db, cfg.ToMailboxID)
	if err != nil {
		log.Error("resolve to mailbox failed",
			"error", err,
			"to_mailbox_id", cfg.ToMailboxID)
		return fmt.Errorf("resolve to mailbox: %w", err)
	}

	// Validate that TO mailbox is internal
	if !isInternalMailbox(toMB.Address) {
		log.Error("probe target mailbox is not internal",
			"to_address", redactMailbox(toMB.Address),
			"to_mailbox_id", cfg.ToMailboxID)
		return fmt.Errorf("%w: %s", ErrInternalMailboxValidation, toMB.Address)
	}

	// Synthetic probe is a one-shot liveness check, not a campaign send.
	// It bypasses Engine.Run because there's no queue, no per-mailbox circuit
	// breaker, and no contact state to mutate.
	// engine-bypass-allowed: synthetic probe path verifies relay→SOCKS→SMTP
	client := sender.NewAntiTraceClient(cfg.RelayURL, cfg.RelayToken)

	// Construct a minimal send request
	req := sender.SendRequest{
		CampaignID:   0, // synthetic probe, not tied to a campaign
		ContactID:    0, // synthetic probe, not tied to a contact
		Step:         0,
		ToAddress:    toMB.Address,
		Subject:      "[SYNTHETIC PROBE] Anti-trace relay verification",
		BodyPlain:    "This is an automated synthetic probe message for anti-trace relay health verification.",
		BodyHTML:     "<p>This is an automated synthetic probe message for anti-trace relay health verification.</p>",
		Headers:      map[string]string{},
		FirstName:    "Probe",
		SkipHumanize: true, // synthetic probes bypass humanization
		SMTPHost:     fromMB.SMTPHost,
		SMTPPort:     fromMB.SMTPPort,
		SMTPUsername: fromMB.SMTPUser,
		SMTPPassword: fromMB.Password,
	}

	// Send via anti-trace relay
	result := client.Send(ctx, req)
	if result.Error != nil {
		log.Error("anti-trace relay send failed",
			"error", result.Error,
			"to_address", redactMailbox(req.ToAddress),
			"from_address", redactMailbox(fromMB.Address))
		return fmt.Errorf("send via relay: %w", result.Error)
	}

	// Log success
	log.Info("synthetic probe sent successfully",
		"message_id", result.MessageID,
		"mailbox_used", redactMailbox(result.MailboxUsed),
		"to_address", redactMailbox(req.ToAddress))

	return nil
}

// redactMailbox returns a redacted version of the email address for logging
// (per HARD RULE feedback_no_pii_in_commands).
func redactMailbox(address string) string {
	if address == "" {
		return ""
	}
	if len(address) < 3 {
		return address
	}
	// Redact: user@example.com → u…@example.com
	parts := make([]byte, len(address))
	copy(parts, address)
	for i := 0; i < len(parts); i++ {
		if parts[i] == '@' {
			break
		}
		if i > 0 {
			parts[i] = '.'
		}
	}
	return string(parts)
}
