package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDomainFromEmail(t *testing.T) {
	tests := []struct{ email, expected string }{
		{"jan@firma.cz", "firma.cz"},
		{"INFO@FIRMA.CZ", "firma.cz"},
		{"user@sub.domain.com", "sub.domain.com"},
		{"noat", ""}, {"", ""}, {"@empty", "empty"},
	}
	for _, tt := range tests {
		if r := DomainFromEmail(tt.email); r != tt.expected {
			t.Errorf("DomainFromEmail(%q) = %q, want %q", tt.email, r, tt.expected)
		}
	}
}

func TestLoadFromEnv_Defaults(t *testing.T) {
	for _, k := range []string{"DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "DB_SSL_MODE"} { os.Unsetenv(k) }
	cfg := LoadFromEnv()
	if cfg.Database.Host != "localhost" { t.Errorf("DB host: got %s", cfg.Database.Host) }
	if cfg.Database.Port != 5432 { t.Errorf("DB port: got %d", cfg.Database.Port) }
	if cfg.Database.SSLMode != "disable" { t.Errorf("DB ssl_mode default: got %s, want disable", cfg.Database.SSLMode) }
	if cfg.Sending.WindowStart != 8 { t.Errorf("window start: got %d", cfg.Sending.WindowStart) }
	if cfg.Sending.WindowEnd != 17 { t.Errorf("window end: got %d", cfg.Sending.WindowEnd) }
	if cfg.Sending.Timezone != "Europe/Prague" { t.Errorf("tz: got %s", cfg.Sending.Timezone) }
	if cfg.Sending.MinDelaySeconds != 45 { t.Errorf("min delay: got %d", cfg.Sending.MinDelaySeconds) }
	if cfg.Sending.MaxDelaySeconds != 180 { t.Errorf("max delay: got %d", cfg.Sending.MaxDelaySeconds) }
	if cfg.Sending.MaxPerDomainHour != 5 { t.Errorf("max per domain: got %d", cfg.Sending.MaxPerDomainHour) }
	if cfg.Safety.MaxBounceRate != 0.05 { t.Errorf("bounce rate: got %f", cfg.Safety.MaxBounceRate) }
	if cfg.Safety.MaxComplaints24h != 1 { t.Errorf("complaints: got %d", cfg.Safety.MaxComplaints24h) }
	if cfg.Web.Port != 8080 { t.Errorf("web port: got %d", cfg.Web.Port) }
	if cfg.Web.Host != "0.0.0.0" { t.Errorf("web host: got %s", cfg.Web.Host) }
}

func TestLoadFromEnv_PersonaConfig(t *testing.T) {
	os.Setenv("PERSONA_NAME", "Jan Novák")
	os.Setenv("PERSONA_EMAIL", "jan@firma.cz")
	os.Setenv("PERSONA_COMPANY", "TechnoTrade s.r.o.")
	os.Setenv("PERSONA_ROLE", "Manager")
	os.Setenv("PERSONA_PHONE", "+420123")
	os.Setenv("PERSONA_WEBSITE", "www.firma.cz")
	os.Setenv("PERSONA_REGION", "Praha")
	defer func() {
		for _, k := range []string{"PERSONA_NAME", "PERSONA_EMAIL", "PERSONA_COMPANY", "PERSONA_ROLE", "PERSONA_PHONE", "PERSONA_WEBSITE", "PERSONA_REGION"} {
			os.Unsetenv(k)
		}
	}()
	cfg := LoadFromEnv()
	if cfg.Persona.Name != "Jan Novák" { t.Errorf("name: %q", cfg.Persona.Name) }
	if cfg.Persona.Email != "jan@firma.cz" { t.Errorf("email: %q", cfg.Persona.Email) }
	if cfg.Persona.Company != "TechnoTrade s.r.o." { t.Errorf("company: %q", cfg.Persona.Company) }
	if cfg.Persona.Role != "Manager" { t.Errorf("role: %q", cfg.Persona.Role) }
	if cfg.Persona.Phone != "+420123" { t.Errorf("phone: %q", cfg.Persona.Phone) }
	if cfg.Persona.Website != "www.firma.cz" { t.Errorf("website: %q", cfg.Persona.Website) }
	if cfg.Persona.Region != "Praha" { t.Errorf("region: %q", cfg.Persona.Region) }
}

func TestLoadFromEnv_PersonaDefaults(t *testing.T) {
	for _, k := range []string{"PERSONA_NAME", "PERSONA_EMAIL"} { os.Unsetenv(k) }
	cfg := LoadFromEnv()
	if cfg.Persona.Name != "" { t.Errorf("default name: %q", cfg.Persona.Name) }
}

func TestLoadFromEnv_CustomDBEnv(t *testing.T) {
	os.Setenv("DB_HOST", "db.example.com")
	os.Setenv("DB_PORT", "5433")
	os.Setenv("DB_NAME", "mydb")
	os.Setenv("DB_USER", "admin")
	os.Setenv("DB_PASSWORD", "secret")
	os.Setenv("DB_SSL_MODE", "require")
	defer func() {
		for _, k := range []string{"DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "DB_SSL_MODE"} { os.Unsetenv(k) }
	}()
	cfg := LoadFromEnv()
	if cfg.Database.Host != "db.example.com" { t.Errorf("host: %s", cfg.Database.Host) }
	if cfg.Database.Port != 5433 { t.Errorf("port: %d", cfg.Database.Port) }
	if cfg.Database.Name != "mydb" { t.Errorf("name: %s", cfg.Database.Name) }
	if cfg.Database.User != "admin" { t.Errorf("user: %s", cfg.Database.User) }
	if cfg.Database.Password != "secret" { t.Errorf("password not set") }
	if cfg.Database.SSLMode != "require" { t.Errorf("ssl: %s", cfg.Database.SSLMode) }
}

func TestDatabaseConfig_DSN(t *testing.T) {
	cfg := DatabaseConfig{Host: "db.example.com", Port: 5432, Name: "outreach", User: "admin", Password: "secret", SSLMode: "require"}
	dsn := cfg.DSN()
	for _, part := range []string{"host=db.example.com", "port=5432", "dbname=outreach", "user=admin", "password=secret", "sslmode=require"} {
		if !strContains(dsn, part) { t.Errorf("DSN missing %q: %s", part, dsn) }
	}
}

func TestDatabaseConfig_DSN_DefaultSSL(t *testing.T) {
	cfg := DatabaseConfig{Host: "localhost", Port: 5432, Name: "test", User: "user"}
	if !strContains(cfg.DSN(), "sslmode=disable") { t.Errorf("default sslmode: %s", cfg.DSN()) }
}

func TestLoad_ValidJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	os.WriteFile(path, []byte(`{
		"database": {"host": "testhost", "port": 5432, "name": "testdb", "user": "testuser", "password": "testpass"},
		"sending": {"window_start": 9, "window_end": 18},
		"safety": {"max_bounce_rate": 0.03},
		"persona": {"name": "Test User", "email": "test@test.cz"}
	}`), 0644)
	cfg, err := Load(path)
	if err != nil { t.Fatalf("Load: %v", err) }
	if cfg.Database.Host != "testhost" { t.Errorf("host: %s", cfg.Database.Host) }
	if cfg.Sending.WindowStart != 9 { t.Errorf("window: %d", cfg.Sending.WindowStart) }
	if cfg.Safety.MaxBounceRate != 0.03 { t.Errorf("bounce: %f", cfg.Safety.MaxBounceRate) }
	if cfg.Persona.Name != "Test User" { t.Errorf("persona: %s", cfg.Persona.Name) }
}

func TestLoad_AppliesDefaults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	os.WriteFile(path, []byte(`{}`), 0644)
	cfg, err := Load(path)
	if err != nil { t.Fatalf("Load: %v", err) }
	if cfg.Sending.WindowStart != 8 { t.Errorf("default window: %d", cfg.Sending.WindowStart) }
	if cfg.Sending.Timezone != "Europe/Prague" { t.Errorf("default tz: %s", cfg.Sending.Timezone) }
	if cfg.Safety.MaxBounceRate != 0.05 { t.Errorf("default bounce: %f", cfg.Safety.MaxBounceRate) }
}

