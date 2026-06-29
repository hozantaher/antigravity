package main

import (
	"context"
	"log/slog"
	"net"
	"time"
)

// applyCustomResolver replaces net.DefaultResolver with one that forwards
// every lookup to the given host:port (typically the Mail Lab unbound
// container at 10.20.0.2:53). Process-global mutation: every lookup in
// this binary — IMAP poller, SMTP relay, outbound HTTP — uses the new
// resolver.
//
// Mail Lab use case: orchestrator running in dev profile points here to
// keep all DNS resolution within the sealed lab. The lab DNS returns
// SERVFAIL for non-lab domains, so an accidental real-Seznam lookup
// fails fast instead of contacting prod.
//
// Production use case: leave DNS_RESOLVER unset; net.DefaultResolver
// uses the system resolver as usual.
//
// The replacement is made through net.DefaultResolver fields. We use the
// PreferGo path because the cgo resolver does not honor the Dialer
// override on every platform (macOS in particular bypasses it).
func applyCustomResolver(addr string) {
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			// network is the protocol the Go resolver picked; honor it
			// (UDP for normal queries, TCP for large responses).
			return dialer.DialContext(ctx, network, addr)
		},
	}
	slog.Info("custom DNS resolver wired",
		"op", "main.applyCustomResolver",
		"resolver_addr", addr)
}
