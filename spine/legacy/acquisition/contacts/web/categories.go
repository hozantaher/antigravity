// Package contactsweb hosts HTTP handlers for contacts-domain endpoints.
// Currently /api/categories/* — more contacts handlers (enrichment,
// prospect) will land as they're carved.
package contactsweb

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"contacts/category"
)

// F1-2 B10 — clamp `?limit=N` so an operator-controlled DoS can't pull
// the whole table in one request. Pre-fix the handlers accepted any
// positive integer; an attacker with a valid X-API-Key (e.g. via
// stolen credentials) could request limit=10000000 and exhaust memory
// formatting the response.
const (
	maxCategoriesLimit = 1000
	maxCompaniesLimit  = 500
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

// HandleCategories — GET /api/categories
// Query params:
//   ?parent=<path>   list children of a parent (omit for roots)
//   ?q=<search>      full-text search across paths
//   ?limit=N         max results (default 200)
func HandleCategories(db *sql.DB, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	store := category.NewStore(db)
	q := r.URL.Query()

	limit := 200
	if l := q.Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > maxCategoriesLimit {
		limit = maxCategoriesLimit
	}

	var cats []category.Category
	var err error

	switch {
	case q.Get("q") != "":
		cats, err = store.Search(r.Context(), q.Get("q"), limit)
	case q.Get("parent") != "":
		cats, err = store.ListChildren(r.Context(), q.Get("parent"))
	default:
		cats, err = store.ListRoots(r.Context())
	}

	if err != nil {
		safeError(w, err, http.StatusInternalServerError, "contactsweb.categories/list")
		return
	}

	writeJSON(w, map[string]any{
		"categories": cats,
		"total":      len(cats),
	})
}

// HandleCategoryDetail — GET /api/categories/<slug>[/companies]
// Query params:
//   ?prefix=true     include sub-categories (default true)
//   ?limit=N         page size (default 50)
//   ?offset=N        pagination offset
func HandleCategoryDetail(db *sql.DB, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/api/categories/")
	parts := strings.SplitN(path, "/", 2)
	slug := parts[0]
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	store := category.NewStore(db)
	cat, err := store.FindBySlug(r.Context(), slug)
	if err != nil {
		safeError(w, err, http.StatusInternalServerError, "contactsweb.categories/find-slug")
		return
	}
	if cat == nil {
		http.Error(w, "category not found", http.StatusNotFound)
		return
	}

	if action == "" {
		children, err := store.ListChildren(r.Context(), cat.Path)
		if err != nil {
			safeError(w, err, http.StatusInternalServerError, "contactsweb.categories/list-children")
			return
		}
		writeJSON(w, map[string]any{
			"category": cat,
			"children": children,
		})
		return
	}

	if action != "companies" {
		http.Error(w, "unknown action", http.StatusNotFound)
		return
	}

	q := r.URL.Query()
	prefix := q.Get("prefix") != "false"
	limit := 50
	offset := 0
	if l := q.Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > maxCompaniesLimit {
		limit = maxCompaniesLimit
	}
	if o := q.Get("offset"); o != "" {
		if n, err := strconv.Atoi(o); err == nil && n >= 0 {
			offset = n
		}
	}

	companies, total, err := store.Companies(r.Context(), cat.Path, prefix, limit, offset)
	if err != nil {
		safeError(w, err, http.StatusInternalServerError, "contactsweb.categories/companies")
		return
	}

	writeJSON(w, map[string]any{
		"category":  cat,
		"companies": companies,
		"total":     total,
		"limit":     limit,
		"offset":    offset,
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
