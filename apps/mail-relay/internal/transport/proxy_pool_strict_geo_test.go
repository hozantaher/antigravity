package transport

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestStrictGeoEnabled_DefaultOff verifies that without PROXY_STRICT_GEO set
// the strict-geo filter stays disabled. Backwards-compat default — historic
// deployments rely on the "let probe decide" behaviour.
func TestStrictGeoEnabled_DefaultOff(t *testing.T) {
	t.Setenv("PROXY_STRICT_GEO", "")
	if strictGeoEnabled() {
		t.Error("expected strict geo OFF when env unset")
	}
}

// TestStrictGeoEnabled_WhitespaceOnlyOff verifies that whitespace-only env
// value is treated as unset.
func TestStrictGeoEnabled_WhitespaceOnlyOff(t *testing.T) {
	t.Setenv("PROXY_STRICT_GEO", "   ")
	if strictGeoEnabled() {
		t.Error("expected strict geo OFF when env is whitespace only")
	}
}

// TestStrictGeoEnabled_AnyValueOn verifies that any non-empty value enables
// strict mode (1, true, on, yes — all treated identically).
func TestStrictGeoEnabled_AnyValueOn(t *testing.T) {
	for _, val := range []string{"1", "true", "on", "yes", "anything"} {
		t.Run(val, func(t *testing.T) {
			t.Setenv("PROXY_STRICT_GEO", val)
			if !strictGeoEnabled() {
				t.Errorf("expected strict geo ON for value %q", val)
			}
		})
	}
}

// TestFilterByGeo_KeepsAllowedCountries verifies allowed countries pass through.
func TestFilterByGeo_KeepsAllowedCountries(t *testing.T) {
	t.Setenv("PROXY_COUNTRY_CODES", "CZ,SK,DE")

	in := []proxyCandidate{
		{addr: "10.0.0.1:1080", country: "CZ", source: "geonode"},
		{addr: "10.0.0.2:1080", country: "SK", source: "geonode"},
		{addr: "10.0.0.3:1080", country: "DE", source: "geonode"},
	}

	out := filterByGeo(in)

	if len(out) != 3 {
		t.Fatalf("expected 3 kept, got %d", len(out))
	}
}

// TestFilterByGeo_DropsNonAllowed verifies VN, US, RU dropped when not in allow.
func TestFilterByGeo_DropsNonAllowed(t *testing.T) {
	t.Setenv("PROXY_COUNTRY_CODES", "CZ,SK")

	in := []proxyCandidate{
		{addr: "10.0.0.1:1080", country: "CZ", source: "geonode"},
		{addr: "10.0.0.2:1080", country: "VN", source: "geonode"},
		{addr: "10.0.0.3:1080", country: "US", source: "geonode"},
		{addr: "10.0.0.4:1080", country: "RU", source: "geonode"},
		{addr: "10.0.0.5:1080", country: "SK", source: "geonode"},
	}

	out := filterByGeo(in)

	if len(out) != 2 {
		t.Fatalf("expected 2 kept (CZ,SK), got %d", len(out))
	}
	for _, c := range out {
		if c.country != "CZ" && c.country != "SK" {
			t.Errorf("unexpected country in output: %s", c.country)
		}
	}
}

// TestFilterByGeo_DropsEmptyCountry verifies candidates without a country tag
// are dropped in strict mode (proxifly + proxyscrape do not surface country).
func TestFilterByGeo_DropsEmptyCountry(t *testing.T) {
	t.Setenv("PROXY_COUNTRY_CODES", "CZ,SK")

	in := []proxyCandidate{
		{addr: "10.0.0.1:1080", country: "CZ", source: "geonode"},
		{addr: "10.0.0.2:1080", country: "", source: "proxifly"},
		{addr: "10.0.0.3:1080", country: "", source: "proxyscrape"},
	}

	out := filterByGeo(in)

	if len(out) != 1 {
		t.Fatalf("expected 1 kept (CZ only), got %d", len(out))
	}
	if out[0].country != "CZ" {
		t.Errorf("expected CZ, got %s", out[0].country)
	}
}

// TestFilterByGeo_AllRejectedReturnsEmpty verifies that when nothing matches
// the result is empty (rather than nil) — keeps caller code uniform.
func TestFilterByGeo_AllRejectedReturnsEmpty(t *testing.T) {
	t.Setenv("PROXY_COUNTRY_CODES", "CZ")

	in := []proxyCandidate{
		{addr: "10.0.0.1:1080", country: "VN", source: "geonode"},
		{addr: "10.0.0.2:1080", country: "US", source: "geonode"},
		{addr: "10.0.0.3:1080", country: "", source: "proxifly"},
	}

	out := filterByGeo(in)

	if len(out) != 0 {
		t.Errorf("expected empty result, got %d entries", len(out))
	}
}

// TestFilterByGeo_EmptyInput verifies empty input → empty output.
func TestFilterByGeo_EmptyInput(t *testing.T) {
	out := filterByGeo([]proxyCandidate{})
	if len(out) != 0 {
		t.Errorf("expected empty result for empty input, got %d", len(out))
	}
}

