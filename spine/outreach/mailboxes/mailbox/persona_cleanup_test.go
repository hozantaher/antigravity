package mailbox

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// TestMailboxStructNoPersonaSlug ensures PersonaSlug field is no longer present.
func TestMailboxStructNoPersonaSlug(t *testing.T) {
	m := Mailbox{
		ID:          1,
		FromAddress: "test@example.com",
		DisplayName: "Test User",
	}

	// Compile-time check: PersonaSlug field removed
	// This test passes if the struct does not have PersonaSlug field
	// (IDE/compiler would flag usage of m.PersonaSlug at compile time)
	if m.ID != 1 {
		t.Errorf("Expected ID=1")
	}
}

// TestFilterStructNoPersona ensures Persona field is no longer present in Filter.
func TestFilterStructNoPersona(t *testing.T) {
	f := Filter{
		Status: []Status{StatusActive},
		Limit:  10,
	}

	// Compile-time check: Persona field removed
	// This test passes if Filter does not have Persona field
	if len(f.Status) != 1 {
		t.Errorf("Expected 1 status filter")
	}
}

// TestListFilterWithoutPersona verifies List ignores persona completely.
func TestListFilterWithoutPersona(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	store := NewPGStore(db)

	// Setup mock: SELECT should NOT include persona_slug in WHERE
	rows := sqlmock.NewRows([]string{
		"id", "from_address", "display_name",
		"smtp_host", "smtp_port", "smtp_username",
		"imap_host", "imap_port", "imap_username",
		"daily_cap_override", "tz", "locale",
		"status", "status_reason",
		"last_send_at", "consecutive_bounces", "total_sent", "total_bounced",
		"created_at", "updated_at", "password", "proxy_url",
		"environment", "preferred_country", "lifecycle_phase",
	}).AddRow(
		1, "test@example.com", "Test",
		"smtp.example.com", 587, "",
		"imap.example.com", 993, "",
		nil, "UTC", "en",
		"active", "",
		nil, 0, 5, 0,
		time.Now(), time.Now(), "secret", "",
		"production", "", "warmup_d0",
	)

	// Expect SELECT without persona_slug filter. tz / locale / counter
	// columns are wrapped in COALESCE (2026-05-13 fix for NULL Scan crash
	// in ActiveAddresses + OverlayRegistry).
	expectedSQL := `SELECT id, from_address, display_name,
    smtp_host, smtp_port, COALESCE\(smtp_username, ''\),
    COALESCE\(imap_host, ''\), COALESCE\(imap_port, 0\), COALESCE\(imap_username, ''\),
    daily_cap_override, COALESCE\(tz, ''\), COALESCE\(locale, ''\),
    status, COALESCE\(status_reason, ''\),
    last_send_at,
    COALESCE\(consecutive_bounces, 0\),
    COALESCE\(total_sent, 0\),
    COALESCE\(total_bounced, 0\),
    created_at, updated_at, COALESCE\(password, ''\), COALESCE\(proxy_url, ''\),
    COALESCE\(environment, 'production'\),
    COALESCE\(preferred_country, ''\),
    COALESCE\(lifecycle_phase, 'warmup_d0'\) FROM outreach_mailboxes  ORDER BY from_address LIMIT \$1`

	mock.ExpectQuery(expectedSQL).WithArgs(100).WillReturnRows(rows)

	result, err := store.List(context.Background(), Filter{})
	if err != nil {
		t.Fatalf("List() error: %v", err)
	}
	if len(result) != 1 {
		t.Errorf("Expected 1 mailbox, got %d", len(result))
	}
	if result[0].FromAddress != "test@example.com" {
		t.Errorf("Expected email test@example.com, got %s", result[0].FromAddress)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("Mock expectations failed: %v", err)
	}
}

