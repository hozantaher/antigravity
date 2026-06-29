package msgbus

import (
	"relay/internal/model"
	"context"
	"sync"
)

// Topics used in the relay pipeline.
const (
	TopicIntakeAccepted = "intake.accepted"
	TopicSanitized      = "sanitized"
	TopicSealed         = "sealed"
	TopicScheduled      = "scheduled"
	TopicRelayReady     = "relay.ready"
)

// Bus provides in-process pub/sub for the message relay pipeline.
// Uses Go channels -- no external broker needed.
type Bus interface {
	Publish(ctx context.Context, topic string, env model.Envelope) error
	Subscribe(topic string) <-chan model.Envelope
	Close()
}

// ChannelBus implements Bus using buffered Go channels.
type ChannelBus struct {
	mu          sync.RWMutex
	subscribers map[string][]chan model.Envelope
	bufferSize  int
	closed      bool
}

// NewChannelBus creates a new in-process message bus.
func NewChannelBus(bufferSize int) *ChannelBus {
	if bufferSize <= 0 {
		bufferSize = 64
	}
	return &ChannelBus{
		subscribers: make(map[string][]chan model.Envelope),
		bufferSize:  bufferSize,
	}
}

// Publish sends an envelope to all subscribers of the given topic.
func (b *ChannelBus) Publish(ctx context.Context, topic string, env model.Envelope) error {
	b.mu.RLock()
	defer b.mu.RUnlock()

	if b.closed {
		return context.Canceled
	}

	subs := b.subscribers[topic]
	for _, ch := range subs {
		select {
		case ch <- env:
		case <-ctx.Done():
			return ctx.Err()
		default:
			// Drop if subscriber is full (non-blocking to prevent pipeline stalls)
		}
	}
	return nil
}

// Subscribe returns a channel that receives envelopes published to the topic.
func (b *ChannelBus) Subscribe(topic string) <-chan model.Envelope {
	b.mu.Lock()
	defer b.mu.Unlock()

	ch := make(chan model.Envelope, b.bufferSize)
	b.subscribers[topic] = append(b.subscribers[topic], ch)
	return ch
}

// Close shuts down the bus and closes all subscriber channels.
func (b *ChannelBus) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.closed = true
	for topic, subs := range b.subscribers {
		for _, ch := range subs {
			close(ch)
		}
		delete(b.subscribers, topic)
	}
}
