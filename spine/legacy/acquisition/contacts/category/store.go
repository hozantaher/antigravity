package category

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Category represents one node in the firmy.cz category tree.
type Category struct {
	ID           int
	Path         string
	Slug         string
	Name         string
	ParentPath   string
	Depth        int
	CompanyCount int
	UpdatedAt    time.Time
}

// Store provides read/write access to the categories table.
type Store struct {
	db *sql.DB
}

// NewStore creates a category store.
func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// ListRoots returns all root categories (depth = 0), ordered by company_count desc.
func (s *Store) ListRoots(ctx context.Context) ([]Category, error) {
	return s.query(ctx,
		`SELECT id, path, slug, name, COALESCE(parent_path,''), depth, company_count, updated_at
		 FROM categories WHERE depth = 0 ORDER BY company_count DESC`)
}

// ListChildren returns immediate children of a parent path.
func (s *Store) ListChildren(ctx context.Context, parentPath string) ([]Category, error) {
	return s.query(ctx,
		`SELECT id, path, slug, name, COALESCE(parent_path,''), depth, company_count, updated_at
		 FROM categories WHERE parent_path = $1 ORDER BY company_count DESC`,
		parentPath)
}

// FindBySlug returns a single category by its slug.
func (s *Store) FindBySlug(ctx context.Context, slug string) (*Category, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, path, slug, name, COALESCE(parent_path,''), depth, company_count, updated_at
		 FROM categories WHERE slug = $1`, slug)
	var c Category
	err := row.Scan(&c.ID, &c.Path, &c.Slug, &c.Name, &c.ParentPath,
		&c.Depth, &c.CompanyCount, &c.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &c, err
}

// FindByPath returns a single category by its exact path.
func (s *Store) FindByPath(ctx context.Context, path string) (*Category, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, path, slug, name, COALESCE(parent_path,''), depth, company_count, updated_at
		 FROM categories WHERE path = $1`, path)
	var c Category
	err := row.Scan(&c.ID, &c.Path, &c.Slug, &c.Name, &c.ParentPath,
		&c.Depth, &c.CompanyCount, &c.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &c, err
}

// Search returns categories whose path contains the query string (case-insensitive).
func (s *Store) Search(ctx context.Context, q string, limit int) ([]Category, error) {
	if limit <= 0 {
		limit = 50
	}
	return s.query(ctx,
		`SELECT id, path, slug, name, COALESCE(parent_path,''), depth, company_count, updated_at
		 FROM categories
		 WHERE path ILIKE $1
		 ORDER BY company_count DESC
		 LIMIT $2`,
		"%"+q+"%", limit)
}

// CompanyRow is a lightweight projection of a company for the category browser.
type CompanyRow struct {
	ID           int
	Name         string
	Email        string
	Website      string
	Locality     string
	ICPTier      string
	ICPScore     float64
	ThreadCount  int
	ContactCount int
}

// Companies returns companies in a category (and optionally its descendants).
// matchPrefix=true → includes all sub-categories.
func (s *Store) Companies(ctx context.Context, path string, matchPrefix bool, limit, offset int) ([]CompanyRow, int, error) {
	if limit <= 0 {
		limit = 50
	}

	var where string
	var args []any
	if matchPrefix {
		where = `(category_path = $1 OR category_path LIKE $2)`
		args = []any{path, path + " > %"}
	} else {
		where = `category_path = $1`
		args = []any{path}
	}

	// Total count
	countQuery := fmt.Sprintf(
		`SELECT COUNT(*) FROM companies WHERE %s AND exclusion_status = 'pass'`, where)
	var total int
	if err := s.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count: %w", err)
	}

	// Paged rows
	args = append(args, limit, offset)
	limitClause := fmt.Sprintf("$%d", len(args)-1)
	offsetClause := fmt.Sprintf("$%d", len(args))

	dataQuery := fmt.Sprintf(`
		SELECT id, name, COALESCE(email,''), COALESCE(website,''),
		       COALESCE(address_locality,''), COALESCE(icp_tier,'unscored'),
		       COALESCE(icp_score,0), thread_count, contact_count
		FROM companies
		WHERE %s AND exclusion_status = 'pass'
		ORDER BY icp_score DESC NULLS LAST, contact_count DESC
		LIMIT %s OFFSET %s`, where, limitClause, offsetClause)

	rows, err := s.db.QueryContext(ctx, dataQuery, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var result []CompanyRow
	for rows.Next() {
		var r CompanyRow
		if err := rows.Scan(&r.ID, &r.Name, &r.Email, &r.Website,
			&r.Locality, &r.ICPTier, &r.ICPScore, &r.ThreadCount, &r.ContactCount); err != nil {
			return nil, 0, err
		}
		result = append(result, r)
	}
	return result, total, rows.Err()
}

