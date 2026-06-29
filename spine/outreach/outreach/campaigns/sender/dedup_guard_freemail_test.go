package sender

// Tests for the freemail carve-out in per-domain cooldown — Sprint
// operator-decision 2026-05-12 (campaign 457 incident).
//
// Before the fix: 14,512 contacts on seznam.cz + 2,294 on gmail.com +
// thousands more on email.cz/volny.cz/etc. were skipped after only 74
// sends because the dedup_guard treated each freemail provider as a
// single corporate entity.
//
// These tests verify isFreemailDomainForDedup correctly classifies the
// known CZ + SK + global freemail providers, and that anything else
// (corporate domain, empty string, unknown TLD) falls through.

import (
	"testing"
)

func TestIsFreemailDomainForDedup_CzechFreemails(t *testing.T) {
	cases := []string{
		"seznam.cz", "email.cz", "centrum.cz", "volny.cz",
		"tiscali.cz", "post.cz", "atlas.cz", "quick.cz",
		"iol.cz", "azet.cz", "wo.cz", "in.cz",
		"mybox.cz", "klikni.cz",
	}
	for _, d := range cases {
		t.Run(d, func(t *testing.T) {
			if !isFreemailDomainForDedup(d) {
				t.Fatalf("expected %q to be classified as freemail", d)
			}
		})
	}
}

func TestIsFreemailDomainForDedup_SlovakFreemails(t *testing.T) {
	cases := []string{"azet.sk", "centrum.sk", "pobox.sk", "post.sk", "zoznam.sk", "atlas.sk"}
	for _, d := range cases {
		t.Run(d, func(t *testing.T) {
			if !isFreemailDomainForDedup(d) {
				t.Fatalf("expected %q to be classified as freemail", d)
			}
		})
	}
}

func TestIsFreemailDomainForDedup_GlobalFreemails(t *testing.T) {
	cases := []string{
		"gmail.com", "googlemail.com",
		"outlook.com", "hotmail.com", "live.com", "msn.com",
		"outlook.cz", "hotmail.cz",
		"yahoo.com", "yahoo.co.uk", "yahoo.de",
		"icloud.com", "me.com", "mac.com",
		"protonmail.com", "proton.me", "pm.me",
		"tutanota.com", "tuta.io",
		"zoho.com", "yandex.com", "mail.ru",
		"aol.com", "gmx.com", "gmx.de", "gmx.net",
	}
	for _, d := range cases {
		t.Run(d, func(t *testing.T) {
			if !isFreemailDomainForDedup(d) {
				t.Fatalf("expected %q to be classified as freemail", d)
			}
		})
	}
}

func TestIsFreemailDomainForDedup_CorporateDomainsNotFlagged(t *testing.T) {
	cases := []string{
		"kovostroj.cz", "balkanmotors.cz", "agd.cz", "stackdesign.cz",
		"acatrade.cz", "advyskovky.cz", "adbcargo.eu", "adzika.cz",
		"strojirny.cz", "garaaage.cz", "messing.dev",
	}
	for _, d := range cases {
		t.Run(d, func(t *testing.T) {
			if isFreemailDomainForDedup(d) {
				t.Fatalf("corporate domain %q must NOT be flagged as freemail", d)
			}
		})
	}
}

func TestIsFreemailDomainForDedup_EdgeCases(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"", false},
		{"   ", false},
		{"SEZNAM.CZ", true},
		{"  gmail.com  ", true},
		{"Gmail.Com", true},
		{"sub.gmail.com", false}, // subdomain-of is intentionally not flagged
		{"gmail", false},          // no TLD
		{"unknown.tld", false},
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			got := isFreemailDomainForDedup(c.in)
			if got != c.want {
				t.Fatalf("isFreemailDomainForDedup(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}
