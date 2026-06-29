// wgsocks: minimal userspace WireGuard + SOCKS5 server.
//
// Drop-in replacement for windtf/wireproxy v1.1.2, written specifically to
// fix the STARTTLS i/o-timeout bug observed on 9/10 SMTP probe hosts:
// Seznam, Gmail, Yahoo, Mailgun, SendGrid, Brevo, Fastmail, Zoho all hung
// at 28s read deadline; only Outlook completed STARTTLS. From the
// operator's local kernel WireGuard the same handshakes work fine, so the
// bug is in wireproxy's SOCKS5 forwarding path.
//
// Root cause: wireproxy's connForward (routine.go:212) uses io.Copy on
// both directions concurrently and closes BOTH ends as soon as either
// copy returns. SMTP servers replying to EHLO and then waiting for the
// client's STARTTLS-initiated TLS ClientHello produce a half-close
// pattern that wireproxy mishandles — the SOCKS5 listener tears down the
// upstream side before the ClientHello is forwarded, leading to the 28s
// i/o timeout. This is exactly what net.TCPConn.CloseWrite is designed
// for.
//
// This binary uses CloseWrite() to propagate half-close events
// correctly. It supports CONNECT only (sufficient for SMTP STARTTLS, the
// only thing the relay does through SOCKS5).
//
// Config format intentionally matches wireproxy's ini layout so the
// existing WIREPROXY_CONFIG Railway secret can be reused unchanged:
//
//   [Interface]
//   PrivateKey = <wg base64>
//   Address    = 10.x.x.x/32
//   DNS        = 10.64.0.1
//
//   [Peer]
//   PublicKey  = <wg base64>
//   AllowedIPs = 0.0.0.0/0,::/0
//   Endpoint   = <host>:51820
//
//   [Socks5]
//   BindAddress = 127.0.0.1:1080
//
// Deliberately stdlib + wireguard-go only. No third-party SOCKS5 lib
// (avoids re-importing the things-go/go-socks5 connForward bug).
package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

const (
	socksVersion5   = 0x05
	socksCmdConnect = 0x01
	socksAtypIPv4   = 0x01
	socksAtypDomain = 0x03
	socksAtypIPv6   = 0x04

	// netstackMTU = 1100 — drastically below standard 1420 to make outer UDP
	// datagrams fit any reasonable Railway egress path MTU.
	//
	// At 1280 (IPv6 min), outer WG UDP datagram = 1280 + 28 (IP+UDP) = 1308.
	// At 1100, outer UDP = 1128. Comfortably below any common path MTU
	// quirk (Railway egress, PoP routes, ISP equipment).
	//
	// Empirical evidence (2026-05-02): WG handshakes (~148B), keepalives
	// (~32B), inner SMTP greeting/EHLO/STARTTLS commands (small) ALL get
	// through Railway → Mullvad → Server return path. But TLS server
	// flights (5907B Seznam cert chain → 5 inner segments at MSS 1380 →
	// ~5 outer UDP datagrams ~1408B each) get DROPPED. Lowering MTU
	// reduces both segment count and per-packet size. See:
	// reports/brutal-2026-05-01/probe-matrix-post-wgsocks.md
	netstackMTU = 1100
	dialTimeout = 30 * time.Second
)

// wgConfig holds the parsed ini values that the WireGuard userspace
// device expects. Mirrors the wireproxy field set we actually use.
type wgConfig struct {
	privateKeyHex   string
	publicKeyHex    string
	endpoint        string
	allowedIPsLines []string
	addresses       []netip.Addr
	dns             []netip.Addr
	socksBind       string
	// persistentKeepalive in seconds. 0 = disabled (wireguard-go default).
	// Critical on Railway: empirical evidence (2026-05-02 verbose logs)
	// shows return UDP packets stop arriving after ~15s of inactivity,
	// consistent with Railway egress NAT closing the UDP flow. Without
	// PersistentKeepalive, wireguard-go never sends idle traffic, NAT
	// expires, return packets get dropped.
	persistentKeepalive int
	// listenPort lets operators pin the WG outbound UDP source port. Default 0
	// = wgsocks picks 51820 (canonical WG port). Override via [Interface] ListenPort.
	listenPort int
}

