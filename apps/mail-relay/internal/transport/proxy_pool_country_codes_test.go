package transport

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestAllowedCountryCodes_Default_CentralEurope verifies that when
// PROXY_COUNTRY_CODES is unset the function returns the Central-Europe set
// (CZ,SK,DE,AT,PL,HU,SI). Wide enough to keep a healthy pool, narrow enough
// to reject Asia/Americas/Africa exits.
func TestAllowedCountryCodes_Default_CentralEurope(t *testing.T) {
	t.Setenv("PROXY_COUNTRY_CODES", "")

	codes := allowedCountryCodes()

	want := []string{"CZ", "SK", "DE", "AT", "PL", "HU", "SI"}
	for _, code := range want {
		if _, ok := codes[code]; !ok {
			t.Errorf("expected %s in default allowed codes", code)
		}
	}
	if got := len(codes); got != len(want) {
		t.Errorf("default allowed codes = %d entries, want %d (Central Europe)", got, len(want))
	}
}

// TestAllowedCountryCodes_Override verifies that PROXY_COUNTRY_CODES="CZ,SK,PL"
// returns exactly 3 codes: CZ, SK, PL and no others.
func TestAllowedCountryCodes_Override(t *testing.T) {
	t.Setenv("PROXY_COUNTRY_CODES", "CZ,SK,PL")

	codes := allowedCountryCodes()

	want := map[string]bool{"CZ": true, "SK": true, "PL": true}
	if got := len(codes); got != len(want) {
		t.Fatalf("len(allowedCountryCodes) = %d, want %d", got, len(want))
	}
	for code := range want {
		if _, ok := codes[code]; !ok {
			t.Errorf("expected %s in overridden allowed codes", code)
		}
	}
	// No extra codes should bleed in.
	for code := range codes {
		if !want[code] {
			t.Errorf("unexpected code %q in allowed set", code)
		}
	}
}

// TestAllowedCountryCodes_CZOnly verifies single-code override.
func TestAllowedCountryCodes_CZOnly(t *testing.T) {
	t.Setenv("PROXY_COUNTRY_CODES", "CZ")

	codes := allowedCountryCodes()

	if got := len(codes); got != 1 {
		t.Fatalf("expected 1 allowed code, got %d: %v", got, codes)
	}
	if _, ok := codes["CZ"]; !ok {
		t.Error("expected CZ in single-code override")
	}
}

// TestAllowedCountryCodes_LowercaseNormalized verifies that lowercase input is
// normalised to uppercase ("cz,sk" → {"CZ","SK"}).
func TestAllowedCountryCodes_LowercaseNormalized(t *testing.T) {
	t.Setenv("PROXY_COUNTRY_CODES", "cz,sk")

	codes := allowedCountryCodes()

	if _, ok := codes["CZ"]; !ok {
		t.Error("expected CZ (from lowercase cz) to be normalised")
	}
	if _, ok := codes["SK"]; !ok {
		t.Error("expected SK (from lowercase sk) to be normalised")
	}
}

// TestAllowedCountryCodes_BlankEnvFallsBackToCentralEurope ensures that
// setting PROXY_COUNTRY_CODES to whitespace-only falls back to the Central-
// Europe default (CZ,SK,DE,AT,PL,HU,SI).
func TestAllowedCountryCodes_BlankEnvFallsBackToCentralEurope(t *testing.T) {
	t.Setenv("PROXY_COUNTRY_CODES", "   ")

	codes := allowedCountryCodes()

	if got := len(codes); got != 7 {
		t.Errorf("blank env → expected Central-Europe fallback (7 codes), got %d", got)
	}
	for _, code := range []string{"CZ", "SK", "DE", "AT", "PL", "HU", "SI"} {
		if _, ok := codes[code]; !ok {
			t.Errorf("%s missing from blank-env fallback", code)
		}
	}
}

// TestAllowedCountryCodes_SpacePaddedEntries verifies that " CZ , SK " is
// parsed correctly regardless of surrounding spaces.
func TestAllowedCountryCodes_SpacePaddedEntries(t *testing.T) {
	t.Setenv("PROXY_COUNTRY_CODES", " CZ , SK ")

	codes := allowedCountryCodes()

	if got := len(codes); got != 2 {
		t.Fatalf("expected 2 codes, got %d: %v", got, codes)
	}
	if _, ok := codes["CZ"]; !ok {
		t.Error("CZ missing after space-padded parse")
	}
	if _, ok := codes["SK"]; !ok {
		t.Error("SK missing after space-padded parse")
	}
}

// TestAllowedCountryCodes_EmptyTokensIgnored verifies that "CZ,,PL," (commas with
// empty tokens) produces exactly 2 codes without panicking.
func TestAllowedCountryCodes_EmptyTokensIgnored(t *testing.T) {
	t.Setenv("PROXY_COUNTRY_CODES", "CZ,,PL,")

	codes := allowedCountryCodes()

	if got := len(codes); got != 2 {
		t.Fatalf("expected 2 codes (empty tokens ignored), got %d: %v", got, codes)
	}
	if _, ok := codes["CZ"]; !ok {
		t.Error("CZ missing")
	}
	if _, ok := codes["PL"]; !ok {
		t.Error("PL missing")
	}
}

// TestProxiflyFilter_RespectsAllowedCountryCodes verifies proxifly txt feed
// returns all socks5 entries regardless of country (no country filter on txt).
func TestProxiflyFilter_RespectsAllowedCountryCodes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// txt format — no country data, all socks5 pass through
		fmt.Fprint(w, "socks5://1.1.1.1:1080\nsocks5://2.2.2.2:1080\n")
	}))
	defer server.Close()

	orig := proxiflyEndpoint
	proxiflyEndpoint = server.URL
	defer func() { proxiflyEndpoint = orig }()

	cands, err := fetchProxyListProxifly(context.Background())
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}

	// Both pass — no country filter in txt mode
	if len(cands) != 2 {
		t.Fatalf("expected 2 cands, got %d: %v", len(cands), candAddrs(cands))
	}
}

// TestProxiflyFilter_DefaultCZSKFiltersDrop verifies txt feed returns all
// socks5 entries — country filter no longer applied to proxifly txt source.
func TestProxiflyFilter_DefaultCZSKFiltersDrop(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "socks5://1.0.0.1:1080\nsocks5://1.0.0.2:1080\nsocks5://1.0.0.3:1080\n")
	}))
	defer server.Close()

	orig := proxiflyEndpoint
	proxiflyEndpoint = server.URL
	defer func() { proxiflyEndpoint = orig }()

	cands, err := fetchProxyListProxifly(context.Background())
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}

	// All 3 pass — no country filter in txt mode
	if len(cands) != 3 {
		t.Fatalf("expected 3 cands, got %d", len(cands))
	}
}
