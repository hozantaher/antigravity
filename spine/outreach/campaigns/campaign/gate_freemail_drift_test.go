package campaign

import (
	"testing"

	"campaigns/sender"
)

// Regression guard for the 2026-06-22 campaign-457 send stall.
//
// The runner's per-domain rotation + per-campaign lifetime cap gates bypass
// freemail providers via IsFreemailDomain. A duplicate freemail map used to
// live in gate.go and DRIFTED from the canonical list in sender — it lacked
// the Czech webmail providers below, so 35 distinct businesses (35 distinct
// IČO) sharing @outlook.cz / @wo.cz / @mybox.cz / @hotmail.cz were collapsed
// onto one "corporate domain" and blocked by MaxPerDomainPerCampaign=1 after
// the first send. Outbound went to count=0 every tick.
//
// These domains are freemail by data: no legitimate single company has tens of
// distinct IČO on one domain. They MUST classify as freemail.
func TestIsFreemailDomain_CzechWebmailProviders_Regression(t *testing.T) {
	mustBeFreemail := []string{
		"outlook.cz", // 31 distinct IČO in campaign 457
		"hotmail.cz", // 14 distinct IČO
		"wo.cz",      // 44 distinct IČO
		"mybox.cz",   // 37 distinct IČO
		"azet.cz",
		"in.cz",
		"klikni.cz",
	}
	for _, d := range mustBeFreemail {
		if !IsFreemailDomain(d) {
			t.Errorf("%q must classify as freemail (regression: 2026-06-22 cap stall)", d)
		}
	}
}

// Corporate domains must NOT be treated as freemail — the per-domain caps are
// the whole point of the gate for real company domains.
func TestIsFreemailDomain_CorporateNegative(t *testing.T) {
	mustNotBeFreemail := []string{
		"renofarmy.cz", // the original Sprint AF holding-cluster incident domain
		"garaaage.cz",
		"skoda-auto.cz",
	}
	for _, d := range mustNotBeFreemail {
		if IsFreemailDomain(d) {
			t.Errorf("%q must NOT classify as freemail (corporate cap must apply)", d)
		}
	}
}

// Drift guard: campaign.IsFreemailDomain MUST agree with the canonical
// sender.IsFreemailDomain for every domain. They are now the same function by
// construction (gate.go delegates), so this asserts no future refactor
// reintroduces a second, divergent list in the campaign package.
func TestIsFreemailDomain_NoDriftFromSenderCanonical(t *testing.T) {
	probe := []string{
		"outlook.cz", "hotmail.cz", "wo.cz", "mybox.cz", "azet.cz", "in.cz",
		"klikni.cz", "seznam.cz", "post.cz", "gmail.com", "outlook.com",
		"renofarmy.cz", "garaaage.cz", "", "UPPER.CZ",
	}
	for _, d := range probe {
		if got, want := IsFreemailDomain(d), sender.IsFreemailDomain(d); got != want {
			t.Errorf("drift for %q: campaign=%v sender=%v", d, got, want)
		}
	}
}
