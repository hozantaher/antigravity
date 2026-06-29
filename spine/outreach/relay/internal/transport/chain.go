package transport

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"time"
)

var ErrChainEmpty = errors.New("transport chain must have at least one transport")

// ChainTransport routes connections through multiple transports in sequence.
// Example: VPN -> Tor -> exit
//
// The chain works by connecting each hop through the previous one's SOCKS5 proxy.
// Hop 1 (VPN): OS-level routing through WireGuard tunnel
// Hop 2 (Tor): SOCKS5 connection to Tor through the VPN
// Hop 3 (exit): Final connection through Tor to the destination
//
// This provides defense in depth:
// - The VPN server sees traffic going to the Tor network but can't read it
// - Tor entry nodes see the VPN's IP, not the operator's real IP
// - The destination sees a Tor exit node IP
type ChainTransport struct {
	hops []AnonymousTransport
}

// NewChainTransport creates a multi-hop transport.
// Connections flow through each transport in order.
// The last transport in the chain makes the final connection to the destination.
func NewChainTransport(hops ...AnonymousTransport) (*ChainTransport, error) {
	if len(hops) == 0 {
		return nil, ErrChainEmpty
	}
	return &ChainTransport{hops: hops}, nil
}

// DialContext connects to the target through the full transport chain.
//
// For a VPN -> Tor chain:
// 1. VPN transport dials the Tor SOCKS5 proxy (traffic goes through VPN tunnel)
// 2. Tor SOCKS5 proxy connects to the destination (traffic goes through Tor)
//
// For a single-hop chain, behaves identically to the wrapped transport.
func (c *ChainTransport) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	// The last transport does the final connection
	return c.hops[len(c.hops)-1].DialContext(ctx, network, addr)
}

// Description returns a human-readable description of the chain.
func (c *ChainTransport) Description() string {
	names := make([]string, len(c.hops))
	for i, hop := range c.hops {
		switch hop.(type) {
		case *SOCKS5Transport:
			names[i] = "tor-socks5"
		case *DirectTransport:
			names[i] = "direct"
		default:
			names[i] = fmt.Sprintf("hop-%d", i)
		}
	}
	return fmt.Sprintf("chain[%s]", joinStrings(names, " -> "))
}

// HopCount returns the number of hops in the chain.
func (c *ChainTransport) HopCount() int {
	return len(c.hops)
}

// ErrDirectTransportForbidden is returned when TRANSPORT_MODE=direct is requested.
// Direct mode exposes the relay's egress IP and breaks anonymization.
var ErrDirectTransportForbidden = errors.New("transport: direct mode is forbidden — set TRANSPORT_MODE to socks5 (with SOCKS_PROXY_ADDR pointing at wireproxy/Mullvad), vpn, or vpn+tor")

// ErrFreePoolForbidden is returned for legacy "proxy" mode requests.
// The rotating free SOCKS5 pool (proxifly/geonode/proxyscrape) was retired
// because Seznam and other Czech recipient SMTP servers reject mail from
// public free-proxy and Tor exit IPs regardless of geography. The supported
// path is wireproxy + Mullvad WireGuard, plumbed via TRANSPORT_MODE=socks5
// + SOCKS_PROXY_ADDR=127.0.0.1:1080.
var ErrFreePoolForbidden = errors.New("transport: free-pool mode is retired — use TRANSPORT_MODE=socks5 + SOCKS_PROXY_ADDR pointing at wireproxy")

// BuildChain constructs the appropriate transport chain based on configuration.
//
// Modes:
//   - "socks5": single-hop SOCKS5 through SOCKS_PROXY_ADDR (production: wireproxy/wgsocks → Mullvad)
//   - "tor":    legacy alias of "socks5"; kept for backwards compatibility
//   - "wgpool": multi-endpoint Mullvad rotation. Pool transport injected by
//               cmd/relay/main.go via the vpnTransport slot; BuildChain
//               itself does not import wgpool to avoid an import cycle.
//   - "vpn":    OS-level VPN tunnel
//   - "vpn+tor": VPN tunnel + SOCKS5 second hop
//
// "direct" leaks the egress IP and is rejected.
// "proxy" (rotating free pool) is retired and is rejected.
func BuildChain(mode string, socksAddr string, vpnTransport AnonymousTransport) (AnonymousTransport, error) {
	switch mode {
	case "direct":
		// 2026-05-12 operator decision (see memory feedback_no_direct_smtp
		// override): Mullvad CZ exit IPs were flagged as datacenter VPN
		// by Gmail spam filters even with SPF/DKIM/DMARC pass. To trade
		// off anti-trace anonymity for deliverability the operator opted
		// to send via Railway's direct egress IP. Gate behind explicit
		// env so the default behavior stays safe — `ALLOW_DIRECT_EGRESS=true`
		// must be set on the relay service to enable.
		if os.Getenv("ALLOW_DIRECT_EGRESS") == "true" {
			return NewDirectTransport(), nil
		}
		return nil, ErrDirectTransportForbidden

	case "proxy":
		return nil, ErrFreePoolForbidden

	case "socks5", "tor":
		if socksAddr == "" {
			return nil, errors.New("socks5/tor mode requires SOCKS_PROXY_ADDR")
		}
		return NewSOCKS5Transport(socksAddr, 60*time.Second), nil

	case "wgpool":
		if vpnTransport == nil {
			return nil, errors.New("wgpool mode requires injected pool transport (cmd/relay/main.go wires it from WIREPROXY_POOL_CONFIG)")
		}
		return vpnTransport, nil

	case "vpn":
		if vpnTransport == nil {
			return nil, errors.New("vpn mode requires active VPN transport")
		}
		return vpnTransport, nil

	case "vpn+tor":
		if vpnTransport == nil {
			return nil, errors.New("vpn+tor mode requires active VPN transport")
		}
		if socksAddr == "" {
			return nil, errors.New("vpn+tor mode requires SOCKS_PROXY_ADDR")
		}
		torHop := NewSOCKS5Transport(socksAddr, 60*time.Second)
		return NewChainTransport(vpnTransport, torHop)

	default:
		return nil, fmt.Errorf("unknown transport mode: %s", mode)
	}
}

func joinStrings(ss []string, sep string) string {
	if len(ss) == 0 {
		return ""
	}
	result := ss[0]
	for _, s := range ss[1:] {
		result += sep + s
	}
	return result
}
