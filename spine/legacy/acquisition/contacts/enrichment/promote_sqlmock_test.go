package enrich

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── PromoteCompanies via sqlmock ──

func TestPromoteCompanies_EmptyResult(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Empty first batch → loop ends
	mock.ExpectQuery(`SELECT id, firmy_cz_id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "firmy_cz_id", "ico", "name", "email",
			"telephone", "website",
			"address_locality", "street_address", "postal_code",
			"velikost_firmy", "pravni_forma",
			"description",
			"sector_tags", "sector_confidence",
			"region_normalized", "icp_score", "category_path",
		}))

	result, err := PromoteCompanies(context.Background(), db, PromoteConfig{BatchSize: 100})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Queried != 0 { t.Errorf("Total = %d, want 0", result.Queried) }
}

func TestPromoteCompanies_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT id, firmy_cz_id`).
		WillReturnError(errEnrich("query failed"))

	_, err = PromoteCompanies(context.Background(), db, PromoteConfig{BatchSize: 100})
	if err == nil { t.Error("expected error") }
}

func TestPromoteCompanies_DefaultsApplied(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Should apply defaults: ICPTiers=["ideal","good"], EmailStatuses=["valid"]
	mock.ExpectQuery(`SELECT id, firmy_cz_id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "firmy_cz_id", "ico", "name", "email",
			"telephone", "website",
			"address_locality", "street_address", "postal_code",
			"velikost_firmy", "pravni_forma",
			"description",
			"sector_tags", "sector_confidence",
			"region_normalized", "icp_score", "category_path",
		}))

	// Zero config → defaults applied
	result, err := PromoteCompanies(context.Background(), db, PromoteConfig{})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result == nil { t.Fatal("result nil") }
}

func TestPromoteCompanies_WithRows(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// First batch with 1 row (< batchSize so loop ends)
	mock.ExpectQuery(`SELECT id, firmy_cz_id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "firmy_cz_id", "ico", "name", "email",
			"telephone", "website",
			"address_locality", "street_address", "postal_code",
			"velikost_firmy", "pravni_forma",
			"description",
			"sector_tags", "sector_confidence",
			"region_normalized", "icp_score", "category_path",
		}).AddRow(
			1, 12345, "12345678", "Firma s.r.o.", "info@firma.cz",
			"+420123456", "https://firma.cz",
			"Praha", "Václavské nám. 1", "110 00",
			"20 - 24 zaměstnanci", "111",
			"Výrobní firma",
			"{machinery,metalwork}", 0.85,
			"Praha", 0.82, "",
		))

	// EnsureDomain: INSERT INTO outreach_domains ... RETURNING id
	mock.ExpectQuery(`INSERT INTO outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(5))

	// INSERT INTO outreach_contacts ... RETURNING id
	mock.ExpectQuery(`INSERT INTO outreach_contacts`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(100))

	// Second query (next batch) → empty, ends loop
	mock.ExpectQuery(`SELECT id, firmy_cz_id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "firmy_cz_id", "ico", "name", "email",
			"telephone", "website",
			"address_locality", "street_address", "postal_code",
			"velikost_firmy", "pravni_forma",
			"description",
			"sector_tags", "sector_confidence",
			"region_normalized", "icp_score", "category_path",
		}))

	result, err := PromoteCompanies(context.Background(), db, PromoteConfig{BatchSize: 100})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Queried != 1 { t.Errorf("Queried = %d, want 1", result.Queried) }
}
