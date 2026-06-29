package main

import (
	"context"
	"testing"

	"campaigns/sender"
	"common/config"
	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── loadPersonaFromDB: success path ──

func TestLoadPersonaFromDB_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT name`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "role", "company", "phone", "email", "website", "region"}).
			AddRow("Jan Novák", "Sales", "ACME", "+420111222333", "jan@acme.cz", "https://acme.cz", "Praha"))

	fallback := config.PersonaConfig{Name: "Default"}
	p := loadPersonaFromDB(db, "jan@acme.cz", fallback)
	if p.Name != "Jan Novák" {
		t.Errorf("Name = %q, want Jan Novák", p.Name)
	}
	if p.Role != "Sales" {
		t.Errorf("Role = %q, want Sales", p.Role)
	}
}

func TestLoadPersonaFromDB_FallsBackOnError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT name`).WillReturnRows(sqlmock.NewRows([]string{"name"}))

	fallback := config.PersonaConfig{Name: "Fallback", Company: "FallbackCo"}
	p := loadPersonaFromDB(db, "nobody@x.cz", fallback)
	if p.Name != "Fallback" {
		t.Errorf("fallback: Name = %q, want Fallback", p.Name)
	}
}

func TestLoadPersonaFromDB_FillsFromFallback(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// company and website empty → fill from fallback
	mock.ExpectQuery(`SELECT name`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "role", "company", "phone", "email", "website", "region"}).
			AddRow("Jan", "Sales", "", "+420", "jan@x.cz", "", "Praha"))

	fallback := config.PersonaConfig{Company: "FallbackCo", Website: "https://fallback.cz"}
	p := loadPersonaFromDB(db, "jan@x.cz", fallback)
	if p.Company != "FallbackCo" {
		t.Errorf("Company = %q, want FallbackCo (filled from fallback)", p.Company)
	}
	if p.Website != "https://fallback.cz" {
		t.Errorf("Website = %q, want https://fallback.cz", p.Website)
	}
}

// ── recordOutboundToThread: error paths ──

func TestRecordOutboundToThread_ContactLookupError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT oc.id FROM outreach_contacts`).
		WillReturnRows(sqlmock.NewRows([]string{"id"})) // no rows → sql.ErrNoRows

	req := sender.SendRequest{ContactID: 99}
	result := sender.SendResult{}
	err = recordOutboundToThread(context.Background(), db, nil, req, result)
	if err == nil {
		t.Error("expected error when contact lookup fails")
	}
}

// ── buildPreSendHook: SkipHumanize path ──

func TestBuildPreSendHook_SkipHumanize(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	hook := buildPreSendHook(db, config.PersonaConfig{})
	req := &sender.SendRequest{
		Subject:      "Original",
		BodyPlain:    "Original body",
		SkipHumanize: true,
	}
	mb := config.MailboxConfig{Address: "test@test.cz"}
	hook(mb, req)

	// SkipHumanize=true → req unchanged
	if req.Subject != "Original" {
		t.Errorf("Subject changed despite SkipHumanize: %q", req.Subject)
	}
}

func TestBuildPreSendHook_AppliesHumanize(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// loadPersonaFromDB → fallback (no persona found)
	mock.ExpectQuery(`SELECT name`).WillReturnRows(sqlmock.NewRows([]string{"name"}))

	hook := buildPreSendHook(db, config.PersonaConfig{Name: "Test"})
	req := &sender.SendRequest{
		Subject:   "Hello",
		BodyPlain: "Body text",
		Step:      0,
	}
	mb := config.MailboxConfig{Address: "sender@test.cz"}
	hook(mb, req)

	// humanize may modify or keep the content; we just verify no panic
	if req.Subject == "" {
		t.Error("subject should not be empty after humanize")
	}
}

// ── buildSendEngine: basic construction ──

func TestBuildSendEngine_BasicConstruction(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	cfg := &config.Config{
		Mailboxes: []config.MailboxConfig{{
			Address:    "test@test.cz",
			SMTPHost:   "smtp.test.cz",
			SMTPPort:   587,
			Username:   "test@test.cz",
			Password:   "pass",
			DailyLimit: 100,
		}},
		Sending: config.SendingConfig{
			WindowStart:      0,
			WindowEnd:        24,
			MaxPerDomainHour: 1000,
		},
		Safety: config.SafetyConfig{MaxBounceRate: 0.5},
	}

	engine := buildSendEngine(cfg, db)
	if engine == nil {
		t.Fatal("expected non-nil engine from buildSendEngine")
	}
}