func TestLoad_InvalidJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.json")
	os.WriteFile(path, []byte(`{invalid json}`), 0644)
	_, err := Load(path)
	if err == nil { t.Error("expected error for invalid JSON") }
}

func TestLoad_MissingFile(t *testing.T) {
	_, err := Load("/nonexistent/config.json")
	if err == nil { t.Error("expected error for missing file") }
}

func TestLoad_ExpandsEnv(t *testing.T) {
	os.Setenv("TEST_DB_HOST_EXPAND", "expanded-host")
	defer os.Unsetenv("TEST_DB_HOST_EXPAND")
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	os.WriteFile(path, []byte(`{"database": {"host": "$TEST_DB_HOST_EXPAND", "port": 5432}}`), 0644)
	cfg, err := Load(path)
	if err != nil { t.Fatalf("Load: %v", err) }
	if cfg.Database.Host != "expanded-host" { t.Errorf("env not expanded: %s", cfg.Database.Host) }
}

// TestEnvOr removed — string env helper consolidated to envconfig.GetOr.
// Coverage lives in services/common/envconfig/envconfig_test.go (TestGetOr).

func TestEnvIntOr(t *testing.T) {
	os.Setenv("TEST_INT", "42")
	defer os.Unsetenv("TEST_INT")
	if envIntOr("TEST_INT", 0) != 42 { t.Error("should parse") }
	if envIntOr("NONEXISTENT_XYZ", 99) != 99 { t.Error("should fallback") }
	os.Setenv("TEST_INT", "abc")
	if envIntOr("TEST_INT", 99) != 99 { t.Error("should fallback on non-numeric") }
}