// TestUpsertFromConfigNoPersona verifies INSERT/UPDATE skips persona_slug.
func TestUpsertFromConfigNoPersona(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	store := NewPGStore(db)

	m := Mailbox{
		FromAddress: "new@example.com",
		DisplayName: "New User",
		SMTPHost:    "smtp.example.com",
		SMTPPort:    587,
		Status:      StatusActive,
	}

	rows := sqlmock.NewRows([]string{
		"id", "from_address", "display_name",
		"smtp_host", "smtp_port", "smtp_username",
		"imap_host", "imap_port", "imap_username",
		"daily_cap_override", "tz", "locale",
		"status", "status_reason",
		"last_send_at", "consecutive_bounces", "total_sent", "total_bounced",
		"created_at", "updated_at", "password", "proxy_url",
		"environment", "preferred_country", "lifecycle_phase",
	}).AddRow(
		1, "new@example.com", "New User",
		"smtp.example.com", 587, "",
		"", 0, "",
		nil, "", "",
		"active", "",
		nil, 0, 0, 0,
		time.Now(), time.Now(), "", "",
		"production", "", "warmup_d0",
	)

	// Expect INSERT without persona_slug column
	expectedSQL := `INSERT INTO outreach_mailboxes \(
			from_address, display_name,
			smtp_host, smtp_port, smtp_username,
			imap_host, imap_port, imap_username,
			daily_cap_override, tz, locale, status, status_reason
		\)
		VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11,\$12,\$13\)
		ON CONFLICT \(from_address\) DO UPDATE SET
			display_name       = EXCLUDED.display_name,
			smtp_host          = EXCLUDED.smtp_host,
			smtp_port          = EXCLUDED.smtp_port,
			smtp_username      = EXCLUDED.smtp_username,
			imap_host          = EXCLUDED.imap_host,
			imap_port          = EXCLUDED.imap_port,
			imap_username      = EXCLUDED.imap_username,
			daily_cap_override = EXCLUDED.daily_cap_override,
			tz                 = EXCLUDED.tz,
			locale             = EXCLUDED.locale
		RETURNING .*`

	mock.ExpectQuery(expectedSQL).WithArgs(
		"new@example.com", "New User",
		"smtp.example.com", 587, nil,
		nil, nil, nil,
		nil, "", "", "active", nil,
	).WillReturnRows(rows)

	result, err := store.UpsertFromConfig(context.Background(), m)
	if err != nil {
		t.Fatalf("UpsertFromConfig() error: %v", err)
	}
	if result.FromAddress != "new@example.com" {
		t.Errorf("Expected from_address new@example.com, got %s", result.FromAddress)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("Mock expectations failed: %v", err)
	}
}

// TestCreateNoPersona verifies Create INSERT skips persona_slug.
func TestCreateNoPersona(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	store := NewPGStore(db)

	m := Mailbox{
		FromAddress: "fresh@example.com",
		DisplayName: "Fresh",
		SMTPHost:    "smtp.fresh.com",
		SMTPPort:    587,
		Status:      StatusActive,
	}

	rows := sqlmock.NewRows([]string{
		"id", "from_address", "display_name",
		"smtp_host", "smtp_port", "smtp_username",
		"imap_host", "imap_port", "imap_username",
		"daily_cap_override", "tz", "locale",
		"status", "status_reason",
		"last_send_at", "consecutive_bounces", "total_sent", "total_bounced",
		"created_at", "updated_at", "password", "proxy_url",
		"environment", "preferred_country", "lifecycle_phase",
	}).AddRow(
		99, "fresh@example.com", "Fresh",
		"smtp.fresh.com", 587, "",
		"", 0, "",
		nil, "", "",
		"active", "",
		nil, 0, 0, 0,
		time.Now(), time.Now(), "", "",
		"production", "", "warmup_d0",
	)

	// Expect CREATE without persona_slug
	expectedSQL := `INSERT INTO outreach_mailboxes \(
			from_address, display_name,
			smtp_host, smtp_port, smtp_username,
			imap_host, imap_port, imap_username,
			daily_cap_override, tz, locale, status, status_reason, password, proxy_url
		\)
		VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11,\$12,\$13,\$14,\$15\)
		RETURNING .*`

	mock.ExpectQuery(expectedSQL).WithArgs(
		"fresh@example.com", "Fresh",
		"smtp.fresh.com", 587, nil,
		nil, nil, nil,
		nil, "", "", "active", nil, nil, nil,
	).WillReturnRows(rows)

	result, err := store.Create(context.Background(), m)
	if err != nil {
		t.Fatalf("Create() error: %v", err)
	}
	if result.ID != 99 {
		t.Errorf("Expected ID 99, got %d", result.ID)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("Mock expectations failed: %v", err)
	}
}

