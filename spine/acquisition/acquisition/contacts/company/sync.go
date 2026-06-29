package company

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
)

// SyncConfig holds configuration for the company sync job.
type SyncConfig struct {
	BatchSize   int  // rows per batch (default 5000)
	Incremental bool // only sync new rows (id > max firmy_cz_id in outreach)
}

// Syncer synchronizes companies from the firmy-cz database to the outreach database.
type Syncer struct {
	firmyDB    *sql.DB
	outreachDB DB
	store      *Store
	cfg        SyncConfig
}

// NewSyncer creates a new company syncer.
func NewSyncer(firmyDB *sql.DB, outreachDB DB, cfg SyncConfig) *Syncer {
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 5000
	}
	return &Syncer{
		firmyDB:    firmyDB,
		outreachDB: outreachDB,
		store:      NewStore(outreachDB),
		cfg:        cfg,
	}
}

// SyncResult holds the result of a full sync run.
type SyncResult struct {
	CompaniesUpserted int
	LinkedByFirmyID   int64
	LinkedByICO       int64
	MetricsUpdated    int64
}

// Run executes the full sync: bulk upsert → link contacts → recompute metrics.
func (s *Syncer) Run(ctx context.Context) (*SyncResult, error) {
	result := &SyncResult{}

	// Phase 1: Bulk upsert from firmy DB
	upserted, err := s.bulkUpsert(ctx)
	if err != nil {
		return result, fmt.Errorf("bulk upsert: %w", err)
	}
	result.CompaniesUpserted = upserted
	slog.Info("sync phase 1 complete: bulk upsert", "upserted", upserted)

	// Phase 2: Link contacts to companies
	linked1, err := s.store.LinkContactByFirmyCzID(ctx)
	if err != nil {
		return result, fmt.Errorf("link by firmy_cz_id: %w", err)
	}
	result.LinkedByFirmyID = linked1

	linked2, err := s.store.LinkContactByICO(ctx)
	if err != nil {
		return result, fmt.Errorf("link by ico: %w", err)
	}
	result.LinkedByICO = linked2
	slog.Info("sync phase 2 complete: contact linking", "by_firmy_id", linked1, "by_ico", linked2)

	// Phase 3: Recompute metrics and quality tiers
	updated, err := s.store.UpdateMetrics(ctx)
	if err != nil {
		return result, fmt.Errorf("update metrics: %w", err)
	}
	result.MetricsUpdated = updated
	slog.Info("sync phase 3 complete: metrics recomputed", "updated", updated)

	return result, nil
}

// bulkUpsert reads from firmy_cz_businesses in batches and upserts into companies.
func (s *Syncer) bulkUpsert(ctx context.Context) (int, error) {
	total := 0
	lastID := 0

	if s.cfg.Incremental {
		row := s.outreachDB.QueryRowContext(ctx, `SELECT COALESCE(MAX(firmy_cz_id), 0) FROM companies`)
		if err := row.Scan(&lastID); err != nil {
			return 0, fmt.Errorf("get max firmy_cz_id: %w", err)
		}
		slog.Info("incremental sync: starting after firmy_cz_id", "start_id", lastID)
	}

	for {
		batch, maxID, err := s.fetchBatch(ctx, lastID)
		if err != nil {
			return total, fmt.Errorf("fetch batch after id=%d: %w", lastID, err)
		}
		if len(batch) == 0 {
			break
		}

		for _, c := range batch {
			_, err := s.store.Upsert(ctx, c)
			if err != nil {
				return total, fmt.Errorf("upsert company firmy_cz_id=%d: %w", c.FirmyCzID, err)
			}
			total++
		}

		lastID = maxID
		slog.Debug("sync batch complete", "batch_size", len(batch), "total", total, "last_id", lastID)

		if len(batch) < s.cfg.BatchSize {
			break
		}
	}

	return total, nil
}

// BackfillCategoryPath copies category_path from the firmy DB for all outreach
// companies where category_path is currently empty. Returns the number of rows updated.
//
// This is a one-time repair for historical rows that were synced before the firmy
// scraper populated category_path (which was NULL at the time, stored as ” via COALESCE).
// Future sync runs via Upsert will keep category_path current automatically.
func (s *Syncer) BackfillCategoryPath(ctx context.Context) (int, error) {
	total := 0
	lastID := 0

	for {
		// Read a batch of (id, category_path) from firmy DB where path is populated.
		frows, err := s.firmyDB.QueryContext(ctx, `
			SELECT id, category_path
			FROM firmy_cz_businesses
			WHERE id > $1
			  AND category_path IS NOT NULL
			  AND category_path != ''
			ORDER BY id
			LIMIT $2`, lastID, s.cfg.BatchSize)
		if err != nil {
			return total, fmt.Errorf("backfill fetch firmy: %w", err)
		}

		type pair struct {
			id   int
			path string
		}
		var batch []pair
		for frows.Next() {
			var p pair
			if err := frows.Scan(&p.id, &p.path); err != nil {
				frows.Close()
				return total, fmt.Errorf("backfill scan: %w", err)
			}
			if p.id > lastID {
				lastID = p.id
			}
			batch = append(batch, p)
		}
		frows.Close()
		if err := frows.Err(); err != nil {
			return total, fmt.Errorf("backfill rows: %w", err)
		}

		if len(batch) == 0 {
			break
		}

		// Build a VALUES list and UPDATE outreach companies in one round-trip.
		// Only touches rows where category_path is still empty (avoids clobbering
		// rows that already have a path from a recent sync).
		vals := make([]string, 0, len(batch))
		args := make([]any, 0, len(batch)*2)
		for i, p := range batch {
			vals = append(vals, fmt.Sprintf("($%d::int, $%d::text)", i*2+1, i*2+2))
			args = append(args, p.id, p.path)
		}

		query := fmt.Sprintf(`
			UPDATE companies SET
				category_path = data.category_path,
				updated_at    = now()
			FROM (VALUES %s) AS data(firmy_cz_id, category_path)
			WHERE companies.firmy_cz_id = data.firmy_cz_id
			  AND companies.category_path = ''`,
			joinStrings(vals, ","))

		result, err := s.outreachDB.ExecContext(ctx, query, args...)
		if err != nil {
			return total, fmt.Errorf("backfill update batch after id=%d: %w", lastID-len(batch), err)
		}
		n, _ := result.RowsAffected()
		total += int(n)

		slog.Debug("backfill category_path batch", "firmy_rows", len(batch), "updated", n, "total", total)

		if len(batch) < s.cfg.BatchSize {
			break
		}
	}

	return total, nil
}

