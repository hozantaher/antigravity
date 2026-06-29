package ares

import (
	"context"
	"database/sql"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

const (
	resBulkURL      = "https://opendata.csu.gov.cz/soubory/od/od_org03/res_data.csv"
	resNaceURL      = "https://opendata.csu.gov.cz/soubory/od/od_org03/res_pf_nace.csv"
	resBatchSize    = 2000
	resLogEvery     = 100_000
)

// RESImportConfig configures the CSÚ RES bulk import.
type RESImportConfig struct {
	// DataURL overrides the default res_data.csv URL.
	DataURL string
	// DataReader reads res_data.csv directly (e.g. from a local file). Takes
	// precedence over DataURL when set.
	DataReader io.Reader
	// SkipClosed skips companies with a closing date (DDATZAN non-empty).
	SkipClosed bool
	// DryRun counts and parses but does not write to DB.
	DryRun bool
	// BatchSize for DB updates (default 2000).
	BatchSize int
}

// RESImportResult holds counts from a bulk import run.
type RESImportResult struct {
	Parsed   int
	Skipped  int
	Updated  int
	NotFound int
	Errors   int
}

// RunRESImport streams res_data.csv and bulk-updates companies with NACE
// codes, founding date, and legal form. It only touches rows where
// ares_synced_at IS NULL so re-runs are safe and incremental.
func RunRESImport(ctx context.Context, db *sql.DB, cfg RESImportConfig) (*RESImportResult, error) {
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = resBatchSize
	}
	dataURL := cfg.DataURL
	if dataURL == "" {
		dataURL = resBulkURL
	}

	var r io.Reader
	if cfg.DataReader != nil {
		r = cfg.DataReader
	} else {
		slog.Info("res_import: downloading", "url", dataURL)
		httpClient := &http.Client{Timeout: 0} // no timeout — 537 MB
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, dataURL, nil)
		if err != nil {
			return nil, fmt.Errorf("res_import: create request: %w", err)
		}
		resp, err := httpClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("res_import: download: %w", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("res_import: HTTP %d", resp.StatusCode)
		}
		slog.Info("res_import: download started",
			"content_length_mb", resp.ContentLength/1024/1024)
		r = resp.Body
	}

	return parseAndImport(ctx, db, r, cfg)
}

// resRow holds the columns we care about from res_data.csv.
type resRow struct {
	ICO         string
	DatumVzniku string // DDATVZN col 2
	DatumZaniku string // DDATZAN col 3
	LegalForm   string // FORMA col 6
	NACEPrimary string // NACE col 9 (CZ-NACE 2008)
}

// parseAndImport streams the CSV reader and flushes DB batches.
func parseAndImport(ctx context.Context, db *sql.DB, r io.Reader, cfg RESImportConfig) (*RESImportResult, error) {
	result := &RESImportResult{}

	csvR := csv.NewReader(r)
	csvR.LazyQuotes = true
	csvR.FieldsPerRecord = -1 // tolerate ragged rows

	// Read and validate header
	header, err := csvR.Read()
	if err != nil {
		return nil, fmt.Errorf("res_import: read header: %w", err)
	}
	colIdx, err := resolveColumns(header)
	if err != nil {
		return nil, err
	}

	batch := make([]resBatchRow, 0, cfg.BatchSize)

	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if cfg.DryRun {
			result.Updated += len(batch)
			batch = batch[:0]
			return nil
		}
		updated, notFound, err := batchUpdate(ctx, db, batch)
		result.Updated += updated
		result.NotFound += notFound
		if err != nil {
			return err
		}
		batch = batch[:0]
		return nil
	}

	for {
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		default:
		}

		record, err := csvR.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			result.Errors++
			continue
		}

		row := extractRow(record, colIdx)
		result.Parsed++

		if cfg.SkipClosed && row.DatumZaniku != "" {
			result.Skipped++
			continue
		}
		if row.ICO == "" {
			result.Skipped++
			continue
		}

		batch = append(batch, resBatchRow{
			ico:         padICO(row.ICO),
			nace:        normalizeNACE(row.NACEPrimary),
			datumVzniku: row.DatumVzniku,
			legalForm:   row.LegalForm,
		})

		if len(batch) >= cfg.BatchSize {
			if err := flush(); err != nil {
				return result, err
			}
		}

		if result.Parsed%resLogEvery == 0 {
			slog.Info("res_import: progress",
				"parsed", result.Parsed,
				"updated", result.Updated,
				"not_found", result.NotFound,
				"skipped", result.Skipped,
			)
		}
	}

	// Final flush
	if err := flush(); err != nil {
		return result, err
	}

	return result, nil
}

