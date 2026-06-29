package web

import (
	"net/http"
	"net/http/httptest"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

func TestLookupContactFound(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	rows := sqlmock.NewRows([]string{"first_name", "last_name", "company_name", "ico", "is_customer"}).
		AddRow("Jan", "Novák", "ACME", "123", true)
	mock.ExpectQuery("FROM contacts WHERE lower").WithArgs("a@b.cz").WillReturnRows(rows)
	res, err := lookupContact(db, " a@b.cz ")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Found || res.Name != "Jan Novák" || res.CompanyName != "ACME" || !res.IsCustomer {
		t.Fatalf("got %+v", res)
	}
}

func TestLookupContactNotFound(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("FROM contacts").WillReturnError(sqlmock.ErrCancelled)
	// not-found path uses sql.ErrNoRows; simulate via empty rows
	db2, mock2, _ := sqlmock.New()
	defer db2.Close()
	mock2.ExpectQuery("FROM contacts").WithArgs("x@y.cz").
		WillReturnRows(sqlmock.NewRows([]string{"first_name", "last_name", "company_name", "ico", "is_customer"}))
	res, _ := lookupContact(db2, "x@y.cz")
	if res.Found {
		t.Fatalf("want not found, got %+v", res)
	}
}

func TestLookupContactEmptyEmail(t *testing.T) {
	db, _, _ := sqlmock.New()
	defer db.Close()
	res, err := lookupContact(db, "   ")
	if err != nil || res.Found {
		t.Fatalf("empty email → not found, got %+v err %v", res, err)
	}
}

func TestHandleContactLookup(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("FROM contacts").WithArgs("a@b.cz").
		WillReturnRows(sqlmock.NewRows([]string{"first_name", "last_name", "company_name", "ico", "is_customer"}).
			AddRow("Jan", "", "ACME", "1", false))
	s := &Server{db: db}
	rec := httptest.NewRecorder()
	s.handleContactLookup(rec, httptest.NewRequest(http.MethodGet, "/api/contacts/lookup?email=a@b.cz", nil))
	if rec.Code != 200 || !contains(rec.Body.String(), `"found":true`) || !contains(rec.Body.String(), `"is_customer":false`) {
		t.Fatalf("code %d body %s", rec.Code, rec.Body.String())
	}
}

func contains(s, sub string) bool { return len(s) >= len(sub) && (s == sub || indexOf(s, sub) >= 0) }
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
