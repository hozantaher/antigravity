package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
)

// Execer is the minimal interface audit.Log needs. Accepts *sql.DB and any
// abstraction that wraps ExecContext (e.g. campaigns/campaign.DB) so callers
// don't need to expose a concrete *sql.DB just for audit hooks.
//
// Hardening 2026-04-25: previously Log required *sql.DB which forced services
// to leak their DB type or skip audit. Tightened to interface; tests + callers
// pass *sql.DB unchanged because *sql.DB satisfies Execer.
type Execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// Log records an operator action in operator_audit_log.
// Errors are logged but never returned — audit must not block operations.
//
// db may be nil (returns silently) — convenient for read-only Runner variants.
func Log(ctx context.Context, db Execer, action, actor, entityType, entityID string, details map[string]any) {
	if db == nil {
		return
	}

	detailsJSON := json.RawMessage("{}")
	if len(details) > 0 {
		if data, err := json.Marshal(details); err == nil {
			detailsJSON = data
		}
	}

	if actor == "" {
		actor = "cli"
	}

	_, err := db.ExecContext(ctx, `
		INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
		VALUES ($1, $2, $3, $4, $5)
	`, action, actor, entityType, entityID, string(detailsJSON))
	if err != nil {
		slog.Warn("audit log write failed", "action", action, "error", err)
	}
}

// Recent returns the most recent audit entries, newest first.
func Recent(ctx context.Context, db *sql.DB, limit int) ([]Entry, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id, action, actor, entity_type, entity_id, details, created_at
		FROM operator_audit_log
		ORDER BY created_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []Entry
	for rows.Next() {
		var e Entry
		var detailsRaw sql.NullString
		if err := rows.Scan(&e.ID, &e.Action, &e.Actor, &e.EntityType, &e.EntityID, &detailsRaw, &e.CreatedAt); err != nil {
			return nil, err
		}
		if detailsRaw.Valid && detailsRaw.String != "" {
			json.Unmarshal([]byte(detailsRaw.String), &e.Details) //nolint:errcheck
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}