func TestMailboxConfig(t *testing.T) {
	mb := MailboxConfig{Address: "jan@firma.cz", SMTPHost: "smtp.seznam.cz", SMTPPort: 465, DailyLimit: 100}
	if mb.Address != "jan@firma.cz" { t.Error("wrong address") }
	if mb.DailyLimit != 100 { t.Error("wrong limit") }
}

func TestLoadFromEnv_MailboxFromEnv(t *testing.T) {
	os.Setenv("MAILBOX_1_ADDRESS", "test@local.dev")
	os.Setenv("MAILBOX_1_SMTP_HOST", "mail.local")
	os.Setenv("MAILBOX_1_SMTP_PORT", "2525")
	os.Setenv("MAILBOX_1_USERNAME", "user1")
	os.Setenv("MAILBOX_1_PASSWORD", "pass1")
	os.Setenv("MAILBOX_1_IMAP_HOST", "imap.local")
	os.Setenv("MAILBOX_1_IMAP_PORT", "1993")
	os.Setenv("MAILBOX_1_DAILY_LIMIT", "50")
	os.Setenv("MAILBOX_1_WARMUP_DAY", "3")
	defer func() {
		for _, k := range []string{
			"MAILBOX_1_ADDRESS", "MAILBOX_1_SMTP_HOST", "MAILBOX_1_SMTP_PORT",
			"MAILBOX_1_USERNAME", "MAILBOX_1_PASSWORD", "MAILBOX_1_IMAP_HOST",
			"MAILBOX_1_IMAP_PORT", "MAILBOX_1_DAILY_LIMIT", "MAILBOX_1_WARMUP_DAY",
		} {
			os.Unsetenv(k)
		}
	}()

	cfg := LoadFromEnv()
	if len(cfg.Mailboxes) != 1 { t.Fatalf("expected 1 mailbox, got %d", len(cfg.Mailboxes)) }
	mb := cfg.Mailboxes[0]
	if mb.Address != "test@local.dev" { t.Errorf("address: %s", mb.Address) }
	if mb.SMTPHost != "mail.local" { t.Errorf("smtp_host: %s", mb.SMTPHost) }
	if mb.SMTPPort != 2525 { t.Errorf("smtp_port: %d", mb.SMTPPort) }
	if mb.Username != "user1" { t.Errorf("username: %s", mb.Username) }
	if mb.Password != "pass1" { t.Errorf("password: %s", mb.Password) }
	if mb.IMAPHost != "imap.local" { t.Errorf("imap_host: %s", mb.IMAPHost) }
	if mb.IMAPPort != 1993 { t.Errorf("imap_port: %d", mb.IMAPPort) }
	if mb.DailyLimit != 50 { t.Errorf("daily_limit: %d", mb.DailyLimit) }
	if mb.WarmupDay != 3 { t.Errorf("warmup_day: %d", mb.WarmupDay) }
}

