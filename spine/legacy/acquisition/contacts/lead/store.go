package lead

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Lead represents a tracked B2B sales lead linking a contact to a campaign.
type Lead struct {
	ID         int64
	ContactID  int64
	CampaignID int64
	Status     string
	Source     string
	Notes      string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// Store manages lead records in the database.
type Store struct{ db *sql.DB }

// NewStore creates a new lead store.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// Create inserts a lead, or returns the existing id on (contact_id, campaign_id) conflict.
func (s *Store) Create(ctx context.Context, contactID, campaignID int64, source, notes string) (int64, error) {
	var id int64
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO leads (contact_id, campaign_id, source, notes)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (contact_id, campaign_id) DO UPDATE
			SET source     = EXCLUDED.source,
			    notes      = EXCLUDED.notes,
			    updated_at = now()
		RETURNING id
	`, contactID, campaignID, source, notes).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("lead create: %w", err)
	}
	return id, nil
}

// Get returns a lead by ID, or an error if not found.
func (s *Store) Get(ctx context.Context, id int64) (*Lead, error) {
	var l Lead
	err := s.db.QueryRowContext(ctx, `
		SELECT id, contact_id, campaign_id, status, source, notes, created_at, updated_at
		FROM leads WHERE id = $1
	`, id).Scan(
		&l.ID, &l.ContactID, &l.CampaignID,
		&l.Status, &l.Source, &l.Notes,
		&l.CreatedAt, &l.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("lead get: %w", err)
	}
	return &l, nil
}

// List returns all leads ordered by created_at descending.
func (s *Store) List(ctx context.Context) ([]Lead, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, contact_id, campaign_id, status, source, notes, created_at, updated_at
		FROM leads ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("lead list: %w", err)
	}
	defer rows.Close()

	var leads []Lead
	for rows.Next() {
		var l Lead
		if err := rows.Scan(
			&l.ID, &l.ContactID, &l.CampaignID,
			&l.Status, &l.Source, &l.Notes,
			&l.CreatedAt, &l.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("lead list scan: %w", err)
		}
		leads = append(leads, l)
	}
	return leads, rows.Err()
}

// Update sets the status and notes of a lead by ID.
func (s *Store) Update(ctx context.Context, id int64, status, notes string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE leads SET status=$1, notes=$2, updated_at=now() WHERE id=$3
	`, status, notes, id)
	if err != nil {
		return fmt.Errorf("lead update: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("lead %d not found", id)
	}
	return nil
}

// Delete removes a lead by ID.
func (s *Store) Delete(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM leads WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("lead delete: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("lead %d not found", id)
	}
	return nil
}
