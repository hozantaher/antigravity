package web

// Sprint AP4 — Egress chaos detection.
//
// GET /v1/egress-observations[?peek=1|?drain=1[&ack=N]]
//
// Query parameters (mutually exclusive — use one per request):
//
//   ?peek=1       — returns all buffered observations WITHOUT clearing (non-destructive).
//                   BFF uses this as Step 1 of the two-step handshake before INSERT.
//
//   ?drain=1      — legacy: returns + clears buffer atomically (for backward compat).
//                   Prefer the peek→ack flow for crash-safe operation.
//
//   ?drain=1&ack=N — preferred: drain exactly the first N observations from the ring
//                   buffer. Returns a 400 if N > current buffer size (BFF miscounted).
//                   BFF calls this AFTER a successful bulk INSERT to confirm it
//                   consumed exactly N rows. Relay drains only those N rows, so a
//                   BFF crash between peek and ack leaves the buffer intact for the
//                   next cron cycle.
//
// The BFF calls this endpoint every 5 minutes, writes the observations to
// mailbox_egress_observation, and runs detect_mailbox_egress_chaos(60) to
// flag mailboxes seen from multiple countries.
//
// No auth required — returns only opaque labels and country codes.

import (
	"fmt"
	"net/http"
	"strconv"

	"relay/internal/transport/wgpool"
)

type egressObservationsResponse struct {
	Observations []wgpool.EgressObservation `json:"observations"`
	Count        int                        `json:"count"`
}

// handleEgressObservations serves GET /v1/egress-observations.
func (s *Server) handleEgressObservations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	if s.wgPool == nil {
		writeJSON(w, http.StatusOK, egressObservationsResponse{Observations: nil, Count: 0})
		return
	}

	q := r.URL.Query()
	peek := q.Get("peek") == "1"
	drain := q.Get("drain") == "1"
	ackStr := q.Get("ack")

	var obs []wgpool.EgressObservation

	switch {
	case peek:
		// Non-destructive snapshot — BFF Step 1 of peek→INSERT→ack handshake.
		obs = s.wgPool.PeekEgressObservations()

	case drain && ackStr != "":
		// Step 2: drain exactly ack=N rows that BFF has successfully INSERTed.
		ackN, err := strconv.Atoi(ackStr)
		if err != nil || ackN < 0 {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid ack value: %q", ackStr))
			return
		}
		drained, err := s.wgPool.DrainEgressObservationsN(ackN)
		if err != nil {
			// ack > buffer size — BFF miscounted; respond with 409 so BFF can re-peek.
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		obs = drained

	case drain:
		// Legacy full drain — backward compatible.
		obs = s.wgPool.DrainEgressObservations()

	default:
		// No param — behave as peek (non-destructive default).
		obs = s.wgPool.PeekEgressObservations()
	}

	if obs == nil {
		obs = []wgpool.EgressObservation{}
	}

	writeJSON(w, http.StatusOK, egressObservationsResponse{
		Observations: obs,
		Count:        len(obs),
	})
}