// BackfillCategoriesJSON copies categories_json from the firmy DB for all outreach
// companies where categories_json is currently empty. Returns the number of rows updated.
//
// Run once after the 021_categories_json.sql migration to populate existing companies.
// Future sync runs via Upsert will keep categories_json current automatically.
func (s *Syncer) BackfillCategoriesJSON(ctx context.Context) (int, error) {
	total := 0
	lastID := 0

	for {
		frows, err := s.firmyDB.QueryContext(ctx, `
			SELECT id, categories_json
			FROM firmy_cz_businesses
			WHERE id > $1
			  AND categories_json IS NOT NULL
			  AND categories_json NOT IN ('', 'null', '[]')
			ORDER BY id
			LIMIT $2`, lastID, s.cfg.BatchSize)
		if err != nil {
			return total, fmt.Errorf("backfill fetch firmy: %w", err)
		}

		type pair struct {
			id   int
			json string
		}
		var batch []pair
		for frows.Next() {
			var p pair
			if err := frows.Scan(&p.id, &p.json); err != nil {
				frows.Close()
				return total, fmt.Errorf("backfill scan: %w", err)
			}
			if p.id > lastID {
				lastID = p.id
			}
			batch = append(batch, p)
		}
		frows.Close()
		if err := frows.Err(); err != nil {
			return total, fmt.Errorf("backfill rows: %w", err)
		}

		if len(batch) == 0 {
			break
		}

		vals := make([]string, 0, len(batch))
		args := make([]any, 0, len(batch)*2)
		for i, p := range batch {
			vals = append(vals, fmt.Sprintf("($%d::int, $%d::text)", i*2+1, i*2+2))
			args = append(args, p.id, p.json)
		}

		query := fmt.Sprintf(`
			UPDATE companies SET
				categories_json = data.categories_json,
				updated_at      = now()
			FROM (VALUES %s) AS data(firmy_cz_id, categories_json)
			WHERE companies.firmy_cz_id = data.firmy_cz_id
			  AND (companies.categories_json IS NULL OR companies.categories_json = '')`,
			joinStrings(vals, ","))

		result, err := s.outreachDB.ExecContext(ctx, query, args...)
		if err != nil {
			return total, fmt.Errorf("backfill update batch: %w", err)
		}
		n, _ := result.RowsAffected()
		total += int(n)

		slog.Debug("backfill categories_json batch", "firmy_rows", len(batch), "updated", n, "total", total)

		if len(batch) < s.cfg.BatchSize {
			break
		}
	}

	return total, nil
}

// joinStrings joins a slice of strings with sep (avoids importing strings in this file).
func joinStrings(ss []string, sep string) string {
	out := ""
	for i, s := range ss {
		if i > 0 {
			out += sep
		}
		out += s
	}
	return out
}

// fetchBatch reads a batch of businesses from firmy-cz ordered by id.
func (s *Syncer) fetchBatch(ctx context.Context, afterID int) ([]*Company, int, error) {
	rows, err := s.firmyDB.QueryContext(ctx, `
		SELECT id, COALESCE(ico, ''), COALESCE(name, ''), COALESCE(email, ''),
			COALESCE(telephone, ''), COALESCE(website, ''),
			COALESCE(street_address, ''), COALESCE(address_locality, ''),
			COALESCE(postal_code, ''), COALESCE(description, ''),
			COALESCE(velikost_firmy, ''), COALESCE(pravni_forma, ''),
			COALESCE(category_path, ''),
			COALESCE(categories_json, ''),
			COALESCE(rating_value, 0), COALESCE(rating_count, 0)
		FROM firmy_cz_businesses
		WHERE id > $1
		ORDER BY id
		LIMIT $2`, afterID, s.cfg.BatchSize)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var batch []*Company
	maxID := afterID
	for rows.Next() {
		c := &Company{}
		err := rows.Scan(
			&c.FirmyCzID, &c.ICO, &c.Name, &c.Email,
			&c.Telephone, &c.Website,
			&c.StreetAddress, &c.AddressLocality,
			&c.PostalCode, &c.Description,
			&c.VelikostFirmy, &c.PravniForma,
			&c.CategoryPath, &c.CategoriesJSON,
			&c.RatingValue, &c.RatingCount,
		)
		if err != nil {
			return nil, 0, fmt.Errorf("scan: %w", err)
		}
		if c.FirmyCzID > maxID {
			maxID = c.FirmyCzID
		}
		batch = append(batch, c)
	}

	return batch, maxID, rows.Err()
}
