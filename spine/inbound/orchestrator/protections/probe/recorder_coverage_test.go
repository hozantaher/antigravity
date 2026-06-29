package probe

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// ---- marshalJSON / unmarshalJSON / nullString ----

func TestMarshalJSON_Nil(t *testing.T) {
	b, err := marshalJSON(nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "{}" {
		t.Fatalf("want {}, got %s", b)
	}
}

func TestMarshalJSON_Empty(t *testing.T) {
	b, err := marshalJSON(map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "{}" {
		t.Fatalf("want {}, got %s", b)
	}
}

func TestMarshalJSON_Populated(t *testing.T) {
	b, err := marshalJSON(map[string]any{"k": "v"})
	if err != nil {
		t.Fatal(err)
	}
	if len(b) == 0 {
		t.Fatal("expected non-empty JSON")
	}
}

func TestUnmarshalJSON_Empty(t *testing.T) {
	if unmarshalJSON("") != nil {
		t.Fatal("expected nil on empty string")
	}
}

func TestUnmarshalJSON_Valid(t *testing.T) {
	m := unmarshalJSON(`{"x":1}`)
	if m == nil || m["x"] == nil {
		t.Fatal("expected parsed map with key x")
	}
}

func TestUnmarshalJSON_Invalid(t *testing.T) {
	if unmarshalJSON("not-json") != nil {
		t.Fatal("expected nil on invalid JSON")
	}
}

func TestNullString_Empty(t *testing.T) {
	if nullString("") != nil {
		t.Fatal("expected nil for empty string")
	}
}

func TestNullString_NonEmpty(t *testing.T) {
	v := nullString("hello")
	if v != "hello" {
		t.Fatalf("expected \"hello\", got %v", v)
	}
}

// ---- AlertingSink ----

type fakeEvaluator struct {
	mu     sync.Mutex
	called bool
	layer  string
	level  int
	retErr error
}

func (f *fakeEvaluator) EvaluateLayer(_ context.Context, layer string, level int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.called = true
	f.layer = layer
	f.level = level
	return f.retErr
}

type fakeSink struct {
	retErr error
}

func (f *fakeSink) Write(_ context.Context, _ Result) error { return f.retErr }

func TestAlertingSink_SuccessCallsEvaluator(t *testing.T) {
	eval := &fakeEvaluator{}
	sink := &AlertingSink{Inner: &fakeSink{}, Evaluator: eval}
	r := Result{Layer: "anti_trace", Level: LevelAlive, Status: StatusOK}
	if err := sink.Write(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	// goroutine async — poll briefly
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		eval.mu.Lock()
		called := eval.called
		eval.mu.Unlock()
		if called {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	eval.mu.Lock()
	defer eval.mu.Unlock()
	if !eval.called {
		t.Fatal("evaluator not called after successful write")
	}
	if eval.layer != "anti_trace" {
		t.Fatalf("wrong layer: %s", eval.layer)
	}
	if eval.level != int(LevelAlive) {
		t.Fatalf("wrong level: %d", eval.level)
	}
}

func TestAlertingSink_ErrorSkipsEvaluator(t *testing.T) {
	eval := &fakeEvaluator{}
	sink := &AlertingSink{Inner: &fakeSink{retErr: errors.New("db down")}, Evaluator: eval}
	r := Result{Layer: "watchdog", Level: LevelAlive, Status: StatusErr}
	if err := sink.Write(context.Background(), r); err == nil {
		t.Fatal("expected error from inner sink")
	}
	time.Sleep(50 * time.Millisecond)
	eval.mu.Lock()
	defer eval.mu.Unlock()
	if eval.called {
		t.Fatal("evaluator must not be called when inner fails")
	}
}

func TestAlertingSink_NilEvaluatorNoPanic(t *testing.T) {
	sink := &AlertingSink{Inner: &fakeSink{}, Evaluator: nil}
	r := Result{Layer: "db_pool", Level: LevelAlive, Status: StatusOK}
	if err := sink.Write(context.Background(), r); err != nil {
		t.Fatal("nil evaluator must not panic or error")
	}
}

// ---- MetricsSink ----

func TestMetricsSink_DelegatesAndRecords(t *testing.T) {
	sink := &MetricsSink{Inner: &fakeSink{}}
	r := Result{
		Layer:   "watchdog",
		Level:   LevelAlive,
		Status:  StatusOK,
		Latency: 42 * time.Millisecond,
	}
	if err := sink.Write(context.Background(), r); err != nil {
		t.Fatal(err)
	}
}

func TestMetricsSink_PropagatesError(t *testing.T) {
	sink := &MetricsSink{Inner: &fakeSink{retErr: errors.New("fail")}}
	r := Result{Layer: "db_pool", Level: LevelAlive, Status: StatusErr, Latency: time.Millisecond}
	if err := sink.Write(context.Background(), r); err == nil {
		t.Fatal("expected error propagation from inner")
	}
}

func TestMetricsSink_ZeroLatency(t *testing.T) {
	sink := &MetricsSink{Inner: &fakeSink{}}
	r := Result{Layer: "header_gate", Level: LevelCorrect, Status: StatusSkip}
	if err := sink.Write(context.Background(), r); err != nil {
		t.Fatal(err)
	}
}
