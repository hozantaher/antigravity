package contact

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// DB abstracts database operations for testability.
type DB interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	BeginTx(ctx context.Context, opts *sql.TxOptions) (*sql.Tx, error)
}

type Store struct {
	db DB
}

func NewStore(db DB) *Store {
	return &Store{db: db}
}

func (s *Store) Create(ctx context.Context, c *Contact) error {
	c.EmailHash = hashEmail(c.Email)
	c.CreatedAt = time.Now()
	c.UpdatedAt = time.Now()

	_, err := s.db.ExecContext(ctx,
		`INSERT INTO contacts (email, email_hash, first_name, last_name, company_name, ico, region, industry, company_size, score, status, source)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		 ON CONFLICT (email_hash) DO NOTHING`,
		c.Email, c.EmailHash, c.FirstName, c.LastName, c.CompanyName,
		c.ICO, c.Region, c.Industry, c.CompanySize, c.Score, c.Status, c.Source,
	)
	return err
}

// ImportResult is returned by BulkImport with per-email detail.
type ImportResult struct {
	Imported int
	Skipped  []string // emails skipped due to duplicate
}

func (s *Store) BulkImport(ctx context.Context, contacts []Contact) (*ImportResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx,
		`INSERT INTO contacts (email, email_hash, first_name, last_name, company_name, ico, region, industry, company_size, score, status, source)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		 ON CONFLICT (email_hash) DO NOTHING`)
	if err != nil {
		return nil, err
	}
	defer stmt.Close()

	result := &ImportResult{}
	for _, c := range contacts {
		hash := hashEmail(c.Email)
		res, err := stmt.ExecContext(ctx,
			c.Email, hash, c.FirstName, c.LastName, c.CompanyName,
			c.ICO, c.Region, c.Industry, c.CompanySize, c.Score, StatusNew, c.Source,
		)
		if err != nil {
			return result, err
		}
		rows, _ := res.RowsAffected()
		if rows > 0 {
			result.Imported++
		} else {
			result.Skipped = append(result.Skipped, c.Email)
		}
	}

	return result, tx.Commit()
}

func (s *Store) FindByID(ctx context.Context, id int64) (*Contact, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, email, email_hash, first_name, last_name, company_name, ico,
		        region, industry, company_size, score, status, validation_result,
		        source, imported_at, validated_at, last_contacted, created_at, updated_at
		 FROM contacts WHERE id = $1`, id)
	return scanContact(row)
}

func (s *Store) FindByEmail(ctx context.Context, email string) (*Contact, error) {
	hash := hashEmail(email)
	row := s.db.QueryRowContext(ctx,
		`SELECT id, email, email_hash, first_name, last_name, company_name, ico,
		        region, industry, company_size, score, status, validation_result,
		        source, imported_at, validated_at, last_contacted, created_at, updated_at
		 FROM contacts WHERE email_hash = $1`, hash)
	return scanContact(row)
}

func (s *Store) UpdateStatus(ctx context.Context, id int64, status Status) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE contacts SET status = $1, updated_at = now() WHERE id = $2`,
		status, id)
	return err
}

func (s *Store) UpdateValidation(ctx context.Context, id int64, result *ValidationResult) error {
	data, err := json.Marshal(result)
	if err != nil {
		return err
	}
	status := StatusValid
	if !result.SyntaxValid || !result.MXExists {
		status = StatusInvalid
	}
	if result.IsDisposable {
		status = StatusInvalid
	}
	_, err = s.db.ExecContext(ctx,
		`UPDATE contacts SET validation_result = $1, status = $2, validated_at = now(), updated_at = now() WHERE id = $3`,
		data, status, id)
	return err
}

func (s *Store) FindBySegment(ctx context.Context, seg SegmentFilter, limit, offset int) ([]Contact, error) {
	query := `SELECT id, email, email_hash, first_name, last_name, company_name, ico,
	                  region, industry, company_size, score, status, validation_result,
	                  source, imported_at, validated_at, last_contacted, created_at, updated_at
	           FROM contacts WHERE 1=1`
	var args []any
	argIdx := 1

	if len(seg.Statuses) > 0 {
		placeholders := make([]string, len(seg.Statuses))
		for i, s := range seg.Statuses {
			placeholders[i] = fmt.Sprintf("$%d", argIdx)
			args = append(args, s)
			argIdx++
		}
		query += " AND status IN (" + strings.Join(placeholders, ",") + ")"
	}
	if len(seg.Regions) > 0 {
		placeholders := make([]string, len(seg.Regions))
		for i, r := range seg.Regions {
			placeholders[i] = fmt.Sprintf("$%d", argIdx)
			args = append(args, r)
			argIdx++
		}
		query += " AND region IN (" + strings.Join(placeholders, ",") + ")"
	}
	if seg.MinScore != nil {
		query += fmt.Sprintf(" AND score >= $%d", argIdx)
		args = append(args, *seg.MinScore)
		argIdx++
	}

	query += fmt.Sprintf(" ORDER BY score DESC, id LIMIT $%d OFFSET $%d", argIdx, argIdx+1)
	args = append(args, limit, offset)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var contacts []Contact
	for rows.Next() {
		c, err := scanContactRows(rows)
		if err != nil {
			return nil, err
		}
		contacts = append(contacts, *c)
	}
	return contacts, rows.Err()
}

func (s *Store) CountByStatus(ctx context.Context) (map[Status]int, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT status, COUNT(*) FROM contacts GROUP BY status`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[Status]int)
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return nil, err
		}
		result[Status(status)] = count
	}
	return result, rows.Err()
}

func hashEmail(email string) string {
	h := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return hex.EncodeToString(h[:])
}

func scanContact(row *sql.Row) (*Contact, error) {
	var c Contact
	var validationJSON sql.NullString
	var validatedAt, lastContacted sql.NullTime

	err := row.Scan(
		&c.ID, &c.Email, &c.EmailHash, &c.FirstName, &c.LastName,
		&c.CompanyName, &c.ICO, &c.Region, &c.Industry, &c.CompanySize,
		&c.Score, &c.Status, &validationJSON,
		&c.Source, &c.ImportedAt, &validatedAt, &lastContacted,
		&c.CreatedAt, &c.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}

	if validationJSON.Valid {
		var vr ValidationResult
		json.Unmarshal([]byte(validationJSON.String), &vr)
		c.ValidationResult = &vr
	}
	if validatedAt.Valid { c.ValidatedAt = &validatedAt.Time }
	if lastContacted.Valid { c.LastContacted = &lastContacted.Time }

	return &c, nil
}

func scanContactRows(rows *sql.Rows) (*Contact, error) {
	var c Contact
	var validationJSON sql.NullString
	var validatedAt, lastContacted sql.NullTime

	err := rows.Scan(
		&c.ID, &c.Email, &c.EmailHash, &c.FirstName, &c.LastName,
		&c.CompanyName, &c.ICO, &c.Region, &c.Industry, &c.CompanySize,
		&c.Score, &c.Status, &validationJSON,
		&c.Source, &c.ImportedAt, &validatedAt, &lastContacted,
		&c.CreatedAt, &c.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}

	if validationJSON.Valid {
		var vr ValidationResult
		json.Unmarshal([]byte(validationJSON.String), &vr)
		c.ValidationResult = &vr
	}
	if validatedAt.Valid { c.ValidatedAt = &validatedAt.Time }
	if lastContacted.Valid { c.LastContacted = &lastContacted.Time }

	return &c, nil
}