func TestLoadFromEnv_MultipleMailboxes(t *testing.T) {
	os.Setenv("MAILBOX_1_ADDRESS", "first@local.dev")
	os.Setenv("MAILBOX_2_ADDRESS", "second@local.dev")
	defer func() {
		os.Unsetenv("MAILBOX_1_ADDRESS")
		os.Unsetenv("MAILBOX_2_ADDRESS")
	}()

	cfg := LoadFromEnv()
	if len(cfg.Mailboxes) != 2 { t.Fatalf("expected 2 mailboxes, got %d", len(cfg.Mailboxes)) }
	if cfg.Mailboxes[0].Address != "first@local.dev" { t.Errorf("first: %s", cfg.Mailboxes[0].Address) }
	if cfg.Mailboxes[1].Address != "second@local.dev" { t.Errorf("second: %s", cfg.Mailboxes[1].Address) }
	// Defaults should apply
	if cfg.Mailboxes[0].SMTPPort != 1025 { t.Errorf("default smtp port: %d", cfg.Mailboxes[0].SMTPPort) }
	if cfg.Mailboxes[0].IMAPPort != 1143 { t.Errorf("default imap port: %d", cfg.Mailboxes[0].IMAPPort) }
	if cfg.Mailboxes[0].DailyLimit != 100 { t.Errorf("default daily limit: %d", cfg.Mailboxes[0].DailyLimit) }
}

func TestLoadFromEnv_NoMailboxes(t *testing.T) {
	os.Unsetenv("MAILBOX_1_ADDRESS")
	cfg := LoadFromEnv()
	if len(cfg.Mailboxes) != 0 { t.Errorf("expected 0 mailboxes, got %d", len(cfg.Mailboxes)) }
}

func TestValidate_LocalDevNoCredentials(t *testing.T) {
	cfg := &Config{
		Mailboxes: []MailboxConfig{
			{Address: "dev@local.dev", SMTPPort: 1025, IMAPPort: 1143},
		},
	}
	if err := cfg.Validate(); err != nil {
		t.Errorf("expected no error for local dev mailbox, got: %v", err)
	}
}

func TestValidate_ProductionPortsOK(t *testing.T) {
	cfg := &Config{
		Mailboxes: []MailboxConfig{
			{Address: "prod@firma.cz", SMTPPort: 465, IMAPPort: 993, Username: "prod@firma.cz", Password: "secret"},
		},
		Tracking: TrackingConfig{BaseURL: "https://track.example.com"},
	}
	if err := cfg.Validate(); err != nil {
		t.Errorf("expected no error for production ports, got: %v", err)
	}
}

func TestValidate_BadSMTPPort(t *testing.T) {
	cfg := &Config{
		Mailboxes: []MailboxConfig{
			{Address: "prod@firma.cz", SMTPPort: 1025, IMAPPort: 993, Username: "prod@firma.cz", Password: "secret"},
		},
	}
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error for bad SMTP port with credentials, got nil")
	}
}