// RefreshCounts recomputes company_count for every category node.
// Includes all descendant companies (prefix match).
// Called from the intelligence loop after each sync+classify cycle.
func (s *Store) RefreshCounts(ctx context.Context) (int, error) {
	// 1) Ensure leaf categories exist for all current company category paths.
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO categories (path, slug, name, parent_path, depth, company_count)
		SELECT
			path,
			lower(regexp_replace(path, '\s*>\s*', '--', 'g')) AS slug,
			reverse(split_part(reverse(path), ' > ', 1)) AS name,
			CASE
				WHEN position(' > ' IN path) = 0 THEN NULL
				ELSE left(path, length(path) - length(reverse(split_part(reverse(path), ' > ', 1))) - 3)
			END AS parent_path,
			array_length(string_to_array(path, ' > '), 1) - 1 AS depth,
			cnt
		FROM (
			SELECT category_path AS path, COUNT(*) AS cnt
			FROM companies
			WHERE exclusion_status = 'pass'
			  AND category_path IS NOT NULL
			  AND category_path != ''
			GROUP BY category_path
		) leaf
		ON CONFLICT (path) DO UPDATE SET
			company_count = EXCLUDED.company_count,
			updated_at = now()`)
	if err != nil {
		return 0, fmt.Errorf("upsert leaf categories: %w", err)
	}

	// 2) Ensure ancestor nodes exist as well.
	_, err = s.db.ExecContext(ctx, `
		WITH RECURSIVE ancestors AS (
			SELECT DISTINCT category_path AS path
			FROM companies
			WHERE exclusion_status = 'pass'
			  AND category_path IS NOT NULL
			  AND category_path != ''

			UNION

			SELECT CASE
				WHEN position(' > ' IN path) = 0 THEN NULL
				ELSE left(path, length(path) - length(reverse(split_part(reverse(path), ' > ', 1))) - 3)
			END
			FROM ancestors
			WHERE position(' > ' IN path) > 0
		)
		INSERT INTO categories (path, slug, name, parent_path, depth, company_count)
		SELECT
			path,
			lower(regexp_replace(path, '\s*>\s*', '--', 'g')) AS slug,
			reverse(split_part(reverse(path), ' > ', 1)) AS name,
			CASE
				WHEN position(' > ' IN path) = 0 THEN NULL
				ELSE left(path, length(path) - length(reverse(split_part(reverse(path), ' > ', 1))) - 3)
			END AS parent_path,
			array_length(string_to_array(path, ' > '), 1) - 1 AS depth,
			0
		FROM ancestors
		WHERE path IS NOT NULL
		ON CONFLICT (path) DO NOTHING`)
	if err != nil {
		return 0, fmt.Errorf("upsert ancestor categories: %w", err)
	}

	// 3) Refresh tree-aware counts (category + descendants) in a single set-based
	// pass to avoid O(categories * companies) correlated scans.
	result, err := s.db.ExecContext(ctx, `
		WITH RECURSIVE expanded AS (
			SELECT category_path AS path
			FROM companies
			WHERE exclusion_status = 'pass'
			  AND category_path IS NOT NULL
			  AND category_path != ''

			UNION ALL

			SELECT CASE
				WHEN position(' > ' IN path) = 0 THEN NULL
				ELSE left(path, length(path) - length(reverse(split_part(reverse(path), ' > ', 1))) - 3)
			END
			FROM expanded
			WHERE position(' > ' IN path) > 0
		),
		counts AS (
			SELECT path, COUNT(*)::int AS company_count
			FROM expanded
			WHERE path IS NOT NULL
			GROUP BY path
		),
		resolved AS (
			SELECT c.path, COALESCE(ct.company_count, 0) AS company_count
			FROM categories c
			LEFT JOIN counts ct ON ct.path = c.path
		)
		UPDATE categories c SET
			company_count = r.company_count,
			updated_at = now()
		FROM resolved r
		WHERE c.path = r.path`)
	if err != nil {
		return 0, fmt.Errorf("refresh counts: %w", err)
	}
	n, _ := result.RowsAffected()
	return int(n), nil
}

// EnsureCategory upserts a single category node (used during sync/classify).
func (s *Store) EnsureCategory(ctx context.Context, path string) error {
	slug := pathToSlug(path)
	name := pathName(path)
	parent := parentPath(path)
	depth := strings.Count(path, " > ")

	_, err := s.db.ExecContext(ctx, `
		INSERT INTO categories (path, slug, name, parent_path, depth, company_count)
		VALUES ($1, $2, $3, $4, $5, 0)
		ON CONFLICT (path) DO NOTHING`,
		path, slug, name, nullStr(parent), depth)
	return err
}

// SuppressForCategory inserts a per-category suppression for an email.
func (s *Store) SuppressForCategory(ctx context.Context, email, categoryPath, reason string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO category_suppressions (email, category_path, reason)
		VALUES ($1, $2, $3)
		ON CONFLICT (email, category_path) DO NOTHING`,
		email, categoryPath, reason)
	if err != nil {
		return fmt.Errorf("suppress for category: %w", err)
	}
	return nil
}

