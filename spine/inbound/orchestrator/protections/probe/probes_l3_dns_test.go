package probe

import (
	"context"
	"errors"
	"testing"
	"time"
)

// fakeResolver simulates DNS responses.
type fakeResolver struct {
	records map[string][]string
	err     map[string]error
}

func (f *fakeResolver) LookupTXT(_ context.Context, name string) ([]string, error) {
	if e, ok := f.err[name]; ok {
		return nil, e
	}
	if r, ok := f.records[name]; ok {
		return r, nil
	}
	return nil, nil
}

// --------------------------------------------------------------------
// SpfDmarcL3 tests
// --------------------------------------------------------------------

func TestSpfDmarcL3_NoDomains_Skip(t *testing.T) {
	p := NewSpfDmarcL3(nil, 0)
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("want skip, got %s", r.Status)
	}
}

func TestSpfDmarcL3_DefaultInterval(t *testing.T) {
	p := NewSpfDmarcL3(nil, 0)
	if p.Interval() != 15*time.Minute {
		t.Fatalf("interval: %v", p.Interval())
	}
	if p.Layer() != "spf_dmarc" {
		t.Fatalf("layer: %s", p.Layer())
	}
	if p.Level() != LevelCorrect {
		t.Fatalf("level: %d", p.Level())
	}
}

func TestSpfDmarcL3_ValidRecords_OK(t *testing.T) {
	res := &fakeResolver{records: map[string][]string{
		"example.com":        {"v=spf1 include:sendgrid.net ~all"},
		"_dmarc.example.com": {"v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"},
	}}
	p := &SpfDmarcL3{Domains: []string{"example.com"}, Resolver: res}
	r := p.Run(context.Background())
	if r.Status != StatusOK {
		t.Fatalf("want ok, got %s: %s", r.Status, r.Detail)
	}
}

func TestSpfDmarcL3_DMARC_pReject_OK(t *testing.T) {
	res := &fakeResolver{records: map[string][]string{
		"example.com":        {"v=spf1 ip4:1.2.3.4 -all"},
		"_dmarc.example.com": {"v=DMARC1; p=reject"},
	}}
	p := &SpfDmarcL3{Domains: []string{"example.com"}, Resolver: res}
	r := p.Run(context.Background())
	if r.Status != StatusOK {
		t.Fatalf("want ok, got %s", r.Status)
	}
}

func TestSpfDmarcL3_DMARC_pNone_Warn(t *testing.T) {
	res := &fakeResolver{records: map[string][]string{
		"example.com":        {"v=spf1 ip4:1.2.3.4 ~all"},
		"_dmarc.example.com": {"v=DMARC1; p=none"},
	}}
	p := &SpfDmarcL3{Domains: []string{"example.com"}, Resolver: res}
	r := p.Run(context.Background())
	if r.Status != StatusWarn {
		t.Fatalf("want warn (p=none), got %s: %s", r.Status, r.Detail)
	}
}

func TestSpfDmarcL3_NoSPF_Err(t *testing.T) {
	res := &fakeResolver{records: map[string][]string{
		"example.com":        {"some-other-record=foo"},
		"_dmarc.example.com": {"v=DMARC1; p=reject"},
	}}
	p := &SpfDmarcL3{Domains: []string{"example.com"}, Resolver: res}
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err (no SPF), got %s", r.Status)
	}
}

func TestSpfDmarcL3_NoDMARC_Err(t *testing.T) {
	res := &fakeResolver{records: map[string][]string{
		"example.com": {"v=spf1 ~all"},
	}}
	p := &SpfDmarcL3{Domains: []string{"example.com"}, Resolver: res}
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err (no DMARC), got %s", r.Status)
	}
}

func TestSpfDmarcL3_LookupError_Err(t *testing.T) {
	res := &fakeResolver{err: map[string]error{
		"example.com": errors.New("DNS timeout"),
	}}
	p := &SpfDmarcL3{Domains: []string{"example.com"}, Resolver: res}
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err (lookup fail), got %s", r.Status)
	}
}

func TestSpfDmarcL3_MultipleDomains_WorstWins(t *testing.T) {
	res := &fakeResolver{records: map[string][]string{
		"ok.com":          {"v=spf1 ~all"},
		"_dmarc.ok.com":   {"v=DMARC1; p=reject"},
		"bad.com":         {"some-other-record"},
		"_dmarc.bad.com":  {"v=DMARC1; p=reject"},
	}}
	p := &SpfDmarcL3{Domains: []string{"ok.com", "bad.com"}, Resolver: res}
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err (one domain bad), got %s: %s", r.Status, r.Detail)
	}
}

func TestSpfDmarcL3_SPF_NoAllQualifier_Warn(t *testing.T) {
	res := &fakeResolver{records: map[string][]string{
		"example.com":        {"v=spf1 include:mailprovider.com"},
		"_dmarc.example.com": {"v=DMARC1; p=reject"},
	}}
	p := &SpfDmarcL3{Domains: []string{"example.com"}, Resolver: res}
	r := p.Run(context.Background())
	if r.Status != StatusWarn {
		t.Fatalf("want warn (no all qualifier), got %s: %s", r.Status, r.Detail)
	}
}

// --------------------------------------------------------------------
// WatchdogMetaL3 tests
// --------------------------------------------------------------------

func TestWatchdogMetaL3_NilDB_Skip(t *testing.T) {
	p := NewWatchdogMetaL3(nil, 0)
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("want skip, got %s", r.Status)
	}
}

func TestWatchdogMetaL3_DefaultInterval(t *testing.T) {
	p := NewWatchdogMetaL3(nil, 0)
	if p.Interval() != 30*time.Minute {
		t.Fatalf("interval: %v", p.Interval())
	}
	if p.Layer() != "watchdog" {
		t.Fatalf("layer: %s", p.Layer())
	}
	if p.Level() != LevelCorrect {
		t.Fatalf("level: %d", p.Level())
	}
}
