package config

import "testing"

func TestLoadUsesDefaults(t *testing.T) {
	t.Setenv("LISTEN_ADDR", "")
	t.Setenv("ALIAS_DOMAIN", "")
	t.Setenv("DATA_DIR", "")
	t.Setenv("DATA_ENCRYPTION_KEY_B64", "")
	t.Setenv("DELIVERY_MODE", "")
	t.Setenv("SMTP_HOST", "")
	t.Setenv("SMTP_PORT", "")
	t.Setenv("SMTP_USERNAME", "")
	t.Setenv("SMTP_PASSWORD", "")
	t.Setenv("SMTP_HELLO_DOMAIN", "")
	t.Setenv("SMTP_REQUIRE_STARTTLS", "")
	t.Setenv("SMTP_CONNECT_TIMEOUT_SECONDS", "")
	t.Setenv("IMAP_HOST", "")
	t.Setenv("IMAP_PORT", "")
	t.Setenv("IMAP_USERNAME", "")
	t.Setenv("IMAP_PASSWORD", "")
	t.Setenv("IMAP_TIMEOUT_SECONDS", "")
	t.Setenv("AUDIT_RETENTION_HOURS", "")
	t.Setenv("IDENTITY_LINK_RETENTION_HOURS", "")
	t.Setenv("SUBMISSION_RETENTION_HOURS", "")
	t.Setenv("INBOX_RETENTION_HOURS", "")
	t.Setenv("OUTBOX_RETENTION_HOURS", "")
	t.Setenv("IMAP_CURSOR_RETENTION_HOURS", "")
	t.Setenv("MAX_RECIPIENTS", "")
	t.Setenv("MAX_MESSAGE_BYTES", "")
	t.Setenv("DEV_API_TOKEN", "")
	t.Setenv("DEV_USER_ID", "")
	t.Setenv("DEV_TENANT_ID", "")
	t.Setenv("DEV_USER_EMAIL", "")
	t.Setenv("INTAKE_API_TOKEN", "")
	t.Setenv("INTAKE_USER_ID", "")
	t.Setenv("INTAKE_TENANT_ID", "")
	t.Setenv("INTAKE_USER_EMAIL", "")

	cfg := Load()

	if cfg.ListenAddr != ":8081" {
		t.Fatalf("expected default listen addr, got %s", cfg.ListenAddr)
	}
	if cfg.AliasDomain != "relay.local" {
		t.Fatalf("expected default alias domain, got %s", cfg.AliasDomain)
	}
	if cfg.DataDir != "data" {
		t.Fatalf("expected default data dir, got %s", cfg.DataDir)
	}
	if cfg.DataEncryptionKeyB64 != "" {
		t.Fatalf("expected empty default data encryption key, got %s", cfg.DataEncryptionKeyB64)
	}
	if cfg.DeliveryMode != "record-only" {
		t.Fatalf("expected default delivery mode, got %s", cfg.DeliveryMode)
	}
	if cfg.SMTPHost != "" {
		t.Fatalf("expected empty default SMTP host, got %s", cfg.SMTPHost)
	}
	if cfg.SMTPPort != 587 {
		t.Fatalf("expected default SMTP port, got %d", cfg.SMTPPort)
	}
	if cfg.SMTPHelloDomain != "privacy-gateway.local" {
		t.Fatalf("expected default SMTP hello domain, got %s", cfg.SMTPHelloDomain)
	}
	if !cfg.SMTPRequireSTARTTLS {
		t.Fatal("expected STARTTLS to be required by default")
	}
	if cfg.SMTPConnectTimeoutSeconds != 10 {
		t.Fatalf("expected default SMTP timeout, got %d", cfg.SMTPConnectTimeoutSeconds)
	}
	if cfg.IMAPHost != "" {
		t.Fatalf("expected empty default IMAP host, got %s", cfg.IMAPHost)
	}
	if cfg.IMAPPort != 993 {
		t.Fatalf("expected default IMAP port, got %d", cfg.IMAPPort)
	}
	if cfg.IMAPTimeoutSeconds != 10 {
		t.Fatalf("expected default IMAP timeout, got %d", cfg.IMAPTimeoutSeconds)
	}
	if cfg.AuditRetentionHours != 24*30 {
		t.Fatalf("expected default audit retention 30 days, got %d", cfg.AuditRetentionHours)
	}
	if cfg.IdentityLinkRetentionHours != 24*90 {
		t.Fatalf("expected default identity-link retention 90 days, got %d", cfg.IdentityLinkRetentionHours)
	}
	if cfg.SubmissionRetentionHours != 24*30 {
		t.Fatalf("expected default submission retention 30 days, got %d", cfg.SubmissionRetentionHours)
	}
	if cfg.InboxRetentionHours != 24*30 {
		t.Fatalf("expected default inbox retention 30 days, got %d", cfg.InboxRetentionHours)
	}
	if cfg.OutboxRetentionHours != 24*30 {
		t.Fatalf("expected default outbox retention 30 days, got %d", cfg.OutboxRetentionHours)
	}
	if cfg.IMAPCursorRetentionHours != 24*7 {
		t.Fatalf("expected default IMAP cursor retention 7 days, got %d", cfg.IMAPCursorRetentionHours)
	}
	if cfg.AliasRetentionHours != 24*90 {
		t.Fatalf("expected default alias retention 90 days, got %d", cfg.AliasRetentionHours)
	}
	if cfg.RelayAttemptRetentionHours != 24*30 {
		t.Fatalf("expected default relay attempt retention 30 days, got %d", cfg.RelayAttemptRetentionHours)
	}
	if cfg.MaxRecipients != 10 {
		t.Fatalf("expected default max recipients, got %d", cfg.MaxRecipients)
	}
	if cfg.MaxMessageBytes != 128*1024 {
		t.Fatalf("expected default max message bytes, got %d", cfg.MaxMessageBytes)
	}
	if cfg.DevToken != "dev-token" {
		t.Fatalf("expected default dev token, got %s", cfg.DevToken)
	}
	if cfg.DevActor.ID != "user-dev" {
		t.Fatalf("expected default dev user id, got %s", cfg.DevActor.ID)
	}
	if cfg.DevActor.TenantID != "tenant-dev" {
		t.Fatalf("expected default tenant id, got %s", cfg.DevActor.TenantID)
	}
	if cfg.DevActor.PrimaryEmail != "user@example.com" {
		t.Fatalf("expected default email, got %s", cfg.DevActor.PrimaryEmail)
	}
	if cfg.IntakeToken != "" {
		t.Fatalf("expected empty default intake token, got %s", cfg.IntakeToken)
	}
	if cfg.IntakeActor.ID != "intake-user" {
		t.Fatalf("expected default intake user id, got %s", cfg.IntakeActor.ID)
	}
	if cfg.IntakeActor.TenantID != "tenant-dev" {
		t.Fatalf("expected default intake tenant id fallback, got %s", cfg.IntakeActor.TenantID)
	}
	if cfg.IntakeActor.PrimaryEmail != "intake@example.com" {
		t.Fatalf("expected default intake email, got %s", cfg.IntakeActor.PrimaryEmail)
	}
}

