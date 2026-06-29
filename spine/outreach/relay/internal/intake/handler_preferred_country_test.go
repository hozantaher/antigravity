package intake

import (
	"relay/internal/model"
	"relay/internal/msgbus"
	"context"
	"testing"
)

// TestProcess_PreferredCountry_PropagatedToEnvelope verifies that
// IntakeRequest.PreferredCountry is copied to the Envelope published to the
// message bus.
func TestProcess_PreferredCountry_PropagatedToEnvelope(t *testing.T) {
	p, bus := testPipeline(t)
	sub := bus.Subscribe(msgbus.TopicSealed)

	req := model.IntakeRequest{
		Recipient:        "to@example.com",
		Subject:          "Test egress pin",
		Body:             "hello",
		FromAddress:      "from@test.cz",
		PreferredCountry: "SK",
	}

	actor := model.Actor{ID: "actor-1", TenantID: "tenant-1"}
	result, err := p.Process(context.Background(), actor, req, "http")
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if result.EnvelopeID == "" {
		t.Fatal("expected non-empty envelope_id")
	}

	select {
	case env := <-sub:
		if env.PreferredCountry != "SK" {
			t.Fatalf("expected PreferredCountry=SK, got %q", env.PreferredCountry)
		}
	default:
		t.Fatal("no message published to bus")
	}
}

// TestProcess_PreferredCountry_EmptyPreserved verifies that when
// PreferredCountry is empty, the envelope also has empty PreferredCountry.
func TestProcess_PreferredCountry_EmptyPreserved(t *testing.T) {
	p, bus := testPipeline(t)
	sub := bus.Subscribe(msgbus.TopicSealed)

	req := model.IntakeRequest{
		Recipient:   "to@example.com",
		Subject:     "No egress pin",
		Body:        "hello",
		FromAddress: "from@test.cz",
		// PreferredCountry intentionally empty
	}

	actor := model.Actor{ID: "actor-2", TenantID: "tenant-2"}
	result, err := p.Process(context.Background(), actor, req, "http")
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if result.EnvelopeID == "" {
		t.Fatal("expected non-empty envelope_id")
	}

	select {
	case env := <-sub:
		if env.PreferredCountry != "" {
			t.Fatalf("expected empty PreferredCountry, got %q", env.PreferredCountry)
		}
	default:
		t.Fatal("no message published to bus")
	}
}

// TestProcess_PreferredCountry_ROPreserved verifies RO pin propagation.
func TestProcess_PreferredCountry_ROPreserved(t *testing.T) {
	p, bus := testPipeline(t)
	sub := bus.Subscribe(msgbus.TopicSealed)

	req := model.IntakeRequest{
		Recipient:        "to@example.com",
		Subject:          "RO pin test",
		Body:             "hello",
		FromAddress:      "goran.nowak@email.cz",
		PreferredCountry: "RO",
	}

	actor := model.Actor{ID: "actor-3", TenantID: "tenant-3"}
	_, err := p.Process(context.Background(), actor, req, "http")
	if err != nil {
		t.Fatalf("Process: %v", err)
	}

	select {
	case env := <-sub:
		if env.PreferredCountry != "RO" {
			t.Fatalf("expected PreferredCountry=RO, got %q", env.PreferredCountry)
		}
	default:
		t.Fatal("no message published to bus")
	}
}
