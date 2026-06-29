package wgpool

// Sprint AP4 — unit tests for Pool.RecordEgressObservation,
// DrainEgressObservations, and PeekEgressObservations.
//
// Tests: TC01–TC06 covering happy path, empty/missing args,
// ring-buffer cap eviction, drain/peek semantics, and race safety.

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func makeTestPool(t *testing.T) *Pool {
	t.Helper()
	p, err := New([]Endpoint{
		{Label: "cz1", SocksAddr: "127.0.0.1:10801", Country: "CZ"},
		{Label: "de1", SocksAddr: "127.0.0.1:10802", Country: "DE"},
	}, Config{})
	if err != nil {
		t.Fatalf("makeTestPool: %v", err)
	}
	return p
}

// TC01: RecordEgressObservation INSERTs row into ring buffer.
func TestRecordEgressObservation_Basic(t *testing.T) {
	p := makeTestPool(t)
	p.RecordEgressObservation("42", "CZ", "cz1", "send")

	obs := p.PeekEgressObservations()
	if len(obs) != 1 {
		t.Fatalf("expected 1 observation, got %d", len(obs))
	}
	got := obs[0]
	if got.MailboxID != "42" {
		t.Errorf("MailboxID = %q, want %q", got.MailboxID, "42")
	}
	if got.Country != "CZ" {
		t.Errorf("Country = %q, want %q", got.Country, "CZ")
	}
	if got.EndpointLabel != "cz1" {
		t.Errorf("EndpointLabel = %q, want %q", got.EndpointLabel, "cz1")
	}
	if got.OpType != "send" {
		t.Errorf("OpType = %q, want %q", got.OpType, "send")
	}
	if got.ObservedAt.IsZero() {
		t.Error("ObservedAt is zero")
	}
}

// TC02: Empty mailboxID or country → no-op.
func TestRecordEgressObservation_EmptyArgs(t *testing.T) {
	p := makeTestPool(t)

	p.RecordEgressObservation("", "CZ", "cz1", "send")   // empty mailboxID
	p.RecordEgressObservation("42", "", "cz1", "send")    // empty country

	obs := p.PeekEgressObservations()
	if len(obs) != 0 {
		t.Errorf("expected 0 observations for empty args, got %d", len(obs))
	}
}

// TC03: Ring buffer eviction — oldest entry dropped when at cap.
func TestRecordEgressObservation_RingCapEviction(t *testing.T) {
	p := makeTestPool(t)

	// Fill to cap + 1 using distinct mailbox IDs
	for i := 0; i < egressObsRingCap+1; i++ {
		p.RecordEgressObservation(fmt.Sprintf("%d", i), "CZ", "cz1", "send")
	}

	obs := p.PeekEgressObservations()
	if len(obs) != egressObsRingCap {
		t.Errorf("expected ring cap %d, got %d", egressObsRingCap, len(obs))
	}
	// First entry (mailbox_id=0) should be evicted; last entry (cap) should be present.
	last := obs[len(obs)-1]
	if last.MailboxID != fmt.Sprintf("%d", egressObsRingCap) {
		t.Errorf("last entry MailboxID = %q, want %q", last.MailboxID, fmt.Sprintf("%d", egressObsRingCap))
	}
}

// TC04: DrainEgressObservations returns all and clears the buffer.
func TestDrainEgressObservations_ClearsBuffer(t *testing.T) {
	p := makeTestPool(t)

	p.RecordEgressObservation("1", "CZ", "cz1", "send")
	p.RecordEgressObservation("2", "DE", "de1", "probe")

	drained := p.DrainEgressObservations()
	if len(drained) != 2 {
		t.Fatalf("expected 2 drained, got %d", len(drained))
	}

	// Buffer should be empty after drain
	remaining := p.PeekEgressObservations()
	if len(remaining) != 0 {
		t.Errorf("expected 0 remaining after drain, got %d", len(remaining))
	}
}

// TC05: PeekEgressObservations does NOT clear the buffer.
func TestPeekEgressObservations_NonDestructive(t *testing.T) {
	p := makeTestPool(t)
	p.RecordEgressObservation("99", "AT", "at1", "imap_poll")

	first := p.PeekEgressObservations()
	second := p.PeekEgressObservations()

	if len(first) != 1 || len(second) != 1 {
		t.Errorf("peek should be non-destructive: first=%d second=%d", len(first), len(second))
	}
}

// TC06: Concurrent RecordEgressObservation + DrainEgressObservations — race-clean.
func TestRecordEgressObservation_Concurrent(t *testing.T) {
	p := makeTestPool(t)

	const goroutines = 10
	const recsEach = 50

	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func(id int) {
			defer wg.Done()
			for j := 0; j < recsEach; j++ {
				p.RecordEgressObservation(fmt.Sprintf("%d", id*1000+j), "CZ", "cz1", "send")
			}
		}(i)
	}

	// Concurrent drainer
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 5; i++ {
			p.DrainEgressObservations()
			time.Sleep(time.Millisecond)
		}
	}()

	wg.Wait()
	// No panic/race = pass
}
