package main

// Sprint AP4 — tests for egressObserverFn wiring in processDrainEnvelope.
//
// TC01: egressObserverFn called on outbound-smtp success with MailboxID+PreferredCountry
// TC02: egressObserverFn NOT called when MailboxID is empty
// TC03: egressObserverFn NOT called when PreferredCountry is empty
// TC04: egressObserverFn NOT called when delivery fails (sendErr != nil)
// TC05: nil egressObserverFn doesn't panic on success

import (
	"relay/internal/delivery"
	"relay/internal/minlog"
	"relay/internal/model"
	"relay/internal/transport"
	"relay/internal/transport/metamin"
	"context"
	"encoding/json"
	"net"
	"sync/atomic"
	"testing"
)

// fakeSMTPForObs is a minimal fake SMTP server that immediately closes
// connection after banner so Deliver returns an error. This lets us
// test the "failure path" without a full SMTP handshake.

// buildOutboundSMTPEnvelopeWithMBID creates an envelope for the outbound-smtp path
// with per-message SMTP creds + MailboxID + PreferredCountry.
func buildOutboundSMTPEnvelopeWithMBID(t *testing.T) model.Envelope {
	t.Helper()
	m := metamin.NewMinimizer()
	type payload struct {
		Recipient string `json:"recipient"`
		Subject   string `json:"subject"`
		Body      string `json:"body"`
	}
	raw, _ := json.Marshal(payload{Recipient: "bob@test.cz", Subject: "test", Body: "body"})
	padded, _ := m.PadToSizeClass(raw)
	return model.Envelope{
		ID:               "env-obs-1",
		TenantID:         "t",
		SealedContent:    padded,
		MailboxID:        "42",
		PreferredCountry: "CZ",
		InlineCreds: model.InlineSMTPCreds{
			SMTPHost:     "127.0.0.1",
			SMTPPort:     1, // port 1 = refuse = delivery fails
			SMTPUsername: "u",
			SMTPPassword: "p",
		},
	}
}

// captureObsFn returns a function that increments a counter and records calls.
func captureObsFn() (func(mailboxID, country, endpointLabel, opType string), *int32) {
	var count int32
	fn := func(_, _, _, _ string) {
		atomic.AddInt32(&count, 1)
	}
	return fn, &count
}

// TC01: egressObserverFn called on success (uses a no-op deliverer that always succeeds).
func TestAP4_DrainEgressObserver_CalledOnSuccess(t *testing.T) {
	fn, count := captureObsFn()
	cfg := newDrainEnvelopeConfig("outbound-smtp")
	cfg.egressObserverFn = fn
	// Override deliverer to always succeed
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		return &fakeDrainDeliverer{deliverErr: nil}
	}

	m := newMinimizer()
	type payload struct {
		Recipient string `json:"recipient"`
		Subject   string `json:"subject"`
		Body      string `json:"body"`
	}
	raw, _ := json.Marshal(payload{Recipient: "bob@test.cz", Subject: "s", Body: "b"})
	padded, _ := m.PadToSizeClass(raw)
	env := model.Envelope{
		ID:               "env-obs-ok",
		TenantID:         "t",
		SealedContent:    padded,
		MailboxID:        "42",
		PreferredCountry: "CZ",
		InlineCreds: model.InlineSMTPCreds{
			SMTPHost:     "smtp.test",
			SMTPPort:     587,
			SMTPUsername: "u",
			SMTPPassword: "p",
		},
	}

	sched := &fakeDrainScheduler{}
	processDrainEnvelope(
		context.Background(), env, cfg, sched,
		&fakeDrainExitVerifier{}, &fakeDrainDeliverer{}, nil, nil,
		newMinimizer(), &fakeAuditRecorder{}, minlog.New("test"),
	)

	if atomic.LoadInt32(count) != 1 {
		t.Errorf("egressObserverFn call count = %d, want 1", *count)
	}
}

// TC02: egressObserverFn NOT called when MailboxID is empty.
func TestAP4_DrainEgressObserver_NotCalledNoMailboxID(t *testing.T) {
	fn, count := captureObsFn()
	cfg := newDrainEnvelopeConfig("outbound-smtp")
	cfg.egressObserverFn = fn
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		return &fakeDrainDeliverer{deliverErr: nil}
	}

	m := newMinimizer()
	type payload struct {
		Recipient string `json:"recipient"`
		Subject   string `json:"subject"`
		Body      string `json:"body"`
	}
	raw, _ := json.Marshal(payload{Recipient: "bob@test.cz", Subject: "s", Body: "b"})
	padded, _ := m.PadToSizeClass(raw)
	env := model.Envelope{
		ID:               "env-obs-nomid",
		TenantID:         "t",
		SealedContent:    padded,
		MailboxID:        "", // empty
		PreferredCountry: "CZ",
		InlineCreds: model.InlineSMTPCreds{
			SMTPHost: "smtp.test", SMTPPort: 587, SMTPUsername: "u", SMTPPassword: "p",
		},
	}

	processDrainEnvelope(
		context.Background(), env, cfg, &fakeDrainScheduler{},
		&fakeDrainExitVerifier{}, &fakeDrainDeliverer{}, nil, nil,
		newMinimizer(), &fakeAuditRecorder{}, minlog.New("test"),
	)

	if atomic.LoadInt32(count) != 0 {
		t.Errorf("egressObserverFn should not be called when MailboxID is empty, got %d calls", *count)
	}
}

