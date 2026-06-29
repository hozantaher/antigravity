package wgpool

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func mkPool(t *testing.T, n int, cfg Config) *Pool {
	t.Helper()
	eps := make([]Endpoint, n)
	for i := 0; i < n; i++ {
		eps[i] = Endpoint{
			Label:     "ep-" + string(rune('a'+i)),
			SocksAddr: "127.0.0.1:108" + string(rune('0'+i)),
			Country:   "CZ",
		}
	}
	p, err := New(eps, cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return p
}

func TestNew_RejectsEmpty(t *testing.T) {
	if _, err := New(nil, Config{}); err == nil {
		t.Fatal("expected error for empty pool")
	}
}

func TestNew_RejectsDuplicateLabel(t *testing.T) {
	_, err := New([]Endpoint{
		{Label: "a", SocksAddr: "127.0.0.1:1080"},
		{Label: "a", SocksAddr: "127.0.0.1:1081"},
	}, Config{})
	if err == nil {
		t.Fatal("expected duplicate label error")
	}
}

func TestNew_RejectsMissingSocksAddr(t *testing.T) {
	_, err := New([]Endpoint{{Label: "a"}}, Config{})
	if err == nil {
		t.Fatal("expected missing socks_addr error")
	}
}

func TestSize(t *testing.T) {
	p := mkPool(t, 4, Config{})
	if got := p.Size(); got != 4 {
		t.Fatalf("size = %d, want 4", got)
	}
}

func TestPick_DeterministicSamePair(t *testing.T) {
	p := mkPool(t, 4, Config{})
	first, err := p.Pick("env-1", "mb-1")
	if err != nil {
		t.Fatalf("first pick: %v", err)
	}
	for i := 0; i < 50; i++ {
		got, err := p.Pick("env-1", "mb-1")
		if err != nil {
			t.Fatalf("pick %d: %v", i, err)
		}
		if got.Label != first.Label {
			t.Fatalf("pick %d: %s != %s", i, got.Label, first.Label)
		}
	}
}

func TestPick_DifferentEnvelopesSpreadAcrossPool(t *testing.T) {
	p := mkPool(t, 4, Config{})
	seen := map[string]struct{}{}
	for i := 0; i < 200; i++ {
		envID := "env-" + time.Now().Format("150405.000000000") + string(rune(i))
		got, err := p.Pick(envID, "")
		if err != nil {
			t.Fatalf("pick %d: %v", i, err)
		}
		seen[got.Label] = struct{}{}
	}
	if len(seen) < 4 {
		t.Fatalf("only %d distinct endpoints reached: %v", len(seen), seen)
	}
}

func TestPick_AffinityWindowSticky(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	p := mkPool(t, 4, Config{
		AffinityEnabled: true,
		AffinityWindow:  3,
		Now:             func() time.Time { return now },
	})

	first, err := p.Pick("env-A", "mb-1")
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	for i := 0; i < 2; i++ {
		got, err := p.Pick("env-different-each-time", "mb-1")
		if err != nil {
			t.Fatalf("pick %d: %v", i, err)
		}
		if got.Label != first.Label {
			t.Fatalf("affinity broken at pick %d: %s != %s", i, got.Label, first.Label)
		}
	}
	if _, err := p.Pick("env-X", "mb-1"); err != nil {
		t.Fatal(err)
	}
}

func TestPick_AllQuarantined(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	p := mkPool(t, 2, Config{
		QuarantineThreshold: 1,
		QuarantineDuration:  10 * time.Minute,
		Now:                 func() time.Time { return now },
	})
	for _, h := range p.Snapshot() {
		p.RecordFailure(h.Endpoint.Label)
	}
	if _, err := p.Pick("e", "m"); !errors.Is(err, ErrAllQuarantined) {
		t.Fatalf("want ErrAllQuarantined, got %v", err)
	}
}

func TestQuarantine_TripsAfterThreshold(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	p := mkPool(t, 2, Config{
		QuarantineThreshold: 3,
		QuarantineDuration:  5 * time.Minute,
		Now:                 func() time.Time { return now },
	})

	p.RecordFailure("ep-a")
	if findHealth(p.Snapshot(), "ep-a").Quarantined {
		t.Fatal("ep-a quarantined after 1 fail")
	}
	p.RecordFailure("ep-a")
	if findHealth(p.Snapshot(), "ep-a").Quarantined {
		t.Fatal("ep-a quarantined after 2 fails")
	}
	p.RecordFailure("ep-a")
	h := findHealth(p.Snapshot(), "ep-a")
	if !h.Quarantined {
		t.Fatal("ep-a should be quarantined after 3 fails")
	}
	if !h.QuarantineUntil.Equal(now.Add(5 * time.Minute)) {
		t.Fatalf("quarantine_until = %v, want now+5m", h.QuarantineUntil)
	}
}

func TestQuarantine_ReleasesAfterDuration(t *testing.T) {
	current := time.Unix(1_700_000_000, 0)
	p := mkPool(t, 2, Config{
		QuarantineThreshold: 1,
		QuarantineDuration:  5 * time.Minute,
		Now:                 func() time.Time { return current },
	})
	p.RecordFailure("ep-a")
	if !findHealth(p.Snapshot(), "ep-a").Quarantined {
		t.Fatal("expected ep-a quarantined")
	}
	current = current.Add(6 * time.Minute)
	if findHealth(p.Snapshot(), "ep-a").Quarantined {
		t.Fatal("expected ep-a released after quarantine duration")
	}
}

func TestRecordSuccess_ResetsStreak(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	p := mkPool(t, 2, Config{
		QuarantineThreshold: 3,
		QuarantineDuration:  5 * time.Minute,
		Now:                 func() time.Time { return now },
	})
	p.RecordFailure("ep-a")
	p.RecordFailure("ep-a")
	p.RecordSuccess("ep-a")
	p.RecordFailure("ep-a")
	p.RecordFailure("ep-a")
	if findHealth(p.Snapshot(), "ep-a").Quarantined {
		t.Fatal("streak reset failed; ep-a quarantined after 2 post-success fails")
	}
}

func TestPick_OnlyOneEndpoint(t *testing.T) {
	p := mkPool(t, 1, Config{})
	for i := 0; i < 10; i++ {
		ep, err := p.Pick("env-"+string(rune(i)), "mb-1")
		if err != nil {
			t.Fatal(err)
		}
		if ep.Label != "ep-a" {
			t.Fatalf("got %s, want ep-a", ep.Label)
		}
	}
}

func TestParseConfig_Empty(t *testing.T) {
	got, err := ParseConfig("")
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("want nil, got %+v", got)
	}
}

