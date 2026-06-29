package profile

import "strings"

// EvaluateRequest is the full input to the combined evaluation pipeline:
// greylist → rate-limit → static rules. Fields parallel MessageContext
// for the static rules plus the triplet for greylist + the sender
// mailbox for rate-limit.
type EvaluateRequest struct {
	SenderMailbox  string  `json:"sender_mailbox"`
	SenderIP       string  `json:"sender_ip"`
	SenderAddr     string  `json:"sender_addr"`
	RecipientAddr  string  `json:"recipient_addr"`
	SizeBytes      int64   `json:"size_bytes"`
	OriginCountry  string  `json:"sender_origin_country"`
	LinkRatio      float64 `json:"link_ratio"`
	HasDkim        bool    `json:"has_dkim"`
	RecordRate     bool    `json:"record_rate"` // when true, advance rate tracker too
}

// EvaluateResult is the resolved verdict + which check fired + supporting
// state so harness drivers can introspect / log.
type EvaluateResult struct {
	Decision  string `json:"decision"`        // accept | reject | greylist | spam
	Reason    string `json:"reason,omitempty"`
	FiredBy   string `json:"fired_by"`        // greylist | rate_limit | static
	RateCount int    `json:"rate_count,omitempty"`
	RateLimit int    `json:"rate_limit,omitempty"`
}

// Evaluate runs the full pipeline. Order matters and matches what a real
// MTA does: greylist first (4xx defer dominates 5xx reject because the
// sender hasn't even passed the front door yet), then rate-limit
// (per-MTA throttling), then static rules (per-message content).
//
// Returns ErrUnknownDomain when the domain isn't registered.
func (r *Registry) Evaluate(domain string, req EvaluateRequest) (EvaluateResult, error) {
	r.mu.RLock()
	p, ok := r.profiles[strings.ToLower(domain)]
	r.mu.RUnlock()
	if !ok {
		return EvaluateResult{}, ErrUnknownDomain
	}

	// Stage 1 — greylist. Only when profile enables it.
	if p.GreylistUnknownSender {
		allow, reason := r.greylist.Allow(req.SenderIP, req.SenderAddr, req.RecipientAddr)
		if !allow {
			return EvaluateResult{
				Decision: string(DecisionGreylist),
				Reason:   reason,
				FiredBy:  "greylist",
			}, nil
		}
	}

	// Stage 2 — rate limit (per sender mailbox under recipient's domain).
	if p.RateLimitPerHour > 0 && req.SenderMailbox != "" {
		count := r.tracker.Count(req.SenderMailbox)
		if count >= p.RateLimitPerHour {
			return EvaluateResult{
				Decision:  string(DecisionReject),
				Reason:    "rate_limit_per_hour exceeded",
				FiredBy:   "rate_limit",
				RateCount: count,
				RateLimit: p.RateLimitPerHour,
			}, nil
		}
		if req.RecordRate {
			count = r.tracker.Record(req.SenderMailbox)
		}
	}

	// Stage 3 — static rules.
	d, reason := Verdict(p, MessageContext{
		SizeBytes:           req.SizeBytes,
		SenderIP:            req.SenderIP,
		SenderOriginCountry: req.OriginCountry,
		LinkRatio:           req.LinkRatio,
		HasDkim:             req.HasDkim,
		// KnownSender is implicit: greylist enabled would have fired or
		// passed by stage 1, and Verdict's greylist branch is bypassed
		// because we already cleared it.
		KnownSender: true,
	})

	rateCount := 0
	if p.RateLimitPerHour > 0 && req.SenderMailbox != "" {
		rateCount = r.tracker.Count(req.SenderMailbox)
	}
	return EvaluateResult{
		Decision:  string(d),
		Reason:    reason,
		FiredBy:   "static",
		RateCount: rateCount,
		RateLimit: p.RateLimitPerHour,
	}, nil
}

// EvaluateFromMap is the JSON-friendly variant — handler decodes a raw
// map, this method maps it onto EvaluateRequest before calling Evaluate.
func (r *Registry) EvaluateFromMap(domain string, raw map[string]interface{}) (interface{}, error) {
	req, err := decodeInto[EvaluateRequest](raw)
	if err != nil {
		return nil, err
	}
	res, err := r.Evaluate(domain, req)
	if err != nil {
		return nil, err
	}
	return &res, nil
}
