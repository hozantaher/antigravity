package web

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// handleProxyPool serves a snapshot of the working proxy-pool for the
// proxy_pool L2/L3 probes and the dashboard's Ochrany / Egress sanity cards.
//
// The egress proxy pool is owned by anti-trace-relay (SMTP-EGRESS-LOCKDOWN R5).
// This handler is a pass-through to relay's GET /v1/proxy-pool. We do NOT
// synthesize a placeholder pool here — operators rely on this surface to
// see ground truth before launching campaigns. Returning {pool-1..pool-4}
// when the real pool is empty is a HARD RULE violation
// (memory: feedback_no_fabricated_test_data).
//
// Response shape (mirrors relay's /v1/proxy-pool):
//
//	{
//	  "mode": "mullvad" | "rotating-pool" | "none" | "unknown",
//	  "working": [{addr, latency_ms, country?, source?}],
//	  "count": N,
//	  "total": N,                       // legacy alias for `count`
//	  "last_refresh": "RFC3339",
//	  "consecutive_zero_refreshes": int,
//	  "empty_pool_critical": bool,
//	  "error": "<reason>"               // only when relay is unreachable
//	}
//
// `total` duplicates `count` for backwards compatibility with older probe
// parsers and the BFF schema-parity check. New consumers should read
// `count`/`mode` from relay's canonical shape.
func (s *Server) handleProxyPool(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if s.relayBaseURL == "" {
		// No relay wired — surface the misconfig instead of fabricating a
		// healthy pool. Probes treat working=0 as err which matches relay's
		// own "mode=none" semantics.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"mode":    "unknown",
			"working": []any{},
			"count":   0,
			"total":   0,
			"error":   "relay_not_configured",
		})
		return
	}

	body, err := s.fetchRelayProxyPool(r.Context())
	if err != nil {
		slog.Warn("proxy-pool relay fetch failed",
			"op", "web.handleProxyPool/fetch",
			"error", err)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"mode":    "unknown",
			"working": []any{},
			"count":   0,
			"total":   0,
			"error":   err.Error(),
		})
		return
	}

	// Forward relay's body verbatim, but ensure `total` is present (legacy
	// parsers including the orchestrator's own probes/parse.go count
	// `working[]`, but the BFF schema-parity check used to require `total`).
	var parsed map[string]any
	if jerr := json.Unmarshal(body, &parsed); jerr != nil {
		slog.Warn("proxy-pool relay parse failed",
			"op", "web.handleProxyPool/parse",
			"error", jerr)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"mode":    "unknown",
			"working": []any{},
			"count":   0,
			"total":   0,
			"error":   "relay_parse_failed",
		})
		return
	}
	if _, has := parsed["total"]; !has {
		if c, ok := parsed["count"].(float64); ok {
			parsed["total"] = int(c)
		} else if working, ok := parsed["working"].([]any); ok {
			parsed["total"] = len(working)
		} else {
			parsed["total"] = 0
		}
	}
	_ = json.NewEncoder(w).Encode(parsed)
}

// fetchRelayProxyPool issues GET <relayBaseURL>/v1/proxy-pool with
// Authorization: Bearer <token> and returns the raw JSON body. It does NOT
// transform the payload; callers decide how to merge it with legacy fields.
func (s *Server) fetchRelayProxyPool(ctx context.Context) ([]byte, error) {
	if s.relayBaseURL == "" {
		return nil, errors.New("relay_not_configured")
	}
	client := s.relayClient
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	url := strings.TrimRight(s.relayBaseURL, "/") + "/v1/proxy-pool"

	reqCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if s.relayToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.relayToken)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1 MiB cap
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("relay_status_" + http.StatusText(resp.StatusCode))
	}
	return body, nil
}
