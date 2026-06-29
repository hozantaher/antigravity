package segment

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"
)

// Segment is a named audience definition with a compound filter query.
type Segment struct {
	ID           int64
	Name         string
	Description  string
	Query        Query
	CompanyCount int
	LastBuiltAt  *time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// Store manages segment records in the database.
type Store struct{ db *sql.DB }

// NewStore creates a new segment store.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// Create inserts a new segment and returns its ID.
func (s *Store) Create(ctx context.Context, name, description string, q Query) (int64, error) {
	raw, err := json.Marshal(q)
	if err != nil {
		return 0, fmt.Errorf("segment create marshal: %w", err)
	}
	var id int64
	err = s.db.QueryRowContext(ctx, `
		INSERT INTO segments (name, description, query)
		VALUES ($1, $2, $3)
		ON CONFLICT (name) DO UPDATE
			SET description = EXCLUDED.description,
			    query       = EXCLUDED.query,
			    updated_at  = now()
		RETURNING id
	`, name, description, string(raw)).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("segment create: %w", err)
	}
	return id, nil
}

// Update modifies an existing segment's name, description, and query.
func (s *Store) Update(ctx context.Context, id int64, name, description string, q Query) error {
	raw, err := json.Marshal(q)
	if err != nil {
		return fmt.Errorf("segment update marshal: %w", err)
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE segments SET name=$1, description=$2, query=$3, updated_at=now()
		WHERE id=$4`, name, description, string(raw), id)
	if err != nil {
		return fmt.Errorf("segment update: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("segment %d not found", id)
	}
	return nil
}

// Delete removes a segment by ID.
func (s *Store) Delete(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM segments WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("segment delete: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("segment %d not found", id)
	}
	return nil
}

// Get returns a segment by ID.
func (s *Store) Get(ctx context.Context, id int64) (*Segment, error) {
	return s.scan(s.db.QueryRowContext(ctx, `
		SELECT id, name, COALESCE(description,''), query,
		       company_count, last_built_at, created_at, updated_at
		FROM segments WHERE id = $1
	`, id))
}

// GetByName returns a segment by its unique name.
func (s *Store) GetByName(ctx context.Context, name string) (*Segment, error) {
	return s.scan(s.db.QueryRowContext(ctx, `
		SELECT id, name, COALESCE(description,''), query,
		       company_count, last_built_at, created_at, updated_at
		FROM segments WHERE name = $1
	`, name))
}

// List returns all segments ordered by name.
func (s *Store) List(ctx context.Context) ([]Segment, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, COALESCE(description,''), query,
		       company_count, last_built_at, created_at, updated_at
		FROM segments ORDER BY name
	`)
	if err != nil {
		return nil, fmt.Errorf("segment list: %w", err)
	}
	defer rows.Close()

	var segs []Segment
	for rows.Next() {
		seg, err := s.scanRow(rows)
		if err != nil {
			return nil, err
		}
		segs = append(segs, *seg)
	}
	return segs, rows.Err()
}

// BuildMemberships rebuilds segment_memberships for the given segment.
// Steps: DELETE old members → INSERT matching company IDs → UPDATE count + last_built_at.
// Returns count of companies matched.
func (s *Store) BuildMemberships(ctx context.Context, seg *Segment) (int, error) {
	whereClause, args, err := BuildSQL(seg.Query, 1)
	if err != nil {
		return 0, fmt.Errorf("segment %q build sql: %w", seg.Name, err)
	}

	// Always restrict to eligible companies only.
	fullWhere := "exclusion_status = 'pass' AND (" + whereClause + ")"

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("segment tx begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	// Delete stale memberships for this segment.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM segment_memberships WHERE segment_id = $1`, seg.ID,
	); err != nil {
		return 0, fmt.Errorf("segment delete memberships: %w", err)
	}

	// Insert matching companies.
	insertQuery := fmt.Sprintf(`
		INSERT INTO segment_memberships (segment_id, company_id)
		SELECT $1, id FROM companies WHERE %s
	`, fullWhere)

	// Prepend segment_id as the first arg.
	insertArgs := append([]any{seg.ID}, args...)
	res, err := tx.ExecContext(ctx, insertQuery, insertArgs...)
	if err != nil {
		return 0, fmt.Errorf("segment insert memberships: %w", err)
	}
	n, _ := res.RowsAffected()

	// Update segment stats.
	if _, err := tx.ExecContext(ctx, `
		UPDATE segments SET company_count = $2, last_built_at = now(), updated_at = now()
		WHERE id = $1
	`, seg.ID, int(n)); err != nil {
		return 0, fmt.Errorf("segment update stats: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("segment commit: %w", err)
	}
	return int(n), nil
}

// RefreshAll rebuilds memberships for all segments.
// Called by the intelligence loop every 6h.
// Returns total companies matched across all segments.
func (s *Store) RefreshAll(ctx context.Context) (int, error) {
	segs, err := s.List(ctx)
	if err != nil {
		return 0, err
	}
	total := 0
	for i := range segs {
		n, err := s.BuildMemberships(ctx, &segs[i])
		if err != nil {
			slog.Warn("segment refresh failed", "name", segs[i].Name, "error", err)
			continue
		}
		total += n
		slog.Info("segment refreshed", "name", segs[i].Name, "companies", n)
	}
	return total, nil
}

// scan reads a single segment from a QueryRow result.
func (s *Store) scan(row *sql.Row) (*Segment, error) {
	var seg Segment
	var rawQuery string
	var lastBuilt sql.NullTime
	if err := row.Scan(
		&seg.ID, &seg.Name, &seg.Description, &rawQuery,
		&seg.CompanyCount, &lastBuilt, &seg.CreatedAt, &seg.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("segment scan: %w", err)
	}
	if lastBuilt.Valid {
		seg.LastBuiltAt = &lastBuilt.Time
	}
	if err := json.Unmarshal([]byte(rawQuery), &seg.Query); err != nil {
		return nil, fmt.Errorf("segment parse query: %w", err)
	}
	return &seg, nil
}

// scanRow reads a single segment from a *sql.Rows result.
func (s *Store) scanRow(rows *sql.Rows) (*Segment, error) {
	var seg Segment
	var rawQuery string
	var lastBuilt sql.NullTime
	if err := rows.Scan(
		&seg.ID, &seg.Name, &seg.Description, &rawQuery,
		&seg.CompanyCount, &lastBuilt, &seg.CreatedAt, &seg.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("segment scan row: %w", err)
	}
	if lastBuilt.Valid {
		seg.LastBuiltAt = &lastBuilt.Time
	}
	if err := json.Unmarshal([]byte(rawQuery), &seg.Query); err != nil {
		return nil, fmt.Errorf("segment parse query: %w", err)
	}
	return &seg, nil
}
