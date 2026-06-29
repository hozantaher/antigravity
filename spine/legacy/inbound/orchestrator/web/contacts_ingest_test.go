package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

func TestIngestContacts(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// a@b → inserted (1), c@d → already exists (0). "A@B.CZ" is a same-email dup → collapsed (no Exec).
	mock.ExpectExec("INSERT INTO contacts").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO contacts").WillReturnResult(sqlmock.NewResult(0, 0))

	rows := []ingestContact{
		{Email: "a@b.cz", FirstName: "A"},
		{Email: "A@B.CZ"},            // batch duplicate → skipped, no Exec
		{Email: "c@d.cz", Phone: "+420"},
		{Email: "  "},                // empty → skipped
	}
	imp, skip, err := ingestContacts(db, rows)
	if err != nil {
		t.Fatal(err)
	}
	if imp != 1 || skip != 3 {
		t.Fatalf("got imported=%d skipped=%d, want 1/3", imp, skip)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestHandleContactsIngest(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectExec("INSERT INTO contacts").WillReturnResult(sqlmock.NewResult(0, 1))
	s := &Server{db: db}

	req := httptest.NewRequest(http.MethodPost, "/api/contacts/ingest",
		strings.NewReader(`[{"email":"a@b.cz","first_name":"A","source":"chatwoot-sales"}]`))
	rec := httptest.NewRecorder()
	s.handleContactsIngest(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"imported":1`) {
		t.Fatalf("body %s", rec.Body.String())
	}
}

func TestHandleContactsIngestMethodNotAllowed(t *testing.T) {
	s := &Server{}
	rec := httptest.NewRecorder()
	s.handleContactsIngest(rec, httptest.NewRequest(http.MethodGet, "/api/contacts/ingest", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("want 405, got %d", rec.Code)
	}
}

func TestHandleContactsIngestBadJSON(t *testing.T) {
	s := &Server{}
	rec := httptest.NewRecorder()
	s.handleContactsIngest(rec, httptest.NewRequest(http.MethodPost, "/api/contacts/ingest",
		strings.NewReader("{not json")))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}

func TestEmailHashMatchesContract(t *testing.T) {
	// must equal hozan-taher hashEmail() = sha256(lower(trim(email)))
	if got := emailHash("  A@B.cz "); got != emailHash("a@b.cz") {
		t.Fatal("hash not normalized")
	}
	if len(emailHash("x@y.cz")) != 64 {
		t.Fatal("not sha256 hex")
	}
}