// IsSuppressedForCategory checks whether an email is suppressed for a given category path.
// Checks both exact match and ancestor paths (if the contact suppressed a parent category).
func (s *Store) IsSuppressedForCategory(ctx context.Context, email, categoryPath string) (bool, error) {
	// Build all ancestor paths to check
	paths := ancestorPaths(categoryPath)

	placeholders := make([]string, len(paths))
	args := make([]any, len(paths)+1)
	args[0] = email
	for i, p := range paths {
		placeholders[i] = fmt.Sprintf("$%d", i+2)
		args[i+1] = p
	}

	var count int
	err := s.db.QueryRowContext(ctx,
		fmt.Sprintf(`SELECT COUNT(*) FROM category_suppressions
		 WHERE email = $1 AND category_path IN (%s)`,
			strings.Join(placeholders, ",")),
		args...).Scan(&count)
	return count > 0, err
}

// --- helpers ---

func (s *Store) query(ctx context.Context, q string, args ...any) ([]Category, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []Category
	for rows.Next() {
		var c Category
		if err := rows.Scan(&c.ID, &c.Path, &c.Slug, &c.Name, &c.ParentPath,
			&c.Depth, &c.CompanyCount, &c.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}

// pathToSlug converts "Remesla-a-sluzby > Stavebni-sluzby" to "remesla-a-sluzby~stavebni-sluzby".
// Separator ~ is used instead of -- to avoid ambiguity with hyphens in category names.
func pathToSlug(path string) string {
	return strings.ToLower(strings.ReplaceAll(path, " > ", "~"))
}

// pathName returns the last segment of a path with hyphens replaced by spaces
// (firmy.cz paths use hyphens as word separators, e.g. "Auto-moto-prodejci" → "Auto moto prodejci").
func pathName(path string) string {
	parts := strings.Split(path, " > ")
	return strings.ReplaceAll(parts[len(parts)-1], "-", " ")
}

// parentPath returns the parent path or empty string if root.
func parentPath(path string) string {
	idx := strings.LastIndex(path, " > ")
	if idx < 0 {
		return ""
	}
	return path[:idx]
}

// ancestorPaths returns the path itself plus all its ancestors.
func ancestorPaths(path string) []string {
	parts := strings.Split(path, " > ")
	paths := make([]string, 0, len(parts))
	for i := range parts {
		paths = append(paths, strings.Join(parts[:i+1], " > "))
	}
	return paths
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