// resBatchRow holds one row to be written to the DB.
type resBatchRow struct {
	ico         string
	nace        string
	datumVzniku string
	legalForm   string
}

// batchUpdate writes one batch to the DB.
// Returns (updated, not_found, error).
func batchUpdate(ctx context.Context, db *sql.DB, batch []resBatchRow) (int, int, error) {
	// Build VALUES clause
	placeholders := make([]string, 0, len(batch))
	args := make([]interface{}, 0, len(batch)*4)
	for i, row := range batch {
		base := i * 4
		placeholders = append(placeholders,
			fmt.Sprintf("($%d,$%d,$%d,$%d)", base+1, base+2, base+3, base+4))
		var datumVzniku interface{}
		if row.datumVzniku != "" {
			datumVzniku = row.datumVzniku
		}
		var legalForm interface{}
		if row.legalForm != "" {
			legalForm = row.legalForm
		}
		args = append(args, row.ico, row.nace, datumVzniku, legalForm)
	}

	query := fmt.Sprintf(`
		UPDATE companies AS c
		SET
			nace_primary    = COALESCE(NULLIF(v.nace,''), c.nace_primary),
			nace_codes      = CASE WHEN v.nace != '' THEN ARRAY[v.nace] ELSE c.nace_codes END,
			datum_vzniku    = COALESCE(v.datum_vzniku::date, c.datum_vzniku),
			ares_synced_at  = now(),
			updated_at      = now()
		FROM (VALUES %s) AS v(ico, nace, datum_vzniku, legal_form)
		WHERE c.ico = v.ico
		  AND c.ares_synced_at IS NULL
	`, strings.Join(placeholders, ","))

	res, err := db.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, 0, fmt.Errorf("res_import batch update: %w", err)
	}
	rowsAffected, _ := res.RowsAffected()
	notFound := len(batch) - int(rowsAffected)
	if notFound < 0 {
		notFound = 0
	}
	return int(rowsAffected), notFound, nil
}

// column index map — positions can vary between CSÚ export versions.
type colMap struct {
	ico         int
	ddatvzn     int
	ddatzan     int
	forma       int
	nace        int
}

func resolveColumns(header []string) (colMap, error) {
	idx := make(map[string]int, len(header))
	for i, h := range header {
		idx[strings.TrimSpace(strings.ToUpper(h))] = i
	}
	required := []string{"ICO", "DDATVZN", "NACE"}
	for _, col := range required {
		if _, ok := idx[col]; !ok {
			return colMap{}, fmt.Errorf("res_import: required column %q not found in header %v", col, header)
		}
	}
	getIdx := func(name string) int {
		if v, ok := idx[name]; ok {
			return v
		}
		return -1
	}
	return colMap{
		ico:     getIdx("ICO"),
		ddatvzn: getIdx("DDATVZN"),
		ddatzan: getIdx("DDATZAN"),
		forma:   getIdx("FORMA"),
		nace:    getIdx("NACE"),
	}, nil
}

func extractRow(record []string, m colMap) resRow {
	get := func(i int) string {
		if i < 0 || i >= len(record) {
			return ""
		}
		return strings.TrimSpace(record[i])
	}
	return resRow{
		ICO:         get(m.ico),
		DatumVzniku: get(m.ddatvzn),
		DatumZaniku: get(m.ddatzan),
		LegalForm:   get(m.forma),
		NACEPrimary: get(m.nace),
	}
}

// padICO pads an ICO to 8 digits with leading zeros.
func padICO(ico string) string {
	for len(ico) < 8 {
		ico = "0" + ico
	}
	return ico
}

// normalizeNACE removes dots and trims the NACE code.
// CSÚ uses "6820" for 68.20; ARES uses "68.20" — normalise to no-dot form.
func normalizeNACE(nace string) string {
	return strings.ReplaceAll(strings.TrimSpace(nace), ".", "")
}

// FormatRESResult returns a human-readable summary.
func FormatRESResult(r *RESImportResult, elapsed time.Duration) string {
	rate := 0
	if elapsed.Seconds() > 0 {
		rate = int(float64(r.Parsed) / elapsed.Seconds())
	}
	return fmt.Sprintf(
		"RES import done in %s\n  parsed:    %d (%d/s)\n  updated:   %d\n  not_found: %d\n  skipped:   %d\n  errors:    %d\n",
		elapsed.Round(time.Second),
		r.Parsed, rate,
		r.Updated,
		r.NotFound,
		r.Skipped,
		r.Errors,
	)
}
