package web

// handleReplyDetail inlines the reply-detail handler that was previously
// delegated to inbox/web.HandleReplyDetail. The delegation created an
// orchestrator→inbox module import, which combined with inbox→orchestrator/llm
// formed a cycle (ADR-010). Moving the handler here breaks the outbound edge.
//
// Functional contract is identical to the previous inbox/web implementation:
// POST /api/replies/<id>/reply — records a manual reply and marks the inbox
// entry as handled.

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
)

// handleReplyDetail handles POST /api/replies/<id>/reply.
func (s *Server) handleReplyDetail(w http.ResponseWriter, r *http.Request) {
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
	err = s.db.QueryRowContext(r.Context(),
		`SELECT id FROM reply_inbox WHERE id = $1`, id,
	).Scan(&replyID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		replyDetailSafeError(w, err, http.StatusInternalServerError, "web.replyDetail/lookup")
		return
	}

	if _, err := s.db.ExecContext(r.Context(),
		`INSERT INTO manual_reply_outbox (reply_inbox_id, body) VALUES ($1, $2)`,
		id, body.Body,
	); err != nil {
		replyDetailSafeError(w, err, http.StatusInternalServerError, "web.replyDetail/insert")
		return
	}

	if _, err := s.db.ExecContext(r.Context(),
		`UPDATE reply_inbox SET handled = TRUE, handled_at = now() WHERE id = $1`, id,
	); err != nil {
		replyDetailSafeError(w, err, http.StatusInternalServerError, "web.replyDetail/mark-handled")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// replyDetailSafeError logs server-side and returns a generic status message.
// Mirrors the safeError helper from the former inbox/web package; scoped to
// this file to avoid conflicts with the existing safeError in web/server.go
// (if any).
func replyDetailSafeError(w http.ResponseWriter, err error, status int, op string) {
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
