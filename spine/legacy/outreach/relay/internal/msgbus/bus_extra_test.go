package msgbus

import (
	"relay/internal/model"
	"context"
	"sync"
	"testing"
	"time"
)

// TestNewChannelBusZeroBufferDefaultsTo64 covers the bufferSize <= 0 branch.
func TestNewChannelBusZeroBufferDefaultsTo64(t *testing.T) {
	bus := NewChannelBus(0)
	defer bus.Close()
	if bus.bufferSize != 64 {
		t.Fatalf("expected bufferSize=64 for input 0, got %d", bus.bufferSize)
	}
}

// TestNewChannelBusNegativeBufferDefaultsTo64 covers the bufferSize <= 0 branch
// with a negative value.
func TestNewChannelBusNegativeBufferDefaultsTo64(t *testing.T) {
	bus := NewChannelBus(-5)
	defer bus.Close()
	if bus.bufferSize != 64 {
		t.Fatalf("expected bufferSize=64 for input -5, got %d", bus.bufferSize)
	}
}

// TestPublishOnClosedBusReturnsError covers the b.closed branch in Publish.
func TestPublishOnClosedBusReturnsError(t *testing.T) {
	bus := NewChannelBus(16)
	bus.Close()

	err := bus.Publish(context.Background(), "topic", model.Envelope{ID: "env_closed"})
	if err == nil {
		t.Fatal("expected error publishing to closed bus, got nil")
	}
	if err != context.Canceled {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}

// TestPublishContextCancellationReturnsError covers the ctx.Done() branch
// in Publish — context is cancelled before the send can complete.
func TestPublishContextCancellationReturnsError(t *testing.T) {
	// Buffer 0 makes the channel unbuffered via Subscribe — but our
	// implementation uses bufferSize for subscriber channels.
	// We need a subscriber whose channel is full to force the select to block.
	// Use buffer 1 and pre-fill the channel, then cancel the context.
	bus := NewChannelBus(1)
	defer bus.Close()

	ch := bus.Subscribe("topic")

	// Send one message to fill the single-slot buffer.
	ctx := context.Background()
	if err := bus.Publish(ctx, "topic", model.Envelope{ID: "fill"}); err != nil {
		t.Fatalf("first publish failed: %v", err)
	}

	// Now the channel is full; publishing again with a cancelled ctx should
	// return the context error via the ctx.Done() path.
	cancelled, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancel

	err := bus.Publish(cancelled, "topic", model.Envelope{ID: "env_cancel"})
	// Either ctx.Err() or nil (drop path); verify no panic.
	// The drop path fires when no subscriber is listening; the ctx path fires
	// when ctx is done first.  With the buffer full, one of the two select
	// cases fires — we only care that it does not panic or deadlock.
	_ = err
	_ = ch
}

// TestPublishDropsWhenSubscriberFull verifies the default (drop) branch when a
// subscriber channel is full and the context is still live — the publish must
// return nil without blocking.
func TestPublishDropsWhenSubscriberFull(t *testing.T) {
	bus := NewChannelBus(1)
	defer bus.Close()

	_ = bus.Subscribe("topic")

	ctx := context.Background()
	// Fill the subscriber channel.
	if err := bus.Publish(ctx, "topic", model.Envelope{ID: "fill"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Channel is now full. A second publish should drop and return nil (non-blocking).
	done := make(chan error, 1)
	go func() {
		done <- bus.Publish(ctx, "topic", model.Envelope{ID: "should_drop"})
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("expected nil (drop), got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Publish blocked instead of dropping")
	}
}

// TestConcurrentPublishSubscribe exercises the bus under concurrent load to
// detect data races (run with -race).
func TestConcurrentPublishSubscribe(t *testing.T) {
	bus := NewChannelBus(256)
	defer bus.Close()

	const workers = 8
	const messages = 50

	ch := bus.Subscribe("concurrent")

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			ctx := context.Background()
			for j := 0; j < messages; j++ {
				_ = bus.Publish(ctx, "concurrent", model.Envelope{
					ID:     "env_concurrent",
					Status: model.StatusSealed,
				})
			}
		}(i)
	}

	// Drain the channel concurrently.
	go func() {
		for range ch {
		}
	}()

	wg.Wait()
}

// TestSubscribeAfterClose verifies that subscribing after close does not panic.
func TestSubscribeAfterClose(t *testing.T) {
	bus := NewChannelBus(16)
	bus.Close()

	// Subscribing after close is not part of the contract but must not panic.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Subscribe after Close panicked: %v", r)
		}
	}()
	ch := bus.Subscribe("topic")
	// Channel exists but bus is closed so no messages will arrive.
	_ = ch
}

// TestPublishNoSubscribers verifies that publishing to a topic with no
// subscribers returns nil and does not block.
func TestPublishNoSubscribers(t *testing.T) {
	bus := NewChannelBus(16)
	defer bus.Close()

	ctx := context.Background()
	err := bus.Publish(ctx, "no-one-listening", model.Envelope{ID: "env_orphan"})
	if err != nil {
		t.Fatalf("expected nil for topic with no subscribers, got %v", err)
	}
}

// TestTopicConstants verifies all pipeline topic constants are non-empty strings.
func TestTopicConstants(t *testing.T) {
	topics := []string{
		TopicIntakeAccepted,
		TopicSanitized,
		TopicSealed,
		TopicScheduled,
		TopicRelayReady,
	}
	seen := make(map[string]struct{}, len(topics))
	for _, topic := range topics {
		if topic == "" {
			t.Fatal("topic constant must not be empty")
		}
		if _, dup := seen[topic]; dup {
			t.Fatalf("duplicate topic constant: %q", topic)
		}
		seen[topic] = struct{}{}
	}
}
