package web

// Thin adapters delegating to services/campaigns/web (M3.3 carve).
// Domain logic lives in `campaigns/web`; Server methods here preserve
// the Server-receiver API for legacy tests in web/campaigns_test.go.
// New code SHOULD call campaignsweb.Handle* directly — see server.go
// registration at /api/campaigns, /api/campaigns/.

import (
	"net/http"

	campaignsweb "campaigns/web"
)

// handleCampaigns — delegates to campaignsweb.HandleCampaigns.
func (s *Server) handleCampaigns(w http.ResponseWriter, r *http.Request) {
	campaignsweb.HandleCampaigns(s.db, w, r)
}

// handleCampaignDetail — delegates to campaignsweb.HandleCampaignDetail.
func (s *Server) handleCampaignDetail(w http.ResponseWriter, r *http.Request) {
	campaignsweb.HandleCampaignDetail(s.db, w, r)
}