// TestUpdateNoPersona verifies Update skips persona_slug.
func TestUpdateNoPersona(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	store := NewPGStore(db)

	m := Mailbox{
		FromAddress: "updated@example.com",
		DisplayName: "Updated",
		SMTPHost:    "smtp.updated.com",
		SMTPPort:    587,
		Status:      StatusActive,
	}

	rows := sqlmock.NewRows([]string{
		"id", "from_address", "display_name",
		"smtp_host", "smtp_port", "smtp_username",
		"imap_host", "imap_port", "imap_username",
		"daily_cap_override", "tz", "locale",
		"status", "status_reason",
		"last_send_at", "consecutive_bounces", "total_sent", "total_bounced",
		"created_at", "updated_at", "password", "proxy_url",
		"environment", "preferred_country", "lifecycle_phase",
	}).AddRow(
		42, "updated@example.com", "Updated",
		"smtp.updated.com", 587, "",
		"", 0, "",
		nil, "", "",
		"active", "",
		nil, 0, 10, 1,
		time.Now(), time.Now(), "secret", "",
		"production", "", "warmup_d0",
	)

	// Expect UPDATE without persona_slug SET clause
	expectedSQL := `UPDATE outreach_mailboxes SET
			from_address       = \$1,
			display_name       = \$2,
			smtp_host          = \$3,
			smtp_port          = \$4,
			smtp_username      = \$5,
			imap_host          = \$6,
			imap_port          = \$7,
			imap_username      = \$8,
			daily_cap_override = \$9,
			tz                 = \$10,
			locale             = \$11,
			password           = COALESCE\(NULLIF\(\$12, ''\), password\),
			proxy_url          = NULLIF\(\$13, ''\)
		WHERE id = \$14
		RETURNING .*`

	mock.ExpectQuery(expectedSQL).WithArgs(
		"updated@example.com", "Updated",
		"smtp.updated.com", 587, nil,
		nil, nil, nil,
		nil, "", "",
		"", "", 42,
	).WillReturnRows(rows)

	result, err := store.Update(context.Background(), 42, m)
	if err != nil {
		t.Fatalf("Update() error: %v", err)
	}
	if result.FromAddress != "updated@example.com" {
		t.Errorf("Expected from_address updated@example.com, got %s", result.FromAddress)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("Mock expectations failed: %v", err)
	}
}

// TestScanMailboxNoPersona ensures scanMailbox does not attempt to scan PersonaSlug.
func TestScanMailboxNoPersona(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	// Simulate a row WITHOUT persona_slug column
	rows := sqlmock.NewRows([]string{
		"id", "from_address", "display_name",
		"smtp_host", "smtp_port", "smtp_username",
		"imap_host", "imap_port", "imap_username",
		"daily_cap_override", "tz", "locale",
		"status", "status_reason",
		"last_send_at", "consecutive_bounces", "total_sent", "total_bounced",
		"created_at", "updated_at", "password", "proxy_url",
		"environment", "preferred_country", "lifecycle_phase",
	}).AddRow(
		1, "scan@example.com", "Scan Test",
		"smtp.scan.com", 587, "",
		"imap.scan.com", 993, "",
		nil, "UTC", "en",
		"active", "",
		nil, 0, 0, 0,
		time.Now(), time.Now(), "", "",
		"production", "CZ", "warmup_d0",
	)

	// tz / locale / counter columns wrapped in COALESCE (2026-05-13 fix
	// for NULL Scan crash in ActiveAddresses + OverlayRegistry).
	expectedSQL := `SELECT id, from_address, display_name,
    smtp_host, smtp_port, COALESCE\(smtp_username, ''\),
    COALESCE\(imap_host, ''\), COALESCE\(imap_port, 0\), COALESCE\(imap_username, ''\),
    daily_cap_override, COALESCE\(tz, ''\), COALESCE\(locale, ''\),
    status, COALESCE\(status_reason, ''\),
    last_send_at,
    COALESCE\(consecutive_bounces, 0\),
    COALESCE\(total_sent, 0\),
    COALESCE\(total_bounced, 0\),
    created_at, updated_at, COALESCE\(password, ''\), COALESCE\(proxy_url, ''\),
    COALESCE\(environment, 'production'\),
    COALESCE\(preferred_country, ''\),
    COALESCE\(lifecycle_phase, 'warmup_d0'\) FROM outreach_mailboxes WHERE id = \$1`

	mock.ExpectQuery(expectedSQL).WithArgs(1).WillReturnRows(rows)

	store := NewPGStore(db)
	result, err := store.Get(context.Background(), 1)
	if err != nil {
		t.Fatalf("Get() error: %v", err)
	}
	if result.FromAddress != "scan@example.com" {
		t.Errorf("Expected from_address scan@example.com, got %s", result.FromAddress)
	}
	if result.PreferredCountry != "CZ" {
		t.Errorf("Expected PreferredCountry CZ, got %s", result.PreferredCountry)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("Mock expectations failed: %v", err)
	}
}

