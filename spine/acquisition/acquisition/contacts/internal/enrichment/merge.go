package enrichment

// authoritativeFor maps a field name to the source that wins on conflict.
// When both ARES and firmy.cz return a non-empty value for the same field
// and they disagree, the authoritative source's value is kept and a
// MergeConflict is logged for audit.
var authoritativeFor = map[string]SourceName{
	"ico":             SourceARES,
	"dic":             SourceARES,
	"name":            SourceARES,
	"pravni_forma":    SourceARES,
	"datum_vzniku":    SourceARES,
	"street_address":  SourceARES,
	"city":            SourceARES,
	"postal_code":     SourceARES,
	"nace_primary":    SourceARES,
	"datova_schranka": SourceARES,

	"email":          SourceFirmyCZ,
	"phone":          SourceFirmyCZ,
	"website":        SourceFirmyCZ,
	"velikost_firmy": SourceFirmyCZ,
	"description":    SourceFirmyCZ,
}

// SourcePayload pairs a source identity with its lookup result.
// Nil Data means "source attempted but returned not-found".
type SourcePayload struct {
	Source SourceName
	Data   *CompanyData
}

// Merge applies the per-field authority matrix to combine multiple source
// payloads into a single CompanyData. Returns the merged data, the list of
// detected conflicts (per-field), and the EnrichmentOutcome label suitable
// for the audit log.
//
// Rules:
//  1. For each field, iterate payloads in priority order (ARES first).
//  2. The first non-empty value wins, unless a lower-priority source is the
//     declared authority for that field AND has a non-empty value — then
//     the authoritative value wins and a MergeConflict is recorded.
//  3. NACECodes is union-merged (ARES first, firmy.cz appended unique).
//  4. Empty payloads (or nil Data) are skipped.
func Merge(payloads []SourcePayload) (CompanyData, []MergeConflict, EnrichmentOutcome) {
	// Filter to payloads that returned something usable.
	usable := make([]SourcePayload, 0, len(payloads))
	for _, p := range payloads {
		if p.Data != nil && !p.Data.IsEmpty() {
			usable = append(usable, p)
		}
	}

	if len(usable) == 0 {
		return CompanyData{}, nil, OutcomeNone
	}

	// Build a quick lookup by source name.
	bySource := make(map[SourceName]*CompanyData, len(usable))
	for _, p := range usable {
		bySource[p.Source] = p.Data
	}

	merged := CompanyData{}
	conflicts := make([]MergeConflict, 0)

	resolveField := func(fieldName string, get func(*CompanyData) string, set func(string)) {
		ares := ""
		firmy := ""
		if d, ok := bySource[SourceARES]; ok {
			ares = get(d)
		}
		if d, ok := bySource[SourceFirmyCZ]; ok {
			firmy = get(d)
		}

		// No data at all from primary sources.
		if ares == "" && firmy == "" {
			// Try justice.cz fallback if present.
			if d, ok := bySource[SourceJusticeCZ]; ok {
				if v := get(d); v != "" {
					set(v)
				}
			}
			return
		}

		// Single-source: trivially use it.
		if ares == "" {
			set(firmy)
			return
		}
		if firmy == "" {
			set(ares)
			return
		}

		// Both present. Apply authority matrix.
		if ares == firmy {
			set(ares)
			return
		}
		auth, hasAuth := authoritativeFor[fieldName]
		if !hasAuth {
			// Default = ARES wins (registry-authoritative bias).
			auth = SourceARES
		}
		conflicts = append(conflicts, MergeConflict{
			Field:      fieldName,
			ARESValue:  ares,
			FirmyValue: firmy,
			Resolved:   auth,
		})
		if auth == SourceFirmyCZ {
			set(firmy)
		} else {
			set(ares)
		}
	}

	resolveField("ico", func(c *CompanyData) string { return c.ICO }, func(v string) { merged.ICO = v })
	resolveField("dic", func(c *CompanyData) string { return c.DIC }, func(v string) { merged.DIC = v })
	resolveField("name", func(c *CompanyData) string { return c.Name }, func(v string) { merged.Name = v })
	resolveField("pravni_forma", func(c *CompanyData) string { return c.PravniForma }, func(v string) { merged.PravniForma = v })
	resolveField("datum_vzniku", func(c *CompanyData) string { return c.DatumVzniku }, func(v string) { merged.DatumVzniku = v })
	resolveField("street_address", func(c *CompanyData) string { return c.StreetAddress }, func(v string) { merged.StreetAddress = v })
	resolveField("city", func(c *CompanyData) string { return c.City }, func(v string) { merged.City = v })
	resolveField("postal_code", func(c *CompanyData) string { return c.PostalCode }, func(v string) { merged.PostalCode = v })
	resolveField("nace_primary", func(c *CompanyData) string { return c.NACEPrimary }, func(v string) { merged.NACEPrimary = v })
	resolveField("datova_schranka", func(c *CompanyData) string { return c.DatovaSchranka }, func(v string) { merged.DatovaSchranka = v })
	resolveField("email", func(c *CompanyData) string { return c.Email }, func(v string) { merged.Email = v })
	resolveField("phone", func(c *CompanyData) string { return c.Phone }, func(v string) { merged.Phone = v })
	resolveField("website", func(c *CompanyData) string { return c.Website }, func(v string) { merged.Website = v })
	resolveField("velikost_firmy", func(c *CompanyData) string { return c.VelikostFirmy }, func(v string) { merged.VelikostFirmy = v })
	resolveField("description", func(c *CompanyData) string { return c.Description }, func(v string) { merged.Description = v })

	// NACE codes — union-merge (ARES first, firmy.cz adds unique).
	seen := make(map[string]bool)
	if d, ok := bySource[SourceARES]; ok {
		for _, code := range d.NACECodes {
			if code == "" || seen[code] {
				continue
			}
			seen[code] = true
			merged.NACECodes = append(merged.NACECodes, code)
		}
	}
	if d, ok := bySource[SourceFirmyCZ]; ok {
		for _, code := range d.NACECodes {
			if code == "" || seen[code] {
				continue
			}
			seen[code] = true
			merged.NACECodes = append(merged.NACECodes, code)
		}
	}

	// Outcome classification.
	outcome := classifyOutcome(usable)
	return merged, conflicts, outcome
}

func classifyOutcome(usable []SourcePayload) EnrichmentOutcome {
	hasARES := false
	hasFirmy := false
	hasJustice := false
	for _, p := range usable {
		switch p.Source {
		case SourceARES:
			hasARES = true
		case SourceFirmyCZ:
			hasFirmy = true
		case SourceJusticeCZ:
			hasJustice = true
		}
	}

	switch {
	case hasARES && hasFirmy:
		return OutcomeMerged
	case hasARES && !hasFirmy && !hasJustice:
		return OutcomeARESOnly
	case !hasARES && hasFirmy && !hasJustice:
		return OutcomeFirmyOnly
	case !hasARES && hasFirmy && hasJustice:
		return OutcomeFirmyOnly // primary source covered the lookup
	case !hasARES && !hasFirmy && hasJustice:
		return OutcomeJusticeFallback
	default:
		return OutcomeNone
	}
}
