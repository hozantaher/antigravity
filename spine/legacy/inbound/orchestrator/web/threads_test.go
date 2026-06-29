package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// replyInboxCols mirrors what handleReplyDetail scans from reply_inbox.
var replyInboxCols = []string{
	"id", "send_event_id", "campaign_id", "contact_id", "mailbox_id",
	"from_email", "subject", "classification",
	"received_at", "handled", "handled_at",
}

// ── handleReplyDetail: POST /:id/reply ────────────────────────────────────────

func TestHandleReplyDetail_Reply_MethodNotAllowed(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/replies/1/reply", nil)
	w := httptest.NewRecorder()
	s.handleReplyDetail(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestHandleReplyDetail_Reply_InvalidID(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/replies/abc/reply", strings.NewReader(`{"body":"hi"}`))
	w := httptest.NewRecorder()
	s.handleReplyDetail(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestHandleReplyDetail_Reply_MissingBody(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/replies/1/reply", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	s.handleReplyDetail(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 when body empty, got %d", w.Code)
	}
}

func TestHandleReplyDetail_Reply_InvalidJSON(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/replies/1/reply", strings.NewReader("{bad"))
	w := httptest.NewRecorder()
	s.handleReplyDetail(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestHandleReplyDetail_Reply_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	// SELECT to check existence returns no rows
	mock.ExpectQuery(`SELECT id FROM reply_inbox`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodPost, "/api/replies/99/reply",
		strings.NewReader(`{"body":"test reply"}`))
	w := httptest.NewRecorder()
	s.handleReplyDetail(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestHandleReplyDetail_Reply_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	now := time.Now()
	// SELECT to confirm reply exists
	mock.ExpectQuery(`SELECT id FROM reply_inbox`).
		WithArgs(int64(5)).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(5))
	// INSERT into manual_reply_outbox
	mock.ExpectExec(`INSERT INTO manual_reply_outbox`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// UPDATE reply_inbox handled=true
	mock.ExpectExec(`UPDATE reply_inbox SET handled`).
		WithArgs(int64(5)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	_ = now

	s := NewServer(db, "")
	body := `{"body":"Díky za zájem, zavolám Vám."}`
	req := httptest.NewRequest(http.MethodPost, "/api/replies/5/reply",
		strings.NewReader(body))
	w := httptest.NewRecorder()
	s.handleReplyDetail(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["ok"] != true {
		t.Errorf("expected ok=true, got %v", resp)
	}
}

func TestHandleReplyDetail_Reply_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id FROM reply_inbox`).
		WillReturnError(errWeb("db down"))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodPost, "/api/replies/1/reply",
		strings.NewReader(`{"body":"test"}`))
	w := httptest.NewRecorder()
	s.handleReplyDetail(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
}