func TestLoadFromEnv_SendingOverrides(t *testing.T) {
	// Set env vars
	t.Setenv("SENDING_WINDOW_START", "0")
	t.Setenv("SENDING_WINDOW_END", "24")
	t.Setenv("SENDING_TIMEZONE", "UTC")
	t.Setenv("SENDING_MIN_DELAY_SECONDS", "1")
	t.Setenv("SENDING_MAX_DELAY_SECONDS", "2")
	t.Setenv("SENDING_MAX_PER_DOMAIN_HOUR", "100")
	t.Setenv("SAFETY_MAX_BOUNCE_RATE", "0.5")
	t.Setenv("SAFETY_MAX_COMPLAINTS_24H", "100")

	cfg := LoadFromEnv()

	if cfg.Sending.WindowStart != 0 {
		t.Errorf("WindowStart: want 0, got %d", cfg.Sending.WindowStart)
	}
	if cfg.Sending.WindowEnd != 24 {
		t.Errorf("WindowEnd: want 24, got %d", cfg.Sending.WindowEnd)
	}
	if cfg.Sending.Timezone != "UTC" {
		t.Errorf("Timezone: want UTC, got %s", cfg.Sending.Timezone)
	}
	if cfg.Sending.MinDelaySeconds != 1 {
		t.Errorf("MinDelaySeconds: want 1, got %d", cfg.Sending.MinDelaySeconds)
	}
	if cfg.Sending.MaxDelaySeconds != 2 {
		t.Errorf("MaxDelaySeconds: want 2, got %d", cfg.Sending.MaxDelaySeconds)
	}
	if cfg.Sending.MaxPerDomainHour != 100 {
		t.Errorf("MaxPerDomainHour: want 100, got %d", cfg.Sending.MaxPerDomainHour)
	}
	if cfg.Safety.MaxBounceRate != 0.5 {
		t.Errorf("MaxBounceRate: want 0.5, got %f", cfg.Safety.MaxBounceRate)
	}
	if cfg.Safety.MaxComplaints24h != 100 {
		t.Errorf("MaxComplaints24h: want 100, got %d", cfg.Safety.MaxComplaints24h)
	}
}

func TestValidate_DevModeBypass(t *testing.T) {
	// D0.8 kill-switch contract: DEV_MODE=1 allows an UNAUTHENTICATED
	// sandbox mailbox (RFC 6761 .test TLD + localhost SMTP/IMAP).
	cfg := &Config{
		Mailboxes: []MailboxConfig{
			{
				Address:  "robot@sandbox.test",
				SMTPHost: "localhost",
				SMTPPort: 1025,
				IMAPHost: "localhost",
				IMAPPort: 1143,
			},
		},
	}

	// Without DEV_MODE — still passes because there are no credentials
	// (unauthenticated mailboxes never triggered the TLS/GDPR check).
	t.Setenv("DEV_MODE", "")
	if err := cfg.Validate(); err != nil {
		t.Errorf("unauth sandbox mailbox should validate in prod mode too, got %v", err)
	}

	// With DEV_MODE=1 — must pass for sandbox fixture.
	t.Setenv("DEV_MODE", "1")
	if err := cfg.Validate(); err != nil {
		t.Errorf("expected no error with DEV_MODE=1, got: %v", err)
	}
}

// D0.8 kill-switch: DEV_MODE=1 MUST refuse any mailbox that could reach
// production infrastructure. Prevents a test run from accidentally spamming
// real addresses when DEV_MODE is set but credentials point at prod.
func TestValidate_DevMode_RefusesNonSandboxHost(t *testing.T) {
	t.Setenv("DEV_MODE", "1")
	cfg := &Config{
		Mailboxes: []MailboxConfig{
			{
				Address:  "robot@real-company.cz", // NOT a sandbox host
				SMTPHost: "localhost",
				SMTPPort: 1025,
				IMAPHost: "localhost",
				IMAPPort: 1143,
			},
		},
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("DEV_MODE=1 with real .cz address must be refused")
	}
}

func TestValidate_DevMode_RefusesProductionCreds(t *testing.T) {
	t.Setenv("DEV_MODE", "1")
	cfg := &Config{
		Mailboxes: []MailboxConfig{
			{
				Address:  "robot@sandbox.test",
				SMTPHost: "localhost",
				SMTPPort: 1025,
				IMAPHost: "localhost",
				IMAPPort: 1143,
				Username: "robot",
				Password: "s3cret", // ← real creds in DEV_MODE → refuse
			},
		},
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("DEV_MODE=1 with password must be refused (kill-switch)")
	}
}

func TestValidate_DevMode_RefusesProductionSMTPHost(t *testing.T) {
	t.Setenv("DEV_MODE", "1")
	cfg := &Config{
		Mailboxes: []MailboxConfig{
			{
				Address:  "robot@sandbox.test",
				SMTPHost: "smtp.seznam.cz", // real host
				SMTPPort: 465,
				IMAPHost: "localhost",
				IMAPPort: 1143,
			},
		},
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("DEV_MODE=1 with real SMTP host must be refused")
	}
}

