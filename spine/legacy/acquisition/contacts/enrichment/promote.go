package enrich

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"common/audit"
	"strings"
)

// PromoteConfig configures the company → outreach_contacts promotion.
type PromoteConfig struct {
	ICPTiers         []string // which tiers to include (default: ideal, good)
	EmailStatuses    []string // which email statuses to include (default: valid)
	BatchSize        int      // batch size for query (default: 5000)
	DryRun           bool     // don't write, just count
	TargetIndustries []string // for consent scoring
}

// PromoteResult summarizes a promotion run.
type PromoteResult struct {
	Queried  int
	Created  int
	Updated  int
	Skipped  int
	Errors   int
}

// PromoteCompanies takes classified+verified companies and creates outreach_contacts.
// This bridges the companies pipeline (sync → classify → ARES → verify) with the
// outreach pipeline (contacts → threads → messages).
func PromoteCompanies(ctx context.Context, db *sql.DB, cfg PromoteConfig) (*PromoteResult, error) {
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 5000
	}
	if len(cfg.ICPTiers) == 0 {
		cfg.ICPTiers = []string{"ideal", "good"}
	}
	if len(cfg.EmailStatuses) == 0 {
		cfg.EmailStatuses = []string{"valid"}
	}

	result := &PromoteResult{}
	lastID := 0

	// Build tier placeholders
	tierPlaceholders := make([]string, len(cfg.ICPTiers))
	for i := range cfg.ICPTiers {
		tierPlaceholders[i] = fmt.Sprintf("$%d", i+1)
	}
	// Build email status placeholders
	statusPlaceholders := make([]string, len(cfg.EmailStatuses))
	for i := range cfg.EmailStatuses {
		statusPlaceholders[i] = fmt.Sprintf("$%d", len(cfg.ICPTiers)+i+1)
	}

	baseQuery := fmt.Sprintf(`
		SELECT id, firmy_cz_id, COALESCE(ico,''), COALESCE(name,''), COALESCE(email,''),
			COALESCE(telephone,''), COALESCE(website,''),
			COALESCE(address_locality,''), COALESCE(street_address,''), COALESCE(postal_code,''),
			COALESCE(velikost_firmy,''), COALESCE(pravni_forma,''),
			COALESCE(description,''),
			COALESCE(sector_tags,'{}'), COALESCE(sector_confidence,0),
			COALESCE(region_normalized,''),
			COALESCE(icp_score,0),
			COALESCE(category_path,'')
		FROM companies
		WHERE exclusion_status = 'pass'
		  AND classified_at IS NOT NULL
		  AND icp_tier IN (%s)
		  AND email_status IN (%s)
		  AND email IS NOT NULL AND email != ''
		  AND id > $%d
		ORDER BY id
		LIMIT $%d`,
		strings.Join(tierPlaceholders, ","),
		strings.Join(statusPlaceholders, ","),
		len(cfg.ICPTiers)+len(cfg.EmailStatuses)+1,
		len(cfg.ICPTiers)+len(cfg.EmailStatuses)+2,
	)

	for {
		args := make([]any, 0, len(cfg.ICPTiers)+len(cfg.EmailStatuses)+2)
		for _, t := range cfg.ICPTiers {
			args = append(args, t)
		}
		for _, s := range cfg.EmailStatuses {
			args = append(args, s)
		}
		args = append(args, lastID, cfg.BatchSize)

		rows, err := db.QueryContext(ctx, baseQuery, args...)
		if err != nil {
			return result, fmt.Errorf("promote query: %w", err)
		}

		type companyRow struct {
			ID               int
			FirmyCzID        int
			ICO              string
			Name             string
			Email            string
			Phone            string
			Website          string
			Region           string
			Street           string
			PostalCode       string
			CompanySize      string
			LegalForm        string
			Description      string
			SectorTagsRaw    string
			SectorConfidence float64
			RegionNormalized string
			ICPScore         float64
			CategoryPath     string
		}

		var batch []companyRow
		for rows.Next() {
			var r companyRow
			if err := rows.Scan(
				&r.ID, &r.FirmyCzID, &r.ICO, &r.Name, &r.Email,
				&r.Phone, &r.Website,
				&r.Region, &r.Street, &r.PostalCode,
				&r.CompanySize, &r.LegalForm,
				&r.Description,
				&r.SectorTagsRaw, &r.SectorConfidence,
				&r.RegionNormalized, &r.ICPScore, &r.CategoryPath,
			); err != nil {
				rows.Close()
				return result, fmt.Errorf("promote scan: %w", err)
			}
			batch = append(batch, r)
		}
		rows.Close()

		if len(batch) == 0 {
			break
		}

		for _, r := range batch {
			lastID = r.ID
			result.Queried++

			if cfg.DryRun {
				continue
			}

			email := strings.ToLower(strings.TrimSpace(r.Email))
			domain := DomainFromEmail(email)
			domainType := ClassifyDomain(domain)

			// Ensure domain record
			var domainID int
			if domain != "" {
				did, err := EnsureDomain(ctx, db, domain, domainType)
				if err != nil {
					slog.Warn("promote ensure domain", "op", "enrich.Promote/ensureDomain", "domain", domain, "error", err)
				} else {
					domainID = did
				}
			}

			// Parse sector tags
			sectorTags := parsePgArray(r.SectorTagsRaw)

			// Calculate targeting score using existing logic
			consentInput := TargetingInput{
				IndustryTags:     tagsFromStrings(sectorTags, r.SectorConfidence),
				TargetIndustries: cfg.TargetIndustries,
				CompanySize:      r.CompanySize,
				DomainType:       domainType,
				IsRoleBased:      IsRoleBasedEmail(email),
			}
			score, factors := CalculateTargeting(consentInput)

			// Snippet
			snippet := r.Description
			if len(snippet) > 500 {
				snippet = snippet[:500]
			}

			enriched := &EnrichedContact{
				Email:              email,
				EmailHash:          hashEmail(email),
				Domain:             domain,
				DomainType:         domainType,
				FirstName:          extractFirstName(r.Name),
				CompanyName:        r.Name,
				ICO:                r.ICO,
				Phone:              r.Phone,
				Website:            r.Website,
				Region:             r.RegionNormalized,
				Address:            r.Street,
				PostalCode:         r.PostalCode,
				CompanySize:        r.CompanySize,
				LegalForm:          r.LegalForm,
				DescriptionSnippet: snippet,
				IndustryTags:       sectorTags,
				IndustryConfidence: r.SectorConfidence,
				TargetingScore:       score,
				TargetingFactors:     factors,
				Source:             "companies",
				FirmyCzID:          r.FirmyCzID,
				DomainID:           domainID,
				CategoryPath:       r.CategoryPath,
			}

			contactID, err := InsertEnriched(ctx, db, enriched)
			if err != nil {
				slog.Warn("promote insert", "op", "enrich.Promote/insert", "email", audit.MaskEmail(email), "error", err)
				result.Errors++
				continue
			}

			// Link contact to company
			_, err = db.ExecContext(ctx, `
				UPDATE outreach_contacts SET company_id = $1
				WHERE id = $2 AND company_id IS NULL`,
				r.ID, contactID)
			if err != nil {
				slog.Warn("promote link company", "op", "enrich.Promote/linkCompany", "company_id", r.ID, "contact_id", contactID, "error", err)
			}

			// Bridge to Schema A: upsert into contacts table so campaign
			// enrollment (which queries contacts) can find promoted companies.
			primaryIndustry := ""
			if len(sectorTags) > 0 {
				primaryIndustry = sectorTags[0]
			}
			scoreInt := int(score * 100)
			if scoreInt > 100 {
				scoreInt = 100
			}
			_, err = db.ExecContext(ctx, `
				INSERT INTO contacts (email, email_hash, first_name, company_name, ico, region, industry, company_size, score, status, source, category_path)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'valid', 'promoted', $10)
				ON CONFLICT (email_hash) DO UPDATE SET
					score = EXCLUDED.score,
					status = 'valid',
					company_name = COALESCE(EXCLUDED.company_name, contacts.company_name),
					region = COALESCE(EXCLUDED.region, contacts.region),
					industry = COALESCE(EXCLUDED.industry, contacts.industry),
					category_path = CASE WHEN EXCLUDED.category_path != '' THEN EXCLUDED.category_path ELSE contacts.category_path END,
					updated_at = now()`,
				email, enriched.EmailHash, enriched.FirstName, r.Name, r.ICO,
				r.RegionNormalized, primaryIndustry, r.CompanySize, scoreInt, r.CategoryPath)
			if err != nil {
				slog.Warn("promote bridge schema-a", "op", "enrich.Promote/bridgeSchemaA", "email", audit.MaskEmail(email), "error", err)
			}

			result.Created++
		}

		slog.Info("promote batch", "queried", result.Queried, "created", result.Created, "last_id", lastID)
	}

	return result, nil
}

func parsePgArray(s string) []string {
	if s == "" || s == "{}" {
		return nil
	}
	s = s[1 : len(s)-1]
	var result []string
	for _, part := range strings.Split(s, ",") {
		if v := strings.TrimSpace(part); v != "" {
			result = append(result, v)
		}
	}
	return result
}

func tagsFromStrings(tags []string, confidence float64) []IndustryTag {
	var result []IndustryTag
	for _, t := range tags {
		result = append(result, IndustryTag{Tag: t, Confidence: confidence})
	}
	return result
}
