package config

import (
	"common/envconfig"

	"relay/internal/model"

	"encoding/base64"
	"fmt"
	"log/slog"
	"strconv"
)

// SMTPAccountConfig holds credentials for one pooled SMTP account.
type SMTPAccountConfig struct {
	Address  string
	Password string
}

// DKIMConfig holds DKIM signing configuration.
// Set DKIM_DOMAIN + DKIM_PRIVATE_KEY_B64 to enable signing;
// omitting either disables DKIM (Enabled = false).
type DKIMConfig struct {
	Domain     string // e.g. "outreach-relay.example.com"
	Selector   string // DNS selector, e.g. "outreach"
	PrivateKey []byte // RSA/Ed25519 private key PEM, decoded from DKIM_PRIVATE_KEY_B64
	Enabled    bool
}

type Config struct {
	ListenAddr      string
	OnionListenAddr string
	DataDir         string

	DataEncryptionKeyB64  string
	VaultEncryptionKeyB64 string

	DeliveryMode string
	SMTPAccounts []SMTPAccountConfig // multi-account pool (SMTP_ACCOUNT_N_ADDRESS/PASSWORD)

	RelayMinDelaySeconds int
	RelayMaxDelaySeconds int
	BatchIntervalSeconds int
	CoverTrafficRatio    float64

	RateLimitPerMinute int
	MaxEnvelopeBytes   int
	MaxRecipients      int

	AuditRetentionHours int
	VaultRetentionHours int
	RelayRetentionHours int

	SMTPHost            string
	SMTPPort            int
	SMTPUsername        string
	SMTPPassword        string
	SMTPRequireSTARTTLS bool

	DKIM DKIMConfig

	DevToken string
	DevActor model.Actor
}

func Load() Config {
	cfg := Config{
		ListenAddr:           envconfig.GetOr("LISTEN_ADDR", ":8090"),
		OnionListenAddr:      envconfig.GetOr("ONION_LISTEN_ADDR", ""),
		DataDir:              envconfig.GetOr("DATA_DIR", "./data"),
		DataEncryptionKeyB64: envconfig.GetOr("DATA_ENCRYPTION_KEY_B64", ""),
		VaultEncryptionKeyB64: envconfig.GetOr("VAULT_ENCRYPTION_KEY_B64", ""),
		DeliveryMode:         envconfig.GetOr("DELIVERY_MODE", "record-only"),

		RelayMinDelaySeconds: envIntOr("RELAY_MIN_DELAY_SECONDS", 30),
		RelayMaxDelaySeconds: envIntOr("RELAY_MAX_DELAY_SECONDS", 300),
		BatchIntervalSeconds: envIntOr("BATCH_INTERVAL_SECONDS", 60),
		CoverTrafficRatio:    envFloatOr("COVER_TRAFFIC_RATIO", 0.3),

		RateLimitPerMinute: envIntOr("RATE_LIMIT_PER_MINUTE", 10),
		MaxEnvelopeBytes:   envIntOr("MAX_ENVELOPE_BYTES", 32768),
		MaxRecipients:      envIntOr("MAX_RECIPIENTS", 5),

		AuditRetentionHours: envIntOr("AUDIT_RETENTION_HOURS", 72),
		VaultRetentionHours: envIntOr("VAULT_RETENTION_HOURS", 0),
		RelayRetentionHours: envIntOr("RELAY_RETENTION_HOURS", 24),

		SMTPHost:            envconfig.GetOr("SMTP_HOST", ""),
		SMTPPort:            envIntOr("SMTP_PORT", 587),
		SMTPUsername:        envconfig.GetOr("SMTP_USERNAME", ""),
		SMTPPassword:        envconfig.GetOr("SMTP_PASSWORD", ""),
		SMTPRequireSTARTTLS: envconfig.BoolOr("SMTP_REQUIRE_STARTTLS", true),
		SMTPAccounts:        loadSMTPAccounts(),

		DKIM: loadDKIMConfig(),

		DevToken: envconfig.GetOr("DEV_API_TOKEN", ""),
		DevActor: model.Actor{
			ID:       envconfig.GetOr("DEV_USER_ID", ""),
			TenantID: envconfig.GetOr("DEV_TENANT_ID", ""),
		},
	}
	return cfg
}

// loadDKIMConfig reads DKIM_DOMAIN, DKIM_SELECTOR, and DKIM_PRIVATE_KEY_B64 from env.
// Enabled is true only when both DKIM_DOMAIN and DKIM_PRIVATE_KEY_B64 are set.
// When DKIM_PRIVATE_KEY_B64 is set but not valid base64, a warning is logged and
// Enabled is set to false.
func loadDKIMConfig() DKIMConfig {
	domain := envconfig.GetOr("DKIM_DOMAIN", "")
	selector := envconfig.GetOr("DKIM_SELECTOR", "outreach")
	keyB64 := envconfig.GetOr("DKIM_PRIVATE_KEY_B64", "")

	if domain == "" || keyB64 == "" {
		if domain != "" || keyB64 != "" {
			slog.Warn("dkim: signing disabled — set DKIM_DOMAIN + DKIM_PRIVATE_KEY_B64 to enable",
				"op", "config.loadDKIMConfig/incomplete")
		}
		return DKIMConfig{
			Domain:   domain,
			Selector: selector,
			Enabled:  false,
		}
	}

	key, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		slog.Warn("dkim: signing disabled — DKIM_PRIVATE_KEY_B64 is not valid base64",
			"op", "config.loadDKIMConfig/invalidBase64",
			"error", err)
		return DKIMConfig{
			Domain:   domain,
			Selector: selector,
			Enabled:  false,
		}
	}

	return DKIMConfig{
		Domain:     domain,
		Selector:   selector,
		PrivateKey: key,
		Enabled:    true,
	}
}

// loadSMTPAccounts parses SMTP_ACCOUNT_N_ADDRESS + SMTP_ACCOUNT_N_PASSWORD (N = 1, 2, ...).
func loadSMTPAccounts() []SMTPAccountConfig {
	var accounts []SMTPAccountConfig
	for i := 1; ; i++ {
		prefix := fmt.Sprintf("SMTP_ACCOUNT_%d_", i)
		addr := envconfig.GetOr(prefix+"ADDRESS", "")
		if addr == "" {
			break
		}
		accounts = append(accounts, SMTPAccountConfig{
			Address:  addr,
			Password: envconfig.GetOr(prefix+"PASSWORD", ""),
		})
	}
	return accounts
}

func envIntOr(key string, fallback int) int {
	v := envconfig.GetOr(key, "")
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func envFloatOr(key string, fallback float64) float64 {
	v := envconfig.GetOr(key, "")
	if v == "" {
		return fallback
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return fallback
	}
	return f
}
