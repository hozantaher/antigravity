package profile

import (
	"net"
	"strings"
)

// MessageContext is the per-message metadata fed into Verdict. Fields are
// optional; a zero-valued context is the "no signals" baseline (accept).
type MessageContext struct {
	SizeBytes           int64   `json:"size_bytes,omitempty"`
	SenderIP            string  `json:"sender_ip,omitempty"`
	SenderOriginCountry string  `json:"sender_origin_country,omitempty"` // ISO-3166-1 alpha-2 (e.g. "CZ")
	LinkRatio           float64 `json:"link_ratio,omitempty"`
	HasDkim             bool    `json:"has_dkim,omitempty"`
	KnownSender         bool    `json:"known_sender,omitempty"`
}

// Decision is the verdict the profile would render on a message. Mirror of
// the bounce-or-deliver fork in the real provider receivers.
type Decision string

const (
	DecisionAccept   Decision = "accept"
	DecisionReject   Decision = "reject"
	DecisionGreylist Decision = "greylist"
	DecisionSpam     Decision = "spam"
)

// Verdict applies the profile rules to the message context and returns the
// first matching decision. Order matters: hard rejects first (size, IP,
// DKIM), then origin reject, then greylist, then spam classification.
//
// The order ensures we surface the *strongest* reason a real provider
// would. A message that's both oversized and from a proxy IP gets the
// size verdict — same as Postfix/Rspamd evaluation order.
func Verdict(p *Profile, ctx MessageContext) (Decision, string) {
	if p == nil {
		return DecisionAccept, ""
	}
	if p.MaxMessageSizeBytes > 0 && ctx.SizeBytes > p.MaxMessageSizeBytes {
		return DecisionReject, "message size exceeds max_message_size_bytes"
	}
	if ctx.SenderIP != "" && ipInAnyCIDR(ctx.SenderIP, p.RejectProxyIpsCidr) {
		return DecisionReject, "sender IP in reject_proxy_ips_cidr"
	}
	if p.DkimStrictness == "strict" && !ctx.HasDkim {
		return DecisionReject, "dkim required by strict policy"
	}
	if p.RejectNonCzOrigin && ctx.SenderOriginCountry != "" && !strings.EqualFold(ctx.SenderOriginCountry, "CZ") {
		return DecisionReject, "non-CZ origin disallowed"
	}
	if p.GreylistUnknownSender && !ctx.KnownSender {
		return DecisionGreylist, "greylist unknown sender"
	}
	if p.SpamClassifyLinkRatio > 0 && ctx.LinkRatio > p.SpamClassifyLinkRatio {
		return DecisionSpam, "link ratio exceeds spam threshold"
	}
	return DecisionAccept, ""
}

// Check is the JSON-friendly Verdict wrapper used by the HTTP handler. It
// decodes the raw map into a MessageContext, looks up the profile, and
// returns the decision + reason. Wraps Verdict so callers get a single
// entry point that respects the registry's RW lock.
func (r *Registry) Check(domain string, raw map[string]interface{}) (string, string, error) {
	r.mu.RLock()
	p, ok := r.profiles[strings.ToLower(domain)]
	r.mu.RUnlock()
	if !ok {
		return "", "", ErrUnknownDomain
	}
	ctx, err := decodeInto[MessageContext](raw)
	if err != nil {
		return "", "", err
	}
	d, reason := Verdict(p, ctx)
	return string(d), reason, nil
}

func ipInAnyCIDR(ipStr string, cidrs []string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	for _, c := range cidrs {
		_, ipnet, err := net.ParseCIDR(c)
		if err != nil {
			continue
		}
		if ipnet.Contains(ip) {
			return true
		}
	}
	return false
}
