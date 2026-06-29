// Package inboxweb hosts HTTP handlers for /api/replies/*, /api/threads/*,
// /api/inbox/* endpoints. Carved out of modules/outreach/web as part of
// M5.3 domain migration (#122).
//
// Handlers take their dependencies explicitly as function parameters
// (DB pool); they do NOT couple to a god-struct.
package inboxweb

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
)

// safeError logs the underlying error server-side and returns a generic
// status-keyed message to the client. S-H2: previously every handler
// echoed err.Error() raw, leaking pq schema names and pgx wire details.
func safeError(w http.ResponseWriter, err error, status int, op string) {
	slog.Error("http handler error", "op", op, "error", err)
	var msg string
	switch status {
	case http.StatusBadRequest:
		msg = "invalid request"
	case http.StatusNotFound:
		msg = "not found"
	default:
		msg = "internal error"
	}
	http.Error(w, msg, status)
}

// HandleReplyDetail — POST /api/replies/<id>/reply — record a manual reply
// and mark the inbox entry as handled.
func HandleReplyDetail(db *sql.DB, w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/replies/"), "/")
	idStr := parts[0]

	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "invalid reply id", http.StatusBadRequest)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		Body string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(body.Body) == "" {
		http.Error(w, "body required", http.StatusBadRequest)
		return
	}

	var replyID int64
	err = db.QueryRowContext(r.Context(),
		`SELECT id FROM reply_inbox WHERE id = $1`, id,
	).Scan(&replyID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		safeError(w, err, http.StatusInternalServerError, "inboxweb.replyDetail/lookup")
		return
	}

	if _, err := db.ExecContext(r.Context(),
		`INSERT INTO manual_reply_outbox (reply_inbox_id, body) VALUES ($1, $2)`,
		id, body.Body,
	); err != nil {
		safeError(w, err, http.StatusInternalServerError, "inboxweb.replyDetail/insert")
		return
	}

	if _, err := db.ExecContext(r.Context(),
		`UPDATE reply_inbox SET handled = TRUE, handled_at = now() WHERE id = $1`, id,
	); err != nil {
		safeError(w, err, http.StatusInternalServerError, "inboxweb.replyDetail/mark-handled")
		return
	}

	writeJSON(w, map[string]any{"ok": true})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
