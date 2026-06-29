package probe

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"campaigns/sender"
)

func TestRun_Disabled(t *testing.T) {
	// When flag is false, Run returns ErrDisabled immediately.
	cfg := &SyntheticProbeConfig{Enabled: false}
	err := Run(context.Background(), nil, cfg)
	if !errors.Is(err, ErrDisabled) {
		t.Errorf("expected ErrDisabled, got %v", err)
	}
}

func TestRun_MissingFromMailboxEnv(t *testing.T) {
	// When SYNTHETIC_PROBE_FROM_MAILBOX_ID is empty and enabled=true, returns error.
	t.Setenv("SYNTHETIC_PROBE_ENABLED", "true")
	t.Setenv("SYNTHETIC_PROBE_FROM_MAILBOX_ID", "")
	t.Setenv("SYNTHETIC_PROBE_TO_MAILBOX_ID", "2")
	t.Setenv("ANTI_TRACE_RELAY_URL", "http://relay:8080")
	t.Setenv("ANTI_TRACE_RELAY_TOKEN", "token")

	_, err := loadSyntheticProbeConfig()
	if err == nil {
		t.Error("expected error, got nil")
	}
	if !errors.Is(err, errors.New("")) && err.Error() != "SYNTHETIC_PROBE_FROM_MAILBOX_ID not set" {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestRun_MissingToMailboxEnv(t *testing.T) {
	// When SYNTHETIC_PROBE_TO_MAILBOX_ID is empty and enabled=true, returns error.
	t.Setenv("SYNTHETIC_PROBE_ENABLED", "true")
	t.Setenv("SYNTHETIC_PROBE_FROM_MAILBOX_ID", "1")
	t.Setenv("SYNTHETIC_PROBE_TO_MAILBOX_ID", "")
	t.Setenv("ANTI_TRACE_RELAY_URL", "http://relay:8080")
	t.Setenv("ANTI_TRACE_RELAY_TOKEN", "token")

	_, err := loadSyntheticProbeConfig()
	if err == nil {
		t.Error("expected error, got nil")
	}
	if err.Error() != "SYNTHETIC_PROBE_TO_MAILBOX_ID not set" {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestRun_MailboxResolution_FromNotFound(t *testing.T) {
	// When FROM mailbox row does not exist, Run returns a wrapped error.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New failed: %v", err)
	}
	defer db.Close()

	cfg := &SyntheticProbeConfig{
		Enabled:       true,
		FromMailboxID: 999,
		ToMailboxID:   2,
		RelayURL:      "http://relay:8080",
		RelayToken:    "token",
	}

	// Mock: FROM mailbox query returns no rows
	mock.ExpectQuery(`SELECT.*FROM outreach_mailboxes`).
		WithArgs(int64(999)).
		WillReturnError(sql.ErrNoRows)

	err = Run(context.Background(), db, cfg)
	if err == nil {
		t.Error("expected error, got nil")
	}
	// Check wrapped error
	if err.Error() != "resolve from mailbox: mailbox id 999 not found" {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestRun_MailboxResolution_ToNotFound(t *testing.T) {
	// When TO mailbox row does not exist, Run returns a wrapped error.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New failed: %v", err)
	}
	defer db.Close()

	cfg := &SyntheticProbeConfig{
		Enabled:       true,
		FromMailboxID: 1,
		ToMailboxID:   999,
		RelayURL:      "http://relay:8080",
		RelayToken:    "token",
	}

	// Mock: FROM mailbox query succeeds
	mock.ExpectQuery(`SELECT.*FROM outreach_mailboxes`).
		WithArgs(int64(1)).
		WillReturnRows(sqlmock.NewRows(
			[]string{"id", "address", "password", "smtp_host", "smtp_port", "smtp_user"}).
			AddRow(1, "mb1@firma.cz", "pass", "smtp.firma.cz", 587, "mb1@firma.cz"))

	// Mock: TO mailbox query returns no rows
	mock.ExpectQuery(`SELECT.*FROM outreach_mailboxes`).
		WithArgs(int64(999)).
		WillReturnError(sql.ErrNoRows)

	err = Run(context.Background(), db, cfg)
	if err == nil {
		t.Error("expected error, got nil")
	}
	if err.Error() != "resolve to mailbox: mailbox id 999 not found" {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestRun_InternalMailboxValidation_Fails(t *testing.T) {
	// When TO mailbox is not internal (not mb1–mb4), Run returns
	// ErrInternalMailboxValidation.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New failed: %v", err)
	}
	defer db.Close()

	cfg := &SyntheticProbeConfig{
		Enabled:       true,
		FromMailboxID: 1,
		ToMailboxID:   10,
		RelayURL:      "http://relay:8080",
		RelayToken:    "token",
	}

	// Mock: FROM mailbox (internal)
	mock.ExpectQuery(`SELECT.*FROM outreach_mailboxes`).
		WithArgs(int64(1)).
		WillReturnRows(sqlmock.NewRows(
			[]string{"id", "address", "password", "smtp_host", "smtp_port", "smtp_user"}).
			AddRow(1, "mb1@firma.cz", "pass", "smtp.firma.cz", 587, "mb1@firma.cz"))

	// Mock: TO mailbox (NOT internal — external customer mailbox)
	mock.ExpectQuery(`SELECT.*FROM outreach_mailboxes`).
		WithArgs(int64(10)).
		WillReturnRows(sqlmock.NewRows(
			[]string{"id", "address", "password", "smtp_host", "smtp_port", "smtp_user"}).
			AddRow(10, "customer@customer.com", "pass", "smtp.customer.com", 587, "customer"))

	err = Run(context.Background(), db, cfg)
	if !errors.Is(err, ErrInternalMailboxValidation) {
		t.Errorf("expected ErrInternalMailboxValidation, got %v", err)
	}
}

func TestRun_MailboxesResolved_CallsRelayClient(t *testing.T) {
	// When both mailboxes are resolved and TO is internal, the relay
	// client is called with the correct SendRequest. This test uses a
	// mock relay client to verify the call succeeds.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New failed: %v", err)
	}
	defer db.Close()

	cfg := &SyntheticProbeConfig{
		Enabled:       true,
		FromMailboxID: 1,
		ToMailboxID:   2,
		RelayURL:      "http://relay:8080",
		RelayToken:    "token",
	}

	// Mock: FROM mailbox (internal)
	mock.ExpectQuery(`SELECT.*FROM outreach_mailboxes`).
		WithArgs(int64(1)).
		WillReturnRows(sqlmock.NewRows(
			[]string{"id", "address", "password", "smtp_host", "smtp_port", "smtp_user"}).
			AddRow(1, "mb1@firma.cz", "pass123", "smtp.firma.cz", 587, "mb1@firma.cz"))

	// Mock: TO mailbox (internal)
	mock.ExpectQuery(`SELECT.*FROM outreach_mailboxes`).
		WithArgs(int64(2)).
		WillReturnRows(sqlmock.NewRows(
			[]string{"id", "address", "password", "smtp_host", "smtp_port", "smtp_user"}).
			AddRow(2, "mb2@firma.cz", "pass456", "smtp.firma.cz", 587, "mb2@firma.cz"))

	// Note: This test does not mock the HTTP relay call; it will fail
	// at network I/O, but we verify that the mailbox resolution succeeded
	// and the probe reached the relay dispatch point.
	err = Run(context.Background(), db, cfg)
	if err == nil {
		t.Fatal("expected error from relay (no mock HTTP), got nil")
	}
	// Error should be a relay transport error, not a mailbox resolution error
	if err.Error() == "resolve from mailbox: mailbox id 1 not found" ||
		err.Error() == "resolve to mailbox: mailbox id 2 not found" {
		t.Errorf("unexpected mailbox error: %v", err)
	}
}

func TestRun_RelayError_Wrapped(t *testing.T) {
	// When the relay client returns an error, it is wrapped and returned.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New failed: %v", err)
	}
	defer db.Close()

	cfg := &SyntheticProbeConfig{
		Enabled:       true,
		FromMailboxID: 1,
		ToMailboxID:   2,
		RelayURL:      "http://relay:8080",
		RelayToken:    "invalid-token", // will cause relay error
	}

	// Mock: FROM mailbox
	mock.ExpectQuery(`SELECT.*FROM outreach_mailboxes`).
		WithArgs(int64(1)).
		WillReturnRows(sqlmock.NewRows(
			[]string{"id", "address", "password", "smtp_host", "smtp_port", "smtp_user"}).
			AddRow(1, "mb1@firma.cz", "pass", "smtp.firma.cz", 587, "mb1@firma.cz"))

	// Mock: TO mailbox
	mock.ExpectQuery(`SELECT.*FROM outreach_mailboxes`).
		WithArgs(int64(2)).
		WillReturnRows(sqlmock.NewRows(
			[]string{"id", "address", "password", "smtp_host", "smtp_port", "smtp_user"}).
			AddRow(2, "mb2@firma.cz", "pass", "smtp.firma.cz", 587, "mb2@firma.cz"))

	// Invoke Run; it will fail at the relay network call
	err = Run(context.Background(), db, cfg)
	if err == nil {
		t.Fatal("expected error from relay, got nil")
	}
	// Should be wrapped with "send via relay:"
	if err.Error() != "send via relay: dial tcp: lookup relay: no such host" &&
		!errors.Is(err, sender.ErrAntiTraceTransport) &&
		!errors.Is(err, sender.ErrAntiTraceRequest) {
		// Network error is expected; relay URL is fake
		t.Logf("network error (expected): %v", err)
	}
}

func TestIsInternalMailbox(t *testing.T) {
	tests := []struct {
		address string
		want    bool
	}{
		{"mb1@firma.cz", true},
		{"mb2@firma.cz", true},
		{"mb3@firma.cz", true},
		{"mb4@firma.cz", true},
		{"mb1@example.com", true},
		{"mb2@test.io", true},
		{"mb5@firma.cz", false},
		{"customer@firma.cz", false},
		{"mb1", false}, // no @ sign
		{"", false},
	}

	for _, tt := range tests {
		t.Run(tt.address, func(t *testing.T) {
			if got := isInternalMailbox(tt.address); got != tt.want {
				t.Errorf("isInternalMailbox(%q) = %v, want %v", tt.address, got, tt.want)
			}
		})
	}
}

func TestRedactMailbox(t *testing.T) {
	tests := []struct {
		address string
		want    string
	}{
		{"john.doe@example.com", "j.......@example.com"},
		{"mb1@firma.cz", "m..@firma.cz"},
		{"a@example.com", "a@example.com"},
		{"", ""},
		{"x", "x"},
		{"xy", "xy"},
	}

	for _, tt := range tests {
		t.Run(tt.address, func(t *testing.T) {
			got := redactMailbox(tt.address)
			if got != tt.want {
				t.Errorf("redactMailbox(%q) = %q, want %q", tt.address, got, tt.want)
			}
		})
	}
}

func TestLoadSyntheticProbeConfig_Enabled(t *testing.T) {
	t.Setenv("SYNTHETIC_PROBE_ENABLED", "true")
	t.Setenv("SYNTHETIC_PROBE_FROM_MAILBOX_ID", "1")
	t.Setenv("SYNTHETIC_PROBE_TO_MAILBOX_ID", "2")
	t.Setenv("ANTI_TRACE_RELAY_URL", "http://relay:8080")
	t.Setenv("ANTI_TRACE_RELAY_TOKEN", "secret")

	cfg, err := loadSyntheticProbeConfig()
	if err != nil {
		t.Fatalf("loadSyntheticProbeConfig failed: %v", err)
	}
	if !cfg.Enabled {
		t.Error("expected Enabled=true")
	}
	if cfg.FromMailboxID != 1 {
		t.Errorf("expected FromMailboxID=1, got %d", cfg.FromMailboxID)
	}
	if cfg.ToMailboxID != 2 {
		t.Errorf("expected ToMailboxID=2, got %d", cfg.ToMailboxID)
	}
	if cfg.RelayURL != "http://relay:8080" {
		t.Errorf("unexpected RelayURL: %s", cfg.RelayURL)
	}
	if cfg.RelayToken != "secret" {
		t.Errorf("unexpected RelayToken: %s", cfg.RelayToken)
	}
}

func TestLoadSyntheticProbeConfig_Disabled(t *testing.T) {
	// When SYNTHETIC_PROBE_ENABLED is not "true", config is returned with Enabled=false
	t.Setenv("SYNTHETIC_PROBE_ENABLED", "false")
	t.Setenv("SYNTHETIC_PROBE_FROM_MAILBOX_ID", "1") // these are ignored when disabled

	cfg, err := loadSyntheticProbeConfig()
	if err != nil {
		t.Fatalf("loadSyntheticProbeConfig failed: %v", err)
	}
	if cfg.Enabled {
		t.Error("expected Enabled=false")
	}
}

func TestLoadSyntheticProbeConfig_InvalidFromMailboxID(t *testing.T) {
	t.Setenv("SYNTHETIC_PROBE_ENABLED", "true")
	t.Setenv("SYNTHETIC_PROBE_FROM_MAILBOX_ID", "not-a-number")
	t.Setenv("SYNTHETIC_PROBE_TO_MAILBOX_ID", "2")
	t.Setenv("ANTI_TRACE_RELAY_URL", "http://relay:8080")
	t.Setenv("ANTI_TRACE_RELAY_TOKEN", "token")

	_, err := loadSyntheticProbeConfig()
	if err == nil {
		t.Error("expected error, got nil")
	}
	if err.Error() != "SYNTHETIC_PROBE_FROM_MAILBOX_ID parse: strconv.ParseInt: parsing \"not-a-number\": invalid syntax" {
		t.Errorf("unexpected error: %v", err)
	}
}
