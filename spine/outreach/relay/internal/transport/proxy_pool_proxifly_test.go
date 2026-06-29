package transport

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
)

// TestFetchProxyListProxifly_ParsesTxtFormat verifies the proxifly fetcher
// parses the socks5://host:port plain-text format correctly.
func TestFetchProxyListProxifly_ParsesTxtFormat(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "socks5://1.1.1.1:1080\nsocks5://2.2.2.2:1080\nsocks5://3.3.3.3:9050\n")
	}))
	defer server.Close()

	orig := proxiflyEndpoint
	origFB := proxiflyFallbackURL
	proxiflyEndpoint = server.URL
	proxiflyFallbackURL = server.URL // prevent fallback from hitting real GitHub URL
	defer func() { proxiflyEndpoint = orig; proxiflyFallbackURL = origFB }()

	cands, err := fetchProxyListProxifly(context.Background())
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}

	addrs := candAddrs(cands)
	sort.Strings(addrs)
	want := []string{"1.1.1.1:1080", "2.2.2.2:1080", "3.3.3.3:9050"}
	if len(addrs) != len(want) {
		t.Fatalf("expected %d addrs, got %d: %v", len(want), len(addrs), addrs)
	}
	for i, w := range want {
		if addrs[i] != w {
			t.Errorf("addr[%d]: want %q got %q", i, w, addrs[i])
		}
	}
	for _, c := range cands {
		if c.source != "proxifly" {
			t.Errorf("%s: source=%q, want proxifly", c.addr, c.source)
		}
	}
}

// TestFetchProxyListProxifly_SkipsNonSocks5Lines verifies http:// and invalid
// lines are skipped.
func TestFetchProxyListProxifly_SkipsNonSocks5Lines(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "socks5://1.1.1.1:1080\nhttp://2.2.2.2:8080\nhttps://3.3.3.3:443\nnot-a-proxy\n\nsocks5://4.4.4.4:1080\n")
	}))
	defer server.Close()

	orig := proxiflyEndpoint
	origFB := proxiflyFallbackURL
	proxiflyEndpoint = server.URL
	proxiflyFallbackURL = server.URL // prevent fallback from hitting real GitHub URL
	defer func() { proxiflyEndpoint = orig; proxiflyFallbackURL = origFB }()

	cands, err := fetchProxyListProxifly(context.Background())
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}

	addrs := candAddrs(cands)
	if len(addrs) != 2 {
		t.Fatalf("expected 2 socks5 addrs, got %d: %v", len(addrs), addrs)
	}
}

// TestFetchProxyListProxifly_EmptyFeed returns zero candidates without error.
func TestFetchProxyListProxifly_EmptyFeed(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "\n\n")
	}))
	defer server.Close()

	orig := proxiflyEndpoint
	origFB := proxiflyFallbackURL
	proxiflyEndpoint = server.URL
	proxiflyFallbackURL = server.URL // prevent fallback from hitting real GitHub URL
	defer func() { proxiflyEndpoint = orig; proxiflyFallbackURL = origFB }()

	cands, err := fetchProxyListProxifly(context.Background())
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(cands) != 0 {
		t.Fatalf("expected 0 addrs, got %d", len(cands))
	}
}

// TestFetchProxyListMulti_IncludesProxifly confirms the tri-source fetcher
// merges proxifly + geonode + proxyscrape and de-dupes the union.
func TestFetchProxyListMulti_IncludesProxifly(t *testing.T) {
	proxifly := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "socks5://9.9.9.9:1080\nsocks5://2.2.2.2:1080\n")
	}))
	defer proxifly.Close()

	geonode := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[{"ip":"1.1.1.1","port":"1080"},{"ip":"2.2.2.2","port":"1080"}]}`)
	}))
	defer geonode.Close()

	proxyscrape := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "4.4.4.4:1080\n5.5.5.5:1080\n")
	}))
	defer proxyscrape.Close()

	origPF, origGeo, origPS, origPFFB := proxiflyEndpoint, proxyListEndpoint, proxyscrapeEndpoint, proxiflyFallbackURL
	proxiflyEndpoint = proxifly.URL
	proxyListEndpoint = geonode.URL
	proxyscrapeEndpoint = proxyscrape.URL
	proxiflyFallbackURL = proxifly.URL // prevent fallback from hitting real GitHub URL
	defer func() {
		proxiflyEndpoint = origPF
		proxyListEndpoint = origGeo
		proxyscrapeEndpoint = origPS
		proxiflyFallbackURL = origPFFB
	}()

	cands, err := fetchProxyListMulti(context.Background())
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}

	addrs := candAddrs(cands)
	sort.Strings(addrs)
	want := []string{"1.1.1.1:1080", "2.2.2.2:1080", "4.4.4.4:1080", "5.5.5.5:1080", "9.9.9.9:1080"}
	if len(addrs) != len(want) {
		t.Fatalf("expected %d addrs, got %d: %v", len(want), len(addrs), addrs)
	}
	for i, w := range want {
		if addrs[i] != w {
			t.Errorf("addr[%d]: want %q got %q", i, w, addrs[i])
		}
	}
}
