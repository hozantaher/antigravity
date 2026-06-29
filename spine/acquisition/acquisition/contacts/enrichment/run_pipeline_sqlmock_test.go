package enrich

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── RunPipeline serial path ──

func TestRunPipeline_Serial_EmptyBatch(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	p := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.1,
		Workers:          0, // serial
	})

	imported, skipped, err := p.RunPipeline(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imported != 0 {
		t.Errorf("imported = %d, want 0", imported)
	}
	if skipped != 0 {
		t.Errorf("skipped = %d, want 0", skipped)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestRunPipeline_Serial_SkipsNoEmail(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	p := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.1,
		Workers:          1, // serial (<=1)
	})

	contacts := []RawContact{
		{Name: "No Email Corp"}, // no email → skipped
	}

	imported, skipped, err := p.RunPipeline(context.Background(), db, contacts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imported != 0 {
		t.Errorf("imported = %d, want 0", imported)
	}
	if skipped != 1 {
		t.Errorf("skipped = %d, want 1", skipped)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestRunPipeline_Serial_BelowThreshold(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	p := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.99, // very high threshold
		Workers:          0,
	})

	contacts := []RawContact{
		{Email: "someone@seznam.cz", Name: "Random", Description: "Kadeřnictví"},
	}

	imported, skipped, err := p.RunPipeline(context.Background(), db, contacts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imported != 0 {
		t.Errorf("imported = %d, want 0", imported)
	}
	if skipped != 1 {
		t.Errorf("skipped = %d, want 1", skipped)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// expectProcessOneSuccess sets up sqlmock expectations for a single successful
// contact processing through processOne (domain upsert + contact upsert).
func expectProcessOneSuccess(mock sqlmock.Sqlmock, domainID, contactID int) {
	// EnsureDomain: INSERT INTO outreach_domains ... RETURNING id
	mock.ExpectQuery(`INSERT INTO outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(domainID))
	// EnsureDomain: SELECT mx_verified
	mock.ExpectQuery(`SELECT mx_verified FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"mx_verified"}).AddRow(true))
	// InsertEnriched: INSERT INTO outreach_contacts ... RETURNING id
	mock.ExpectQuery(`INSERT INTO outreach_contacts`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(contactID))
}

func TestRunPipeline_Serial_OneValidContact(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	p := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.1,
		Workers:          0,
	})

	contacts := []RawContact{
		{
			Email:       "jan@firma.cz",
			Name:        "Ing. Jan Novák",
			Description: "Výroba strojů a CNC obráběním.",
			CompanySize: "25 - 49 zaměstnanců",
		},
	}

	expectProcessOneSuccess(mock, 1, 100)

	// LinkContactToCompany not called (FirmyCzID == 0)

	imported, skipped, err := p.RunPipeline(context.Background(), db, contacts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imported != 1 {
		t.Errorf("imported = %d, want 1", imported)
	}
	if skipped != 0 {
		t.Errorf("skipped = %d, want 0", skipped)
	}
}

func TestRunPipeline_Serial_MixedContacts(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	p := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.1,
		Workers:          1,
	})

	contacts := []RawContact{
		{Email: "valid@firma.cz", Name: "Firma s.r.o.", Description: "Stroje"},
		{Name: "No Email"}, // skipped — no email
	}

	expectProcessOneSuccess(mock, 1, 100)

	imported, skipped, err := p.RunPipeline(context.Background(), db, contacts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imported != 1 {
		t.Errorf("imported = %d, want 1", imported)
	}
	if skipped != 1 {
		t.Errorf("skipped = %d, want 1", skipped)
	}
}