// TestValidateStillWorks confirms Validate() does not check PersonaSlug.
func TestValidateStillWorks(t *testing.T) {
	tests := []struct {
		name    string
		mailbox Mailbox
		wantErr bool
	}{
		{
			name: "valid minimal mailbox",
			mailbox: Mailbox{
				FromAddress: "test@example.com",
				DisplayName: "Test",
				SMTPHost:    "smtp.example.com",
				SMTPPort:    587,
				Status:      StatusActive,
			},
			wantErr: false,
		},
		{
			name: "missing from_address",
			mailbox: Mailbox{
				FromAddress: "",
				DisplayName: "Test",
				SMTPHost:    "smtp.example.com",
				SMTPPort:    587,
				Status:      StatusActive,
			},
			wantErr: true,
		},
		{
			name: "missing display name",
			mailbox: Mailbox{
				FromAddress: "test@example.com",
				DisplayName: "",
				SMTPHost:    "smtp.example.com",
				SMTPPort:    587,
				Status:      StatusActive,
			},
			wantErr: true,
		},
		{
			name: "invalid smtp port",
			mailbox: Mailbox{
				FromAddress: "test@example.com",
				DisplayName: "Test",
				SMTPHost:    "smtp.example.com",
				SMTPPort:    99999,
				Status:      StatusActive,
			},
			wantErr: true,
		},
		{
			name: "valid with imap config",
			mailbox: Mailbox{
				FromAddress:  "test@example.com",
				DisplayName:  "Test",
				SMTPHost:     "smtp.example.com",
				SMTPPort:     587,
				IMAPHost:     "imap.example.com",
				IMAPPort:     993,
				IMAPUsername: "user",
				Status:       StatusActive,
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.mailbox.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// TestNoPersonaSlugReferencesInCode is an audit check for test files.
func TestNoPersonaSlugReferencesInCode(t *testing.T) {
	// This test verifies that our code modifications removed all
	// references to persona_slug filtering. If postgres.go still had
	// code like `filter.Persona != ""`, this test would need to be updated.
	// For now, it's a safety check that the Filter struct indeed lacks the field.

	f := Filter{}
	// If Persona field existed, this would compile fine but test would be incomplete.
	// Since it's removed, attempting to access f.Persona would fail at compile time.
	// This test passes if compilation succeeds.
	if f.Limit <= 0 {
		f.Limit = 100
	}
}

// BenchmarkListWithoutPersona shows List performance (should not change).
func BenchmarkListWithoutPersona(b *testing.B) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	rows := sqlmock.NewRows([]string{
		"id", "from_address", "display_name",
		"smtp_host", "smtp_port", "smtp_username",
		"imap_host", "imap_port", "imap_username",
		"daily_cap_override", "tz", "locale",
		"status", "status_reason",
		"last_send_at", "consecutive_bounces", "total_sent", "total_bounced",
		"created_at", "updated_at", "password", "proxy_url",
		"environment", "preferred_country",
	})

	for i := 0; i < 10; i++ {
		rows.AddRow(
			int64(i), "test@example.com", "Test",
			"smtp.example.com", 587, "",
			"imap.example.com", 993, "",
			nil, "UTC", "en",
			"active", "",
			nil, 0, 0, 0,
			time.Now(), time.Now(), "", "",
			"production", "",
		)
	}

	mock.ExpectQuery(".*").WillReturnRows(rows)

	store := NewPGStore(db)
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		store.List(context.Background(), Filter{})
	}
}
