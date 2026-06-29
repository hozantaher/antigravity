package wgpool

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

func TestTransport_DialErrorRecordsFailure(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	p, err := New([]Endpoint{{Label: "ep-a", SocksAddr: "127.0.0.1:1"}}, Config{
		QuarantineThreshold: 1,
		QuarantineDuration:  time.Minute,
		Now:                 func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	tr := NewTransport(p, 1*time.Second)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_, dialErr := tr.DialContext(ctx, "tcp", "smtp.seznam.cz:465")
	if dialErr == nil {
		t.Fatal("expected dial error")
	}
	snap := p.Snapshot()
	if !snap[0].Quarantined {
		t.Fatalf("expected ep-a quarantined after dial failure, got snap=%+v", snap)
	}
	if _, err := p.Pick("env", "mb"); !errors.Is(err, ErrAllQuarantined) {
		t.Fatalf("expected ErrAllQuarantined, got %v", err)
	}
}

func TestWithRoutingKeys_RoundTrip(t *testing.T) {
	ctx := WithRoutingKeys(context.Background(), "env-1", "mb-2")
	env, mb, country := routingKeysFromContext(ctx)
	if env != "env-1" || mb != "mb-2" {
		t.Fatalf("got env=%q mb=%q", env, mb)
	}
	if country != "" {
		t.Fatalf("expected empty country, got %q", country)
	}
}

func TestWithRoutingKeys_AbsentDefaultsEmpty(t *testing.T) {
	env, mb, country := routingKeysFromContext(context.Background())
	if env != "" || mb != "" || country != "" {
		t.Fatalf("unexpected: env=%q mb=%q country=%q", env, mb, country)
	}
}

func TestWithRoutingKeysAndCountry_RoundTrip(t *testing.T) {
	ctx := WithRoutingKeysAndCountry(context.Background(), "env-2", "mb-3", "SK")
	env, mb, country := routingKeysFromContext(ctx)
	if env != "env-2" {
		t.Fatalf("expected env=env-2, got %q", env)
	}
	if mb != "mb-3" {
		t.Fatalf("expected mb=mb-3, got %q", mb)
	}
	if country != "SK" {
		t.Fatalf("expected country=SK, got %q", country)
	}
}

func TestWithRoutingKeysAndCountry_EmptyCountry(t *testing.T) {
	ctx := WithRoutingKeysAndCountry(context.Background(), "env-3", "mb-4", "")
	_, _, country := routingKeysFromContext(ctx)
	if country != "" {
		t.Fatalf("expected empty country, got %q", country)
	}
}

func TestWithRoutingKeysAndCountry_ROCountry(t *testing.T) {
	ctx := WithRoutingKeysAndCountry(context.Background(), "env-4", "mb-5", "RO")
	_, _, country := routingKeysFromContext(ctx)
	if country != "RO" {
		t.Fatalf("expected country=RO, got %q", country)
	}
}

func TestEndpointLabelFromConn_Untagged(t *testing.T) {
	c1, c2 := net.Pipe()
	defer c1.Close()
	defer c2.Close()
	if got := EndpointLabelFromConn(c1); got != "" {
		t.Fatalf("untagged conn returned label %q", got)
	}
}

func TestEndpointLabelFromConn_Tagged(t *testing.T) {
	c1, c2 := net.Pipe()
	defer c1.Close()
	defer c2.Close()
	w := wrapConn(c1, nil, "ep-x")
	if got := EndpointLabelFromConn(w); got != "ep-x" {
		t.Fatalf("got %q want ep-x", got)
	}
}