// Pure helper coverage — exercise the sandbox host classifier.
func TestIsSandboxHost(t *testing.T) {
	safe := []string{
		"", "localhost", "127.0.0.1", "::1",
		"mailpit", "greenmail", "smtp4dev", "maildev", "inbucket",
		"sandbox.test", "foo.bar.test",
		"example.com", "sub.example.com",
		"something.example.net",
		"thing.invalid", "x.localhost",
	}
	for _, h := range safe {
		if !isSandboxHost(h) {
			t.Errorf("expected %q to be sandbox", h)
		}
	}
	prod := []string{
		"seznam.cz", "smtp.seznam.cz", "google.com", "garaaage.cz",
		"real-company.cz", "outreach.example.co", // .co ≠ .com
	}
	for _, h := range prod {
		if isSandboxHost(h) {
			t.Errorf("expected %q to be production, got sandbox", h)
		}
	}
}

func strContains(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub { return true }
	}
	return false
}

// ── Persona tests ──

func TestPersonaConfig_IsEmpty(t *testing.T) {
	if !(PersonaConfig{}).IsEmpty() { t.Error("zero value should be empty") }
	if (PersonaConfig{Name: "Jan"}).IsEmpty() { t.Error("name set = not empty") }
	if (PersonaConfig{Email: "j@f.cz"}).IsEmpty() { t.Error("email set = not empty") }
}

func TestResolvePersona_MailboxLevel(t *testing.T) {
	mb := MailboxConfig{
		Address: "jan@firma.cz",
		Persona: PersonaConfig{Name: "Jan", Role: "Mgr", Email: "jan@firma.cz"},
	}
	global := PersonaConfig{Name: "Global", Company: "Corp", Website: "www.corp.cz"}
	p := mb.ResolvePersona(global)

	if p.Name != "Jan" { t.Errorf("name: want Jan, got %s", p.Name) }
	if p.Role != "Mgr" { t.Errorf("role: want Mgr, got %s", p.Role) }
	// Company/Website should fall back from global
	if p.Company != "Corp" { t.Errorf("company: want Corp, got %s", p.Company) }
	if p.Website != "www.corp.cz" { t.Errorf("website: want www.corp.cz, got %s", p.Website) }
}

func TestResolvePersona_GlobalFallback(t *testing.T) {
	mb := MailboxConfig{Address: "jan@firma.cz"} // no persona
	global := PersonaConfig{Name: "Global", Email: "g@f.cz"}
	p := mb.ResolvePersona(global)

	if p.Name != "Global" { t.Errorf("want Global, got %s", p.Name) }
	if p.Email != "g@f.cz" { t.Errorf("want g@f.cz, got %s", p.Email) }
}

func TestResolvePersona_NoPersona(t *testing.T) {
	mb := MailboxConfig{Address: "fallback@x.cz"}
	p := mb.ResolvePersona(PersonaConfig{})

	if p.Email != "fallback@x.cz" { t.Errorf("want mailbox address, got %s", p.Email) }
}

func TestLoadFromEnv_MailboxPersona(t *testing.T) {
	t.Setenv("MAILBOX_1_ADDRESS", "jan@firma.cz")
	t.Setenv("MAILBOX_1_PERSONA_NAME", "Jan Novák")
	t.Setenv("MAILBOX_1_PERSONA_ROLE", "Obchodní manažer")
	t.Setenv("MAILBOX_1_PERSONA_COMPANY", "TechnoTrade")
	t.Setenv("MAILBOX_1_PERSONA_PHONE", "+420111")
	defer func() {
		for _, k := range []string{
			"MAILBOX_1_ADDRESS", "MAILBOX_1_PERSONA_NAME",
			"MAILBOX_1_PERSONA_ROLE", "MAILBOX_1_PERSONA_COMPANY",
			"MAILBOX_1_PERSONA_PHONE",
		} {
			os.Unsetenv(k)
		}
	}()

	cfg := LoadFromEnv()
	if len(cfg.Mailboxes) != 1 { t.Fatal("expected 1 mailbox") }
	p := cfg.Mailboxes[0].Persona
	if p.Name != "Jan Novák" { t.Errorf("name: %s", p.Name) }
	if p.Role != "Obchodní manažer" { t.Errorf("role: %s", p.Role) }
	if p.Company != "TechnoTrade" { t.Errorf("company: %s", p.Company) }
	if p.Phone != "+420111" { t.Errorf("phone: %s", p.Phone) }
}

