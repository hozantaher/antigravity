package ares

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"
)

// SyncConfig configures the ARES sync job.
type SyncConfig struct {
	BatchSize   int
	Concurrency int // number of parallel ARES requests (default 1)
	DryRun      bool
}

// SyncResult holds the outcome of an ARES sync run.
type SyncResult struct {
	Total     int
	Synced    int
	NotFound  int
	Errors    int
	Skipped   int
}

// RunSync fetches NACE codes and metadata from ARES for all companies
// that have an ICO but haven't been synced yet (ares_synced_at IS NULL).
func RunSync(ctx context.Context, db *sql.DB, client *Client, cfg SyncConfig) (*SyncResult, error) {
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 1000
	}

	result := &SyncResult{}
	lastID := 0

	for {
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		default:
		}

		rows, err := db.QueryContext(ctx, `
			SELECT id, ico FROM companies
			WHERE ares_synced_at IS NULL
				AND ico IS NOT NULL AND ico != ''
				AND id > $1
			ORDER BY id LIMIT $2
		`, lastID, cfg.BatchSize)
		if err != nil {
			return result, fmt.Errorf("fetch batch: %w", err)
		}

		type icoRow struct {
			ID  int
			ICO string
		}
		var batch []icoRow
		for rows.Next() {
			var r icoRow
			if err := rows.Scan(&r.ID, &r.ICO); err != nil {
				rows.Close()
				return result, fmt.Errorf("scan: %w", err)
			}
			batch = append(batch, r)
		}
		rows.Close()

		if len(batch) == 0 {
			break
		}

		for _, r := range batch {
			lastID = r.ID
			result.Total++

			ico := strings.TrimSpace(r.ICO)
			if ico == "" {
				result.Skipped++
				continue
			}

			// Pad ICO to 8 digits (ARES requires it)
			for len(ico) < 8 {
				ico = "0" + ico
			}

			data, err := client.FetchSubject(ctx, ico)
			if ctx.Err() != nil {
				return result, ctx.Err()
			}
			if err != nil {
				slog.Warn("ares fetch error", "id", r.ID, "ico", ico, "error", err)
				result.Errors++
				// Mark as synced with empty data to avoid re-fetching
				if !cfg.DryRun {
					markSynced(ctx, db, r.ID)
				}
				continue
			}

			if data == nil {
				slog.Debug("ares not found", "id", r.ID, "ico", ico)
				result.NotFound++
				if !cfg.DryRun {
					markSynced(ctx, db, r.ID)
				}
				continue
			}

			if !cfg.DryRun {
				if err := persistARES(ctx, db, r.ID, data); err != nil {
					slog.Warn("ares persist error", "id", r.ID, "error", err)
					result.Errors++
					continue
				}
			}

			result.Synced++

			if result.Total%100 == 0 {
				slog.Info("ares sync progress",
					"total", result.Total,
					"synced", result.Synced,
					"not_found", result.NotFound,
					"errors", result.Errors,
					"last_id", lastID,
				)
			}
		}

		slog.Info("ares sync batch",
			"batch_size", len(batch),
			"total", result.Total,
			"synced", result.Synced,
			"last_id", lastID,
		)
	}

	return result, nil
}

func persistARES(ctx context.Context, db *sql.DB, id int, data *SubjectData) error {
	naceCodes := "{}"
	if len(data.NACECodes) > 0 {
		naceCodes = "{" + strings.Join(data.NACECodes, ",") + "}"
	}

	var datumVzniku interface{}
	if data.DatumVzniku != "" {
		datumVzniku = data.DatumVzniku
	}

	_, err := db.ExecContext(ctx, `
		UPDATE companies SET
			nace_codes = $2,
			nace_primary = $3,
			datum_vzniku = $4,
			ares_synced_at = now(),
			updated_at = now()
		WHERE id = $1
	`, id, naceCodes, data.NACEPrimary, datumVzniku)
	return err
}

func markSynced(ctx context.Context, db *sql.DB, id int) {
	_, err := db.ExecContext(ctx, `
		UPDATE companies SET ares_synced_at = now(), updated_at = now()
		WHERE id = $1
	`, id)
	if err != nil {
		slog.Warn("mark synced error", "id", id, "error", err)
	}
}