func TestRunPipeline_Serial_WithFirmyCzID_LinksCompany(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	p := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.1,
		Workers:          0,
	})

	contacts := []RawContact{
		{
			Email:       "jan@firma.cz",
			Name:        "Firma s.r.o.",
			Description: "Strojírenská výroba",
			FirmyCzID:   42,
		},
	}

	expectProcessOneSuccess(mock, 1, 100)

	// LinkContactToCompany: UPDATE outreach_contacts SET company_id
	mock.ExpectExec(`UPDATE outreach_contacts SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	imported, skipped, err := p.RunPipeline(context.Background(), db, contacts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imported != 1 {
		t.Errorf("imported = %d, want 1", imported)
	}
	if skipped != 0 {
		t.Errorf("skipped = %d, want 0", skipped)
	}
}

func TestRunPipeline_Serial_InsertError_SkipsContact(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	p := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.1,
		Workers:          0,
	})

	contacts := []RawContact{
		{Email: "jan@firma.cz", Name: "Firma", Description: "Stroje"},
	}

	// EnsureDomain succeeds
	mock.ExpectQuery(`INSERT INTO outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectQuery(`SELECT mx_verified FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"mx_verified"}).AddRow(true))

	// InsertEnriched fails all 3 retry attempts
	mock.ExpectQuery(`INSERT INTO outreach_contacts`).
		WillReturnError(errEnrich("insert failed"))
	mock.ExpectQuery(`INSERT INTO outreach_contacts`).
		WillReturnError(errEnrich("insert failed"))
	mock.ExpectQuery(`INSERT INTO outreach_contacts`).
		WillReturnError(errEnrich("insert failed"))

	imported, skipped, err := p.RunPipeline(context.Background(), db, contacts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imported != 0 {
		t.Errorf("imported = %d, want 0", imported)
	}
	if skipped != 1 {
		t.Errorf("skipped = %d, want 1", skipped)
	}
}

// ── RunPipeline parallel path ──

func TestRunPipeline_Parallel_EmptyBatch(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	p := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.1,
		Workers:          4,
	})

	imported, skipped, err := p.RunPipeline(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imported != 0 {
		t.Errorf("imported = %d, want 0", imported)
	}
	if skipped != 0 {
		t.Errorf("skipped = %d, want 0", skipped)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestRunPipeline_Parallel_SkipsNoEmail(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	p := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.1,
		Workers:          2,
	})

	contacts := []RawContact{
		{Name: "No Email 1"},
		{Name: "No Email 2"},
	}

	imported, skipped, err := p.RunPipeline(context.Background(), db, contacts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imported != 0 {
		t.Errorf("imported = %d, want 0", imported)
	}
	if skipped != 2 {
		t.Errorf("skipped = %d, want 2", skipped)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestRunPipeline_Parallel_BelowThreshold(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	p := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.99,
		Workers:          3,
	})

	contacts := []RawContact{
		{Email: "a@seznam.cz", Name: "Test", Description: "Kadeřnictví"},
		{Email: "b@seznam.cz", Name: "Test2", Description: "Kosmetika"},
	}

	imported, skipped, err := p.RunPipeline(context.Background(), db, contacts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imported != 0 {
		t.Errorf("imported = %d, want 0", imported)
	}
	if skipped != 2 {
		t.Errorf("skipped = %d, want 2", skipped)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestRunPipeline_Parallel_ContextCancelled(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	p := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.1,
		Workers:          4,
	})

	// With a cancelled context, the semaphore select should break early.
	contacts := []RawContact{
		{Email: "a@firma.cz", Name: "A"},
		{Email: "b@firma.cz", Name: "B"},
	}

	// Should not panic and should return reasonable values.
	imported, skipped, err := p.RunPipeline(ctx, db, contacts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// With cancelled context, some contacts may be skipped or not processed.
	total := imported + skipped
	if total > len(contacts) {
		t.Errorf("processed more than input: imported=%d skipped=%d", imported, skipped)
	}
}

func TestRunPipeline_Serial_WithHoneypotSignals(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	p := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.01, // very low to let role-based through
		Workers:          0,
	})

	contacts := []RawContact{
		{
			Email:       "admin@firma.cz", // role-based → honeypot signal
			Name:        "Firma s.r.o.",
			Description: "Strojírenská výroba",
		},
	}

	expectProcessOneSuccess(mock, 1, 200)

	// InsertHoneypotSignals: INSERT INTO outreach_honeypot_signals
	mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	imported, skipped, err := p.RunPipeline(context.Background(), db, contacts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imported != 1 {
		t.Errorf("imported = %d, want 1", imported)
	}
	if skipped != 0 {
		t.Errorf("skipped = %d, want 0", skipped)
	}
}

func TestRunPipeline_Serial_DomainEnsureError_ContinuesProcessing(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	p := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.1,
		Workers:          0,
	})

	contacts := []RawContact{
		{Email: "jan@firma.cz", Name: "Firma", Description: "Stroje"},
	}

	// EnsureDomain fails all 3 retry attempts
	mock.ExpectQuery(`INSERT INTO outreach_domains`).
		WillReturnError(errEnrich("domain insert failed"))
	mock.ExpectQuery(`INSERT INTO outreach_domains`).
		WillReturnError(errEnrich("domain insert failed"))
	mock.ExpectQuery(`INSERT INTO outreach_domains`).
		WillReturnError(errEnrich("domain insert failed"))

	// InsertEnriched still succeeds (domainID = 0)
	mock.ExpectQuery(`INSERT INTO outreach_contacts`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(100))

	imported, skipped, err := p.RunPipeline(context.Background(), db, contacts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imported != 1 {
		t.Errorf("imported = %d, want 1", imported)
	}
	if skipped != 0 {
		t.Errorf("skipped = %d, want 0", skipped)
	}
}
