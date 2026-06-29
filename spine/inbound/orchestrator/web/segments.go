package web

// Thin adapters delegating to services/campaigns/web (M3.3 carve).
// Domain logic in campaigns/web; kept here for legacy test compatibility.

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"

	campaignsweb "campaigns/web"
)

// isNotFound — used by threads.go; kept in outreach/web for shared use.
func isNotFound(err error) bool {
	return err != nil && (errors.Is(err, sql.ErrNoRows) || strings.Contains(err.Error(), "not found"))
}

func (s *Server) handleSegments(w http.ResponseWriter, r *http.Request) {
	campaignsweb.HandleSegments(s.db, w, r)
}

func (s *Server) handleSegmentDetail(w http.ResponseWriter, r *http.Request) {
	campaignsweb.HandleSegmentDetail(s.db, w, r)
}
