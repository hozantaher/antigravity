package transport

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

var ErrProxyUnreachable = errors.New("SOCKS5 proxy unreachable -- refusing direct connection")

// AnonymousTransport abstracts the network layer so different anonymization
// backends (Tor SOCKS5, direct for testing) can be plugged in.
type AnonymousTransport interface {
	DialContext(ctx context.Context, network, addr string) (net.Conn, error)
}

// DirectTransport connects without any proxy. Use only for testing.
type DirectTransport struct {
	dialer net.Dialer
	guard  *DialGuard
}

func NewDirectTransport() *DirectTransport {
	return &DirectTransport{
		dialer: net.Dialer{Timeout: 30 * time.Second},
	}
}

// AttachGuard wires a DialGuard that refuses dial targets outside the
// working pool + bridge allowlist. When nil, behavior is unchanged.
func (d *DirectTransport) AttachGuard(g *DialGuard) {
	d.guard = g
}

func (d *DirectTransport) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	if d.guard != nil {
		if err := d.guard.Assert(addr); err != nil {
			return nil, err
		}
	}
	return d.dialer.DialContext(ctx, network, addr)
}

// SOCKS5Transport routes all connections through a SOCKS5 proxy (e.g. Tor).
// Fails closed: if the proxy is unreachable, refuses to connect directly.
type SOCKS5Transport struct {
	proxyAddr string
	timeout   time.Duration
	guard     *DialGuard
	// dialFn overrides the TCP dial step. When nil, net.Dialer is used.
	// Tests inject a mock net.Conn via this field.
	dialFn func(ctx context.Context, network, addr string) (net.Conn, error)
}

// NewSOCKS5Transport creates a transport that routes through the given SOCKS5 proxy.
// proxyAddr is typically "127.0.0.1:9050" for Tor.
func NewSOCKS5Transport(proxyAddr string, timeout time.Duration) *SOCKS5Transport {
	return &SOCKS5Transport{
		proxyAddr: proxyAddr,
		timeout:   timeout,
	}
}

// AttachGuard wires a DialGuard that must allowlist the SOCKS5 proxyAddr
// before the underlying net.Dial runs. When nil, behavior is unchanged.
func (s *SOCKS5Transport) AttachGuard(g *DialGuard) {
	s.guard = g
}

// DialContext connects to the target address through the SOCKS5 proxy.
// Implements SOCKS5 CONNECT command (RFC 1928) using stdlib only.
func (s *SOCKS5Transport) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	if s.guard != nil {
		if err := s.guard.Assert(s.proxyAddr); err != nil {
			return nil, err
		}
	}
	var proxyConn net.Conn
	var err error
	if s.dialFn != nil {
		proxyConn, err = s.dialFn(ctx, "tcp", s.proxyAddr)
	} else {
		dialer := net.Dialer{Timeout: s.timeout}
		proxyConn, err = dialer.DialContext(ctx, "tcp", s.proxyAddr)
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrProxyUnreachable, err)
	}
	// Prevent indefinite hang on dead proxies that accept TCP but never
	// respond to SOCKS5 handshake. Deadline covers entire handshake +
	// CONNECT exchange; cleared before returning to caller.
	if err := proxyConn.SetDeadline(time.Now().Add(s.timeout)); err != nil {
		proxyConn.Close()
		return nil, fmt.Errorf("socks5 set deadline: %w", err)
	}

	// SOCKS5 handshake: no auth
	// +----+----------+----------+
	// |VER | NMETHODS | METHODS  |
	// +----+----------+----------+
	if _, err := proxyConn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		proxyConn.Close()
		return nil, fmt.Errorf("socks5 handshake write: %w", err)
	}

	var resp [2]byte
	if _, err := proxyConn.Read(resp[:]); err != nil {
		proxyConn.Close()
		return nil, fmt.Errorf("socks5 handshake read: %w", err)
	}
	if resp[0] != 0x05 || resp[1] != 0x00 {
		proxyConn.Close()
		return nil, fmt.Errorf("socks5 handshake failed: ver=%d method=%d", resp[0], resp[1])
	}

	// SOCKS5 CONNECT request
	host, port, err := splitHostPort(addr)
	if err != nil {
		proxyConn.Close()
		return nil, err
	}

	// Use domain name resolution (ATYP=0x03) to let proxy resolve DNS
	// This prevents DNS leakage from our side.
	req := make([]byte, 0, 7+len(host))
	req = append(req, 0x05, 0x01, 0x00, 0x03) // VER, CMD=CONNECT, RSV, ATYP=DOMAINNAME
	req = append(req, byte(len(host)))
	req = append(req, []byte(host)...)
	req = append(req, byte(port>>8), byte(port&0xff))

	if _, err := proxyConn.Write(req); err != nil {
		proxyConn.Close()
		return nil, fmt.Errorf("socks5 connect write: %w", err)
	}

	// SOCKS5 reply (RFC 1928 §6):
	//   +----+-----+-------+------+----------+----------+
	//   |VER | REP |  RSV  | ATYP | BND.ADDR | BND.PORT |
	//   +----+-----+-------+------+----------+----------+
	//   | 1  |  1  | X'00' |  1   | Variable |    2     |
	//
	// ATYP determines BND.ADDR length: 0x01 IPv4 (4 B), 0x03 DOMAINNAME
	// (1 B length + N B), 0x04 IPv6 (16 B). Reading a fixed 10 bytes only
	// works when ATYP=0x01; with IPv6 (Mullvad/wireproxy) the trailing
	// BND.ADDR+BND.PORT bytes leak into the next read and corrupt the
	// caller's SMTP/TLS handshake. Use io.ReadFull with the exact length.
	var head [4]byte
	if _, err := io.ReadFull(proxyConn, head[:]); err != nil {
		proxyConn.Close()
		return nil, fmt.Errorf("socks5 connect read header: %w", err)
	}
	if head[0] != 0x05 {
		proxyConn.Close()
		return nil, fmt.Errorf("socks5 bad version in response: %d", head[0])
	}
	if head[1] != 0x00 {
		proxyConn.Close()
		return nil, fmt.Errorf("socks5 connect failed: status=%d", head[1])
	}
	var addrLen int
	switch head[3] {
	case 0x01:
		addrLen = 4
	case 0x04:
		addrLen = 16
	case 0x03:
		var ll [1]byte
		if _, err := io.ReadFull(proxyConn, ll[:]); err != nil {
			proxyConn.Close()
			return nil, fmt.Errorf("socks5 read domain length: %w", err)
		}
		addrLen = int(ll[0])
	default:
		proxyConn.Close()
		return nil, fmt.Errorf("socks5 unknown ATYP in response: %d", head[3])
	}
	tail := make([]byte, addrLen+2) // BND.ADDR + BND.PORT
	if _, err := io.ReadFull(proxyConn, tail); err != nil {
		proxyConn.Close()
		return nil, fmt.Errorf("socks5 read bind address: %w", err)
	}

	// Clear handshake deadline so long-lived connections (SMTP relay)
	// are governed by the caller's own deadlines, not the dial timeout.
	if err := proxyConn.SetDeadline(time.Time{}); err != nil {
		proxyConn.Close()
		return nil, fmt.Errorf("socks5 clear deadline: %w", err)
	}

	return proxyConn, nil
}

func splitHostPort(addr string) (string, int, error) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return "", 0, err
	}
	port := 0
	for _, c := range portStr {
		if c < '0' || c > '9' {
			return "", 0, fmt.Errorf("invalid port: %s", portStr)
		}
		port = port*10 + int(c-'0')
	}
	return host, port, nil
}