func main() {
	configPath := flag.String("c", "", "path to wireproxy-format ini config")
	flag.Parse()
	if *configPath == "" {
		log.Fatalf("wgsocks: -c <config> required")
	}

	cfg, err := parseConfig(*configPath)
	if err != nil {
		log.Fatalf("wgsocks: parse config: %v", err)
	}
	if cfg.socksBind == "" {
		cfg.socksBind = "127.0.0.1:1080"
	}

	tun, tnet, err := netstack.CreateNetTUN(cfg.addresses, cfg.dns, netstackMTU)
	if err != nil {
		log.Fatalf("wgsocks: create netstack tun: %v", err)
	}

	// WGSOCKS_DEBUG=1 enables verbose WG-layer logging — every UDP send/recv,
	// handshake state, keepalive timing, peer ping. Used to diagnose
	// Railway-environmental failures where same binary works locally but hangs
	// on Railway (suspect: PMTU blackhole, NAT timeout, or UDP rate-limit).
	logLevel := device.LogLevelError
	// envconfig-allowed: wgsocks is a standalone Go module with its own go.mod
	// (intentionally minimal — wireguard-go + stdlib only); importing
	// common/envconfig would break the dependency-free build invariant.
	if os.Getenv("WGSOCKS_DEBUG") == "1" {
		logLevel = device.LogLevelVerbose
		log.Printf("wgsocks: WGSOCKS_DEBUG=1 — verbose WG layer logging ENABLED")
	}
	dev := device.NewDevice(tun, conn.NewDefaultBind(), device.NewLogger(logLevel, "wgsocks "))

	uapi := buildUAPIConfig(cfg)
	if err := dev.IpcSet(uapi); err != nil {
		log.Fatalf("wgsocks: ipc set: %v", err)
	}
	if err := dev.Up(); err != nil {
		log.Fatalf("wgsocks: device up: %v", err)
	}
	log.Printf("wgsocks: WireGuard device up, peer endpoint=%s", cfg.endpoint)

	listener, err := net.Listen("tcp", cfg.socksBind)
	if err != nil {
		log.Fatalf("wgsocks: listen %s: %v", cfg.socksBind, err)
	}
	log.Printf("wgsocks: SOCKS5 listening on %s", cfg.socksBind)

	// ctx is cancelled on SIGINT / SIGTERM so the accept loop can drain
	// gracefully instead of being killed mid-flight.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serveSOCKS5(ctx, listener, tnet)

	log.Printf("wgsocks: shutting down (context done: %v)", ctx.Err())
	_ = listener.Close()
	dev.Down()
}

// serveSOCKS5 runs the SOCKS5 accept loop until ctx is cancelled. It sets a
// 1 s Accept deadline so the loop can poll ctx.Done() between accepts — this
// avoids blocking forever on a quiet listener when SIGTERM arrives. Timeout
// errors are silently retried; net.ErrClosed signals a clean exit.
func serveSOCKS5(ctx context.Context, listener net.Listener, tnet *netstack.Net) {
	var wg sync.WaitGroup
	for {
		select {
		case <-ctx.Done():
			log.Printf("wgsocks: accept loop shutting down, waiting for in-flight handlers")
			wg.Wait()
			return
		default:
		}

		// Set a short deadline so we can re-check ctx.Done() regularly.
		if dl, ok := listener.(interface{ SetDeadline(time.Time) error }); ok {
			_ = dl.SetDeadline(time.Now().Add(1 * time.Second))
		}

		c, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				log.Printf("wgsocks: listener closed, exiting accept loop")
				wg.Wait()
				return
			}
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				// Deadline expired — normal poll cycle, not an error.
				continue
			}
			log.Printf("wgsocks: accept error: %v", err)
			continue
		}

		wg.Add(1)
		go func(c net.Conn) {
			defer wg.Done()
			defer c.Close()
			if err := handleSOCKS5(c, tnet); err != nil {
				log.Printf("wgsocks: socks5 session: %v", err)
			}
		}(c)
	}
}

// parseConfig reads the wireproxy-format ini into a wgConfig.
//
// Hand-rolled rather than pulling in github.com/go-ini/ini to keep the
// dependency surface minimal — the format is trivial and deterministic.
func parseConfig(path string) (*wgConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	var cfg wgConfig
	var section string
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(line, "["), "]"))
			continue
		}
		eq := strings.Index(line, "=")
		if eq < 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])

		switch section {
		case "interface":
			switch strings.ToLower(key) {
			case "privatekey":
				h, err := wgKeyHex(val)
				if err != nil {
					return nil, fmt.Errorf("interface privatekey: %w", err)
				}
				cfg.privateKeyHex = h
			case "address":
				addrs, err := parseAddrList(val)
				if err != nil {
					return nil, fmt.Errorf("interface address: %w", err)
				}
				cfg.addresses = append(cfg.addresses, addrs...)
			case "dns":
				addrs, err := parseAddrList(val)
				if err != nil {
					return nil, fmt.Errorf("interface dns: %w", err)
				}
				cfg.dns = append(cfg.dns, addrs...)
			case "listenport":
				n, err := strconv.Atoi(strings.TrimSpace(val))
				if err != nil {
					return nil, fmt.Errorf("interface listenport: %w", err)
				}
				cfg.listenPort = n
			}
		case "peer":
			switch strings.ToLower(key) {
			case "publickey":
				h, err := wgKeyHex(val)
				if err != nil {
					return nil, fmt.Errorf("peer publickey: %w", err)
				}
				cfg.publicKeyHex = h
			case "endpoint":
				cfg.endpoint = val
			case "allowedips":
				for _, p := range strings.Split(val, ",") {
					p = strings.TrimSpace(p)
					if p != "" {
						cfg.allowedIPsLines = append(cfg.allowedIPsLines, p)
					}
				}
			case "persistentkeepalive":
				n, err := strconv.Atoi(strings.TrimSpace(val))
				if err != nil {
					return nil, fmt.Errorf("peer persistentkeepalive: %w", err)
				}
				cfg.persistentKeepalive = n
			}
		case "socks5":
			if strings.EqualFold(key, "bindaddress") {
				cfg.socksBind = val
			}
		}
	}

	if cfg.privateKeyHex == "" {
		return nil, errors.New("missing [Interface] PrivateKey")
	}
	if cfg.publicKeyHex == "" {
		return nil, errors.New("missing [Peer] PublicKey")
	}
	if cfg.endpoint == "" {
		return nil, errors.New("missing [Peer] Endpoint")
	}
	if len(cfg.addresses) == 0 {
		return nil, errors.New("missing [Interface] Address")
	}
	return &cfg, nil
}

