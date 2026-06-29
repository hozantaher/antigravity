package transport

import (
	"errors"
	"testing"
)

func TestBuildChainDirectForbidden(t *testing.T) {
	// Default (no env): direct mode rejected to preserve the no_direct_smtp
	// HARD RULE. Operator opt-in via ALLOW_DIRECT_EGRESS=true is covered
	// by TestBuildChainDirectAllowedViaEnv below.
	t.Setenv("ALLOW_DIRECT_EGRESS", "")
	tr, err := BuildChain("direct", "", nil)
	if err == nil {
		t.Fatal("expected error — direct mode must be forbidden by default")
	}
	if !errors.Is(err, ErrDirectTransportForbidden) {
		t.Fatalf("expected ErrDirectTransportForbidden, got %v", err)
	}
	if tr != nil {
		t.Fatal("expected nil transport when direct mode rejected")
	}
}

// TestBuildChainDirectAllowedViaEnv covers the 2026-05-12 operator
// override path. When ALLOW_DIRECT_EGRESS=true is set on the relay
// service, BuildChain("direct", ...) must return a usable DirectTransport
// so SMTP submission can bypass the Mullvad VPN tunnel for deliverability.
//
// The env flag is the gate — direct egress without it remains forbidden.
func TestBuildChainDirectAllowedViaEnv(t *testing.T) {
	t.Setenv("ALLOW_DIRECT_EGRESS", "true")
	tr, err := BuildChain("direct", "", nil)
	if err != nil {
		t.Fatalf("unexpected error with ALLOW_DIRECT_EGRESS=true: %v", err)
	}
	if tr == nil {
		t.Fatal("expected non-nil transport when direct mode allowed")
	}
	if _, ok := tr.(*DirectTransport); !ok {
		t.Fatalf("expected *DirectTransport, got %T", tr)
	}
}

// TestBuildChainDirectAllowedRequiresExactTrueValue ensures stray values
// don't accidentally enable direct egress. Only the literal string "true"
// flips the gate; "1", "yes", "TRUE", etc. all stay forbidden so a typo
// in the Railway env panel doesn't leak the egress IP.
func TestBuildChainDirectAllowedRequiresExactTrueValue(t *testing.T) {
	cases := []string{"1", "yes", "TRUE", "True", "on", " true ", ""}
	for _, val := range cases {
		t.Run("val="+val, func(t *testing.T) {
			t.Setenv("ALLOW_DIRECT_EGRESS", val)
			tr, err := BuildChain("direct", "", nil)
			if err == nil || !errors.Is(err, ErrDirectTransportForbidden) {
				t.Fatalf("value %q should NOT enable direct egress (err=%v tr=%v)", val, err, tr)
			}
		})
	}
}

func TestBuildChainProxyForbidden(t *testing.T) {
	tr, err := BuildChain("proxy", "", nil)
	if err == nil {
		t.Fatal("expected error — proxy mode (free pool) must be retired")
	}
	if !errors.Is(err, ErrFreePoolForbidden) {
		t.Fatalf("expected ErrFreePoolForbidden, got %v", err)
	}
	if tr != nil {
		t.Fatal("expected nil transport when proxy mode rejected")
	}
}

func TestBuildChainSocks5RequiresAddr(t *testing.T) {
	_, err := BuildChain("socks5", "", nil)
	if err == nil {
		t.Fatal("expected error for socks5 without socks addr")
	}
}

func TestBuildChainSocks5(t *testing.T) {
	tr, err := BuildChain("socks5", "127.0.0.1:1080", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := tr.(*SOCKS5Transport); !ok {
		t.Fatal("expected SOCKS5Transport")
	}
}

// "tor" is kept as a backwards-compatible alias of "socks5".
func TestBuildChainTorAlias(t *testing.T) {
	tr, err := BuildChain("tor", "127.0.0.1:9050", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := tr.(*SOCKS5Transport); !ok {
		t.Fatal("expected SOCKS5Transport")
	}
}

func TestBuildChainVPNRequiresTransport(t *testing.T) {
	_, err := BuildChain("vpn", "", nil)
	if err == nil {
		t.Fatal("expected error for vpn without transport")
	}
}

func TestBuildChainVPNTor(t *testing.T) {
	vpn := NewDirectTransport() // mock VPN transport
	tr, err := BuildChain("vpn+tor", "127.0.0.1:9050", vpn)
	if err != nil {
		t.Fatal(err)
	}
	chain, ok := tr.(*ChainTransport)
	if !ok {
		t.Fatal("expected ChainTransport")
	}
	if chain.HopCount() != 2 {
		t.Fatalf("expected 2 hops, got %d", chain.HopCount())
	}
}

func TestBuildChainUnknownMode(t *testing.T) {
	_, err := BuildChain("unknown", "", nil)
	if err == nil {
		t.Fatal("expected error for unknown mode")
	}
}

func TestChainDescription(t *testing.T) {
	vpn := NewDirectTransport()
	tor := NewSOCKS5Transport("127.0.0.1:9050", 60)
	chain, _ := NewChainTransport(vpn, tor)

	desc := chain.Description()
	if desc == "" {
		t.Fatal("expected non-empty description")
	}
}
