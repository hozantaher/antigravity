package enrich

import "time"

// TargetingFactors breaks down the targeting-quality score: industry fit,
// company size, email-type bonus/penalty, domain health, engagement
// history, recency decay, and honeypot penalty.
//
// This is a B2B sales priority signal — not a legal consent state. It is
// the same pattern as Clearbit / ZoomInfo / Apollo.io / Cognism lead
// scoring: a single float [0, 1] driving auto-enroll vs. manual review
// vs. block decisions in the sender pipeline.
type TargetingFactors struct {
	BaseScore       float64 `json:"base"`
	IndustryFit     float64 `json:"industry_fit"`
	CompanySize     float64 `json:"company_size"`
	EmailType       float64 `json:"email_type"`
	DomainHealth    float64 `json:"domain_health"`
	EmailQuality    float64 `json:"email_quality"`
	Engagement      float64 `json:"engagement"`
	RecencyDecay    float64 `json:"recency_decay"`
	HoneypotPenalty float64 `json:"honeypot_penalty"`
}

// TargetingInput contains all signals for scoring.
type TargetingInput struct {
	// Industry
	IndustryTags     []IndustryTag
	TargetIndustries []string // which industries are we targeting

	// Company
	CompanySize string

	// Email
	DomainType  DomainType
	IsRoleBased bool // info@, office@, etc.

	// Email verification result from the validation pipeline.
	// Values: valid, invalid, catch_all, risky, role_only, spamtrap, unverified, no_email.
	EmailVerificationStatus string

	// Domain health
	DomainBounceRate    float64
	DomainComplaintRate float64
	DomainSuppressed    bool

	// Engagement history
	TotalSent    int
	TotalOpened  int
	TotalReplied int
	TotalBounced int

	// Recency
	LastContacted *time.Time

	// Honeypot
	HoneypotSignals int
}

// CalculateTargeting computes the targeting-quality score and factor breakdown.
func CalculateTargeting(input TargetingInput) (float64, TargetingFactors) {
	factors := TargetingFactors{
		BaseScore: 0.5,
	}

	// ── Industry Fit ──
	if len(input.TargetIndustries) > 0 && len(input.IndustryTags) > 0 {
		bestMatch := 0.0
		for _, tag := range input.IndustryTags {
			for _, target := range input.TargetIndustries {
				if tag.Tag == target && tag.Confidence > bestMatch {
					bestMatch = tag.Confidence
				}
			}
		}
		factors.IndustryFit = bestMatch * 0.3 // max +0.3
	}

	// ── Company Size ──
	factors.CompanySize = companySizeBonus(input.CompanySize)

	// ── Email Type ──
	// In the Czech SMB market, seznam.cz / email.cz / centrum.cz etc. are routinely
	// used as primary business emails — treat freemail as neutral (0), not penalised.
	// Corporate domains (owns domain matching website) are still a positive signal (+0.1).
	// Government and education are negative priorities: not part of the dealer ICP (-0.3).
	switch input.DomainType {
	case DomainCorporate:
		factors.EmailType = 0.1
	case DomainFreemail:
		factors.EmailType = 0.0 // neutral — common for CZ SMBs
	case DomainGov, DomainEdu:
		factors.EmailType = -0.3 // not part of dealer ICP
	}

	if input.IsRoleBased {
		factors.EmailType -= 0.05
	}

	// ── Domain Health ──
	if input.DomainSuppressed {
		factors.DomainHealth = -0.5
	} else {
		if input.DomainBounceRate > 0.1 {
			factors.DomainHealth = -0.3
		} else if input.DomainBounceRate > 0.05 {
			factors.DomainHealth = -0.1
		}
		if input.DomainComplaintRate > 0.001 {
			factors.DomainHealth -= 0.2
		}
	}

	// ── Email Quality (pre-send verification result) ──
	switch input.EmailVerificationStatus {
	case "invalid", "spamtrap", "no_email":
		factors.EmailQuality = -1.0
	case "catch_all":
		factors.EmailQuality = -0.3
	case "role_only":
		factors.EmailQuality = -0.15
	case "risky":
		factors.EmailQuality = -0.1
	case "unverified":
		factors.EmailQuality = -0.05
	// "valid" or "" (not yet verified) → 0.0 (no penalty)
	}

	// ── Engagement History ──
	if input.TotalSent > 0 {
		if input.TotalBounced > 0 {
			factors.Engagement = -1.0 // bounced = suppress (dominates over opens)
		} else if input.TotalReplied > 0 {
			factors.Engagement = 0.5 // replied before = strong positive
		} else if input.TotalOpened > 0 {
			factors.Engagement = 0.2 // opened but didn't reply
		} else {
			// Sent but no engagement — potential trap or dead address
			if input.TotalSent >= 3 {
				opened := input.TotalOpened
				if opened > input.TotalSent {
					opened = input.TotalSent // guard against data inconsistency
				}
				ghostRatio := float64(input.TotalSent-opened) / float64(input.TotalSent)
				if ghostRatio > 0.8 {
					factors.Engagement = -0.3
				}
			}
		}
	}

	// ── Recency Decay ──
	if input.LastContacted != nil {
		daysSince := time.Since(*input.LastContacted).Hours() / 24
		if daysSince < 30 {
			factors.RecencyDecay = -0.2 // contacted recently
		} else if daysSince < 90 {
			factors.RecencyDecay = -0.1
		}
	}

	// ── Honeypot Penalty ──
	if input.HoneypotSignals > 0 {
		factors.HoneypotPenalty = -0.1 * float64(input.HoneypotSignals)
		if factors.HoneypotPenalty < -0.5 {
			factors.HoneypotPenalty = -0.5
		}
	}

	// ── Total ──
	score := factors.BaseScore +
		factors.IndustryFit +
		factors.CompanySize +
		factors.EmailType +
		factors.DomainHealth +
		factors.EmailQuality +
		factors.Engagement +
		factors.RecencyDecay +
		factors.HoneypotPenalty

	// Clamp to [0, 1]
	if score < 0 {
		score = 0
	}
	if score > 1 {
		score = 1
	}

	return score, factors
}

// TargetingDecision returns the action for a given targeting score.
func TargetingDecision(score float64) string {
	switch {
	case score >= 0.7:
		return "auto" // auto-enroll in campaign
	case score >= 0.4:
		return "low" // lower priority
	case score >= 0.2:
		return "manual" // manual approval required
	default:
		return "block" // do not contact
	}
}

func companySizeBonus(size string) float64 {
	switch size {
	case "10 - 19 zaměstnanců", "20 - 24 zaměstnanci", "25 - 49 zaměstnanců":
		return 0.2 // sweet spot — decision maker accessible
	case "50 - 99 zaměstnanců", "100 - 199 zaměstnanců":
		return 0.15
	case "6 - 9 zaměstnanců":
		return 0.1
	case "1 - 5 zaměstnanců":
		return 0.05
	case "200 - 249 zaměstnanců", "250 - 499 zaměstnanců":
		return 0.05
	case "500 - 999 zaměstnanců", "1000 - 1499 zaměstnanců":
		return -0.05 // too big for cold outreach
	case "Bez zaměstnanců":
		return -0.1 // one-person shop
	default:
		return 0.0
	}
}
