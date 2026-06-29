package profile

import (
	"strings"
	"sync"
)

// QuotaTracker is a per-mailbox bytes-used counter. Profile.MailboxQuotaBytes
// caps the total; harness drivers call AddBytes when delivering, RemoveBytes
// when erasing, and Allow before delivering to know whether the next message
// would overflow.
//
// Unlike the rate tracker, quota state is not time-windowed — bytes
// accumulate until explicitly removed (e.g. mailbox cleanup) or Reset.
type QuotaTracker struct {
	mu    sync.Mutex
	usage map[string]int64
}

func NewQuotaTracker() *QuotaTracker {
	return &QuotaTracker{usage: map[string]int64{}}
}

// AddBytes increments the counter and returns post-add total. Negative
// inputs are ignored (use RemoveBytes for subtraction).
func (q *QuotaTracker) AddBytes(mailbox string, n int64) int64 {
	if n <= 0 {
		return q.Bytes(mailbox)
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	key := normalizeMailbox(mailbox)
	q.usage[key] += n
	return q.usage[key]
}

// RemoveBytes decrements; clamps at 0 (cannot go negative).
func (q *QuotaTracker) RemoveBytes(mailbox string, n int64) int64 {
	if n <= 0 {
		return q.Bytes(mailbox)
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	key := normalizeMailbox(mailbox)
	q.usage[key] -= n
	if q.usage[key] < 0 {
		q.usage[key] = 0
	}
	return q.usage[key]
}

// Bytes returns the current total for the mailbox.
func (q *QuotaTracker) Bytes(mailbox string) int64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.usage[normalizeMailbox(mailbox)]
}

// Allow tells whether incoming bytes would fit under the profile's
// mailbox_quota_bytes. Profiles with quota <= 0 are unlimited.
func (q *QuotaTracker) Allow(mailbox string, incoming int64, p *Profile) bool {
	if p == nil || p.MailboxQuotaBytes <= 0 {
		return true
	}
	return q.Bytes(mailbox)+incoming <= p.MailboxQuotaBytes
}

// Reset drops all tracked bytes — used between scenarios.
func (q *QuotaTracker) Reset() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.usage = map[string]int64{}
}

func normalizeMailbox(mailbox string) string {
	return strings.ToLower(strings.TrimSpace(mailbox))
}

// ── Registry-bound quota methods ───────────────────────────────────────

// QuotaAdd increments the mailbox's used bytes, returning post-add total
// and the profile's quota cap. Unknown domain → ErrUnknownDomain.
func (r *Registry) QuotaAdd(domain, mailbox string, bytes int64) (int64, int64, error) {
	r.mu.RLock()
	p, ok := r.profiles[strings.ToLower(domain)]
	r.mu.RUnlock()
	if !ok {
		return 0, 0, ErrUnknownDomain
	}
	used := r.quota.AddBytes(mailbox, bytes)
	return used, p.MailboxQuotaBytes, nil
}

// QuotaRemove decrements; clamps at 0.
func (r *Registry) QuotaRemove(domain, mailbox string, bytes int64) (int64, int64, error) {
	r.mu.RLock()
	p, ok := r.profiles[strings.ToLower(domain)]
	r.mu.RUnlock()
	if !ok {
		return 0, 0, ErrUnknownDomain
	}
	used := r.quota.RemoveBytes(mailbox, bytes)
	return used, p.MailboxQuotaBytes, nil
}

// QuotaUsage returns current bytes used + quota cap.
func (r *Registry) QuotaUsage(domain, mailbox string) (int64, int64, error) {
	r.mu.RLock()
	p, ok := r.profiles[strings.ToLower(domain)]
	r.mu.RUnlock()
	if !ok {
		return 0, 0, ErrUnknownDomain
	}
	return r.quota.Bytes(mailbox), p.MailboxQuotaBytes, nil
}

// QuotaAllow tells whether incoming bytes would fit.
func (r *Registry) QuotaAllow(domain, mailbox string, incoming int64) (bool, error) {
	r.mu.RLock()
	p, ok := r.profiles[strings.ToLower(domain)]
	r.mu.RUnlock()
	if !ok {
		return false, ErrUnknownDomain
	}
	return r.quota.Allow(mailbox, incoming, p), nil
}

// QuotaReset clears all tracked bytes.
func (r *Registry) QuotaReset() {
	r.quota.Reset()
}
