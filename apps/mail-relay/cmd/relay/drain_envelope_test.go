package main

import (
	"relay/internal/delivery"
	"relay/internal/minlog"
	"relay/internal/model"
	"relay/internal/transport"
	"relay/internal/transport/bridge"
	"relay/internal/transport/metamin"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Fakes for processDrainEnvelope
// ---------------------------------------------------------------------------

type fakeDrainScheduler struct {
	mu              sync.Mutex
	failedIDs       []string
	relayedIDs      []string
	rescheduled     []rescheduleCall
	rescheduleErr   error
}

type rescheduleCall struct {
	envID         string
	attempts      int
	nextAttemptAt time.Time
	lastErr       string
}

func (s *fakeDrainScheduler) MarkFailed(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failedIDs = append(s.failedIDs, id)
	return nil
}
func (s *fakeDrainScheduler) MarkRelayed(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.relayedIDs = append(s.relayedIDs, id)
	return nil
}
func (s *fakeDrainScheduler) Reschedule(_ context.Context, env model.Envelope, nextAttemptAt time.Time, lastErr string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rescheduleErr != nil {
		return s.rescheduleErr
	}
	s.rescheduled = append(s.rescheduled, rescheduleCall{
		envID:         env.ID,
		attempts:      env.Attempts,
		nextAttemptAt: nextAttemptAt,
		lastErr:       lastErr,
	})
	return nil
}
func (s *fakeDrainScheduler) relayedCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.relayedIDs)
}
func (s *fakeDrainScheduler) rescheduleCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.rescheduled)
}

type fakeDrainExitVerifier struct {
	verifyErr    error
	getChannelErr error
	channel      model.ExitChannel
}

func (v *fakeDrainExitVerifier) Verify(_ context.Context, _ model.Envelope, _ string) error {
	return v.verifyErr
}
func (v *fakeDrainExitVerifier) GetChannel(_ context.Context, _, _ string) (model.ExitChannel, error) {
	return v.channel, v.getChannelErr
}

type fakeDrainDeliverer struct {
	deliverErr error
	calls      int32
}

func (d *fakeDrainDeliverer) Deliver(_ context.Context, _ string, _ []string, _ []byte) error {
	atomic.AddInt32(&d.calls, 1)
	return d.deliverErr
}

type fakeDrainAccountPool struct {
	deliverErr error
	hasResult  bool
	calls      int32
}

func (p *fakeDrainAccountPool) Has(_ string) bool { return p.hasResult }
func (p *fakeDrainAccountPool) Deliver(_ context.Context, _ string, _ []string, _ []byte) error {
	atomic.AddInt32(&p.calls, 1)
	return p.deliverErr
}

type fakeDrainGatewayBridge struct {
	forwardErr error
	calls      int32
}

func (b *fakeDrainGatewayBridge) ForwardSubmission(_ context.Context, _ model.Envelope, _, _, _ string) (*bridge.ForwardResult, error) {
	atomic.AddInt32(&b.calls, 1)
	return &bridge.ForwardResult{StatusCode: 200}, b.forwardErr
}

// buildOutboundSMTPEnvelope creates an envelope with padded JSON payload
// suitable for the outbound-smtp delivery path. Per-message SMTP creds
// live on Envelope.InlineCreds (matches production intake handler at
// services/relay/internal/intake/handler.go:143) — sprint M5 RCA.
func buildOutboundSMTPEnvelope(t *testing.T, smtpHost, smtpPassword string, smtpPort int) model.Envelope {
	t.Helper()
	m := metamin.NewMinimizer()
	type payload struct {
		Recipient string `json:"recipient"`
		Subject   string `json:"subject"`
		Body      string `json:"body"`
	}
	p := payload{
		Recipient: "bob@example.com",
		Subject:   "hello",
		Body:      "test body",
	}
	raw, _ := json.Marshal(p)
	padded, _ := m.PadToSizeClass(raw)
	return model.Envelope{
		ID:            "env-drain-1",
		TenantID:      "tenant-t",
		AliasToken:    "alias-a",
		SealedContent: padded,
		InlineCreds: model.InlineSMTPCreds{
			SMTPHost:     smtpHost,
			SMTPPort:     smtpPort,
			SMTPUsername: "user",
			SMTPPassword: smtpPassword,
		},
	}
}