// TC03: egressObserverFn NOT called when PreferredCountry is empty.
func TestAP4_DrainEgressObserver_NotCalledNoCountry(t *testing.T) {
	fn, count := captureObsFn()
	cfg := newDrainEnvelopeConfig("outbound-smtp")
	cfg.egressObserverFn = fn
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		return &fakeDrainDeliverer{deliverErr: nil}
	}

	m := newMinimizer()
	type payload struct {
		Recipient string `json:"recipient"`
		Subject   string `json:"subject"`
		Body      string `json:"body"`
	}
	raw, _ := json.Marshal(payload{Recipient: "bob@test.cz", Subject: "s", Body: "b"})
	padded, _ := m.PadToSizeClass(raw)
	env := model.Envelope{
		ID:               "env-obs-nocountry",
		TenantID:         "t",
		SealedContent:    padded,
		MailboxID:        "42",
		PreferredCountry: "", // empty
		InlineCreds: model.InlineSMTPCreds{
			SMTPHost: "smtp.test", SMTPPort: 587, SMTPUsername: "u", SMTPPassword: "p",
		},
	}

	processDrainEnvelope(
		context.Background(), env, cfg, &fakeDrainScheduler{},
		&fakeDrainExitVerifier{}, &fakeDrainDeliverer{}, nil, nil,
		newMinimizer(), &fakeAuditRecorder{}, minlog.New("test"),
	)

	if atomic.LoadInt32(count) != 0 {
		t.Errorf("egressObserverFn should not be called when PreferredCountry empty, got %d calls", *count)
	}
}

// TC04: egressObserverFn NOT called when delivery fails.
func TestAP4_DrainEgressObserver_NotCalledOnFailure(t *testing.T) {
	fn, count := captureObsFn()
	cfg := newDrainEnvelopeConfig("outbound-smtp")
	cfg.egressObserverFn = fn
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		return &fakeDrainDeliverer{deliverErr: net.ErrClosed}
	}

	m := newMinimizer()
	type payload struct {
		Recipient string `json:"recipient"`
		Subject   string `json:"subject"`
		Body      string `json:"body"`
	}
	raw, _ := json.Marshal(payload{Recipient: "bob@test.cz", Subject: "s", Body: "b"})
	padded, _ := m.PadToSizeClass(raw)
	env := model.Envelope{
		ID:               "env-obs-fail",
		TenantID:         "t",
		SealedContent:    padded,
		MailboxID:        "42",
		PreferredCountry: "CZ",
		InlineCreds: model.InlineSMTPCreds{
			SMTPHost: "smtp.test", SMTPPort: 587, SMTPUsername: "u", SMTPPassword: "p",
		},
	}

	processDrainEnvelope(
		context.Background(), env, cfg, &fakeDrainScheduler{},
		&fakeDrainExitVerifier{}, &fakeDrainDeliverer{}, nil, nil,
		newMinimizer(), &fakeAuditRecorder{}, minlog.New("test"),
	)

	if atomic.LoadInt32(count) != 0 {
		t.Errorf("egressObserverFn should not be called on delivery failure, got %d calls", *count)
	}
}

// TC05: nil egressObserverFn doesn't panic on success.
func TestAP4_DrainEgressObserver_NilFnNoPanic(t *testing.T) {
	cfg := newDrainEnvelopeConfig("outbound-smtp")
	cfg.egressObserverFn = nil // explicitly nil
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		return &fakeDrainDeliverer{deliverErr: nil}
	}

	m := newMinimizer()
	type payload struct {
		Recipient string `json:"recipient"`
		Subject   string `json:"subject"`
		Body      string `json:"body"`
	}
	raw, _ := json.Marshal(payload{Recipient: "bob@test.cz", Subject: "s", Body: "b"})
	padded, _ := m.PadToSizeClass(raw)
	env := model.Envelope{
		ID:               "env-obs-nilcb",
		TenantID:         "t",
		SealedContent:    padded,
		MailboxID:        "42",
		PreferredCountry: "CZ",
		InlineCreds: model.InlineSMTPCreds{
			SMTPHost: "smtp.test", SMTPPort: 587, SMTPUsername: "u", SMTPPassword: "p",
		},
	}

	// No panic = pass
	processDrainEnvelope(
		context.Background(), env, cfg, &fakeDrainScheduler{},
		&fakeDrainExitVerifier{}, &fakeDrainDeliverer{}, nil, nil,
		newMinimizer(), &fakeAuditRecorder{}, minlog.New("test"),
	)
}
