package wgpool

import (
	"context"
	"errors"
	"net"
	"time"

	"relay/internal/transport"
)

// Transport is the AnonymousTransport implementation that picks one
// endpoint from the pool for each DialContext call.
//
// Every dial path through this Transport routes via a SOCKS5Transport
// constructed against the picked endpoint's SocksAddr. This is the only
// production-allowed construction site for SOCKS5Transport(127.0.0.1:108x)
// — see wgpool_audit_test.go in this package for the ratchet that
// enforces it.
type Transport struct {
	pool        *Pool
	dialTimeout time.Duration
}

// NewTransport constructs the pool-aware transport.
func NewTransport(pool *Pool, dialTimeout time.Duration) *Transport {
	if dialTimeout <= 0 {
		dialTimeout = 60 * time.Second
	}
	return &Transport{pool: pool, dialTimeout: dialTimeout}
}

// Pool returns the underlying Pool.
func (t *Transport) Pool() *Pool { return t.pool }

// routingKey is the context value type carried by WithRoutingKeys.
type routingKey struct{}

type routingValue struct {
	envelopeID       string
	mailboxID        string
	preferredCountry string
	chosenLabel      string // populated by DialContext after Pick
}

// routingLabelKey carries the endpoint label chosen by DialContext so the
// drain loop can call Pool.SetPin after a successful send.
type routingLabelKey struct{}

// WithRoutingKeys returns a derived context that carries the envelope +
// mailbox identifiers used by the wgpool picker.
func WithRoutingKeys(ctx context.Context, envelopeID, mailboxID string) context.Context {
	return context.WithValue(ctx, routingKey{}, routingValue{envelopeID: envelopeID, mailboxID: mailboxID})
}

// WithRoutingKeysAndCountry returns a derived context that carries the envelope +
// mailbox identifiers AND a preferred egress country for the wgpool picker.
// Use this instead of WithRoutingKeys when the mailbox has a preferred_country set.
func WithRoutingKeysAndCountry(ctx context.Context, envelopeID, mailboxID, preferredCountry string) context.Context {
	return context.WithValue(ctx, routingKey{}, routingValue{
		envelopeID:       envelopeID,
		mailboxID:        mailboxID,
		preferredCountry: preferredCountry,
	})
}

func routingKeysFromContext(ctx context.Context) (string, string, string) {
	if v, ok := ctx.Value(routingKey{}).(routingValue); ok {
		return v.envelopeID, v.mailboxID, v.preferredCountry
	}
	return "", "", ""
}

// DialContext picks an endpoint from the pool, dials through its SOCKS5
// listener, and returns the resulting net.Conn.
func (t *Transport) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	envID, mbID, country := routingKeysFromContext(ctx)
	ep, err := t.pool.Pick(envID, mbID, country)
	if err != nil {
		return nil, err
	}
	socks := transport.NewSOCKS5Transport(ep.SocksAddr, t.dialTimeout)
	conn, dialErr := socks.DialContext(ctx, network, addr)
	if dialErr != nil {
		t.pool.RecordFailure(ep.Label)
		return nil, dialErr
	}
	t.pool.RecordSuccess(ep.Label)
	// Store the chosen label in context so callers can call Pool.SetPin (AP2).
	storeRoutingLabel(ctx, ep.Label)
	return wrapConn(conn, t.pool, ep.Label), nil
}

// storeRoutingLabel writes the chosen endpoint label into a *labelSink stored
// in ctx under routingLabelKey{}, if one was wired by WithLabelSink.
func storeRoutingLabel(ctx context.Context, label string) {
	if s, ok := ctx.Value(routingLabelKey{}).(*labelSink); ok && s != nil {
		s.label = label
	}
}

// labelSink is a mutable cell injected into the context by WithLabelSink.
// DialContext writes the chosen endpoint label into it after a successful pick.
type labelSink struct{ label string }

// WithLabelSink returns a derived context that carries a *labelSink. After
// DialContext completes successfully, the sink holds the endpoint label used.
// Call RoutingLabelFromContext on the same ctx to read it back.
//
// Usage in drain loop:
//
//	ctx = wgpool.WithLabelSink(ctx)
//	err = deliverer.Deliver(ctx, ...)
//	label = wgpool.RoutingLabelFromContext(ctx)
func WithLabelSink(ctx context.Context) context.Context {
	return context.WithValue(ctx, routingLabelKey{}, &labelSink{})
}

// RoutingLabelFromContext returns the endpoint label that was chosen by the
// most recent DialContext call on a context previously prepared with
// WithLabelSink. Returns "" when the label sink is absent or was never written.
func RoutingLabelFromContext(ctx context.Context) string {
	if s, ok := ctx.Value(routingLabelKey{}).(*labelSink); ok && s != nil {
		return s.label
	}
	return ""
}

type wrappedConn struct {
	net.Conn
	pool  *Pool
	label string
}

func wrapConn(c net.Conn, pool *Pool, label string) net.Conn {
	return &wrappedConn{Conn: c, pool: pool, label: label}
}

// EndpointLabelFromConn extracts the routing label from a net.Conn
// produced by Transport.DialContext.
func EndpointLabelFromConn(c net.Conn) string {
	if w, ok := c.(*wrappedConn); ok {
		return w.label
	}
	return ""
}

// Compile-time interface check.
var _ interface {
	DialContext(ctx context.Context, network, addr string) (net.Conn, error)
} = (*Transport)(nil)

// ErrPoolUnconfigured is returned when delivery code expects a Pool but
// the caller passed nil.
var ErrPoolUnconfigured = errors.New("wgpool: pool unconfigured")
