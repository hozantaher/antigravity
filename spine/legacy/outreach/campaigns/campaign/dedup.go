package campaign

import "strings"

const (
	// DefaultDomainCap is the maximum contacts from the same email domain
	// that may be enrolled in a single campaign tick.
	DefaultDomainCap = 3

	// HoldingClusterCap is the maximum contacts per parent_ico (holding
	// company) that may be sent to in a single campaign tick.
	HoldingClusterCap = 1

	// MaxPerDomainPerTick limits sends to the same domain in one scheduler tick.
	// Prevents reputation damage from bulk-hitting a single company domain.
	MaxPerDomainPerTick = 2

	// statusCheckEvery is how often (in successfully enqueued contacts) the
	// runner re-reads campaigns.status mid-tick to honor a UI Pause click.
	// Without this, a Pause issued during a tick that was about to enqueue
	// hundreds of contacts would not take effect until the next scheduler
	// interval. Set conservatively low (10) — at scheduler interval 60s
	// and tick LIMIT 500, this caps cost at ~50 extra COUNT queries per
	// tick worst case.
	statusCheckEvery = 10
)

// dedupContact carries the minimal fields needed by dedup functions.
type dedupContact struct {
	ContactID int64
	Email     string
	ParentICO string
}

// ApplyDomainCap returns a slice with at most cap contacts per email domain.
// Order is preserved (first cap contacts per domain are kept).
func ApplyDomainCap(contacts []dedupContact, cap int) []dedupContact {
	if cap <= 0 {
		return nil
	}
	seen := map[string]int{}
	out := make([]dedupContact, 0, len(contacts))
	for _, c := range contacts {
		d := extractEmailDomain(c.Email)
		if seen[d] < cap {
			out = append(out, c)
			seen[d]++
		}
	}
	return out
}

// ApplyHoldingCluster returns a slice with at most cap contacts per
// non-empty parent_ico. Contacts with empty parent_ico pass through
// unconditionally (they are standalone companies, not subsidiaries).
func ApplyHoldingCluster(contacts []dedupContact, cap int) []dedupContact {
	seen := map[string]int{}
	out := make([]dedupContact, 0, len(contacts))
	for _, c := range contacts {
		if c.ParentICO == "" {
			out = append(out, c)
			continue
		}
		if seen[c.ParentICO] < cap {
			out = append(out, c)
			seen[c.ParentICO]++
		}
	}
	return out
}

// extractEmailDomain returns the lowercase part after '@', or "" for malformed
// addresses. Lowercasing ensures that EXAMPLE.COM and example.com count as
// the same domain for all dedup and rotation gates.
func extractEmailDomain(email string) string {
	idx := strings.LastIndex(email, "@")
	if idx < 0 {
		return ""
	}
	return strings.ToLower(email[idx+1:])
}