// parseAddrList accepts comma-separated CIDRs or bare addresses and
// returns just the addresses (the netstack TUN takes addresses, not
// prefixes — masks are advisory in userspace WG).
func parseAddrList(val string) ([]netip.Addr, error) {
	var out []netip.Addr
	for _, p := range strings.Split(val, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if strings.Contains(p, "/") {
			pref, err := netip.ParsePrefix(p)
			if err != nil {
				return nil, fmt.Errorf("parse prefix %q: %w", p, err)
			}
			out = append(out, pref.Addr())
			continue
		}
		a, err := netip.ParseAddr(p)
		if err != nil {
			return nil, fmt.Errorf("parse addr %q: %w", p, err)
		}
		out = append(out, a)
	}
	return out, nil
}

// wgKeyHex converts a base64-encoded WireGuard 32-byte key into the hex
// format the UAPI protocol expects.
func wgKeyHex(b64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", fmt.Errorf("base64 decode: %w", err)
	}
	if len(raw) != 32 {
		return "", fmt.Errorf("expected 32-byte key, got %d", len(raw))
	}
	return hex.EncodeToString(raw), nil
}

// buildUAPIConfig serialises wgConfig into wireguard-go's text-format IPC
// config (one key=value per line, trailing newline).
func buildUAPIConfig(c *wgConfig) string {
	var b strings.Builder
	fmt.Fprintf(&b, "private_key=%s\n", c.privateKeyHex)
	// Stable UDP source port (default 51820) — without listen_port wireguard-go
	// binds to OS-ephemeral, and Railway egress PAT may randomize source port
	// per outbound packet. WireGuard requires stable source port for return
	// packets to find the listener. Operator can override via
	// [Interface] ListenPort = N in INI.
	listenPort := 51820
	if c.listenPort > 0 {
		listenPort = c.listenPort
	}
	fmt.Fprintf(&b, "listen_port=%d\n", listenPort)
	fmt.Fprintf(&b, "public_key=%s\n", c.publicKeyHex)
	fmt.Fprintf(&b, "endpoint=%s\n", c.endpoint)
	if c.persistentKeepalive > 0 {
		fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", c.persistentKeepalive)
	}
	if len(c.allowedIPsLines) == 0 {
		fmt.Fprint(&b, "allowed_ip=0.0.0.0/0\n")
		fmt.Fprint(&b, "allowed_ip=::/0\n")
	} else {
		for _, p := range c.allowedIPsLines {
			fmt.Fprintf(&b, "allowed_ip=%s\n", p)
		}
	}
	return b.String()
}

