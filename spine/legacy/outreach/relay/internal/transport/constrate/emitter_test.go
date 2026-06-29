package constrate

import (
	"relay/internal/minlog"
	"relay/internal/model"
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type mockSource struct {
	mu       sync.Mutex
	messages []model.Envelope
}

func (m *mockSource) Requeue(env model.Envelope) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.messages = append(m.messages, env)
}

func (m *mockSource) Draw() (model.Envelope, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.messages) == 0 {
		return model.Envelope{IsCover: true, ID: "cover"}, false
	}
	env := m.messages[0]
	m.messages = m.messages[1:]
	return env, true
}

type mockSender struct {
	sent      []model.Envelope
	mu        sync.Mutex
	sendCount atomic.Int64
}

func (m *mockSender) Send(ctx context.Context, env model.Envelope) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sent = append(m.sent, env)
	m.sendCount.Add(1)
	return nil
}

func TestEmitterConstantRate(t *testing.T) {
	source := &mockSource{}
	sender := &mockSender{}
	logger := minlog.New("test")

	emitter := NewEmitter(50*time.Millisecond, source, sender, logger)

	ctx, cancel := context.WithCancel(context.Background())
	go emitter.Run(ctx)

	// Let it run for ~250ms (should emit ~5 messages at 50ms intervals)
	time.Sleep(275 * time.Millisecond)
	cancel()
	time.Sleep(10 * time.Millisecond)

	count := sender.sendCount.Load()
	// Should have emitted approximately 5 messages (±1 for timing)
	if count < 4 || count > 7 {
		t.Fatalf("expected ~5 emissions in 250ms at 50ms interval, got %d", count)
	}
}

func TestEmitterSendsRealWhenAvailable(t *testing.T) {
	source := &mockSource{
		messages: []model.Envelope{
			{ID: "env_real_1"},
			{ID: "env_real_2"},
		},
	}
	sender := &mockSender{}
	logger := minlog.New("test")

	emitter := NewEmitter(20*time.Millisecond, source, sender, logger)

	ctx, cancel := context.WithCancel(context.Background())
	go emitter.Run(ctx)

	time.Sleep(120 * time.Millisecond)
	cancel()
	time.Sleep(10 * time.Millisecond)

	sender.mu.Lock()
	defer sender.mu.Unlock()

	realCount := 0
	coverCount := 0
	for _, env := range sender.sent {
		if env.IsCover {
			coverCount++
		} else {
			realCount++
		}
	}

	if realCount != 2 {
		t.Fatalf("expected 2 real messages, got %d", realCount)
	}
	if coverCount == 0 {
		t.Fatal("expected some cover traffic after real messages exhausted")
	}
}

func TestEmitterSendsCoverWhenEmpty(t *testing.T) {
	source := &mockSource{} // empty
	sender := &mockSender{}
	logger := minlog.New("test")

	emitter := NewEmitter(20*time.Millisecond, source, sender, logger)

	ctx, cancel := context.WithCancel(context.Background())
	go emitter.Run(ctx)

	time.Sleep(100 * time.Millisecond)
	cancel()
	time.Sleep(10 * time.Millisecond)

	sender.mu.Lock()
	defer sender.mu.Unlock()

	for _, env := range sender.sent {
		if !env.IsCover {
			t.Fatal("expected only cover traffic when source is empty")
		}
	}

	if len(sender.sent) < 3 {
		t.Fatalf("expected at least 3 cover emissions, got %d", len(sender.sent))
	}
}

func TestEmitterStats(t *testing.T) {
	source := &mockSource{
		messages: []model.Envelope{{ID: "env_1"}, {ID: "env_2"}},
	}
	sender := &mockSender{}
	logger := minlog.New("test")

	emitter := NewEmitter(20*time.Millisecond, source, sender, logger)

	ctx, cancel := context.WithCancel(context.Background())
	go emitter.Run(ctx)

	time.Sleep(120 * time.Millisecond)
	cancel()
	time.Sleep(10 * time.Millisecond)

	stats := emitter.Stats()
	if stats.RealEmitted != 2 {
		t.Fatalf("expected 2 real emitted, got %d", stats.RealEmitted)
	}
	if stats.CoverEmitted == 0 {
		t.Fatal("expected some cover emitted")
	}
	if stats.TotalEmitted != stats.RealEmitted+stats.CoverEmitted {
		t.Fatal("total should equal real + cover")
	}
}
