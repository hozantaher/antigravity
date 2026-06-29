package config

import "testing"

func TestLoadUsesDefaultsWhenEnvMissing(t *testing.T) {
	t.Setenv("LISTEN_ADDR", "")
	t.Setenv("ONION_LISTEN_ADDR", "")
	t.Setenv("DATA_DIR", "")
	t.Setenv("DELIVERY_MODE", "")
	t.Setenv("RELAY_MIN_DELAY_SECONDS", "")
	t.Setenv("RELAY_MAX_DELAY_SECONDS", "")
	t.Setenv("BATCH_INTERVAL_SECONDS", "")
	t.Setenv("COVER_TRAFFIC_RATIO", "")
	t.Setenv("RATE_LIMIT_PER_MINUTE", "")
	t.Setenv("MAX_ENVELOPE_BYTES", "")
	t.Setenv("MAX_RECIPIENTS", "")
	t.Setenv("SMTP_PORT", "")
	t.Setenv("SMTP_REQUIRE_STARTTLS", "")

	cfg := Load()

	if cfg.ListenAddr != ":8090" {
		t.Fatalf("ListenAddr = %q, want %q", cfg.ListenAddr, ":8090")
	}
	if cfg.DataDir != "./data" {
		t.Fatalf("DataDir = %q, want %q", cfg.DataDir, "./data")
	}
	if cfg.DeliveryMode != "record-only" {
		t.Fatalf("DeliveryMode = %q, want %q", cfg.DeliveryMode, "record-only")
	}
	if cfg.RelayMinDelaySeconds != 30 || cfg.RelayMaxDelaySeconds != 300 {
		t.Fatalf("unexpected relay delays: min=%d max=%d", cfg.RelayMinDelaySeconds, cfg.RelayMaxDelaySeconds)
	}
	if cfg.BatchIntervalSeconds != 60 {
		t.Fatalf("BatchIntervalSeconds = %d, want 60", cfg.BatchIntervalSeconds)
	}
	if cfg.CoverTrafficRatio != 0.3 {
		t.Fatalf("CoverTrafficRatio = %v, want 0.3", cfg.CoverTrafficRatio)
	}
	if cfg.RateLimitPerMinute != 10 {
		t.Fatalf("RateLimitPerMinute = %d, want 10", cfg.RateLimitPerMinute)
	}
	if cfg.MaxEnvelopeBytes != 32768 {
		t.Fatalf("MaxEnvelopeBytes = %d, want 32768", cfg.MaxEnvelopeBytes)
	}
	if cfg.MaxRecipients != 5 {
		t.Fatalf("MaxRecipients = %d, want 5", cfg.MaxRecipients)
	}
	if cfg.SMTPPort != 587 {
		t.Fatalf("SMTPPort = %d, want 587", cfg.SMTPPort)
	}
	if !cfg.SMTPRequireSTARTTLS {
		t.Fatal("SMTPRequireSTARTTLS = false, want true")
	}
	if len(cfg.SMTPAccounts) != 0 {
		t.Fatalf("SMTPAccounts len = %d, want 0", len(cfg.SMTPAccounts))
	}
}