// handleSOCKS5 implements RFC 1928 CONNECT-only handshake on conn, dials
// the target through the WireGuard netstack, and forwards bytes in both
// directions with proper half-close propagation.
func handleSOCKS5(client net.Conn, tnet *netstack.Net) error {
	_ = client.SetDeadline(time.Now().Add(15 * time.Second))
	br := bufio.NewReader(client)

	// Greeting: ver | nmethods | methods...
	hdr := make([]byte, 2)
	if _, err := io.ReadFull(br, hdr); err != nil {
		return fmt.Errorf("greeting header: %w", err)
	}
	if hdr[0] != socksVersion5 {
		return fmt.Errorf("unsupported SOCKS version: %d", hdr[0])
	}
	methods := make([]byte, hdr[1])
	if _, err := io.ReadFull(br, methods); err != nil {
		return fmt.Errorf("greeting methods: %w", err)
	}
	// Reply: no auth required (we listen on 127.0.0.1 only).
	if _, err := client.Write([]byte{socksVersion5, 0x00}); err != nil {
		return fmt.Errorf("greeting reply: %w", err)
	}

	// Request: ver | cmd | rsv | atyp
	req := make([]byte, 4)
	if _, err := io.ReadFull(br, req); err != nil {
		return fmt.Errorf("request header: %w", err)
	}
	if req[0] != socksVersion5 {
		return fmt.Errorf("unexpected version on request: %d", req[0])
	}
	if req[1] != socksCmdConnect {
		_ = writeSOCKSReply(client, 0x07) // command not supported
		return fmt.Errorf("unsupported command: %d", req[1])
	}

	host, err := readSOCKSAddr(br, req[3])
	if err != nil {
		_ = writeSOCKSReply(client, 0x08) // address type not supported
		return fmt.Errorf("read address: %w", err)
	}
	portBytes := make([]byte, 2)
	if _, err := io.ReadFull(br, portBytes); err != nil {
		return fmt.Errorf("read port: %w", err)
	}
	port := uint16(portBytes[0])<<8 | uint16(portBytes[1])

	target := net.JoinHostPort(host, fmt.Sprintf("%d", port))

	// Clear handshake deadline; downstream copy uses its own deadlines.
	_ = client.SetDeadline(time.Time{})

	dialCtx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	defer cancel()

	upstream, err := tnet.DialContext(dialCtx, "tcp", target)
	if err != nil {
		_ = writeSOCKSReply(client, 0x05) // connection refused
		return fmt.Errorf("dial %s: %w", target, err)
	}
	defer upstream.Close()

	if err := writeSOCKSReply(client, 0x00); err != nil {
		return fmt.Errorf("success reply: %w", err)
	}

	// Drain anything bufio buffered before the body — TLS ClientHello
	// may already be in br by the time we get here on fast clients.
	if buffered := br.Buffered(); buffered > 0 {
		buf, _ := br.Peek(buffered)
		if _, err := upstream.Write(buf); err != nil {
			return fmt.Errorf("flush prebuffered: %w", err)
		}
		if _, err := br.Discard(buffered); err != nil {
			return fmt.Errorf("discard prebuffered: %w", err)
		}
	}

	bidirectionalCopy(client, upstream)
	return nil
}

func readSOCKSAddr(br *bufio.Reader, atyp byte) (string, error) {
	switch atyp {
	case socksAtypIPv4:
		buf := make([]byte, 4)
		if _, err := io.ReadFull(br, buf); err != nil {
			return "", err
		}
		return net.IP(buf).String(), nil
	case socksAtypIPv6:
		buf := make([]byte, 16)
		if _, err := io.ReadFull(br, buf); err != nil {
			return "", err
		}
		return net.IP(buf).String(), nil
	case socksAtypDomain:
		lenByte, err := br.ReadByte()
		if err != nil {
			return "", err
		}
		buf := make([]byte, int(lenByte))
		if _, err := io.ReadFull(br, buf); err != nil {
			return "", err
		}
		return string(buf), nil
	default:
		return "", fmt.Errorf("unknown atyp %d", atyp)
	}
}

func writeSOCKSReply(w io.Writer, code byte) error {
	// Reply with bound 0.0.0.0:0 — SMTP/STARTTLS clients don't care.
	_, err := w.Write([]byte{socksVersion5, code, 0x00, socksAtypIPv4, 0, 0, 0, 0, 0, 0})
	return err
}

// closeWriter is the half-close interface implemented by both
// *net.TCPConn and gVisor's *gonet.TCPConn.
type closeWriter interface {
	CloseWrite() error
}

// bidirectionalCopy moves bytes between client (the local SOCKS caller)
// and upstream (the WG-tunneled target) with proper half-close
// propagation. This is the part the wireproxy → things-go/go-socks5
// path gets wrong: when one side returns EOF on Read, that side's
// CloseWrite must be signalled on the OTHER side so the peer learns the
// half is done. Failing to do so makes STARTTLS-style protocols (server
// replies then waits for ClientHello on same socket) hang until OS-level
// read timeout fires.
func bidirectionalCopy(client net.Conn, upstream net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		_, _ = io.Copy(upstream, client)
		// client→upstream finished. Tell upstream we won't write more;
		// let upstream still send replies until it's done.
		if cw, ok := upstream.(closeWriter); ok {
			_ = cw.CloseWrite()
		} else {
			_ = upstream.SetReadDeadline(time.Now().Add(30 * time.Second))
		}
	}()

	go func() {
		defer wg.Done()
		_, _ = io.Copy(client, upstream)
		if cw, ok := client.(closeWriter); ok {
			_ = cw.CloseWrite()
		} else {
			_ = client.SetReadDeadline(time.Now().Add(30 * time.Second))
		}
	}()

	wg.Wait()
}