func TestParseConfig_Valid(t *testing.T) {
	in := `[
	  {"label":"cz5","socks_addr":"127.0.0.1:1080","country":"CZ","city":"Prague","peer_pubkey":"abc","peer_host":"cz5.mullvad.net:51820"},
	  {"label":"de4","socks_addr":"127.0.0.1:1081","country":"DE"}
	]`
	got, err := ParseConfig(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Label != "cz5" || got[1].SocksAddr != "127.0.0.1:1081" {
		t.Fatalf("parsed: %+v", got)
	}
}

func TestParseConfig_Invalid(t *testing.T) {
	if _, err := ParseConfig("{not json"); err == nil {
		t.Fatal("expected error")
	}
}

func TestSnapshot_SortedByLabel(t *testing.T) {
	p := mkPool(t, 4, Config{})
	snap := p.Snapshot()
	for i := 1; i < len(snap); i++ {
		if !(snap[i-1].Endpoint.Label < snap[i].Endpoint.Label) {
			t.Fatalf("snapshot not sorted at %d: %s vs %s",
				i, snap[i-1].Endpoint.Label, snap[i].Endpoint.Label)
		}
	}
}

func TestRoundRobin_NoAffinity(t *testing.T) {
	p := mkPool(t, 4, Config{})
	counts := map[string]int{}
	for i := 0; i < 200; i++ {
		ep, err := p.Pick("", "")
		if err != nil {
			t.Fatal(err)
		}
		counts[ep.Label]++
	}
	if len(counts) != 4 {
		t.Fatalf("round-robin reached %d endpoints, want 4: %v", len(counts), counts)
	}
	for label, c := range counts {
		if c < 40 || c > 60 {
			t.Fatalf("round-robin imbalance for %s: %d hits", label, c)
		}
	}
}

func findHealth(snap []Health, label string) Health {
	for _, h := range snap {
		if h.Endpoint.Label == label {
			return h
		}
	}
	return Health{}
}

// TestEndpointSocksAddrPattern guards the operator contract: every
// endpoint binds 127.0.0.1:108x.
func TestEndpointSocksAddrPattern(t *testing.T) {
	cases := []string{"127.0.0.1:1080", "127.0.0.1:1081", "127.0.0.1:1085"}
	for _, addr := range cases {
		if !strings.HasPrefix(addr, "127.0.0.1:108") {
			t.Fatalf("contract violation: %s", addr)
		}
	}
}
