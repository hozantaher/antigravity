package config

import (
	"os"
	"strconv"

	"common/envconfig"

	"privacy-gateway/internal/model"
)

type Config struct {
	ListenAddr                 string
	AliasDomain                string
	DataDir                    string
	DataEncryptionKeyB64       string
	DeliveryMode               string
	SMTPHost                   string
	SMTPPort                   int
	SMTPUsername               string
	SMTPPassword               string
	SMTPHelloDomain            string
	SMTPRequireSTARTTLS        bool
	SMTPConnectTimeoutSeconds  int
	IMAPHost                   string
	IMAPPort                   int
	IMAPUsername               string
	IMAPPassword               string
	IMAPTimeoutSeconds         int
	AuditRetentionHours        int
	IdentityLinkRetentionHours int
	SubmissionRetentionHours   int
	InboxRetentionHours        int
	OutboxRetentionHours       int
	IMAPCursorRetentionHours   int
	AliasRetentionHours        int
	RelayAttemptRetentionHours int
	MaxRecipients              int
	MaxMessageBytes            int
	DevToken                   string
	DevActor                   model.Actor
	IntakeToken                string
	IntakeActor                model.Actor
}

func Load() Config {
	return Config{
		ListenAddr:                 envconfig.GetOr("LISTEN_ADDR", ":8081"),
		AliasDomain:                envconfig.GetOr("ALIAS_DOMAIN", "relay.local"),
		DataDir:                    envconfig.GetOr("DATA_DIR", "data"),
		DataEncryptionKeyB64:       envconfig.GetOr("DATA_ENCRYPTION_KEY_B64", ""),
		DeliveryMode:               envconfig.GetOr("DELIVERY_MODE", "record-only"),
		SMTPHost:                   envconfig.GetOr("SMTP_HOST", ""),
		SMTPPort:                   envPositiveIntOrDefault("SMTP_PORT", 587),
		SMTPUsername:               envconfig.GetOr("SMTP_USERNAME", ""),
		SMTPPassword:               envconfig.GetOr("SMTP_PASSWORD", ""),
		SMTPHelloDomain:            envconfig.GetOr("SMTP_HELLO_DOMAIN", "privacy-gateway.local"),
		SMTPRequireSTARTTLS:        envconfig.BoolOr("SMTP_REQUIRE_STARTTLS", true),
		SMTPConnectTimeoutSeconds:  envPositiveIntOrDefault("SMTP_CONNECT_TIMEOUT_SECONDS", 10),
		IMAPHost:                   envconfig.GetOr("IMAP_HOST", ""),
		IMAPPort:                   envPositiveIntOrDefault("IMAP_PORT", 993),
		IMAPUsername:               envconfig.GetOr("IMAP_USERNAME", ""),
		IMAPPassword:               envconfig.GetOr("IMAP_PASSWORD", ""),
		IMAPTimeoutSeconds:         envPositiveIntOrDefault("IMAP_TIMEOUT_SECONDS", 10),
		AuditRetentionHours:        envPositiveIntOrDefault("AUDIT_RETENTION_HOURS", 24*30),   // 30 days
		IdentityLinkRetentionHours: envPositiveIntOrDefault("IDENTITY_LINK_RETENTION_HOURS", 24*90), // 90 days
		SubmissionRetentionHours:   envPositiveIntOrDefault("SUBMISSION_RETENTION_HOURS", 24*30),     // 30 days
		InboxRetentionHours:        envPositiveIntOrDefault("INBOX_RETENTION_HOURS", 24*30),          // 30 days
		OutboxRetentionHours:       envPositiveIntOrDefault("OUTBOX_RETENTION_HOURS", 24*30),         // 30 days
		IMAPCursorRetentionHours:   envPositiveIntOrDefault("IMAP_CURSOR_RETENTION_HOURS", 24*7),     // 7 days
		AliasRetentionHours:        envPositiveIntOrDefault("ALIAS_RETENTION_HOURS", 24*90),          // 90 days
		RelayAttemptRetentionHours: envPositiveIntOrDefault("RELAY_ATTEMPT_RETENTION_HOURS", 24*30),  // 30 days
		MaxRecipients:              envIntOrDefault("MAX_RECIPIENTS", 10),
		MaxMessageBytes:            envIntOrDefault("MAX_MESSAGE_BYTES", 128*1024),
		DevToken:                   envconfig.GetOr("DEV_API_TOKEN", "dev-token"),
		DevActor: model.Actor{
			ID:           envconfig.GetOr("DEV_USER_ID", "user-dev"),
			TenantID:     envconfig.GetOr("DEV_TENANT_ID", "tenant-dev"),
			PrimaryEmail: envconfig.GetOr("DEV_USER_EMAIL", "user@example.com"),
		},
		IntakeToken: envconfig.GetOr("INTAKE_API_TOKEN", ""),
		IntakeActor: model.Actor{
			ID:           envconfig.GetOr("INTAKE_USER_ID", "intake-user"),
			TenantID:     envconfig.GetOr("INTAKE_TENANT_ID", envconfig.GetOr("DEV_TENANT_ID", "tenant-dev")),
			PrimaryEmail: envconfig.GetOr("INTAKE_USER_EMAIL", "intake@example.com"),
		},
	}
}


func envIntOrDefault(key string, fallback int) int {
	// envconfig-allowed: int parse; envconfig.GetOr is string-only
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envPositiveIntOrDefault(key string, fallback int) int {
	// envconfig-allowed: positive-int parse; envconfig.GetOr is string-only
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