// ── ResolvePersona — p.Email filled from mailbox address ──

func TestResolvePersona_EmailFallsBackToAddress(t *testing.T) {
	mb := MailboxConfig{
		Address: "jan@firma.cz",
		Persona: PersonaConfig{Name: "Jan"}, // no Email set
	}
	p := mb.ResolvePersona(PersonaConfig{Company: "Corp"})
	if p.Email != "jan@firma.cz" {
		t.Errorf("Email should fall back to mailbox address, got %q", p.Email)
	}
}

// ── envFloatOr ──

func TestEnvFloatOr(t *testing.T) {
	// key not set → fallback
	os.Unsetenv("TEST_ENV_FLOAT_OR")
	if v := envFloatOr("TEST_ENV_FLOAT_OR", 1.5); v != 1.5 {
		t.Errorf("missing key: want 1.5, got %f", v)
	}

	// key set to valid float
	t.Setenv("TEST_ENV_FLOAT_OR", "3.14")
	if v := envFloatOr("TEST_ENV_FLOAT_OR", 1.5); v != 3.14 {
		t.Errorf("valid float: want 3.14, got %f", v)
	}

	// key set to invalid float → fallback
	t.Setenv("TEST_ENV_FLOAT_OR", "notafloat")
	if v := envFloatOr("TEST_ENV_FLOAT_OR", 2.0); v != 2.0 {
		t.Errorf("invalid float: want fallback 2.0, got %f", v)
	}
}

// ── Validate — bad IMAP port ──

func TestValidate_BadIMAPPort(t *testing.T) {
	cfg := &Config{
		Mailboxes: []MailboxConfig{
			{Address: "prod@firma.cz", SMTPPort: 587, IMAPPort: 143, Username: "u", Password: "p"},
		},
	}
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error for bad IMAP port (143) with credentials")
	}
}

// ── ANTI_TRACE_URL alias tests ────────────────────────────────────────────

func TestAntiTrace_PrimaryURL(t *testing.T) {
	t.Setenv("ANTI_TRACE_URL", "http://relay.example.com:8090")
	t.Setenv("ANTI_TRACE_RELAY_URL", "")
	cfg := LoadFromEnv()
	if !cfg.AntiTrace.Enabled {
		t.Error("AntiTrace.Enabled should be true when ANTI_TRACE_URL set")
	}
	if cfg.AntiTrace.URL != "http://relay.example.com:8090" {
		t.Errorf("unexpected URL: %s", cfg.AntiTrace.URL)
	}
}

func TestAntiTrace_AliasURL_FallsBackToRelayURL(t *testing.T) {
	t.Setenv("ANTI_TRACE_URL", "")
	t.Setenv("ANTI_TRACE_RELAY_URL", "https://anti-trace-relay.up.railway.app")
	cfg := LoadFromEnv()
	if !cfg.AntiTrace.Enabled {
		t.Error("AntiTrace.Enabled should be true when ANTI_TRACE_RELAY_URL set")
	}
	if cfg.AntiTrace.URL != "https://anti-trace-relay.up.railway.app" {
		t.Errorf("unexpected URL: %s", cfg.AntiTrace.URL)
	}
}

func TestAntiTrace_Disabled_WhenNeitherSet(t *testing.T) {
	t.Setenv("ANTI_TRACE_URL", "")
	t.Setenv("ANTI_TRACE_RELAY_URL", "")
	cfg := LoadFromEnv()
	if cfg.AntiTrace.Enabled {
		t.Error("AntiTrace.Enabled should be false when no URL set")
	}
}

func TestAntiTrace_PrimaryTakesPrecedence(t *testing.T) {
	t.Setenv("ANTI_TRACE_URL", "http://primary:8090")
	t.Setenv("ANTI_TRACE_RELAY_URL", "http://alias:8091")
	cfg := LoadFromEnv()
	if cfg.AntiTrace.URL != "http://primary:8090" {
		t.Errorf("primary URL should win, got: %s", cfg.AntiTrace.URL)
	}
}