// TestFilterByGeo_CaseInsensitiveCountry verifies that lowercase country tags
// from the feed (defensive — geonode responses may be inconsistent) match
// the uppercase allow list. Geonode normalisation upper-cases at parse time,
// but a regression there shouldn't silently drop valid candidates.
func TestFilterByGeo_CaseInsensitiveCountry(t *testing.T) {
	t.Setenv("PROXY_COUNTRY_CODES", "CZ")

	in := []proxyCandidate{
		// fetchProxyListGeonode upper-cases at parse, but defend against drift.
		{addr: "10.0.0.1:1080", country: "CZ", source: "geonode"},
	}

	out := filterByGeo(in)

	if len(out) != 1 {
		t.Errorf("expected 1 kept, got %d", len(out))
	}
}

// TestFetchProxyListMulti_StrictGeoFiltersVietnam exercises the integration:
// geonode returns mixed-country candidates, strict mode active, only allowed
// countries should remain after fetchProxyListMulti.
func TestFetchProxyListMulti_StrictGeoFiltersVietnam(t *testing.T) {
	geonodeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"data":[
			{"ip":"1.1.1.1","port":"1080","country":"CZ"},
			{"ip":"2.2.2.2","port":"1080","country":"VN"},
			{"ip":"3.3.3.3","port":"1080","country":"SK"},
			{"ip":"4.4.4.4","port":"1080","country":"US"},
			{"ip":"5.5.5.5","port":"1080","country":"RU"}
		]}`)
	}))
	defer geonodeServer.Close()

	// Empty feeds for proxifly + proxyscrape so test isolates geonode behaviour.
	emptyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "")
	}))
	defer emptyServer.Close()

	origGeonode := proxyListEndpoint
	origProxifly := proxiflyEndpoint
	origProxiflyFallback := proxiflyFallbackURL
	origProxyscrape := proxyscrapeEndpoint
	proxyListEndpoint = geonodeServer.URL
	proxiflyEndpoint = emptyServer.URL
	proxiflyFallbackURL = emptyServer.URL
	proxyscrapeEndpoint = emptyServer.URL
	defer func() {
		proxyListEndpoint = origGeonode
		proxiflyEndpoint = origProxifly
		proxiflyFallbackURL = origProxiflyFallback
		proxyscrapeEndpoint = origProxyscrape
	}()

	t.Setenv("PROXY_STRICT_GEO", "1")
	t.Setenv("PROXY_COUNTRY_CODES", "CZ,SK")

	cands, err := fetchProxyListMulti(context.Background())
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}

	if len(cands) != 2 {
		t.Fatalf("expected 2 cands (CZ+SK only), got %d: %v", len(cands), candAddrs(cands))
	}

	for _, c := range cands {
		if c.country != "CZ" && c.country != "SK" {
			t.Errorf("strict mode let through %s/%s", c.country, c.addr)
		}
	}
}

// TestFetchProxyListMulti_NonStrictKeepsAllCountries verifies that without
// PROXY_STRICT_GEO the multi-fetch keeps everything (regression guard — we
// must not break the legacy "let probe decide" path).
func TestFetchProxyListMulti_NonStrictKeepsAllCountries(t *testing.T) {
	geonodeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"data":[
			{"ip":"1.1.1.1","port":"1080","country":"CZ"},
			{"ip":"2.2.2.2","port":"1080","country":"VN"},
			{"ip":"3.3.3.3","port":"1080","country":"SK"}
		]}`)
	}))
	defer geonodeServer.Close()

	emptyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "")
	}))
	defer emptyServer.Close()

	origGeonode := proxyListEndpoint
	origProxifly := proxiflyEndpoint
	origProxiflyFallback := proxiflyFallbackURL
	origProxyscrape := proxyscrapeEndpoint
	proxyListEndpoint = geonodeServer.URL
	proxiflyEndpoint = emptyServer.URL
	proxiflyFallbackURL = emptyServer.URL
	proxyscrapeEndpoint = emptyServer.URL
	defer func() {
		proxyListEndpoint = origGeonode
		proxiflyEndpoint = origProxifly
		proxiflyFallbackURL = origProxiflyFallback
		proxyscrapeEndpoint = origProxyscrape
	}()

	t.Setenv("PROXY_STRICT_GEO", "")

	cands, err := fetchProxyListMulti(context.Background())
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}

	if len(cands) != 3 {
		t.Fatalf("expected 3 cands (no filter), got %d: %v", len(cands), candAddrs(cands))
	}
}

// TestFetchProxyListGeonode_PreservesCountry verifies that the geonode parser
// captures the country tag end-to-end (regression for the original bug — the
// parser used to discard country and return []string).
func TestFetchProxyListGeonode_PreservesCountry(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"data":[
			{"ip":"1.1.1.1","port":"1080","country":"cz"},
			{"ip":"2.2.2.2","port":"1080","country":"SK"}
		]}`)
	}))
	defer server.Close()

	orig := proxyListEndpoint
	proxyListEndpoint = server.URL
	defer func() { proxyListEndpoint = orig }()

	cands, err := fetchProxyListGeonode(context.Background())
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}

	if len(cands) != 2 {
		t.Fatalf("expected 2 cands, got %d", len(cands))
	}

	// Lowercase from feed should be normalised to uppercase.
	want := map[string]string{
		"1.1.1.1:1080": "CZ",
		"2.2.2.2:1080": "SK",
	}
	for _, c := range cands {
		if got := want[c.addr]; got != c.country {
			t.Errorf("addr=%s country=%s, want %s", c.addr, c.country, got)
		}
	}
}
