package inbox

import (
	"context"
	"sort"
	"sync"
	"time"

	"privacy-gateway/internal/filestore"
	"privacy-gateway/internal/model"
)

type Store struct {
	mu        sync.RWMutex
	path      string
	codec     filestore.Codec
	now       func() time.Time
	retention time.Duration
	messages  []model.InboxMessage
}

func NewStore(path string) (*Store, error) {
	return NewStoreWithCodec(path, filestore.DefaultCodec())
}

func NewStoreWithCodec(path string, codec filestore.Codec) (*Store, error) {
	return NewStoreWithCodecAndRetention(path, codec, 0)
}

func NewStoreWithCodecAndRetention(path string, codec filestore.Codec, retention time.Duration) (*Store, error) {
	var messages []model.InboxMessage
	if err := filestore.ReadJSONWithCodec(path, &messages, codec); err != nil {
		return nil, err
	}

	return &Store{
		path:      path,
		codec:     codec,
		now:       time.Now,
		retention: retention,
		messages:  cloneMessages(messages),
	}, nil
}

func (s *Store) Save(_ context.Context, msg model.InboxMessage) (model.InboxMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	next := s.prunedMessagesLocked()
	if msg.ReceivedAt.IsZero() {
		msg.ReceivedAt = s.now().UTC()
	}

	updated := false
	for index, existing := range next {
		if existing.ID == msg.ID {
			next[index] = msg
			updated = true
			break
		}
	}
	if !updated {
		next = append(next, msg)
	}

	sort.SliceStable(next, func(left, right int) bool {
		if next[left].ReceivedAt.Equal(next[right].ReceivedAt) {
			return next[left].ID > next[right].ID
		}
		return next[left].ReceivedAt.After(next[right].ReceivedAt)
	})

	if err := filestore.WriteJSONAtomicWithCodec(s.path, next, s.codec); err != nil {
		return model.InboxMessage{}, err
	}

	s.messages = next
	return msg, nil
}

func (s *Store) ListByActor(_ context.Context, actor model.Actor) ([]model.InboxMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	next := s.prunedMessagesLocked()
	if len(next) != len(s.messages) && s.path != "" {
		if err := filestore.WriteJSONAtomicWithCodec(s.path, next, s.codec); err != nil {
			return nil, err
		}
		s.messages = next
	}

	out := make([]model.InboxMessage, 0, len(next))
	for _, msg := range next {
		if msg.UserID == actor.ID && msg.TenantID == actor.TenantID {
			out = append(out, msg)
		}
	}
	return out, nil
}

func (s *Store) prunedMessagesLocked() []model.InboxMessage {
	next := cloneMessages(s.messages)
	if s.retention <= 0 {
		return next
	}
	cutoff := s.now().UTC().Add(-s.retention)
	filtered := next[:0]
	for _, msg := range next {
		if msg.ReceivedAt.IsZero() || !msg.ReceivedAt.Before(cutoff) {
			filtered = append(filtered, msg)
		}
	}
	return append([]model.InboxMessage(nil), filtered...)
}

func cloneMessages(messages []model.InboxMessage) []model.InboxMessage {
	return append([]model.InboxMessage(nil), messages...)
}
