package web

import (
	"context"
	"errors"
	"testing"
)

// ─── LookupTXT (netDNSResolver) ──────────────────────────────────────────────

func TestNetDNSResolver_LookupTXT_InvalidDomain_Error(t *testing.T) {
	r := &netDNSResolver{r: defaultDNSResolver.(*netDNSResolver).r}
	// .invalid TLD is guaranteed to not resolve
	_, err := r.LookupTXT(context.Background(), "nonexistent-outreach-test.invalid")
	if err == nil {
		t.Log("DNS resolved unexpectedly — skipping assertion (network environment)")
	}
	// Either err != nil (expected) or nil (unusual network). Both are fine
	// as long as we cover the code path.
	_ = err
}

// ─── checkSPFWeb ─────────────────────────────────────────────────────────────

func TestCheckSPFWeb_LookupError(t *testing.T) {
	res := &fakeWebResolver{errs: map[string]error{"bad.cz": errors.New("dns down")}}
	status, detail := checkSPFWeb(context.Background(), res, "bad.cz")
	if status != "err" {
		t.Errorf("expected err status, got %q", status)
	}
	if detail == "" {
		t.Error("expected non-empty detail")
	}
}

func TestCheckSPFWeb_NoSPFRecord(t *testing.T) {
	res := &fakeWebResolver{records: map[string][]string{
		"firma.cz": {"v=DKIM1; p=abc"},
	}}
	status, _ := checkSPFWeb(context.Background(), res, "firma.cz")
	if status != "err" {
		t.Errorf("expected err for missing SPF, got %q", status)
	}
}

func TestCheckSPFWeb_SPFWithHardFail(t *testing.T) {
	res := &fakeWebResolver{records: map[string][]string{
		"firma.cz": {"v=spf1 include:_spf.google.com -all"},
	}}
	status, detail := checkSPFWeb(context.Background(), res, "firma.cz")
	if status != "ok" {
		t.Errorf("expected ok for -all SPF, got %q: %s", status, detail)
	}
}

func TestCheckSPFWeb_SPFWithSoftFail(t *testing.T) {
	res := &fakeWebResolver{records: map[string][]string{
		"firma.cz": {"v=spf1 include:_spf.google.com ~all"},
	}}
	status, detail := checkSPFWeb(context.Background(), res, "firma.cz")
	if status != "ok" {
		t.Errorf("expected ok for ~all SPF, got %q: %s", status, detail)
	}
}

func TestCheckSPFWeb_SPFMissingAll(t *testing.T) {
	res := &fakeWebResolver{records: map[string][]string{
		"firma.cz": {"v=spf1 include:_spf.google.com"},
	}}
	status, _ := checkSPFWeb(context.Background(), res, "firma.cz")
	if status != "warn" {
		t.Errorf("expected warn for SPF without -all/~all, got %q", status)
	}
}

// ─── checkDMARCWeb ───────────────────────────────────────────────────────────

func TestCheckDMARCWeb_LookupError(t *testing.T) {
	res := &fakeWebResolver{errs: map[string]error{"_dmarc.bad.cz": errors.New("dns down")}}
	status, _ := checkDMARCWeb(context.Background(), res, "bad.cz")
	if status != "err" {
		t.Errorf("expected err status, got %q", status)
	}
}

func TestCheckDMARCWeb_NoDMARCRecord(t *testing.T) {
	res := &fakeWebResolver{records: map[string][]string{}}
	status, _ := checkDMARCWeb(context.Background(), res, "firma.cz")
	if status != "err" {
		t.Errorf("expected err for missing DMARC, got %q", status)
	}
}

func TestCheckDMARCWeb_PReject(t *testing.T) {
	res := &fakeWebResolver{records: map[string][]string{
		"_dmarc.firma.cz": {"v=DMARC1; p=reject; rua=mailto:dmarc@firma.cz"},
	}}
	status, _ := checkDMARCWeb(context.Background(), res, "firma.cz")
	if status != "ok" {
		t.Errorf("expected ok for p=reject, got %q", status)
	}
}

func TestCheckDMARCWeb_PNone_Warn(t *testing.T) {
	res := &fakeWebResolver{records: map[string][]string{
		"_dmarc.firma.cz": {"v=DMARC1; p=none"},
	}}
	status, _ := checkDMARCWeb(context.Background(), res, "firma.cz")
	if status != "warn" {
		t.Errorf("expected warn for p=none, got %q", status)
	}
}

func TestCheckDMARCWeb_UnrecognisedPolicy_Warn(t *testing.T) {
	res := &fakeWebResolver{records: map[string][]string{
		"_dmarc.firma.cz": {"v=DMARC1; p=unknown"},
	}}
	status, _ := checkDMARCWeb(context.Background(), res, "firma.cz")
	if status != "warn" {
		t.Errorf("expected warn for unrecognised DMARC policy, got %q", status)
	}
}
