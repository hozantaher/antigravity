package campaign

import "campaigns/sender"

// MaxPerDomainDay limits total sends to one recipient domain across all
// mailboxes and all campaigns within a rolling 24-hour window.
// Queried from send_events so the limit is persistent across scheduler restarts.
const MaxPerDomainDay = 5

// MaxPerDomainPerCampaign caps total sends to one recipient corporate
// domain across the entire campaign lifetime (not a rolling window).
//
// Sprint AF (2026-05-14): operator incident report — campaign 457 sent
// to plhota@renofarmy.cz at 20:56 UTC; the cohort enrichment held 12
// further @renofarmy.cz contacts queued. MaxPerDomainDay (rolling 24h
// = 5) and MaxPerDomainPerTick (= 2) were both within budget, so a
// holding-group domain with 12 distinct ICOs would still receive 5
// emails per day = "celá firma dostane stejný e-mail". Operator rule:
// ONE email per corporate domain per kampaň, period.
//
// Freemail providers bypass this gate (see IsFreemailDomain) because
// each address belongs to a distinct individual.
//
// Operator can override per-campaign via operator_settings key
// `corporate_domain_max_per_campaign` (positive integer). Empty/missing
// = use this default. Per HARD RULE feedback_env_var_needs_db_fallback
// the long-term home is operator_settings, not a const recompile.
const MaxPerDomainPerCampaign = 1

// IsFreemailDomain returns true if domain should bypass the per-tick rotation,
// per-day, and per-campaign lifetime cap gates. Each address on a freemail /
// webmail provider belongs to a distinct individual or business, so the
// "one email per corporate domain" reputation rationale does not apply.
//
// SINGLE SOURCE OF TRUTH: this delegates to services/campaigns/sender, which
// owns the canonical freemail map (freemailDomainsForDedup, used by the dedup
// cooldown). A previous duplicate map lived here and DRIFTED — it lacked the
// Czech webmail providers (outlook.cz, hotmail.cz, wo.cz, mybox.cz, …) that the
// sender list already had, which silently stalled campaign 457 on 2026-06-22
// (35 distinct businesses capped as one corporate domain). Delegating makes a
// recurrence impossible: there is now exactly one list to maintain.
func IsFreemailDomain(domain string) bool {
	return sender.IsFreemailDomain(domain)
}

// EmailStatusAllowed returns true only when the email address has been
// verified as deliverable. Every other status blocks outreach to prevent
// sending to dead, risky, or role-only mailboxes.
//
// Allowed:  "valid"
// Blocked:  "risky", "catch_all", "role_only", "unverified",
//           "invalid", "spamtrap", "no_email", "" (no company row)
func EmailStatusAllowed(status string) bool {
	return status == "valid"
}
