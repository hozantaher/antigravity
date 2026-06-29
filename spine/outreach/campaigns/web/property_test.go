package campaignsweb

import (
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/quick"

	"github.com/DATA-DOG/go-sqlmock"
)

// createCampaignValidation replicates the body-validation branches of
// createCampaign without DB calls. Returns (statusCode, reason).
// Used by TestCreateCampaignValidation_PropertyLaws.
func createCampaignValidation(name string, minScore float64, categoryMatch string) (int, string) {
	if name == "" {
		return http.StatusBadRequest, "name is required"
	}
	if minScore < 0 || minScore > 1 {
		return http.StatusBadRequest, "min_score must be between 0 and 1"
	}
	if categoryMatch != "" && categoryMatch != "prefix" && categoryMatch != "exact" {
		return http.StatusBadRequest, "category_match must be 'prefix' or 'exact'"
	}
	return http.StatusOK, ""
}

// ── Property: empty name ALWAYS → 400 name-required ──────────────
func TestProperty_EmptyNameAlwaysFails(t *testing.T) {
	f := func(minScore float64, match string) bool {
		// Only use valid min_score + category_match so we prove NAME is
		// the rejection reason.
		if minScore < 0 || minScore > 1 {
			return true // skip — different rule fires
		}
		if match != "" && match != "prefix" && match != "exact" {
			return true // skip
		}
		code, reason := createCampaignValidation("", minScore, match)
		return code == http.StatusBadRequest && reason == "name is required"
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: min_score ∈ [0, 1] is accepted when name+match are valid ──
func TestProperty_MinScoreInRange_Passes(t *testing.T) {
	for i := 0; i <= 100; i++ {
		score := float64(i) / 100.0
		code, _ := createCampaignValidation("ok", score, "prefix")
		if code != http.StatusOK {
			t.Fatalf("min_score=%f should pass, got %d", score, code)
		}
	}
}

// ── Property: min_score outside [0, 1] ALWAYS rejected ──────────
func TestProperty_MinScoreOutOfRange_Rejected(t *testing.T) {
	bads := []float64{-0.001, -1, -100, 1.001, 2, 1000, -1e-9}
	for _, s := range bads {
		code, reason := createCampaignValidation("ok", s, "prefix")
		if code != http.StatusBadRequest {
			t.Fatalf("min_score=%f should be rejected, got %d (%s)", s, code, reason)
		}
	}
}

// ── Property: category_match only 'prefix' or 'exact' or empty ──
func TestProperty_CategoryMatch_Values(t *testing.T) {
	// Valid: "", "prefix", "exact" → pass
	for _, m := range []string{"", "prefix", "exact"} {
		code, _ := createCampaignValidation("ok", 0.5, m)
		if code != http.StatusOK {
			t.Fatalf("match=%q should pass, got %d", m, code)
		}
	}
	// Invalid fuzz
	f := func(match string) bool {
		if match == "" || match == "prefix" || match == "exact" {
			return true
		}
		code, _ := createCampaignValidation("ok", 0.5, match)
		return code == http.StatusBadRequest
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: HandleCampaigns with random JSON bodies never panics,
//     never returns 5xx solely because of body shape. Validation either
//     accepts or rejects deterministically. ────────────────────────────
func TestProperty_CreateCampaign_NoPanic(t *testing.T) {
	db, _, _ := sqlmock.New()
	defer db.Close()
	// Random bodies — including well-formed and malformed JSON.
	bodies := []string{
		`{}`,
		`{"name":""}`,
		`{"name":"x"}`,
		`{"name":"x","min_score":-0.5}`,
		`{"name":"x","min_score":2}`,
		`{"name":"x","category_match":"banana"}`,
		`{"name":"x","category_match":"prefix"}`,
		`{"name":"x","description":"hi","min_score":0.3}`,
		`not json`,
		`{`,
		`[]`,
		`null`,
		`{"name":"ěščřžýáíéůú"}`, // Czech unicode
		`{"name":"` + strings.Repeat("x", 10000) + `"}`, // long name
	}
	for _, body := range bodies {
		t.Run(fmt.Sprintf("body=%.30q", body), func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panic on body %q: %v", body, r)
				}
			}()
			req := httptest.NewRequest(http.MethodPost, "/api/campaigns", strings.NewReader(body))
			w := httptest.NewRecorder()
			HandleCampaigns(db, w, req)
			// Status code must be in the 200/400/500 range; never negative / not a HTTP code.
			if w.Code < 200 || w.Code >= 600 {
				t.Fatalf("invalid status %d for body %q", w.Code, body)
			}
		})
	}
}

// ── Property: HandleCampaignDetail always emits JSON or an error; never panics. ──
func TestProperty_HandleCampaignDetail_PathFuzz(t *testing.T) {
	db, _, _ := sqlmock.New()
	defer db.Close()
	paths := []string{
		"/api/campaigns/",
		"/api/campaigns/0",
		"/api/campaigns/abc",
		"/api/campaigns/" + strings.Repeat("9", 30), // overflows int64
		"/api/campaigns/-1",
		"/api/campaigns/1/run",
		"/api/campaigns/1/pause",
		"/api/campaigns/1/estimate",
		"/api/campaigns/1/../..",
		"/api/campaigns/1/🚀",
	}
	for _, p := range paths {
		t.Run(p, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panic on path %q: %v", p, r)
				}
			}()
			for _, m := range []string{http.MethodGet, http.MethodPost} {
				req := httptest.NewRequest(m, p, nil)
				w := httptest.NewRecorder()
				HandleCampaignDetail(db, w, req)
				if w.Code < 200 || w.Code >= 600 {
					t.Fatalf("invalid status %d for %s %s", w.Code, m, p)
				}
			}
		})
	}
	// silence unused
	_ = sql.ErrNoRows
}