func TestLoadUsesOverridesAndFallsBackOnInvalidIntegers(t *testing.T) {
	t.Setenv("LISTEN_ADDR", ":9090")
	t.Setenv("ALIAS_DOMAIN", "relay.example")
	t.Setenv("DATA_DIR", "/tmp/privacy-data")
	t.Setenv("DATA_ENCRYPTION_KEY_B64", "ZmFrZS1iYXNlNjQta2V5")
	t.Setenv("DELIVERY_MODE", "smtp")
	t.Setenv("SMTP_HOST", "smtp.example.com")
	t.Setenv("SMTP_PORT", "2525")
	t.Setenv("SMTP_USERNAME", "mailer")
	t.Setenv("SMTP_PASSWORD", "topsecret")
	t.Setenv("SMTP_HELLO_DOMAIN", "gateway.example.com")
	t.Setenv("SMTP_REQUIRE_STARTTLS", "false")
	t.Setenv("SMTP_CONNECT_TIMEOUT_SECONDS", "invalid")
	t.Setenv("IMAP_HOST", "imap.example.com")
	t.Setenv("IMAP_PORT", "1993")
	t.Setenv("IMAP_USERNAME", "imap-user")
	t.Setenv("IMAP_PASSWORD", "imap-pass")
	t.Setenv("IMAP_TIMEOUT_SECONDS", "-3")
	t.Setenv("AUDIT_RETENTION_HOURS", "48")
	t.Setenv("IDENTITY_LINK_RETENTION_HOURS", "720")
	t.Setenv("SUBMISSION_RETENTION_HOURS", "168")
	t.Setenv("INBOX_RETENTION_HOURS", "72")
	t.Setenv("OUTBOX_RETENTION_HOURS", "96")
	t.Setenv("IMAP_CURSOR_RETENTION_HOURS", "336")
	t.Setenv("ALIAS_RETENTION_HOURS", "480")
	t.Setenv("RELAY_ATTEMPT_RETENTION_HOURS", "240")
	t.Setenv("MAX_RECIPIENTS", "3")
	t.Setenv("MAX_MESSAGE_BYTES", "invalid")
	t.Setenv("DEV_API_TOKEN", "secret-token")
	t.Setenv("DEV_USER_ID", "user-99")
	t.Setenv("DEV_TENANT_ID", "tenant-99")
	t.Setenv("DEV_USER_EMAIL", "person@example.com")
	t.Setenv("INTAKE_API_TOKEN", "intake-secret")
	t.Setenv("INTAKE_USER_ID", "intake-42")
	t.Setenv("INTAKE_TENANT_ID", "tenant-intake")
	t.Setenv("INTAKE_USER_EMAIL", "intake@example.net")

	cfg := Load()

	if cfg.ListenAddr != ":9090" {
		t.Fatalf("expected overridden listen addr, got %s", cfg.ListenAddr)
	}
	if cfg.AliasDomain != "relay.example" {
		t.Fatalf("expected overridden alias domain, got %s", cfg.AliasDomain)
	}
	if cfg.DataDir != "/tmp/privacy-data" {
		t.Fatalf("expected overridden data dir, got %s", cfg.DataDir)
	}
	if cfg.DataEncryptionKeyB64 != "ZmFrZS1iYXNlNjQta2V5" {
		t.Fatalf("expected overridden encryption key, got %s", cfg.DataEncryptionKeyB64)
	}
	if cfg.DeliveryMode != "smtp" {
		t.Fatalf("expected overridden delivery mode, got %s", cfg.DeliveryMode)
	}
	if cfg.SMTPHost != "smtp.example.com" {
		t.Fatalf("expected overridden SMTP host, got %s", cfg.SMTPHost)
	}
	if cfg.SMTPPort != 2525 {
		t.Fatalf("expected overridden SMTP port, got %d", cfg.SMTPPort)
	}
	if cfg.SMTPUsername != "mailer" {
		t.Fatalf("expected overridden SMTP username, got %s", cfg.SMTPUsername)
	}
	if cfg.SMTPPassword != "topsecret" {
		t.Fatalf("expected overridden SMTP password, got %s", cfg.SMTPPassword)
	}
	if cfg.SMTPHelloDomain != "gateway.example.com" {
		t.Fatalf("expected overridden SMTP hello domain, got %s", cfg.SMTPHelloDomain)
	}
	if cfg.SMTPRequireSTARTTLS {
		t.Fatal("expected STARTTLS override to disable requirement")
	}
	if cfg.SMTPConnectTimeoutSeconds != 10 {
		t.Fatalf("expected invalid SMTP timeout to fall back to 10, got %d", cfg.SMTPConnectTimeoutSeconds)
	}
	if cfg.IMAPHost != "imap.example.com" {
		t.Fatalf("expected overridden IMAP host, got %s", cfg.IMAPHost)
	}
	if cfg.IMAPPort != 1993 {
		t.Fatalf("expected overridden IMAP port, got %d", cfg.IMAPPort)
	}
	if cfg.IMAPTimeoutSeconds != 10 {
		t.Fatalf("expected invalid IMAP timeout to fall back to 10, got %d", cfg.IMAPTimeoutSeconds)
	}
	if cfg.IMAPUsername != "imap-user" {
		t.Fatalf("expected overridden IMAP username, got %s", cfg.IMAPUsername)
	}
	if cfg.IMAPPassword != "imap-pass" {
		t.Fatalf("expected overridden IMAP password, got %s", cfg.IMAPPassword)
	}
	if cfg.AuditRetentionHours != 48 {
		t.Fatalf("expected overridden audit retention hours, got %d", cfg.AuditRetentionHours)
	}
	if cfg.IdentityLinkRetentionHours != 720 {
		t.Fatalf("expected overridden identity-link retention hours, got %d", cfg.IdentityLinkRetentionHours)
	}
	if cfg.SubmissionRetentionHours != 168 {
		t.Fatalf("expected overridden submission retention hours, got %d", cfg.SubmissionRetentionHours)
	}
	if cfg.InboxRetentionHours != 72 {
		t.Fatalf("expected overridden inbox retention hours, got %d", cfg.InboxRetentionHours)
	}
	if cfg.OutboxRetentionHours != 96 {
		t.Fatalf("expected overridden outbox retention hours, got %d", cfg.OutboxRetentionHours)
	}
	if cfg.IMAPCursorRetentionHours != 336 {
		t.Fatalf("expected overridden IMAP cursor retention hours, got %d", cfg.IMAPCursorRetentionHours)
	}
	if cfg.AliasRetentionHours != 480 {
		t.Fatalf("expected overridden alias retention hours, got %d", cfg.AliasRetentionHours)
	}
	if cfg.RelayAttemptRetentionHours != 240 {
		t.Fatalf("expected overridden relay attempt retention hours, got %d", cfg.RelayAttemptRetentionHours)
	}
	if cfg.MaxRecipients != 3 {
		t.Fatalf("expected overridden max recipients, got %d", cfg.MaxRecipients)
	}
	if cfg.MaxMessageBytes != 128*1024 {
		t.Fatalf("expected invalid max message bytes to fall back, got %d", cfg.MaxMessageBytes)
	}
	if cfg.DevToken != "secret-token" {
		t.Fatalf("expected overridden dev token, got %s", cfg.DevToken)
	}
	if cfg.DevActor.ID != "user-99" {
		t.Fatalf("expected overridden dev user id, got %s", cfg.DevActor.ID)
	}
	if cfg.DevActor.TenantID != "tenant-99" {
		t.Fatalf("expected overridden tenant id, got %s", cfg.DevActor.TenantID)
	}
	if cfg.DevActor.PrimaryEmail != "person@example.com" {
		t.Fatalf("expected overridden email, got %s", cfg.DevActor.PrimaryEmail)
	}
	if cfg.IntakeToken != "intake-secret" {
		t.Fatalf("expected overridden intake token, got %s", cfg.IntakeToken)
	}
	if cfg.IntakeActor.ID != "intake-42" {
		t.Fatalf("expected overridden intake user id, got %s", cfg.IntakeActor.ID)
	}
	if cfg.IntakeActor.TenantID != "tenant-intake" {
		t.Fatalf("expected overridden intake tenant id, got %s", cfg.IntakeActor.TenantID)
	}
	if cfg.IntakeActor.PrimaryEmail != "intake@example.net" {
		t.Fatalf("expected overridden intake email, got %s", cfg.IntakeActor.PrimaryEmail)
	}
}
