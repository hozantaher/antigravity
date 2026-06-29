// Package campaignsweb hosts HTTP handlers for /api/campaigns/* endpoints.
// Carved out of modules/outreach/web as part of M3.3 domain migration.
//
// Handlers take their dependencies explicitly as function parameters
// (DB pool); they do NOT couple to a god-struct like the old Server.
// Register via RegisterRoutes(mux, db) — see services/campaigns/internal/web/routes.go.
package campaignsweb

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"campaigns/campaign"
)

// safeError logs the underlying error server-side and returns a generic
// status-keyed message to the client. S-H2 closure: previously every
// handler echoed err.Error() raw, leaking pq schema names, FK constraint
// labels, and pgx wire details to anyone hitting a 4xx/5xx path.
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

// HandleCampaigns — GET /api/campaigns  or  POST /api/campaigns
func HandleCampaigns(db *sql.DB, w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		listCampaigns(db, w, r)
	case http.MethodPost:
		createCampaign(db, w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// listCampaigns — GET /api/campaigns
func listCampaigns(db *sql.DB, w http.ResponseWriter, r *http.Request) {
	runner := campaign.NewReadOnlyRunner(db)
	campaigns, err := runner.List(r.Context())
	if err != nil {
		safeError(w, err, http.StatusInternalServerError, "campaignsweb.listCampaigns")
		return
	}
	writeJSON(w, map[string]any{"campaigns": campaigns, "total": len(campaigns)})
}

// createCampaign — POST /api/campaigns
func createCampaign(db *sql.DB, w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name          string                  `json:"name"`
		Description   string                  `json:"description"`
		CategoryPaths []string                `json:"category_paths"`
		CategoryMatch string                  `json:"category_match"`
		MinScore      float64                 `json:"min_score"`
		Region        string                  `json:"region"`
		Steps         []campaign.SequenceStep `json:"steps"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		safeError(w, err, http.StatusBadRequest, "campaignsweb.createCampaign/decode")
		return
	}
	if body.Name == "" {
		http.Error(w, "name is required", http.StatusBadRequest)
		return
	}
	if body.MinScore < 0 || body.MinScore > 1 {
		http.Error(w, "min_score must be between 0 and 1", http.StatusBadRequest)
		return
	}
	if body.CategoryMatch != "" && body.CategoryMatch != "prefix" && body.CategoryMatch != "exact" {
		http.Error(w, "category_match must be 'prefix' or 'exact'", http.StatusBadRequest)
		return
	}
	if len(body.Steps) == 0 {
		body.Steps = campaign.DefaultSequence()
	}

	filter := campaign.EnrollmentFilter{
		CategoryPaths: body.CategoryPaths,
		CategoryMatch: body.CategoryMatch,
		MinScore:      body.MinScore,
		Region:        body.Region,
	}

	runner := campaign.NewReadOnlyRunner(db)

	estimate, err := runner.EstimateEnrollment(r.Context(), filter)
	if err != nil {
		slog.Warn("estimate enrollment failed", "error", err)
		estimate = 0
	}

	id, err := runner.CreateCampaign(r.Context(), body.Name, body.Description, body.Steps, filter)
	if err != nil {
		safeError(w, err, http.StatusInternalServerError, "campaignsweb.createCampaign/insert")
		return
	}

	w.WriteHeader(http.StatusCreated)
	writeJSON(w, map[string]any{
		"id":       id,
		"estimate": estimate,
	})
}

// HandleCampaignDetail — GET/POST /api/campaigns/<id>[/<action>]
func HandleCampaignDetail(db *sql.DB, w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/campaigns/")
	parts := strings.SplitN(path, "/", 2)
	idStr := parts[0]
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "invalid campaign id", http.StatusBadRequest)
		return
	}

	runner := campaign.NewReadOnlyRunner(db)

	switch {
	case r.Method == http.MethodGet && action == "":
		camp, err := runner.Get(r.Context(), id)
		if err != nil {
			safeError(w, err, http.StatusNotFound, "campaignsweb.detail/get")
			return
		}
		stats, _ := runner.Stats(r.Context(), id)
		writeJSON(w, map[string]any{"campaign": camp, "stats": stats})

	case r.Method == http.MethodPost && action == "run":
		// F3-2: only flip status. The HTTP handler holds a
		// NewReadOnlyRunner which has no sender Engine wired — calling
		// RunCampaign on it would silently no-op the Enqueue step
		// (logged as "engine nil at Enqueue") and advance current_step
		// in DB without sending. The actual send happens on the next
		// scheduler tick (campaign/scheduler.go), which uses
		// NewRunner with the full Engine.
		//
		// Operator-visible behavior: clicking "Spustit" flips status
		// to 'running' immediately; the scheduler picks the campaign
		// up on its next tick (≤ scheduler interval) and starts
		// dispatching. Pre-fix the click LOOKED like an immediate
		// send via the misleading RunCampaign call but produced the
		// same outcome (zero sends until next scheduler tick) plus a
		// confusing slog.Error.
		if err := runner.SetStatus(r.Context(), id, "running"); err != nil {
			safeError(w, err, http.StatusInternalServerError, "campaignsweb.detail/run/set-status")
			return
		}
		writeJSON(w, map[string]any{
			"ok": true,
			"hint": "campaign queued; scheduler picks up on next tick",
		})

	case r.Method == http.MethodPost && action == "pause":
		if err := runner.SetStatus(r.Context(), id, "paused"); err != nil {
			safeError(w, err, http.StatusInternalServerError, "campaignsweb.detail/pause")
			return
		}
		writeJSON(w, map[string]any{"ok": true})

	case r.Method == http.MethodGet && action == "estimate":
		camp, err := runner.Get(r.Context(), id)
		if err != nil {
			safeError(w, err, http.StatusNotFound, "campaignsweb.detail/estimate/get")
			return
		}
		filter := campaign.EnrollmentFilter{
			CategoryPaths: camp.CategoryPaths,
			CategoryMatch: camp.CategoryMatch,
		}
		count, err := runner.EstimateEnrollment(r.Context(), filter)
		if err != nil {
			safeError(w, err, http.StatusInternalServerError, "campaignsweb.detail/estimate/count")
			return
		}
		writeJSON(w, map[string]any{"count": count})

	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