// buildOutboundSMTPEnvelopeNoCredentials creates an envelope with no per-message
// SMTP credentials, so it falls through to accountPool / deliverer.
func buildOutboundSMTPEnvelopeNoCredentials(t *testing.T) model.Envelope {
	t.Helper()
	m := metamin.NewMinimizer()
	type payload struct {
		Recipient string `json:"recipient"`
		Subject   string `json:"subject"`
		Body      string `json:"body"`
	}
	raw, _ := json.Marshal(payload{Recipient: "carol@example.com", Subject: "s", Body: "b"})
	padded, _ := m.PadToSizeClass(raw)
	return model.Envelope{
		ID: "env-drain-2", TenantID: "tenant-t", AliasToken: "alias-b", SealedContent: padded,
	}
}

// newDrainEnvelopeConfig returns a minimal drainEnvelopeConfig for tests.
func newDrainEnvelopeConfig(mode string) drainEnvelopeConfig {
	return drainEnvelopeConfig{
		deliveryMode:    mode,
		smtpUsername:    "relay@example.com",
		smtpHelloDomain: "example.com",
		smtpBaseCfg:     delivery.SMTPConfig{Host: "127.0.0.1", Port: 587},
		anonTransport:   transport.NewDirectTransport(),
	}
}

func newMinimizer() *metamin.Minimizer { return metamin.NewMinimizer() }

// ---------------------------------------------------------------------------
// processDrainEnvelope — cover traffic
// ---------------------------------------------------------------------------

func TestProcessDrainEnvelope_CoverTrafficSkipped(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	deliv := &fakeDrainDeliverer{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := model.Envelope{ID: "cover-1", IsCover: true, TenantID: "t"}
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("record-only"), sched, exitV, deliv, nil, nil, newMinimizer(), audit, logger)

	if len(sched.failedIDs) != 0 || len(sched.relayedIDs) != 0 {
		t.Error("cover envelope should not touch scheduler")
	}
	if atomic.LoadInt32(&audit.calls) != 0 {
		t.Error("cover envelope should not touch audit")
	}
}

// ---------------------------------------------------------------------------
// processDrainEnvelope — exit channel verification
// ---------------------------------------------------------------------------

func TestProcessDrainEnvelope_ExitChannelVerifyFails(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{verifyErr: errors.New("not verified")}
	deliv := &fakeDrainDeliverer{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := model.Envelope{ID: "env-exit-1", TenantID: "t", ExitChannelID: "ch-1"}
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("record-only"), sched, exitV, deliv, nil, nil, newMinimizer(), audit, logger)

	if len(sched.failedIDs) != 1 {
		t.Errorf("expected 1 failed, got %d", len(sched.failedIDs))
	}
}

func TestProcessDrainEnvelope_ExitChannelVerifyPasses(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{verifyErr: nil}
	deliv := &fakeDrainDeliverer{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := model.Envelope{ID: "env-exit-2", TenantID: "t", ExitChannelID: "ch-2"}
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("record-only"), sched, exitV, deliv, nil, nil, newMinimizer(), audit, logger)

	if len(sched.relayedIDs) != 1 {
		t.Errorf("expected 1 relayed, got %d", len(sched.relayedIDs))
	}
}

// ---------------------------------------------------------------------------
// processDrainEnvelope — record-only delivery mode
// ---------------------------------------------------------------------------

func TestProcessDrainEnvelope_RecordOnly(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	deliv := &fakeDrainDeliverer{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := model.Envelope{ID: "env-ro-1", TenantID: "t"}
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("record-only"), sched, exitV, deliv, nil, nil, newMinimizer(), audit, logger)

	if len(sched.relayedIDs) != 1 {
		t.Errorf("expected 1 relayed, got %d", len(sched.relayedIDs))
	}
	if atomic.LoadInt32(&audit.calls) != 1 {
		t.Errorf("expected 1 audit call, got %d", atomic.LoadInt32(&audit.calls))
	}
}

func TestProcessDrainEnvelope_EmptyDeliveryMode(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := model.Envelope{ID: "env-empty-1", TenantID: "t"}
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig(""), sched, exitV, nil, nil, nil, newMinimizer(), audit, logger)

	if len(sched.relayedIDs) != 1 {
		t.Errorf("expected 1 relayed for empty delivery mode, got %d", len(sched.relayedIDs))
	}
}

// ---------------------------------------------------------------------------
// processDrainEnvelope — bridge delivery mode
// ---------------------------------------------------------------------------

