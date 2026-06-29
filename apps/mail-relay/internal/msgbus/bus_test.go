package msgbus

import (
	"relay/internal/model"
	"context"
	"testing"
	"time"
)

func TestPublishSubscribe(t *testing.T) {
	bus := NewChannelBus(16)
	defer bus.Close()

	ch := bus.Subscribe("test.topic")
	env := model.Envelope{ID: "env_test", Status: model.StatusSealed}

	ctx := context.Background()
	if err := bus.Publish(ctx, "test.topic", env); err != nil {
		t.Fatal(err)
	}

	select {
	case received := <-ch:
		if received.ID != "env_test" {
			t.Fatalf("expected env_test, got %s", received.ID)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for message")
	}
}

func TestMultipleSubscribers(t *testing.T) {
	bus := NewChannelBus(16)
	defer bus.Close()

	ch1 := bus.Subscribe("topic")
	ch2 := bus.Subscribe("topic")

	ctx := context.Background()
	bus.Publish(ctx, "topic", model.Envelope{ID: "env_multi"})

	for _, ch := range []<-chan model.Envelope{ch1, ch2} {
		select {
		case msg := <-ch:
			if msg.ID != "env_multi" {
				t.Fatalf("wrong ID: %s", msg.ID)
			}
		case <-time.After(time.Second):
			t.Fatal("timeout")
		}
	}
}

func TestTopicIsolation(t *testing.T) {
	bus := NewChannelBus(16)
	defer bus.Close()

	chA := bus.Subscribe("topic.a")
	chB := bus.Subscribe("topic.b")

	ctx := context.Background()
	bus.Publish(ctx, "topic.a", model.Envelope{ID: "env_a"})

	select {
	case <-chA:
		// expected
	case <-time.After(time.Second):
		t.Fatal("topic.a subscriber didn't receive")
	}

	select {
	case <-chB:
		t.Fatal("topic.b subscriber should not receive topic.a message")
	case <-time.After(50 * time.Millisecond):
		// expected
	}
}

func TestCloseSignalsSubscribers(t *testing.T) {
	bus := NewChannelBus(16)
	ch := bus.Subscribe("topic")
	bus.Close()

	_, ok := <-ch
	if ok {
		t.Fatal("expected channel to be closed")
	}
}
