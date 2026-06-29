package wgpool

// Tests for DrainEgressObservationsN (AP4-P3 peek/ack handshake).
//
// TC-DN01: DrainEgressObservationsN(N) removes exactly N from head
// TC-DN02: DrainEgressObservationsN(0) returns empty slice, buffer unchanged
// TC-DN03: DrainEgressObservationsN > buffer size → error, buffer unchanged
// TC-DN04: Sequential peek → ack clears only peeked count
// TC-DN05: New observations added between peek and ack are NOT drained

import (
	"testing"
)

func mustPoolDN(t *testing.T) *Pool {
	t.Helper()
	p, err := New([]Endpoint{
		{Label: "cz1", SocksAddr: "127.0.0.1:10801", Country: "CZ"},
	}, Config{})
	if err != nil {
		t.Fatalf("mustPoolDN: %v", err)
	}
	return p
}

// TC-DN01: DrainEgressObservationsN(2) with 5 in buffer → returns 2, leaves 3.
func TestDrainEgressObservationsN_DrainExactCount(t *testing.T) {
	p := mustPoolDN(t)
	for i := 0; i < 5; i++ {
		p.RecordEgressObservation("mb", "CZ", "cz1", "send")
	}

	got, err := p.DrainEgressObservationsN(2)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("drained %d, want 2", len(got))
	}

	remaining := p.PeekEgressObservations()
	if len(remaining) != 3 {
		t.Errorf("remaining = %d, want 3 after draining 2 of 5", len(remaining))
	}
}

// TC-DN02: DrainEgressObservationsN(0) → empty result, buffer unchanged.
func TestDrainEgressObservationsN_ZeroNoop(t *testing.T) {
	p := mustPoolDN(t)
	p.RecordEgressObservation("mb", "CZ", "cz1", "send")

	got, err := p.DrainEgressObservationsN(0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected empty slice for n=0, got %d", len(got))
	}
	if remaining := p.PeekEgressObservations(); len(remaining) != 1 {
		t.Errorf("buffer altered by n=0 drain: remaining=%d, want 1", len(remaining))
	}
}

// TC-DN03: ack > buffer size → error returned, buffer unchanged.
func TestDrainEgressObservationsN_AckExceedsBuffer_Error(t *testing.T) {
	p := mustPoolDN(t)
	p.RecordEgressObservation("mb", "CZ", "cz1", "send")
	p.RecordEgressObservation("mb", "DE", "de1", "probe")

	_, err := p.DrainEgressObservationsN(5) // only 2 in buffer
	if err == nil {
		t.Fatal("expected error when ack > buffer size, got nil")
	}

	// Buffer must be untouched after the rejected drain.
	remaining := p.PeekEgressObservations()
	if len(remaining) != 2 {
		t.Errorf("buffer corrupted after failed drain: remaining=%d, want 2", len(remaining))
	}
}

// TC-DN04: peek then ack=N clears exactly the peeked rows.
func TestDrainEgressObservationsN_PeekThenAck(t *testing.T) {
	p := mustPoolDN(t)
	for i := 0; i < 4; i++ {
		p.RecordEgressObservation("mb", "CZ", "cz1", "send")
	}

	// Step 1: peek (non-destructive)
	peeked := p.PeekEgressObservations()
	if len(peeked) != 4 {
		t.Fatalf("peek returned %d, want 4", len(peeked))
	}

	// Simulate BFF INSERT succeeds → ack
	drained, err := p.DrainEgressObservationsN(len(peeked))
	if err != nil {
		t.Fatalf("ack drain error: %v", err)
	}
	if len(drained) != 4 {
		t.Errorf("ack returned %d rows, want 4", len(drained))
	}

	// Buffer should be empty now.
	remaining := p.PeekEgressObservations()
	if len(remaining) != 0 {
		t.Errorf("remaining = %d after ack, want 0", len(remaining))
	}
}

// TC-DN05: observations added between peek and ack are NOT consumed by ack.
func TestDrainEgressObservationsN_NewObsAfterPeekSurviveAck(t *testing.T) {
	p := mustPoolDN(t)
	p.RecordEgressObservation("mb", "CZ", "cz1", "send")
	p.RecordEgressObservation("mb", "DE", "de1", "probe")

	// Step 1: peek 2 rows
	peeked := p.PeekEgressObservations()
	if len(peeked) != 2 {
		t.Fatalf("peek = %d, want 2", len(peeked))
	}

	// Simulate a new observation arriving between peek and ack.
	p.RecordEgressObservation("mb", "AT", "at1", "send")

	// Step 2: ack only the 2 we peeked — 3rd (AT) must survive.
	_, err := p.DrainEgressObservationsN(2)
	if err != nil {
		t.Fatalf("ack drain error: %v", err)
	}

	remaining := p.PeekEgressObservations()
	if len(remaining) != 1 {
		t.Errorf("remaining = %d after partial ack, want 1 (the AT obs)", len(remaining))
	}
	if remaining[0].Country != "AT" {
		t.Errorf("remaining obs country = %q, want AT", remaining[0].Country)
	}
}