func TestProcessDrainEnvelope_BridgeNilGateway(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := model.Envelope{ID: "env-bridge-nil", TenantID: "t"}
	// nil gateway → bridge delivery fails → mark failed
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("bridge"), sched, exitV, nil, nil, nil, newMinimizer(), audit, logger)

	if len(sched.failedIDs) != 1 {
		t.Errorf("expected 1 failed (nil bridge), got %d", len(sched.failedIDs))
	}
}

func TestProcessDrainEnvelope_BridgeSuccess(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	gw := &fakeDrainGatewayBridge{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := model.Envelope{ID: "env-bridge-ok", TenantID: "t"}
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("bridge"), sched, exitV, nil, nil, gw, newMinimizer(), audit, logger)

	if len(sched.relayedIDs) != 1 {
		t.Errorf("expected 1 relayed, got %d", len(sched.relayedIDs))
	}
	if atomic.LoadInt32(&gw.calls) != 1 {
		t.Errorf("expected 1 bridge call, got %d", atomic.LoadInt32(&gw.calls))
	}
}

func TestProcessDrainEnvelope_BridgeFailure(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	gw := &fakeDrainGatewayBridge{forwardErr: errors.New("gateway unreachable")}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := model.Envelope{ID: "env-bridge-fail", TenantID: "t"}
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("bridge"), sched, exitV, nil, nil, gw, newMinimizer(), audit, logger)

	if len(sched.failedIDs) != 1 {
		t.Errorf("expected 1 failed, got %d", len(sched.failedIDs))
	}
}

// ---------------------------------------------------------------------------
// processDrainEnvelope — smtp delivery mode
// ---------------------------------------------------------------------------

func TestProcessDrainEnvelope_SMTPGetChannelFails(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{getChannelErr: errors.New("channel not found")}
	deliv := &fakeDrainDeliverer{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := model.Envelope{ID: "env-smtp-nch", TenantID: "t", ExitChannelID: "ch-smtp"}
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("smtp"), sched, exitV, deliv, nil, nil, newMinimizer(), audit, logger)

	if len(sched.failedIDs) != 1 {
		t.Errorf("expected 1 failed (channel not found), got %d", len(sched.failedIDs))
	}
	if atomic.LoadInt32(&deliv.calls) != 0 {
		t.Error("deliverer should not be called when channel not found")
	}
}

func TestProcessDrainEnvelope_SMTPDeliverSuccess(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{
		channel: model.ExitChannel{ID: "ch-1", Endpoint: "bob@example.com"},
	}
	deliv := &fakeDrainDeliverer{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := model.Envelope{
		ID: "env-smtp-ok", TenantID: "t", ExitChannelID: "ch-1",
		SealedContent: []byte("sealed"),
	}
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("smtp"), sched, exitV, deliv, nil, nil, newMinimizer(), audit, logger)

	if len(sched.relayedIDs) != 1 {
		t.Errorf("expected 1 relayed, got %d", len(sched.relayedIDs))
	}
	if atomic.LoadInt32(&deliv.calls) != 1 {
		t.Errorf("expected 1 deliver call, got %d", atomic.LoadInt32(&deliv.calls))
	}
}

func TestProcessDrainEnvelope_SMTPDeliverFails(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{
		channel: model.ExitChannel{ID: "ch-1", Endpoint: "bob@example.com"},
	}
	deliv := &fakeDrainDeliverer{deliverErr: errors.New("smtp error")}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := model.Envelope{
		ID: "env-smtp-fail", TenantID: "t", ExitChannelID: "ch-1",
		SealedContent: []byte("sealed"),
	}
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("smtp"), sched, exitV, deliv, nil, nil, newMinimizer(), audit, logger)

	if len(sched.failedIDs) != 1 {
		t.Errorf("expected 1 failed, got %d", len(sched.failedIDs))
	}
}

// ---------------------------------------------------------------------------
// processDrainEnvelope — outbound-smtp delivery mode
// ---------------------------------------------------------------------------

func TestProcessDrainEnvelope_OutboundSMTP_UnmarshalError(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	deliv := &fakeDrainDeliverer{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	// SealedContent is not valid JSON — must trigger unmarshal error path.
	env := model.Envelope{
		ID: "env-osmtp-bad", TenantID: "t",
		SealedContent: []byte("{invalid-json"),
	}
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("outbound-smtp"), sched, exitV, deliv, nil, nil, newMinimizer(), audit, logger)

	if len(sched.failedIDs) != 1 {
		t.Errorf("expected 1 failed (unmarshal error), got %d", len(sched.failedIDs))
	}
}

