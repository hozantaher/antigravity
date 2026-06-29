package web

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
)

// Contacts ingest CONTRACT — the published seam other units (e.g. sync-contacts) use to push
// contacts INTO data-core without reaching into its DB/schema directly. POST /api/contacts/ingest
// (X-API-Key). Idempotent: inserts only when no contact with the same lower(trim(email)) exists
// (matches the prod UNIQUE index idx_contacts_email_lower) — never updates/clobbers existing rows.

type ingestContact struct {
	Email       string `json:"email"`
	FirstName   string `json:"first_name"`
	LastName    string `json:"last_name"`
	CompanyName string `json:"company_name"`
	Phone       string `json:"phone"`
	Source      string `json:"source"`
}

const contactsIngestSQL = `INSERT INTO contacts
  (email, email_hash, first_name, last_name, company_name, phone, source, status, created_at, updated_at)
  SELECT $1,$2,$3,$4,$5,$6,$7,'new',now(),now()
  WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE lower(trim(email)) = lower(trim($1)))`

func emailHash(email string) string {
	h := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return hex.EncodeToString(h[:])
}

func nullIfEmpty(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

// ingestContacts performs the idempotent upsert; split out for testability.
func ingestContacts(db *sql.DB, rows []ingestContact) (imported, skipped int, err error) {
	seen := map[string]bool{}
	for _, c := range rows {
		key := strings.ToLower(strings.TrimSpace(c.Email))
		if key == "" || seen[key] { // empty/duplicate-in-batch → skip (prod index would reject dup)
			skipped++
			continue
		}
		seen[key] = true
		src := c.Source
		if src == "" {
			src = "chatwoot-sales"
		}
		res, e := db.Exec(contactsIngestSQL, c.Email, emailHash(c.Email), c.FirstName,
			c.LastName, c.CompanyName, nullIfEmpty(c.Phone), src)
		if e != nil {
			return imported, skipped, e
		}
		if n, _ := res.RowsAffected(); n > 0 {
			imported++
		} else {
			skipped++ // already present (dedup by lower(trim(email)))
		}
	}
	return imported, skipped, nil
}

func (s *Server) handleContactsIngest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var rows []ingestContact
	if err := json.NewDecoder(r.Body).Decode(&rows); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	imported, skipped, err := ingestContacts(s.db, rows)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]int{"imported": imported, "skipped": skipped})
}
