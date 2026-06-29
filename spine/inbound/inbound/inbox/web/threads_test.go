package inboxweb

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func newDBMock(t *testing.T) (*sql.DB, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db, mock
}

func TestHandleReplyDetail_InvalidID(t *testing.T) {
	db, _ := newDBMock(t)
	req := httptest.NewRequest(http.MethodPost, "/api/replies/abc/reply", strings.NewReader(`{"body":"test"}`))
	w := httptest.NewRecorder()
	HandleReplyDetail(db, w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "invalid reply id") {
		t.Fatalf("unexpected body: %s", w.Body.String())
	}
}

func TestHandleReplyDetail_MethodNotAllowed(t *testing.T) {
	db, _ := newDBMock(t)
	req := httptest.NewRequest(http.MethodGet, "/api/replies/42/reply", nil)
	w := httptest.NewRecorder()
	HandleReplyDetail(db, w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("want 405, got %d", w.Code)
	}
}

func TestHandleReplyDetail_InvalidJSON(t *testing.T) {
	db, _ := newDBMock(t)
	req := httptest.NewRequest(http.MethodPost, "/api/replies/42/reply", strings.NewReader(`not json`))
	w := httptest.NewRecorder()
	HandleReplyDetail(db, w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", w.Code)
	}
}

func TestHandleReplyDetail_EmptyBody(t *testing.T) {
	db, _ := newDBMock(t)
	req := httptest.NewRequest(http.MethodPost, "/api/replies/42/reply", strings.NewReader(`{"body":"   "}`))
	w := httptest.NewRecorder()
	HandleReplyDetail(db, w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for whitespace-only body, got %d", w.Code)
	}
}

func TestHandleReplyDetail_NotFound(t *testing.T) {
	db, mock := newDBMock(t)
	mock.ExpectQuery(`SELECT id FROM reply_inbox WHERE id = \$1`).
		WithArgs(int64(999)).
		WillReturnError(sql.ErrNoRows)
	req := httptest.NewRequest(http.MethodPost, "/api/replies/999/reply", strings.NewReader(`{"body":"hello"}`))
	w := httptest.NewRecorder()
	HandleReplyDetail(db, w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("want 404, got %d (body=%s)", w.Code, w.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock expectations: %v", err)
	}
}

func TestHandleReplyDetail_HappyPath(t *testing.T) {
	db, mock := newDBMock(t)
	mock.ExpectQuery(`SELECT id FROM reply_inbox WHERE id = \$1`).
		WithArgs(int64(42)).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(42)))
	mock.ExpectExec(`INSERT INTO manual_reply_outbox`).
		WithArgs(int64(42), "odpovídáme").
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE reply_inbox SET handled = TRUE`).
		WithArgs(int64(42)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	body, _ := json.Marshal(map[string]string{"body": "odpovídáme"})
	req := httptest.NewRequest(http.MethodPost, "/api/replies/42/reply", bytes.NewReader(body))
	w := httptest.NewRecorder()
	HandleReplyDetail(db, w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp["ok"] != true {
		t.Fatalf("want ok:true, got %v", resp)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock expectations: %v", err)
	}
}

func TestHandleReplyDetail_InsertFails(t *testing.T) {
	db, mock := newDBMock(t)
	mock.ExpectQuery(`SELECT id FROM reply_inbox WHERE id = \$1`).
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(7)))
	mock.ExpectExec(`INSERT INTO manual_reply_outbox`).
		WillReturnError(sql.ErrConnDone)

	req := httptest.NewRequest(http.MethodPost, "/api/replies/7/reply", strings.NewReader(`{"body":"x"}`))
	w := httptest.NewRecorder()
	HandleReplyDetail(db, w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500 when INSERT fails, got %d", w.Code)
	}
}

func TestHandleReplyDetail_UpdateFails(t *testing.T) {
	db, mock := newDBMock(t)
	mock.ExpectQuery(`SELECT id FROM reply_inbox WHERE id = \$1`).
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(7)))
	mock.ExpectExec(`INSERT INTO manual_reply_outbox`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE reply_inbox SET handled = TRUE`).
		WillReturnError(sql.ErrConnDone)

	req := httptest.NewRequest(http.MethodPost, "/api/replies/7/reply", strings.NewReader(`{"body":"x"}`))
	w := httptest.NewRecorder()
	HandleReplyDetail(db, w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500 when UPDATE fails, got %d", w.Code)
	}
}

func TestHandleReplyDetail_LookupError(t *testing.T) {
	db, mock := newDBMock(t)
	mock.ExpectQuery(`SELECT id FROM reply_inbox WHERE id = \$1`).
		WithArgs(int64(7)).
		WillReturnError(sql.ErrConnDone)

	req := httptest.NewRequest(http.MethodPost, "/api/replies/7/reply", strings.NewReader(`{"body":"x"}`))
	w := httptest.NewRecorder()
	HandleReplyDetail(db, w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500 for lookup error, got %d", w.Code)
	}
	// S-H2: 500 body is now the generic "internal error" — server-side
	// slog still carries the underlying lookup error with op=
	// inboxweb.replyDetail/lookup.
	if !strings.Contains(w.Body.String(), "internal error") {
		t.Fatalf("want 'internal error' in body, got %s", w.Body.String())
	}
}

func TestHandleReplyDetail_NegativeID(t *testing.T) {
	db, _ := newDBMock(t)
	req := httptest.NewRequest(http.MethodPost, "/api/replies/-5/reply", strings.NewReader(`{"body":"x"}`))
	w := httptest.NewRecorder()
	HandleReplyDetail(db, w, req)
	// Negative parses as valid int64 — handler forwards; if DB has no row,
	// we get 404, otherwise 500 on the ErrNoRows path.
	if w.Code != http.StatusNotFound && w.Code != http.StatusInternalServerError {
		t.Fatalf("want 404 or 500 for negative id path, got %d", w.Code)
	}
}