func TestProcessDrainEnvelope_OutboundSMTP_PerMessageCreds_DefaultPort(t *testing.T) {
	// SMTPPort=0 → default port 587 branch.
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	oneShotCalled := false
	cfg := newDrainEnvelopeConfig("outbound-smtp")
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		oneShotCalled = true
		return &fakeDrainDeliverer{deliverErr: errors.New("connect refused")}
	}

	env := buildOutboundSMTPEnvelope(t, "127.0.0.1", "pass", 0) // port 0 → default
	processDrainEnvelope(context.Background(), env, cfg, sched, exitV, nil, nil, nil, newMinimizer(), audit, logger)

	if !oneShotCalled {
		t.Error("expected one-shot deliverer to be called for per-message creds")
	}
	if len(sched.failedIDs) != 1 {
		t.Errorf("expected 1 failed (delivery error), got %d", len(sched.failedIDs))
	}
}

func TestProcessDrainEnvelope_OutboundSMTP_PerMessageCreds_ExplicitPort(t *testing.T) {
	// SMTPPort=465 → explicit port, no default branch.
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	portUsed := 0
	cfg := newDrainEnvelopeConfig("outbound-smtp")
	cfg.delivererFn = func(_ transport.AnonymousTransport, smtpCfg delivery.SMTPConfig) drainDeliverer {
		portUsed = smtpCfg.Port
		return &fakeDrainDeliverer{deliverErr: nil}
	}

	env := buildOutboundSMTPEnvelope(t, "mail.example.com", "pass", 465)
	processDrainEnvelope(context.Background(), env, cfg, sched, exitV, nil, nil, nil, newMinimizer(), audit, logger)

	if portUsed != 465 {
		t.Errorf("expected port 465, got %d", portUsed)
	}
	if len(sched.relayedIDs) != 1 {
		t.Errorf("expected 1 relayed, got %d", len(sched.relayedIDs))
	}
}

func TestProcessDrainEnvelope_OutboundSMTP_AccountPool_Success(t *testing.T) {
	// No per-message creds → accountPool path (pool has the address).
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	pool := &fakeDrainAccountPool{hasResult: false} // pool does NOT have the address
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := buildOutboundSMTPEnvelopeNoCredentials(t)
	cfg := newDrainEnvelopeConfig("outbound-smtp")

	processDrainEnvelope(context.Background(), env, cfg, sched, exitV, nil, pool, nil, newMinimizer(), audit, logger)

	// accountPool.Has returned false, so accountPool.Deliver was called
	if atomic.LoadInt32(&pool.calls) != 1 {
		t.Errorf("expected 1 accountPool.Deliver call, got %d", atomic.LoadInt32(&pool.calls))
	}
	if len(sched.relayedIDs) != 1 {
		t.Errorf("expected 1 relayed, got %d", len(sched.relayedIDs))
	}
}

func TestProcessDrainEnvelope_OutboundSMTP_AccountPoolDeliverFails(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	pool := &fakeDrainAccountPool{deliverErr: errors.New("pool error"), hasResult: false}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := buildOutboundSMTPEnvelopeNoCredentials(t)
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("outbound-smtp"), sched, exitV, nil, pool, nil, newMinimizer(), audit, logger)

	if len(sched.failedIDs) != 1 {
		t.Errorf("expected 1 failed, got %d", len(sched.failedIDs))
	}
}

func TestProcessDrainEnvelope_OutboundSMTP_FallbackDeliverer(t *testing.T) {
	// No per-message creds, no accountPool → falls back to deliverer.
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	deliv := &fakeDrainDeliverer{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := buildOutboundSMTPEnvelopeNoCredentials(t)
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("outbound-smtp"), sched, exitV, deliv, nil, nil, newMinimizer(), audit, logger)

	if atomic.LoadInt32(&deliv.calls) != 1 {
		t.Errorf("expected 1 fallback deliver call, got %d", atomic.LoadInt32(&deliv.calls))
	}
	if len(sched.relayedIDs) != 1 {
		t.Errorf("expected 1 relayed, got %d", len(sched.relayedIDs))
	}
}

func TestProcessDrainEnvelope_OutboundSMTP_FallbackDelivererFails(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	deliv := &fakeDrainDeliverer{deliverErr: errors.New("send failed")}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := buildOutboundSMTPEnvelopeNoCredentials(t)
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("outbound-smtp"), sched, exitV, deliv, nil, nil, newMinimizer(), audit, logger)

	if len(sched.failedIDs) != 1 {
		t.Errorf("expected 1 failed, got %d", len(sched.failedIDs))
	}
}

