package wgpool

import (
	"errors"
	"fmt"
)

// ErrPinnedEndpointQuarantined is returned by Pick when the mailbox has a
// pinned endpoint that is currently quarantined. The relay MUST refuse
// delivery — never fallback to another endpoint.
var ErrPinnedEndpointQuarantined = errors.New("wgpool: pinned endpoint quarantined")

// ErrPinnedEndpointMissing is returned by Pick when the mailbox's pinned
// endpoint label is not in the pool (pool config change after pinning).
var ErrPinnedEndpointMissing = errors.New("wgpool: pinned endpoint not found in pool")

// ErrDBWriterUnavailable is returned by SetPin when no DB writer was wired.
var ErrDBWriterUnavailable = errors.New("wgpool: db writer not configured")

// PinReader provides read-only access to the per-mailbox egress pin stored
// in the database. Implementations must be safe for concurrent use.
type PinReader interface {
	// GetMailboxPinnedEndpoint returns the pinned_endpoint_label for the
	// given mailbox ID, or ("", nil) when no pin is set.
	GetMailboxPinnedEndpoint(mailboxID string) (label string, err error)

	// GetAllPinnedLabels returns the set of distinct pinned_endpoint_label
	// values currently assigned to any mailbox. Used by pickAllocate to
	// determine which endpoints are free.
	//
	// SELECT DISTINCT pinned_endpoint_label
	//   FROM outreach_mailboxes
	//  WHERE pinned_endpoint_label IS NOT NULL
	GetAllPinnedLabels() (labels []string, err error)
}

// PinWriter provides write access to persist the per-mailbox egress pin.
// Implementations must be safe for concurrent use.
type PinWriter interface {
	// SetMailboxPin records endpointLabel as the permanent egress for
	// mailboxID. First-call wins: if a pin is already set and force is
	// false, the call is a no-op. When force is true (operator repin), the
	// old value is overwritten and an audit row is inserted.
	//
	// actor identifies the caller ("drain_first_send", "probe_first", or
	// an operator user ID for forced repins).
	SetMailboxPin(mailboxID, endpointLabel, actor string) error
}

// findEndpointByLabel scans the pool's endpoint list for the given label.
// Must be called with pool.mu held.
func (p *Pool) findEndpointByLabel(label string) (Endpoint, bool) {
	for _, ep := range p.endpoints {
		if ep.Label == label {
			return ep, true
		}
	}
	return Endpoint{}, false
}

// LabelBySocksAddr returns the endpoint label for the given SOCKS5 address.
// Returns "" when not found.
func (p *Pool) LabelBySocksAddr(socksAddr string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, ep := range p.endpoints {
		if ep.SocksAddr == socksAddr {
			return ep.Label
		}
	}
	return ""
}

// WithPinReader wires a PinReader into the pool so Pick can enforce the
// per-mailbox egress pin. Call once before first Pick.
func (p *Pool) WithPinReader(r PinReader) *Pool {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pinReader = r
	return p
}

// WithPinWriter wires a PinWriter into the pool so SetPin can persist the
// chosen endpoint. Call once before first send.
func (p *Pool) WithPinWriter(w PinWriter) *Pool {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pinWriter = w
	return p
}

// SetPin records endpointLabel as the permanent egress for mailboxID.
// First successful SetPin wins (DB UNIQUE or atomic UPDATE). Subsequent
// calls with force=false are NOOP.
//
// actor identifies the call site:
//   - "drain_first_send"  — called by processDrainEnvelope on first delivery
//   - "probe_first"       — called by smtpAuthProbe on first successful probe
//   - operator UID        — called by POST /api/mailboxes/:id/repin
func (p *Pool) SetPin(mailboxID, endpointLabel, actor string) error {
	p.mu.Lock()
	w := p.pinWriter
	p.mu.Unlock()

	if w == nil {
		return ErrDBWriterUnavailable
	}
	return w.SetMailboxPin(mailboxID, endpointLabel, actor)
}

// pickPinned checks whether mailboxID has a persisted pin and, if so,
// returns the pinned endpoint (or an error when quarantined / missing).
//
// Returns (Endpoint{}, false, nil) when no pin is set — caller should
// proceed with the normal country-filter + hash-rotate logic.
// Returns (ep, true, nil) when the pin is satisfied.
// Returns (Endpoint{}, true, err) when the pin is set but unusable; the
// caller MUST propagate the error without fallback.
//
// Must be called with p.mu held.
func (p *Pool) pickPinned(mailboxID string) (Endpoint, bool, error) {
	if mailboxID == "" || p.pinReader == nil {
		return Endpoint{}, false, nil
	}

	// Read outside the lock to avoid holding p.mu across a DB call.
	// The unlock/relock pattern is safe because we never mutate pool state
	// based on the pin; we only read the endpoint list.
	p.mu.Unlock()
	pinnedLabel, err := p.pinReader.GetMailboxPinnedEndpoint(mailboxID)
	p.mu.Lock()

	if err != nil || pinnedLabel == "" {
		return Endpoint{}, false, nil
	}

	ep, found := p.findEndpointByLabel(pinnedLabel)
	if !found {
		return Endpoint{}, true, fmt.Errorf("pinned endpoint %q not in pool: %w", pinnedLabel, ErrPinnedEndpointMissing)
	}
	h, ok := p.health[pinnedLabel]
	if ok && h.Quarantined {
		return Endpoint{}, true, fmt.Errorf("pinned endpoint %q quarantined: %w", pinnedLabel, ErrPinnedEndpointQuarantined)
	}
	return ep, true, nil
}
