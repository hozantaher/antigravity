package campaignsweb

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"contacts/segment"
	"campaigns/campaign"
)

// HandleSegments — GET /api/segments or POST /api/segments
func HandleSegments(db *sql.DB, w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		listSegments(db, w, r)
	case http.MethodPost:
		createSegment(db, w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func listSegments(db *sql.DB, w http.ResponseWriter, r *http.Request) {
	store := segment.NewStore(db)
	segs, err := store.List(r.Context())
	if err != nil {
		safeError(w, err, http.StatusInternalServerError, "campaignsweb.segments")
		return
	}
	if segs == nil {
		segs = []segment.Segment{}
	}
	writeJSON(w, map[string]any{"segments": segs, "total": len(segs)})
}

func createSegment(db *sql.DB, w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        string        `json:"name"`
		Description string        `json:"description"`
		Query       segment.Query `json:"query"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if body.Name == "" {
		http.Error(w, "name required", http.StatusBadRequest)
		return
	}
	store := segment.NewStore(db)
	id, err := store.Create(r.Context(), body.Name, body.Description, body.Query)
	if err != nil {
		safeError(w, err, http.StatusInternalServerError, "campaignsweb.segments")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]any{"id": id})
}

// HandleSegmentDetail — /api/segments/:id or /api/segments/:id/action
func HandleSegmentDetail(db *sql.DB, w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/segments/"), "/")
	idStr := parts[0]
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "invalid segment id", http.StatusBadRequest)
		return
	}

	store := segment.NewStore(db)

	switch {
	case r.Method == http.MethodGet && action == "":
		seg, err := store.Get(r.Context(), id)
		if err != nil {
			if isNotFound(err) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			safeError(w, err, http.StatusInternalServerError, "campaignsweb.segments")
			return
		}
		writeJSON(w, map[string]any{"segment": seg})

	case r.Method == http.MethodPatch && action == "":
		var body struct {
			Name        string        `json:"name"`
			Description string        `json:"description"`
			Query       segment.Query `json:"query"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON", http.StatusBadRequest)
			return
		}
		if err := store.Update(r.Context(), id, body.Name, body.Description, body.Query); err != nil {
			if isNotFound(err) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			safeError(w, err, http.StatusInternalServerError, "campaignsweb.segments")
			return
		}
		writeJSON(w, map[string]any{"ok": true})

	case r.Method == http.MethodDelete && action == "":
		if err := store.Delete(r.Context(), id); err != nil {
			if isNotFound(err) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			safeError(w, err, http.StatusInternalServerError, "campaignsweb.segments")
			return
		}
		writeJSON(w, map[string]any{"ok": true})

	case r.Method == http.MethodPost && action == "verify":
		runner := campaign.NewRunner(db, nil, nil)
		result, err := runner.VerifySegmentBatch(r.Context(), id)
		if err != nil {
			safeError(w, err, http.StatusInternalServerError, "campaignsweb.segments")
			return
		}
		writeJSON(w, map[string]any{"ok": true, "count": result.Count, "ready": result.Ready})

	case r.Method == http.MethodPost && action == "rebuild":
		seg, err := store.Get(r.Context(), id)
		if err != nil {
			if isNotFound(err) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			safeError(w, err, http.StatusInternalServerError, "campaignsweb.segments")
			return
		}
		n, err := store.BuildMemberships(r.Context(), seg)
		if err != nil {
			safeError(w, err, http.StatusInternalServerError, "campaignsweb.segments")
			return
		}
		writeJSON(w, map[string]any{"ok": true, "companies": n})

	case r.Method == http.MethodPost:
		http.Error(w, "not found", http.StatusNotFound)

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func isNotFound(err error) bool {
	return err != nil && (errors.Is(err, sql.ErrNoRows) || strings.Contains(err.Error(), "not found"))
}