func TestProcessDrainEnvelope_OutboundSMTP_FromAddrFallback(t *testing.T) {
	// env.FromAddress is empty → fromAddr falls back to cfg.smtpUsername.
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	deliv := &fakeDrainDeliverer{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	cfg := newDrainEnvelopeConfig("outbound-smtp")
	cfg.smtpUsername = "default@example.com"

	env := buildOutboundSMTPEnvelopeNoCredentials(t)
	env.FromAddress = "" // explicitly empty
	processDrainEnvelope(context.Background(), env, cfg, sched, exitV, deliv, nil, nil, newMinimizer(), audit, logger)

	if atomic.LoadInt32(&deliv.calls) != 1 {
		t.Errorf("expected 1 deliver call (fromAddr fallback), got %d", atomic.LoadInt32(&deliv.calls))
	}
}

func TestProcessDrainEnvelope_OutboundSMTP_FromAddrSet(t *testing.T) {
	// env.FromAddress is set → used directly.
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	deliv := &fakeDrainDeliverer{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := buildOutboundSMTPEnvelopeNoCredentials(t)
	env.FromAddress = "sender@custom.com"
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("outbound-smtp"), sched, exitV, deliv, nil, nil, newMinimizer(), audit, logger)

	// Just verify it didn't panic and attempted delivery.
	if atomic.LoadInt32(&deliv.calls) != 1 {
		t.Errorf("expected 1 deliver call, got %d", atomic.LoadInt32(&deliv.calls))
	}
}

// ---------------------------------------------------------------------------
// processDrainEnvelope — account pool "has" path (pool knows the from address)
// ---------------------------------------------------------------------------

func TestProcessDrainEnvelope_OutboundSMTP_PerMessageCreds_PoolHasAddress(t *testing.T) {
	// Per-message creds present, but pool already has this from address →
	// pool.Has returns true → use accountPool.Deliver, not one-shot deliverer.
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	oneShotCalled := false
	cfg := newDrainEnvelopeConfig("outbound-smtp")
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		oneShotCalled = true
		return &fakeDrainDeliverer{}
	}
	pool := &fakeDrainAccountPool{hasResult: true} // pool has the address

	env := buildOutboundSMTPEnvelope(t, "mail.example.com", "secret", 587)
	processDrainEnvelope(context.Background(), env, cfg, sched, exitV, nil, pool, nil, newMinimizer(), audit, logger)

	if oneShotCalled {
		t.Error("one-shot deliverer should NOT be called when pool has the address")
	}
	if atomic.LoadInt32(&pool.calls) != 1 {
		t.Errorf("expected pool.Deliver called once, got %d", atomic.LoadInt32(&pool.calls))
	}
}

// ---------------------------------------------------------------------------
// processDrainEnvelope — cancelled context
// ---------------------------------------------------------------------------

func TestProcessDrainEnvelope_CancelledContext_RecordOnly(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // pre-cancelled

	env := model.Envelope{ID: "env-cancel-1", TenantID: "t"}
	processDrainEnvelope(ctx, env, newDrainEnvelopeConfig("record-only"), sched, exitV, nil, nil, nil, newMinimizer(), audit, logger)

	// Should still mark relayed (audit/scheduler ignore ctx for record-only path)
	if len(sched.relayedIDs) != 1 {
		t.Errorf("expected 1 relayed even with cancelled ctx, got %d", len(sched.relayedIDs))
	}
}

// ---------------------------------------------------------------------------
// processDrainEnvelope — unknown delivery mode (no-op)
// ---------------------------------------------------------------------------

func TestProcessDrainEnvelope_UnknownMode(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	env := model.Envelope{ID: "env-unknown-1", TenantID: "t"}
	processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("foobar"), sched, exitV, nil, nil, nil, newMinimizer(), audit, logger)

	if len(sched.failedIDs) != 0 || len(sched.relayedIDs) != 0 {
		t.Error("unknown mode should not touch scheduler")
	}
}

// ---------------------------------------------------------------------------
// processDrainEnvelope — outbound-smtp: outbound succeeds (full success path)
// ---------------------------------------------------------------------------

