package watchdog

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestEvaluateCircuit_Closed_BelowThreshold(t *testing.T) {
	now := time.Now()
	action, _ := EvaluateCircuit(CircuitBreakerState{}, 4, now, CircuitBreakerConfig{})
	if action != CircuitNone {
		t.Fatalf("action = %v, want CircuitNone", action)
	}
}

func TestEvaluateCircuit_Closed_HitsThreshold_Trips(t *testing.T) {
	now := time.Now()
	action, reason := EvaluateCircuit(CircuitBreakerState{}, 5, now, CircuitBreakerConfig{})
	if action != CircuitTrip {
		t.Fatalf("action = %v, want CircuitTrip", action)
	}
	if reason == "" {
		t.Fatalf("reason is empty")
	}
}

func TestEvaluateCircuit_Open_StillInCooldown(t *testing.T) {
	now := time.Now()
	opened := now.Add(-5 * time.Minute)
	action, _ := EvaluateCircuit(
		CircuitBreakerState{CircuitOpenedAt: &opened},
		10, now, CircuitBreakerConfig{PauseDuration: 15 * time.Minute},
	)
	if action != CircuitNone {
		t.Fatalf("action = %v, want CircuitNone (still in cooldown)", action)
	}
}

func TestEvaluateCircuit_Open_CooldownElapsed_Closes(t *testing.T) {
	now := time.Now()
	opened := now.Add(-20 * time.Minute)
	action, _ := EvaluateCircuit(
		CircuitBreakerState{CircuitOpenedAt: &opened},
		0, now, CircuitBreakerConfig{PauseDuration: 15 * time.Minute},
	)
	if action != CircuitClose {
		t.Fatalf("action = %v, want CircuitClose", action)
	}
}

func TestEvaluateCircuit_UsesDefaults_OnZeroConfig(t *testing.T) {
	// Zero config should apply 5 fail threshold.
	now := time.Now()
	action, _ := EvaluateCircuit(CircuitBreakerState{}, 5, now, CircuitBreakerConfig{})
	if action != CircuitTrip {
		t.Fatalf("zero config should trip at 5 fails, got %v", action)
	}
}

// fakeCircuitStore is an in-memory CircuitBreakerStore for Daemon tests.
type fakeCircuitStore struct {
	mu     sync.Mutex
	states map[int64]CircuitBreakerState
}

func newFakeCircuitStore() *fakeCircuitStore {
	return &fakeCircuitStore{states: make(map[int64]CircuitBreakerState)}
}

func (f *fakeCircuitStore) GetState(_ context.Context, id int64) (CircuitBreakerState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.states[id]
	if !ok {
		return CircuitBreakerState{MailboxID: id}, nil
	}
	return s, nil
}

func (f *fakeCircuitStore) TripCircuit(_ context.Context, id int64, at time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.states[id]
	s.MailboxID = id
	s.CircuitOpenedAt = &at
	s.CircuitTripCount++
	f.states[id] = s
	return nil
}

func (f *fakeCircuitStore) CloseCircuit(_ context.Context, id int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.states[id]
	s.MailboxID = id
	s.CircuitOpenedAt = nil
	f.states[id] = s
	return nil
}
