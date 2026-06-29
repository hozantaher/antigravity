package exclusion

import "strings"

// Decision represents the exclusion verdict.
type Decision string

const (
	Pass      Decision = "pass"
	HardBlock Decision = "hard_block"
	SoftBlock Decision = "soft_block"
)

// Result is the output of exclusion detection.
type Result struct {
	Decision    Decision
	Reasons     []string
	Confidence  float64
	NeedsReview bool
}

// Input contains all available signals for a company.
type Input struct {
	Name        string
	PravniForma string
	ICO         string
	NACECodes   []string
	Email       string
	Website     string
	VInsolvenci bool
	VLikvidaci  bool
}

// Detect evaluates a company against exclusion rules.
// Priority: ARES flags > legal form > NACE > email domain > name patterns.
func Detect(input Input) Result {
	pf := strings.TrimSpace(input.PravniForma)

	var reasons []string

	// 1. ARES flags — evaluated before any legal-form short-circuit so a
	// company in liquidation/insolvency is blocked even when it carries a
	// commercial legal form (s.r.o./a.s./…). Liquidation is terminal
	// (HardBlock); insolvency is a soft block pending review.
	if input.VLikvidaci {
		reasons = append(reasons, "ares:v_likvidaci")
		return Result{Decision: HardBlock, Reasons: reasons, Confidence: 1.0}
	}
	if input.VInsolvenci {
		reasons = append(reasons, "ares:v_insolvenci")
		return Result{Decision: SoftBlock, Reasons: reasons, Confidence: 0.9}
	}

	// 2. Commercial legal form → PASS. This guard only skips downstream
	// name-pattern blocking; the ARES insolvency flags above always win.
	if CommercialForms[pf] {
		return Result{Decision: Pass, Confidence: 1.0}
	}

	// 3. Hard-block legal form
	if HardBlockForms[pf] {
		reasons = append(reasons, "pravni_forma:"+pf)
		return Result{Decision: HardBlock, Reasons: reasons, Confidence: 1.0}
	}

	// 4. Soft-block legal form
	if SoftBlockForms[pf] {
		reasons = append(reasons, "pravni_forma:"+pf)
		return Result{Decision: SoftBlock, Reasons: reasons, Confidence: 0.95}
	}

	// 5. NACE codes
	var softNACEReason string
	for _, nace := range input.NACECodes {
		code := strings.TrimSpace(nace)
		if HardBlockNACE[code] {
			reasons = append(reasons, "nace:"+code)
			return Result{Decision: HardBlock, Reasons: reasons, Confidence: 0.95}
		}
		if SoftBlockNACE[code] && softNACEReason == "" {
			softNACEReason = "nace:" + code
		}
	}

	// 6. Email domain
	if input.Email != "" {
		domain := domainFromEmail(input.Email)
		if HardBlockDomains[domain] {
			reasons = append(reasons, "domain:"+domain)
			return Result{Decision: HardBlock, Reasons: reasons, Confidence: 0.9}
		}
		if strings.HasSuffix(domain, ".gov.cz") {
			reasons = append(reasons, "domain_suffix:gov.cz")
			return Result{Decision: HardBlock, Reasons: reasons, Confidence: 0.85}
		}
	}

	// 7. Name patterns (only for non-commercial / unknown legal form)
	name := strings.TrimSpace(input.Name)
	if name != "" {
		for _, re := range hardBlockNameRegexps {
			if re.MatchString(name) {
				reasons = append(reasons, "name_pattern:hard")
				if pf == "" {
					return Result{Decision: SoftBlock, Reasons: reasons, Confidence: 0.6, NeedsReview: true}
				}
				return Result{Decision: HardBlock, Reasons: reasons, Confidence: 0.8}
			}
		}
		for _, re := range softBlockNameRegexps {
			if re.MatchString(name) {
				reasons = append(reasons, "name_pattern:soft")
				if pf == "" {
					return Result{Decision: SoftBlock, Reasons: reasons, Confidence: 0.5, NeedsReview: true}
				}
				return Result{Decision: SoftBlock, Reasons: reasons, Confidence: 0.7}
			}
		}
	}

	// 8. Deferred soft NACE
	if softNACEReason != "" {
		reasons = append(reasons, softNACEReason)
		return Result{Decision: SoftBlock, Reasons: reasons, Confidence: 0.7}
	}

	// 9. PASS
	return Result{Decision: Pass, Confidence: 1.0}
}

func domainFromEmail(email string) string {
	idx := strings.LastIndex(email, "@")
	if idx < 0 {
		return ""
	}
	return strings.ToLower(email[idx+1:])
}