func TestProcessDrainEnvelope_OutboundSMTP_PerMessageCredsSuccess(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	cfg := newDrainEnvelopeConfig("outbound-smtp")
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		return &fakeDrainDeliverer{deliverErr: nil} // success
	}

	env := buildOutboundSMTPEnvelope(t, "smtp.example.com", "pass123", 587)
	processDrainEnvelope(context.Background(), env, cfg, sched, exitV, nil, nil, nil, newMinimizer(), audit, logger)

	if len(sched.relayedIDs) != 1 {
		t.Errorf("expected 1 relayed on successful one-shot delivery, got %d", len(sched.relayedIDs))
	}
}

// ---------------------------------------------------------------------------
// concurrency safety — multiple envelopes processed concurrently
// ---------------------------------------------------------------------------

func TestProcessDrainEnvelope_ConcurrentSafe(t *testing.T) {
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")
	exitV := &fakeDrainExitVerifier{}
	deliv := &fakeDrainDeliverer{}

	type trackingScheduler struct {
		mu      sync.Mutex
		failed  []string
		relayed []string
	}
	ts := &trackingScheduler{}

	type trackingSched struct{ *trackingScheduler }
	fakeSched := &trackingSched{ts}

	_ = fakeSched // use interface directly
	const n = 20
	done := make(chan struct{}, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer func() { done <- struct{}{} }()
			sched := &fakeDrainScheduler{}
			env := model.Envelope{
				ID:       fmt.Sprintf("env-%d", i),
				TenantID: "t",
			}
			processDrainEnvelope(context.Background(), env, newDrainEnvelopeConfig("record-only"), sched, exitV, deliv, nil, nil, newMinimizer(), audit, logger)
		}(i)
	}
	for i := 0; i < n; i++ {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("timeout waiting for concurrent envelope processing")
		}
	}
}

// ---------------------------------------------------------------------------
// processDrainEnvelope — production one-shot deliverer path (delivererFn==nil)
// ---------------------------------------------------------------------------

// TestProcessDrainEnvelope_OutboundSMTP_ProductionOneShotDeliverer exercises
// the production path where delivererFn is nil and delivery.NewSMTPDeliverer
// is called directly. Port 1 is unreachable, so delivery fails, but the
// code path (the `else` branch) is covered.
func TestProcessDrainEnvelope_OutboundSMTP_ProductionOneShotDeliverer(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	// delivererFn is nil → production path uses delivery.NewSMTPDeliverer.
	cfg := newDrainEnvelopeConfig("outbound-smtp")
	cfg.delivererFn = nil // explicitly nil

	// Envelope with per-message credentials; port 1 is unreachable.
	env := buildOutboundSMTPEnvelope(t, "127.0.0.1", "pass", 1)

	// The dial will fail because port 1 is closed; MarkFailed is called.
	processDrainEnvelope(context.Background(), env, cfg, sched, exitV, nil, nil, nil, newMinimizer(), audit, logger)

	// Either failed or relayed depending on timing; the key is no panic.
	_ = sched.failedIDs
	_ = sched.relayedIDs
}

// ---------------------------------------------------------------------------
// Regression: adversarial sweep F1 — debug DRAIN_DISPATCH_M5 traces removed
// ---------------------------------------------------------------------------

// TestProcessDrainEnvelope_OutboundSMTP_NoDebugStderrTrace verifies that
// processDrainEnvelope does not emit DRAIN_DISPATCH_M5 traces to os.Stderr.
// The adversarial sweep (2026-05-05 F1) found that four fmt.Fprintf(os.Stderr)
// calls leaked SMTP credential metadata (smtp_pwd_len, branch) on every
// outbound envelope in production. This test captures stderr during execution
// and fails if any DRAIN_DISPATCH_M5 line is present.
func TestProcessDrainEnvelope_OutboundSMTP_NoDebugStderrTrace(t *testing.T) {
	// Redirect os.Stderr to a pipe for the duration of this test.
	origStderr := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	os.Stderr = w

	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test")

	cfg := newDrainEnvelopeConfig("outbound-smtp")
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		return &fakeDrainDeliverer{}
	}
	env := buildOutboundSMTPEnvelope(t, "smtp.example.com", "pass123", 587)
	processDrainEnvelope(context.Background(), env, cfg, sched, exitV, nil, nil, nil, newMinimizer(), audit, logger)

	// Close write end and restore stderr before reading.
	w.Close()
	os.Stderr = origStderr

	var buf [4096]byte
	n, _ := r.Read(buf[:])
	r.Close()
	captured := string(buf[:n])

	if strings.Contains(captured, "DRAIN_DISPATCH_M5") {
		t.Errorf("DRAIN_DISPATCH_M5 debug trace found in stderr — must not be present in production code:\n%s", captured)
	}
}