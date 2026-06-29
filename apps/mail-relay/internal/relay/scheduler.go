package relay

import (
	"relay/internal/filestore"
	"relay/internal/model"
	"context"
	"crypto/rand"
	"encoding/binary"
	"sync"
	"time"
)

// Scheduler manages store-and-forward relay with random delays.
// Envelopes are persisted and scheduled for future delivery to resist timing analysis.
type Scheduler struct {
	mu        sync.RWMutex
	path      string
	codec     filestore.Codec
	envelopes []model.Envelope
	minDelay  time.Duration
	maxDelay  time.Duration
	retention time.Duration
	now       func() time.Time
}

// NewScheduler creates a relay scheduler with configurable random delay bounds.
func NewScheduler(path string, codec filestore.Codec, minDelay, maxDelay, retention time.Duration) (*Scheduler, error) {
	s := &Scheduler{
		path:      path,
		codec:     codec,
		minDelay:  minDelay,
		maxDelay:  maxDelay,
		retention: retention,
		now:       time.Now,
	}
	if err := filestore.ReadJSON(path, codec, &s.envelopes); err != nil {
		return nil, err
	}
	return s, nil
}

// Schedule assigns a random future relay time to an envelope and persists it.
func (s *Scheduler) Schedule(ctx context.Context, env model.Envelope) (time.Time, error) {
	delay, err := cryptoRandDuration(s.minDelay, s.maxDelay)
	if err != nil {
		return time.Time{}, err
	}

	scheduledAt := s.now().Add(delay)
	env.ScheduledAt = scheduledAt
	env.Status = model.StatusScheduled

	s.mu.Lock()
	defer s.mu.Unlock()

	s.envelopes = append(s.envelopes, env)
	if err := s.persist(); err != nil {
		return time.Time{}, err
	}
	return scheduledAt, nil
}

// DrainReady returns all envelopes whose scheduled time has passed.
// They are removed from the store.
func (s *Scheduler) DrainReady(ctx context.Context) ([]model.Envelope, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	var ready, remaining []model.Envelope

	for _, env := range s.envelopes {
		if env.Status == model.StatusScheduled && !env.ScheduledAt.After(now) {
			ready = append(ready, env)
		} else {
			remaining = append(remaining, env)
		}
	}

	if len(ready) > 0 {
		s.envelopes = remaining
		if err := s.persist(); err != nil {
			return nil, err
		}
	}

	return ready, nil
}

// PendingCount returns the number of envelopes waiting to be relayed.
func (s *Scheduler) PendingCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	count := 0
	for _, env := range s.envelopes {
		if env.Status == model.StatusScheduled {
			count++
		}
	}
	return count
}

// PendingEnvelopes returns a snapshot of all currently scheduled envelopes.
// The returned slice is a copy; callers must not mutate its elements.
func (s *Scheduler) PendingEnvelopes() []model.Envelope {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.Envelope, 0, len(s.envelopes))
	for _, env := range s.envelopes {
		if env.Status == model.StatusScheduled {
			out = append(out, env)
		}
	}
	return out
}

// OldestPendingAge returns the age of the oldest scheduled envelope (time since BucketedAt).
// Returns -1 if there are no pending envelopes.
func (s *Scheduler) OldestPendingAge() time.Duration {
	s.mu.RLock()
	defer s.mu.RUnlock()
	oldest := time.Duration(-1)
	now := s.now()
	for _, env := range s.envelopes {
		if env.Status != model.StatusScheduled {
			continue
		}
		age := now.Sub(env.BucketedAt)
		if oldest < 0 || age > oldest {
			oldest = age
		}
	}
	return oldest
}

// MarkRelayed updates an envelope's status after successful delivery.
func (s *Scheduler) MarkRelayed(ctx context.Context, envID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.envelopes {
		if s.envelopes[i].ID == envID {
			s.envelopes[i].Status = model.StatusRelayed
			s.envelopes[i].RelayedAt = s.now()
			return s.persist()
		}
	}
	return nil
}

// MarkFailed updates an envelope's status after a delivery failure.
func (s *Scheduler) MarkFailed(ctx context.Context, envID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.envelopes {
		if s.envelopes[i].ID == envID {
			s.envelopes[i].Status = model.StatusFailed
			return s.persist()
		}
	}
	return nil
}

// Reschedule re-queues an envelope after a transient (greylist) delivery
// failure. The envelope's status returns to StatusScheduled, ScheduledAt is
// set to nextAttemptAt, Attempts is incremented, and LastError captures a
// truncated form of the failure reason for diagnosis.
//
// The envelope is restored to the queue if it is no longer present (which
// happens when DrainReady removed it earlier in the same loop). If the
// envelope is still in the queue (e.g. a different code path), its row is
// updated in place.
//
// Sprint AW7-5: enables auto-retry for 4xx transient SMTP errors.
func (s *Scheduler) Reschedule(ctx context.Context, env model.Envelope, nextAttemptAt time.Time, lastErr string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	const lastErrCap = 256
	if len(lastErr) > lastErrCap {
		lastErr = lastErr[:lastErrCap]
	}

	// Update in place if the envelope is still tracked.
	for i := range s.envelopes {
		if s.envelopes[i].ID == env.ID {
			s.envelopes[i].Status = model.StatusScheduled
			s.envelopes[i].ScheduledAt = nextAttemptAt
			s.envelopes[i].NextAttemptAt = nextAttemptAt
			s.envelopes[i].Attempts = env.Attempts
			s.envelopes[i].LastError = lastErr
			return s.persist()
		}
	}

	// Not present → re-insert (the common path: DrainReady removed it).
	env.Status = model.StatusScheduled
	env.ScheduledAt = nextAttemptAt
	env.NextAttemptAt = nextAttemptAt
	env.LastError = lastErr
	s.envelopes = append(s.envelopes, env)
	return s.persist()
}

func (s *Scheduler) persist() error {
	s.pruneExpired()
	return filestore.WriteJSONAtomic(s.path, s.codec, s.envelopes)
}

func (s *Scheduler) pruneExpired() {
	if s.retention <= 0 {
		return
	}
	cutoff := s.now().Add(-s.retention)
	kept := s.envelopes[:0]
	for _, env := range s.envelopes {
		if env.BucketedAt.After(cutoff) {
			kept = append(kept, env)
		}
	}
	s.envelopes = kept
}

// cryptoRandDuration returns a random duration between min and max using crypto/rand.
func cryptoRandDuration(min, max time.Duration) (time.Duration, error) {
	if max <= min {
		return min, nil
	}
	rangeNanos := max - min
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return 0, err
	}
	n := binary.BigEndian.Uint64(buf[:])
	offset := time.Duration(n % uint64(rangeNanos))
	return min + offset, nil
}
