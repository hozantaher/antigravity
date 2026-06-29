package web

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
)

// Contacts lookup CONTRACT (read, sales-safe) — GET /api/contacts/lookup?email=<e> (X-API-Key).
// Lets the sales side ask "do we already know this contact / is it already a customer?" WITHOUT
// exposing any nábor data (no sentiment, score, campaign, disposition…). Returns only identity +
// the is_customer flag. This is the read seam skills (skill-lookup-company) call through the gateway.

type lookupResult struct {
	Found       bool   `json:"found"`
	Name        string `json:"name,omitempty"`
	CompanyName string `json:"company_name,omitempty"`
	ICO         string `json:"ico,omitempty"`
	IsCustomer  bool   `json:"is_customer"`
}

func lookupContact(db *sql.DB, email string) (lookupResult, error) {
	email = strings.TrimSpace(email)
	if email == "" {
		return lookupResult{}, nil
	}
	var first, last, company, ico sql.NullString
	var isCustomer sql.NullBool
	err := db.QueryRow(
		`SELECT first_name, last_name, company_name, ico, (crm_client_id IS NOT NULL)
		   FROM contacts WHERE lower(trim(email)) = lower(trim($1)) LIMIT 1`, email,
	).Scan(&first, &last, &company, &ico, &isCustomer)
	if err == sql.ErrNoRows {
		return lookupResult{Found: false}, nil
	}
	if err != nil {
		return lookupResult{}, err
	}
	name := strings.TrimSpace(first.String + " " + last.String)
	return lookupResult{
		Found: true, Name: name, CompanyName: company.String,
		ICO: ico.String, IsCustomer: isCustomer.Bool,
	}, nil
}

func (s *Server) handleContactLookup(w http.ResponseWriter, r *http.Request) {
	res, err := lookupContact(s.db, r.URL.Query().Get("email"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(res)
}
