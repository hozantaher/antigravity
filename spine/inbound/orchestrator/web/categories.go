package web

// Thin adapters delegating to services/contacts/web (M3.3 carve).
// Domain logic in contactsweb; kept here for legacy-test compatibility
// and to own the writeJSON helper used elsewhere in this package.

import (
	"encoding/json"
	"net/http"

	contactsweb "contacts/web"
)

// handleCategories — delegates to contactsweb.HandleCategories.
func (s *Server) handleCategories(w http.ResponseWriter, r *http.Request) {
	contactsweb.HandleCategories(s.db, w, r)
}

// handleCategoryDetail — delegates to contactsweb.HandleCategoryDetail.
func (s *Server) handleCategoryDetail(w http.ResponseWriter, r *http.Request) {
	contactsweb.HandleCategoryDetail(s.db, w, r)
}

// writeJSON is used by handlers still living in outreach/web (categories
// adapters above, segments adapters, legacy test helpers).
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
