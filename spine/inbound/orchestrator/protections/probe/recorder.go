package probe

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
)

// LayerEvaluator is the subset of alert.Evaluator that the AlertingSink
// needs. Defined here so this package does not import the alert package.
type LayerEvaluator interface {
	EvaluateLayer(ctx context.Context, layer string, level int) error
}

// AlertingSink wraps any Sink and, after each successful Write, calls
// evaluator.EvaluateLayer in a goroutine. This lets the alert engine run
// out-of-band without blocking the probe's scheduler tick.
type AlertingSink struct {
	Inner     Sink
	Evaluator LayerEvaluator
}

func (a *AlertingSink) Write(ctx context.Context, r Result) error {
	err := a.Inner.Write(ctx, r)
	if err == nil && a.Evaluator != nil {
		// M-O3 (2026-04-22): goroutine now recovers from panics so a
		// misbehaving alert evaluator cannot crash the probe scheduler.
		go func() {
			defer func() {
				if p := recover(); p != nil {
					slog.Error("protection alert evaluator panic recovered", "op", "AlertingSink.Write/panicRecover",
						"layer", r.Layer, "level", r.Level, "recover", p)
				}
			}()
			if evalErr := a.Evaluator.EvaluateLayer(context.Background(), r.Layer, int(r.Level)); evalErr != nil {
				slog.Warn("protection alert evaluation failed", "op", "AlertingSink.Write/evalFail", "layer", r.Layer, "level", r.Level, "error", evalErr)
			}
		}()
	}
	return err
}

// PGRecorder writes probe results to protection_probes (migration 041).
// A nil *sql.DB makes Write a no-op — convenient for tests where the
// scheduler is exercised without a database.
type PGRecorder struct {
	DB *sql.DB
}

// NewPGRecorder wraps a *sql.DB.
func NewPGRecorder(db *sql.DB) *PGRecorder {
	return &PGRecorder{DB: db}
}

// Write persists one Result row.
func (r *PGRecorder) Write(ctx context.Context, res Result) error {
	if r == nil || r.DB == nil {
		return nil
	}
	expected, err := marshalJSON(res.Expected)
	if err != nil {
		return fmt.Errorf("probe: marshal expected: %w", err)
	}
	actual, err := marshalJSON(res.Actual)
	if err != nil {
		return fmt.Errorf("probe: marshal actual: %w", err)
	}
	latencyMs := int(res.Latency.Milliseconds())
	_, err = r.DB.ExecContext(ctx, `
		INSERT INTO protection_probes
		    (layer, level, status, detail, latency_ms, expected, actual)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
	`,
		res.Layer, int(res.Level), string(res.Status),
		nullString(res.Detail), latencyMs, expected, actual,
	)
	if err != nil {
		return fmt.Errorf("probe: insert: %w", err)
	}
	return nil
}

// LatestRow is one matrix cell: the most recent probe for a (layer, level).
type LatestRow struct {
	Layer     string
	Level     Level
	Status    Status
	Detail    string
	LatencyMs int
	Expected  map[string]any
	Actual    map[string]any
	CheckedAt string // RFC3339
}

// Matrix returns the most recent probe per (layer, level). The BFF
// GET /api/protections/matrix wraps this and serves it to the UI.
func (r *PGRecorder) Matrix(ctx context.Context) ([]LatestRow, error) {
	if r == nil || r.DB == nil {
		return nil, nil
	}
	rows, err := r.DB.QueryContext(ctx, `
		SELECT DISTINCT ON (layer, level)
		    layer, level, status,
		    COALESCE(detail, '') AS detail,
		    COALESCE(latency_ms, 0) AS latency_ms,
		    COALESCE(expected::text, '{}') AS expected,
		    COALESCE(actual::text, '{}') AS actual,
		    to_char(checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS checked_at
		FROM protection_probes
		ORDER BY layer, level, checked_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("probe: matrix query: %w", err)
	}
	defer rows.Close()
	out := make([]LatestRow, 0, 16)
	for rows.Next() {
		var row LatestRow
		var lvl int
		var status, expected, actual string
		if err := rows.Scan(
			&row.Layer, &lvl, &status, &row.Detail,
			&row.LatencyMs, &expected, &actual, &row.CheckedAt,
		); err != nil {
			return nil, err
		}
		row.Level = Level(lvl)
		row.Status = Status(status)
		row.Expected = unmarshalJSON(expected)
		row.Actual = unmarshalJSON(actual)
		out = append(out, row)
	}
	return out, rows.Err()
}

func marshalJSON(v map[string]any) ([]byte, error) {
	if len(v) == 0 {
		return []byte("{}"), nil
	}
	return json.Marshal(v)
}

func unmarshalJSON(s string) map[string]any {
	if s == "" {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil
	}
	return m
}

func nullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}
