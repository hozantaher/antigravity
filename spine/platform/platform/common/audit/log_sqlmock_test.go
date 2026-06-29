package audit

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── Recent via sqlmock ──

func TestRecent_WithRows(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	now := time.Now()
	mock.ExpectQuery(`SELECT id, action, actor, entity_type, entity_id, details, created_at`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "action", "actor", "entity_type", "entity_id", "details", "created_at",
		}).
			AddRow(1, ActionCampaignCreated, "cli", "campaign", "42", `{"contacts":100}`, now).
			AddRow(2, ActionContactSuppress, "admin", "contact", "7", `{}`, now))

	entries, err := Recent(context.Background(), db, 10)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(entries) != 2 { t.Fatalf("expected 2 entries, got %d", len(entries)) }
	if entries[0].ID != 1 { t.Error("first entry ID") }
	if entries[0].Action != ActionCampaignCreated { t.Error("first entry action") }
	if entries[0].Actor != "cli" { t.Error("first entry actor") }
	if entries[0].Details["contacts"] != float64(100) {
		t.Errorf("first entry details contacts: %v", entries[0].Details["contacts"])
	}
}

func TestRecent_EmptyResult(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT id, action, actor, entity_type, entity_id, details, created_at`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "action", "actor", "entity_type", "entity_id", "details", "created_at",
		}))

	entries, err := Recent(context.Background(), db, 10)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(entries) != 0 { t.Errorf("expected 0 entries, got %d", len(entries)) }
}

func TestRecent_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT id, action, actor, entity_type, entity_id, details, created_at`).
		WillReturnError(errAudit("db error"))

	_, err = Recent(context.Background(), db, 10)
	if err == nil { t.Error("expected error from QueryContext") }
}

func TestRecent_NullDetails(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	now := time.Now()
	mock.ExpectQuery(`SELECT id, action, actor, entity_type, entity_id, details, created_at`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "action", "actor", "entity_type", "entity_id", "details", "created_at",
		}).
			AddRow(1, "test.action", "system", "entity", "1", nil, now))

	entries, err := Recent(context.Background(), db, 5)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(entries) != 1 { t.Fatalf("expected 1 entry, got %d", len(entries)) }
	// Null details → empty map (no unmarshal)
	if entries[0].Details != nil {
		t.Errorf("null details should be nil, got %v", entries[0].Details)
	}
}

// ── Log via sqlmock ──

func TestLog_WithDB_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	// Should not panic or return error (Log swallows errors)
	Log(context.Background(), db, ActionCampaignCreated, "cli", "campaign", "42",
		map[string]any{"contacts": 100})

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations not met: %v", err)
	}
}

func TestLog_WithDB_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnError(errAudit("insert failed"))

	// Should not panic — errors are logged only
	Log(context.Background(), db, "test.action", "system", "entity", "1", nil)
}

func TestLog_WithDB_DefaultsActor(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	// Empty actor → defaults to "cli"
	Log(context.Background(), db, "action", "", "type", "id", nil)
}

// TestLog_WithDB_DetailsEncodedInSQL verifies that non-empty details are
// actually JSON-encoded and passed as the INSERT arg — catching the
// `len(details) > 0 → < 0` mutation which drops non-empty details to "{}".
// Uses a single-key map to get deterministic JSON output.
func TestLog_WithDB_DetailsEncodedInSQL(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Single-key map: json.Marshal always produces {"enrolled":42}
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WithArgs(
			ActionCampaignCreated,
			"cli",
			"campaign",
			"99",
			`{"enrolled":42}`, // must NOT be "{}"
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	Log(context.Background(), db, ActionCampaignCreated, "cli", "campaign", "99",
		map[string]any{"enrolled": 42})

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("details JSON not passed to INSERT: %v", err)
	}
}

// TestLog_WithDB_EmptyDetailsPassedAsEmptyJSON verifies that an empty details
// map produces `{}` as the SQL arg (not a nil or non-JSON value).
func TestLog_WithDB_EmptyDetailsPassedAsEmptyJSON(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WithArgs(
			"action", "cli", "entity", "id", "{}",
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	Log(context.Background(), db, "action", "cli", "entity", "id", map[string]any{})

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("empty details should produce {}: %v", err)
	}
}

// TestRecent_ValidEmptyStringDetailsProducesNilMap verifies the
// `detailsRaw.Valid && detailsRaw.String != ""` guard — catching the
// `&& → ||` mutation which would try to unmarshal an empty string.
// When Valid=true but String="", Details should remain nil (not an empty map).
func TestRecent_ValidEmptyStringDetailsProducesNilMap(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	now := time.Now()
	mock.ExpectQuery(`SELECT id, action, actor, entity_type, entity_id, details, created_at`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "action", "actor", "entity_type", "entity_id", "details", "created_at",
		}).
			AddRow(1, "test.action", "cli", "campaign", "1", "", now))

	entries, err := Recent(context.Background(), db, 5)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(entries) != 1 { t.Fatalf("expected 1 entry, got %d", len(entries)) }
	if entries[0].Details != nil {
		t.Errorf("empty string details should yield nil map, got %v", entries[0].Details)
	}
}

// TestRecent_ScanError_ReturnsError verifies that a scan failure (wrong column
// type) causes Recent to return an error rather than silently skip the row.
func TestRecent_ScanError_ReturnsError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// "not-a-time-value" cannot be scanned into time.Time → scan error.
	mock.ExpectQuery(`SELECT id, action, actor, entity_type, entity_id, details, created_at`).
		WillReturnRows(
			sqlmock.NewRows([]string{"id", "action", "actor", "entity_type", "entity_id", "details", "created_at"}).
				AddRow("", "", "", "", "", "", "not-a-time-value"),
		)

	_, err = Recent(context.Background(), db, 10)
	if err == nil {
		t.Error("expected error from scan failure, got nil")
	}
}

// TestRecent_ZeroLimit_NoPanic confirms Recent(ctx, db, 0) does not panic.
func TestRecent_ZeroLimit_NoPanic(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, action, actor, entity_type, entity_id, details, created_at`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "action", "actor", "entity_type", "entity_id", "details", "created_at",
		}))

	entries, err := Recent(context.Background(), db, 0)
	if err != nil {
		t.Fatalf("unexpected error with limit=0: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected 0 entries with limit=0, got %d", len(entries))
	}
}

// TestRecent_NegativeLimit_NoPanic confirms Recent(ctx, db, -1) does not panic.
func TestRecent_NegativeLimit_NoPanic(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, action, actor, entity_type, entity_id, details, created_at`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "action", "actor", "entity_type", "entity_id", "details", "created_at",
		}))

	entries, err := Recent(context.Background(), db, -1)
	if err != nil {
		t.Fatalf("unexpected error with limit=-1: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected 0 entries with limit=-1, got %d", len(entries))
	}
}

type errAudit string
func (e errAudit) Error() string { return string(e) }
