package mail

import (
	"context"
	"errors"
	"testing"

	"privacy-gateway/internal/model"
)

type recordingTransport struct {
	settings SMTPSettings
	sent     []Envelope
	fail     error
}

func (t *recordingTransport) Send(_ context.Context, envelope Envelope) error {
	if t.fail != nil {
		return t.fail
	}
	t.sent = append(t.sent, envelope)
	return nil
}

func newSanitized(sender, recipient, subject, body string) model.SanitizedMessage {
	actor := model.Actor{ID: "user-1", TenantID: "t-1"}
	return model.SanitizedMessage{
		Actor:    actor,
		Alias:    model.Alias{ID: "al_test", Email: sender, UserID: actor.ID, TenantID: actor.TenantID},
		To:       []string{recipient},
		Subject:  subject,
		TextBody: body,
	}
}

func TestResolverGatewayPicksPerSender(t *testing.T) {
	aliceSMTP := SMTPSettings{Host: "smtp.alice.example", Port: 465, Username: "alice", Password: "pw-a"}
	bobSMTP := SMTPSettings{Host: "smtp.bob.example", Port: 587, Username: "bob", Password: "pw-b"}
	resolver := NewStaticSMTPResolver(map[string]SMTPSettings{
		"alice@example.com": aliceSMTP,
		"Bob@example.com":   bobSMTP,
	})

	var dialed []SMTPSettings
	transports := map[string]*recordingTransport{}
	dialer := func(s SMTPSettings) (Transport, error) {
		dialed = append(dialed, s)
		t := &recordingTransport{settings: s}
		transports[s.Host] = t
		return t, nil
	}

	gw := NewResolverGateway(NewRecordedGateway(), resolver).WithDialer(dialer)

	if _, err := gw.Send(context.Background(), newSanitized("alice@example.com", "dest@test.local", "hello alice", "body a")); err != nil {
		t.Fatalf("send from alice: %v", err)
	}
	if _, err := gw.Send(context.Background(), newSanitized("bob@example.com", "dest@test.local", "hello bob", "body b")); err != nil {
		t.Fatalf("send from bob: %v", err)
	}

	if len(dialed) != 2 {
		t.Fatalf("expected 2 dials, got %d", len(dialed))
	}
	if dialed[0].Host != aliceSMTP.Host || dialed[1].Host != bobSMTP.Host {
		t.Errorf("dialed hosts = %v, want [%s, %s]", dialed, aliceSMTP.Host, bobSMTP.Host)
	}
	if got := len(transports[aliceSMTP.Host].sent); got != 1 {
		t.Errorf("alice transport got %d envelopes, want 1", got)
	}
	if got := len(transports[bobSMTP.Host].sent); got != 1 {
		t.Errorf("bob transport got %d envelopes, want 1", got)
	}
}

func TestResolverGatewayUnknownSenderSurfacesError(t *testing.T) {
	resolver := NewStaticSMTPResolver(map[string]SMTPSettings{
		"known@example.com": {Host: "smtp.known.example"},
	})
	dialer := func(SMTPSettings) (Transport, error) { t := &recordingTransport{}; return t, nil }

	gw := NewResolverGateway(NewRecordedGateway(), resolver).WithDialer(dialer)

	_, err := gw.Send(context.Background(), newSanitized("stranger@example.com", "dest@test.local", "s", "b"))
	if !errors.Is(err, ErrMailboxNotFound) {
		t.Fatalf("expected ErrMailboxNotFound, got %v", err)
	}
}

func TestResolverGatewayTransportErrorSkipsRecord(t *testing.T) {
	sender := "alice@example.com"
	resolver := NewStaticSMTPResolver(map[string]SMTPSettings{sender: {Host: "smtp.alice.example"}})

	wantErr := errors.New("boom")
	dialer := func(SMTPSettings) (Transport, error) {
		return &recordingTransport{fail: wantErr}, nil
	}

	store := NewRecordedGateway()
	gw := NewResolverGateway(store, resolver).WithDialer(dialer)

	if _, err := gw.Send(context.Background(), newSanitized(sender, "dest@test.local", "s", "b")); !errors.Is(err, wantErr) {
		t.Fatalf("expected transport error, got %v", err)
	}

	list, err := store.ListByActor(context.Background(), model.Actor{ID: "user-1", TenantID: "t-1"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("expected no recorded sends on transport failure, got %d", len(list))
	}
}

func TestStaticResolverCaseInsensitive(t *testing.T) {
	r := NewStaticSMTPResolver(map[string]SMTPSettings{"Mixed@Host.Example": {Host: "s"}})
	if _, err := r.Resolve(context.Background(), "mixed@host.example"); err != nil {
		t.Errorf("expected case-insensitive hit, got %v", err)
	}
	if _, err := r.Resolve(context.Background(), "MIXED@HOST.EXAMPLE"); err != nil {
		t.Errorf("expected case-insensitive hit uppercase, got %v", err)
	}
}