func TestLoadReadsTypedEnvValues(t *testing.T) {
	t.Setenv("LISTEN_ADDR", "127.0.0.1:18090")
	t.Setenv("DATA_DIR", "/tmp/atr")
	t.Setenv("DELIVERY_MODE", "smtp")
	t.Setenv("RELAY_MIN_DELAY_SECONDS", "11")
	t.Setenv("RELAY_MAX_DELAY_SECONDS", "22")
	t.Setenv("BATCH_INTERVAL_SECONDS", "33")
	t.Setenv("COVER_TRAFFIC_RATIO", "0.75")
	t.Setenv("RATE_LIMIT_PER_MINUTE", "44")
	t.Setenv("MAX_ENVELOPE_BYTES", "55555")
	t.Setenv("MAX_RECIPIENTS", "6")
	t.Setenv("SMTP_PORT", "2525")
	t.Setenv("SMTP_REQUIRE_STARTTLS", "false")
	t.Setenv("SMTP_ACCOUNT_1_ADDRESS", "relay-1@example.com")
	t.Setenv("SMTP_ACCOUNT_1_PASSWORD", "pass-1")
	t.Setenv("SMTP_ACCOUNT_2_ADDRESS", "relay-2@example.com")
	t.Setenv("SMTP_ACCOUNT_2_PASSWORD", "pass-2")

	cfg := Load()

	if cfg.ListenAddr != "127.0.0.1:18090" {
		t.Fatalf("ListenAddr = %q", cfg.ListenAddr)
	}
	if cfg.DataDir != "/tmp/atr" {
		t.Fatalf("DataDir = %q", cfg.DataDir)
	}
	if cfg.DeliveryMode != "smtp" {
		t.Fatalf("DeliveryMode = %q", cfg.DeliveryMode)
	}
	if cfg.RelayMinDelaySeconds != 11 || cfg.RelayMaxDelaySeconds != 22 || cfg.BatchIntervalSeconds != 33 {
		t.Fatalf("typed int values not parsed: %+v", cfg)
	}
	if cfg.CoverTrafficRatio != 0.75 {
		t.Fatalf("CoverTrafficRatio = %v, want 0.75", cfg.CoverTrafficRatio)
	}
	if cfg.RateLimitPerMinute != 44 || cfg.MaxEnvelopeBytes != 55555 || cfg.MaxRecipients != 6 {
		t.Fatalf("limits not parsed: %+v", cfg)
	}
	if cfg.SMTPPort != 2525 {
		t.Fatalf("SMTPPort = %d, want 2525", cfg.SMTPPort)
	}
	if cfg.SMTPRequireSTARTTLS {
		t.Fatal("SMTPRequireSTARTTLS = true, want false")
	}
	if len(cfg.SMTPAccounts) != 2 {
		t.Fatalf("SMTPAccounts len = %d, want 2", len(cfg.SMTPAccounts))
	}
	if cfg.SMTPAccounts[0].Address != "relay-1@example.com" || cfg.SMTPAccounts[1].Address != "relay-2@example.com" {
		t.Fatalf("unexpected smtp account addresses: %+v", cfg.SMTPAccounts)
	}
}

func TestLoadFallsBackOnInvalidNumericValues(t *testing.T) {
	t.Setenv("RELAY_MIN_DELAY_SECONDS", "oops")
	t.Setenv("COVER_TRAFFIC_RATIO", "bad-float")
	t.Setenv("SMTP_REQUIRE_STARTTLS", "not-bool")

	cfg := Load()

	if cfg.RelayMinDelaySeconds != 30 {
		t.Fatalf("RelayMinDelaySeconds = %d, want default 30", cfg.RelayMinDelaySeconds)
	}
	if cfg.CoverTrafficRatio != 0.3 {
		t.Fatalf("CoverTrafficRatio = %v, want default 0.3", cfg.CoverTrafficRatio)
	}
	if !cfg.SMTPRequireSTARTTLS {
		t.Fatal("SMTPRequireSTARTTLS = false, want default true")
	}
}

func TestLoadSMTPAccountsStopsAtFirstMissingIndex(t *testing.T) {
	t.Setenv("SMTP_ACCOUNT_1_ADDRESS", "relay-1@example.com")
	t.Setenv("SMTP_ACCOUNT_1_PASSWORD", "pass-1")
	t.Setenv("SMTP_ACCOUNT_2_ADDRESS", "")
	t.Setenv("SMTP_ACCOUNT_3_ADDRESS", "relay-3@example.com")
	t.Setenv("SMTP_ACCOUNT_3_PASSWORD", "pass-3")

	cfg := Load()

	if len(cfg.SMTPAccounts) != 1 {
		t.Fatalf("SMTPAccounts len = %d, want 1", len(cfg.SMTPAccounts))
	}
	if cfg.SMTPAccounts[0].Address != "relay-1@example.com" {
		t.Fatalf("unexpected SMTP account: %+v", cfg.SMTPAccounts[0])
	}
}
