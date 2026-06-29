package mail

import (
	"context"
	"errors"
	"strings"

	"privacy-gateway/internal/model"
)

// ErrMailboxNotFound is returned by SMTPResolver when no mailbox matches
// the requested sender address.
var ErrMailboxNotFound = errors.New("smtp resolver: mailbox not found for sender")

// SMTPResolver looks up SMTP credentials per outbound sender. Each
// outreach mailbox in the operator's table becomes a SMTPSettings.
// Implementations should be safe for concurrent use.
type SMTPResolver interface {
	Resolve(ctx context.Context, sender string) (SMTPSettings, error)
}

// ResolverGateway implements mail.Gateway by resolving SMTP credentials
// per-message from an SMTPResolver. Unlike the single-account SMTPGateway,
// this picks the correct outbound mailbox per alias / sender, which is
// what the outreach_mailboxes table drives.
type ResolverGateway struct {
	recordStore *RecordedGateway
	resolver    SMTPResolver
	dial        func(SMTPSettings) (Transport, error)
}

// NewResolverGateway wires a RecordedGateway audit tail with a per-send
// SMTPResolver. The default dialer builds a real SMTPTransport; tests
// inject a stub via WithDialer.
func NewResolverGateway(recordStore *RecordedGateway, resolver SMTPResolver) *ResolverGateway {
	return &ResolverGateway{
		recordStore: recordStore,
		resolver:    resolver,
		dial: func(s SMTPSettings) (Transport, error) {
			return NewSMTPTransport(s)
		},
	}
}

// WithDialer swaps the transport constructor. Returns the receiver for
// chaining.
func (g *ResolverGateway) WithDialer(dial func(SMTPSettings) (Transport, error)) *ResolverGateway {
	g.dial = dial
	return g
}

// Send resolves outbound SMTP credentials for msg.Alias.Email, dials the
// transport, delivers, then records through the audit tail.
func (g *ResolverGateway) Send(ctx context.Context, msg model.SanitizedMessage) (model.MessageRecord, error) {
	sender := strings.TrimSpace(msg.Alias.Email)
	settings, err := g.resolver.Resolve(ctx, sender)
	if err != nil {
		return model.MessageRecord{}, err
	}

	transport, err := g.dial(settings)
	if err != nil {
		return model.MessageRecord{}, err
	}

	data, err := buildRFC822Message(msg)
	if err != nil {
		return model.MessageRecord{}, err
	}

	if err := transport.Send(ctx, Envelope{
		From: sender,
		To:   append([]string(nil), msg.To...),
		Data: data,
	}); err != nil {
		return model.MessageRecord{}, err
	}

	return g.recordStore.Send(ctx, msg)
}

// ListByActor delegates to the underlying audit tail.
func (g *ResolverGateway) ListByActor(ctx context.Context, actor model.Actor) ([]model.MessageRecord, error) {
	return g.recordStore.ListByActor(ctx, actor)
}

// StaticSMTPResolver is an in-memory resolver useful for tests and
// small deployments. Keys are case-insensitive sender addresses.
type StaticSMTPResolver struct {
	byAddress map[string]SMTPSettings
}

// NewStaticSMTPResolver builds a resolver from a map of sender → settings.
// The input map is defensively copied.
func NewStaticSMTPResolver(entries map[string]SMTPSettings) *StaticSMTPResolver {
	normalized := make(map[string]SMTPSettings, len(entries))
	for sender, settings := range entries {
		key := strings.ToLower(strings.TrimSpace(sender))
		if key == "" {
			continue
		}
		normalized[key] = settings
	}
	return &StaticSMTPResolver{byAddress: normalized}
}

// Resolve returns the settings registered for sender, or ErrMailboxNotFound.
func (r *StaticSMTPResolver) Resolve(_ context.Context, sender string) (SMTPSettings, error) {
	key := strings.ToLower(strings.TrimSpace(sender))
	if settings, ok := r.byAddress[key]; ok {
		return settings, nil
	}
	return SMTPSettings{}, ErrMailboxNotFound
}
