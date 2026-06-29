package enrich

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

// RecalculateFast recomputes targeting scores for all contacts using a single bulk SQL statement.
// ~100× faster than RecalculateAll for large datasets (no per-row round-trips).
// Limitations: does not write score history, does not track Promoted/Demoted/Blocked counts.
//
// If targetIndustries is empty, falls back to the 'target_industries' key in outreach_config
// so the Railway daemon scores correctly even when TARGET_INDUSTRIES env var is not set.
func RecalculateFast(ctx context.Context, db *sql.DB, targetIndustries []string) (*RecalcResult, error) {
	start := time.Now()

	// Fall back to DB config when no target industries supplied (e.g. Railway daemon without env var).
	if len(targetIndustries) == 0 {
		var val string
		err := db.QueryRowContext(ctx,
			`SELECT value FROM outreach_config WHERE key = 'target_industries'`).Scan(&val)
		if err == nil && val != "" {
			targetIndustries = strings.Split(val, ",")
			slog.Info("recalc: loaded target_industries from outreach_config", "count", len(targetIndustries))
		}
	}

	// Build a Postgres array literal from targetIndustries, e.g. ARRAY['machinery','metalwork']
	targetArr := buildPGArray(targetIndustries)

	// Single UPDATE covering all non-suppressed contacts.
	// Postgres UPDATE FROM can't reference the target table in FROM-clause JOINs,
	// so we pull all auxiliary columns in a subquery first.
	query := fmt.Sprintf(`
UPDATE outreach_contacts oc
SET targeting_score = GREATEST(0.0, LEAST(1.0,
    0.5

    + CASE
        WHEN oc.industry_tags && %[1]s
          AND GREATEST(COALESCE(oc.industry_confidence, 0),
              CASE WHEN sub.sector_source IN ('nace','category_path')
                        AND oc.industry_tags && sub.sector_tags
                   THEN COALESCE(sub.sector_confidence, 0)
                   ELSE 0.0 END) > 0
        THEN GREATEST(COALESCE(oc.industry_confidence, 0),
              CASE WHEN sub.sector_source IN ('nace','category_path')
                        AND oc.industry_tags && sub.sector_tags
                   THEN COALESCE(sub.sector_confidence, 0)
                   ELSE 0.0 END) * 0.3
        ELSE 0.0
      END

    + CASE COALESCE(NULLIF(oc.company_size,''), sub.velikost_firmy)
        WHEN '10 - 19 zaměstnanců'      THEN  0.20
        WHEN '20 - 24 zaměstnanci'      THEN  0.20
        WHEN '25 - 49 zaměstnanců'      THEN  0.20
        WHEN '50 - 99 zaměstnanců'      THEN  0.15
        WHEN '100 - 199 zaměstnanců'    THEN  0.15
        WHEN '6 - 9 zaměstnanců'        THEN  0.10
        WHEN '1 - 5 zaměstnanců'        THEN  0.05
        WHEN '200 - 249 zaměstnanců'    THEN  0.05
        WHEN '250 - 499 zaměstnanců'    THEN  0.05
        WHEN '500 - 999 zaměstnanců'    THEN -0.05
        WHEN '1000 - 1499 zaměstnanců'  THEN -0.05
        WHEN 'Bez zaměstnanců'          THEN -0.10
        ELSE 0.0
      END

    + CASE sub.domain_type
        WHEN 'corporate' THEN  0.10
        WHEN 'freemail'  THEN  0.00
        WHEN 'gov'       THEN -0.30
        WHEN 'edu'       THEN -0.30
        ELSE 0.0
      END

    + CASE WHEN oc.email ~* '^(info|office|kontakt|obchod|sekretariat|recepce|podatelna|posta)@'
           THEN -0.05 ELSE 0.0 END

    + CASE
        WHEN sub.is_suppressed = true              THEN -0.50
        WHEN COALESCE(sub.bounce_rate,0) > 0.10   THEN -0.30
        WHEN COALESCE(sub.bounce_rate,0) > 0.05   THEN -0.10
        ELSE 0.0
      END
    + CASE WHEN COALESCE(sub.complaint_rate,0) > 0.001 THEN -0.20 ELSE 0.0 END

    + CASE
        WHEN oc.total_bounced > 0                              THEN -1.0
        WHEN oc.total_replied > 0                              THEN  0.5
        WHEN oc.total_opened  > 0                              THEN  0.2
        WHEN oc.total_sent >= 3 AND oc.total_opened = 0        THEN -0.3
        ELSE 0.0
      END

    + CASE
        WHEN oc.last_contacted > now() - interval '30 days'    THEN -0.20
        WHEN oc.last_contacted > now() - interval '90 days'    THEN -0.10
        ELSE 0.0
      END

    + CASE COALESCE(sub.email_status, 'unverified')
        WHEN 'invalid'    THEN -1.0
        WHEN 'spamtrap'   THEN -1.0
        WHEN 'no_email'   THEN -1.0
        WHEN 'catch_all'  THEN -0.30
        WHEN 'role_only'  THEN -0.15
        WHEN 'risky'      THEN -0.10
        WHEN 'unverified' THEN -0.05
        ELSE 0.0  -- 'valid' or '' (not yet verified) → neutral
      END
)),
targeting_factors = jsonb_build_object(
    'base', 0.5,
    'industry_fit', CASE
        WHEN oc.industry_tags && %[1]s
          AND GREATEST(COALESCE(oc.industry_confidence, 0),
              CASE WHEN sub.sector_source IN ('nace','category_path')
                        AND oc.industry_tags && sub.sector_tags
                   THEN COALESCE(sub.sector_confidence, 0)
                   ELSE 0.0 END) > 0
        THEN GREATEST(COALESCE(oc.industry_confidence, 0),
              CASE WHEN sub.sector_source IN ('nace','category_path')
                        AND oc.industry_tags && sub.sector_tags
                   THEN COALESCE(sub.sector_confidence, 0)
                   ELSE 0.0 END) * 0.3
        ELSE 0.0
      END,
    'company_size', CASE COALESCE(NULLIF(oc.company_size,''), sub.velikost_firmy)
        WHEN '10 - 19 zaměstnanců'      THEN  0.20
        WHEN '20 - 24 zaměstnanci'      THEN  0.20
        WHEN '25 - 49 zaměstnanců'      THEN  0.20
        WHEN '50 - 99 zaměstnanců'      THEN  0.15
        WHEN '100 - 199 zaměstnanců'    THEN  0.15
        WHEN '6 - 9 zaměstnanců'        THEN  0.10
        WHEN '1 - 5 zaměstnanců'        THEN  0.05
        WHEN '200 - 249 zaměstnanců'    THEN  0.05
        WHEN '250 - 499 zaměstnanců'    THEN  0.05
        WHEN '500 - 999 zaměstnanců'    THEN -0.05
        WHEN '1000 - 1499 zaměstnanců'  THEN -0.05
        WHEN 'Bez zaměstnanců'          THEN -0.10
        ELSE 0.0
      END,
    'email_type',
        CASE sub.domain_type
            WHEN 'corporate' THEN  0.10
            WHEN 'freemail'  THEN  0.00
            WHEN 'gov'       THEN -0.30
            WHEN 'edu'       THEN -0.30
            ELSE 0.0
          END
        + CASE WHEN oc.email ~* '^(info|office|kontakt|obchod|sekretariat|recepce|podatelna|posta)@'
               THEN -0.05 ELSE 0.0 END,
    'domain_health',
        CASE
            WHEN sub.is_suppressed = true              THEN -0.50
            WHEN COALESCE(sub.bounce_rate,0) > 0.10   THEN -0.30
            WHEN COALESCE(sub.bounce_rate,0) > 0.05   THEN -0.10
            ELSE 0.0
          END
        + CASE WHEN COALESCE(sub.complaint_rate,0) > 0.001 THEN -0.20 ELSE 0.0 END,
    'engagement', CASE
        WHEN oc.total_bounced > 0                              THEN -1.0
        WHEN oc.total_replied > 0                              THEN  0.5
        WHEN oc.total_opened  > 0                              THEN  0.2
        WHEN oc.total_sent >= 3 AND oc.total_opened = 0        THEN -0.3
        ELSE 0.0
      END,
    'recency_decay', CASE
        WHEN oc.last_contacted > now() - interval '30 days'    THEN -0.20
        WHEN oc.last_contacted > now() - interval '90 days'    THEN -0.10
        ELSE 0.0
      END,
    'email_quality', CASE COALESCE(sub.email_status, 'unverified')
        WHEN 'invalid'    THEN -1.0
        WHEN 'spamtrap'   THEN -1.0
        WHEN 'no_email'   THEN -1.0
        WHEN 'catch_all'  THEN -0.30
        WHEN 'role_only'  THEN -0.15
        WHEN 'risky'      THEN -0.10
        WHEN 'unverified' THEN -0.05
        ELSE 0.0
      END,
    'honeypot_penalty', 0.0
),
last_score_update = now(),
updated_at = now()
FROM (
    SELECT c.id,
           d.domain_type, d.bounce_rate, d.is_suppressed, d.complaint_rate,
           co.velikost_firmy,
           co.sector_tags, co.sector_confidence, co.sector_source,
           co.email_status
    FROM outreach_contacts c
    LEFT JOIN outreach_domains d  ON c.domain_id  = d.id
    LEFT JOIN companies       co  ON c.company_id = co.id
    WHERE c.status NOT IN ('suppressed')
) sub
WHERE oc.id = sub.id`, targetArr)

	res, err := db.ExecContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("fast recalc: %w", err)
	}
	n, _ := res.RowsAffected()

	// Sync Schema-A contacts.score from the freshly updated targeting_scores.
	// contacts.score = ROUND(targeting_score * 100). Only touches rows that changed.
	// Join on email_hash — the canonical Schema A↔B key — not email: contacts.email
	// is stored as-imported (mixed case) while outreach_contacts.email is lowercased,
	// so a raw `c.email = oc.email` join silently drops mixed-case rows.
	_, syncErr := db.ExecContext(ctx, `
		UPDATE contacts c
		SET score = ROUND(oc.targeting_score * 100)::int
		FROM outreach_contacts oc
		WHERE c.email_hash = oc.email_hash
		  AND ROUND(oc.targeting_score * 100)::int IS DISTINCT FROM c.score
	`)
	if syncErr != nil {
		slog.Warn("recalc: contacts.score sync failed", "op", "enrich.RecalculateFast/sync", "error", syncErr)
	}

	return &RecalcResult{
		Total:    int(n),
		Updated:  int(n),
		Duration: time.Since(start),
	}, nil
}

// buildPGArray converts a Go string slice to a Postgres ARRAY literal for embedding in SQL.
// Uses single-quoted elements with apostrophe escaping.
func buildPGArray(items []string) string {
	if len(items) == 0 {
		return "ARRAY[]::text[]"
	}
	var sb strings.Builder
	sb.WriteString("ARRAY[")
	for i, item := range items {
		if i > 0 {
			sb.WriteString(",")
		}
		sb.WriteString("'")
		sb.WriteString(strings.ReplaceAll(item, "'", "''"))
		sb.WriteString("'")
	}
	sb.WriteString("]")
	return sb.String()
}

// RecalcResult holds the outcome of a batch recalculation.
type RecalcResult struct {
	Total     int
	Updated   int
	Blocked   int
	Promoted  int
	Demoted   int
	Duration  time.Duration
}

// scoreTier returns the consent tier label for a given score.
func scoreTier(score float64) string {
	switch {
	case score >= 0.7:
		return "auto"
	case score >= 0.4:
		return "low"
	case score >= 0.2:
		return "manual"
	default:
		return "block"
	}
}

// RecalculateAll recomputes targeting scores for all contacts based on current engagement data.
func RecalculateAll(ctx context.Context, db *sql.DB, targetIndustries []string) (*RecalcResult, error) {
	start := time.Now()
	result := &RecalcResult{}

	rows, err := db.QueryContext(ctx, `
		SELECT c.id, c.email,
			-- Use contact's own industry_tags when populated; fall back to company sector_tags.
			CASE WHEN c.industry_tags IS NOT NULL AND c.industry_tags != '{}'
				THEN c.industry_tags::text
				ELSE COALESCE(co.sector_tags, '{}')::text
			END AS industry_tags,
			GREATEST(COALESCE(c.industry_confidence, 0), COALESCE(co.sector_confidence, 0)) AS industry_confidence,
			COALESCE(NULLIF(c.company_size, ''), co.velikost_firmy) AS company_size,
			c.targeting_score,
			c.total_sent, c.total_opened, c.total_replied, c.total_bounced,
			c.last_contacted, c.status,
			d.domain_type, d.bounce_rate, d.is_suppressed,
			COALESCE(d.complaint_rate, 0) as domain_complaint_rate,
			COALESCE(co.email_status, 'unverified') as email_status,
			(SELECT COUNT(*) FROM outreach_honeypot_signals h WHERE h.contact_id = c.id) as honeypot_count
		FROM outreach_contacts c
		LEFT JOIN outreach_domains d ON c.domain_id = d.id
		LEFT JOIN companies co ON c.company_id = co.id
		WHERE c.status NOT IN ('suppressed')
		ORDER BY c.id
	`)
	if err != nil {
		return nil, fmt.Errorf("query contacts: %w", err)
	}
	defer rows.Close()

	updateStmt, err := db.PrepareContext(ctx, `
		UPDATE outreach_contacts
		SET targeting_score = $1, targeting_factors = $2, last_score_update = now(), updated_at = now()
		WHERE id = $3
	`)
	if err != nil {
		return nil, fmt.Errorf("prepare update: %w", err)
	}
	defer updateStmt.Close()

	historyStmt, err := db.PrepareContext(ctx, `
		INSERT INTO outreach_score_history (contact_id, old_score, new_score, old_tier, new_tier, trigger)
		VALUES ($1, $2, $3, $4, $5, 'recalc')
	`)
	if err != nil {
		// Table may not exist yet — continue without history
		slog.Warn("score history table unavailable, skipping history writes", "op", "enrich.RecalculateAll/prepareHistory", "error", err)
		historyStmt = nil
	} else {
		defer historyStmt.Close()
	}

	for rows.Next() {
		var (
			id                                   int
			email                                string
			industryTagsRaw                      sql.NullString
			industryConfidence                   sql.NullFloat64
			companySize                          sql.NullString
			oldScore                             float64
			totalSent, totalOpened               int
			totalReplied, totalBounced           int
			lastContacted                        sql.NullTime
			status                               string
			domainType                           sql.NullString
			domainBounceRate                     sql.NullFloat64
			domainSuppressed                     sql.NullBool
			domainComplaintRate                  sql.NullFloat64
			emailStatus                          string
			honeypotCount                        int
		)

		if err := rows.Scan(
			&id, &email, &industryTagsRaw, &industryConfidence, &companySize, &oldScore,
			&totalSent, &totalOpened, &totalReplied, &totalBounced,
			&lastContacted, &status,
			&domainType, &domainBounceRate, &domainSuppressed,
			&domainComplaintRate, &emailStatus,
			&honeypotCount,
		); err != nil {
			slog.Error("recalc scan error", "op", "enrich.RecalculateAll/scan", "error", err)
			continue
		}

		result.Total++

		// Parse industry tags from Postgres array, using stored confidence
		storedConf := 0.5
		if industryConfidence.Valid {
			storedConf = industryConfidence.Float64
		}
		tags := parseIndustryTagsFromDB(industryTagsRaw, storedConf)

		// Build consent input from current state
		input := TargetingInput{
			IndustryTags:            tags,
			TargetIndustries:        targetIndustries,
			CompanySize:             nullString(companySize),
			DomainType:              DomainType(nullString(domainType)),
			IsRoleBased:             IsRoleBasedEmail(email),
			EmailVerificationStatus: emailStatus,
			DomainBounceRate:        nullFloat(domainBounceRate),
			DomainComplaintRate:     nullFloat(domainComplaintRate),
			DomainSuppressed:        nullBool(domainSuppressed),
			TotalSent:               totalSent,
			TotalOpened:             totalOpened,
			TotalReplied:            totalReplied,
			TotalBounced:            totalBounced,
			HoneypotSignals:         honeypotCount,
		}

		if lastContacted.Valid {
			t := lastContacted.Time
			input.LastContacted = &t
		}

		newScore, factors := CalculateTargeting(input)
		factorsJSON, _ := json.Marshal(factors)

		// Track changes
		if newScore < 0.2 && oldScore >= 0.2 {
			result.Blocked++
		}
		if newScore >= 0.7 && oldScore < 0.7 {
			result.Promoted++
		}
		if newScore < 0.4 && oldScore >= 0.4 {
			result.Demoted++
		}

		// Only update if score changed meaningfully (>0.01)
		diff := newScore - oldScore
		if diff < 0 {
			diff = -diff
		}
		if diff > 0.01 {
			// Capture the UPDATE error so a transient DB failure does not
			// silently inflate result.Updated. Operator dashboards read
			// result.Updated as ground truth — bare ExecContext meant a
			// reported "updated 100" could correspond to ~80 actual rows.
			if _, err := updateStmt.ExecContext(ctx, newScore, string(factorsJSON), id); err != nil {
				slog.Warn("recalc: score update failed",
					"op", "enrich.RecalculateAll/updateScore", "contact_id", id, "old_score", oldScore, "new_score", newScore, "error", err)
				continue
			}
			result.Updated++
			if historyStmt != nil {
				// History insert is best-effort: a missing history row is
				// non-fatal (operator can still see current score). Log
				// at debug level so failures are visible without alerting.
				if _, err := historyStmt.ExecContext(ctx, id, oldScore, newScore, scoreTier(oldScore), scoreTier(newScore)); err != nil {
					slog.Debug("recalc: score history insert failed",
						"contact_id", id, "error", err)
				}
			}
		}
	}

	result.Duration = time.Since(start)
	return result, rows.Err()
}

// RecalculateOne recomputes targeting score for a single contact after an event.
func RecalculateOne(ctx context.Context, db *sql.DB, contactID int, targetIndustries []string) (float64, error) {
	var (
		email               string
		industryTagsRaw     sql.NullString
		industryConfidence  sql.NullFloat64
		companySize         sql.NullString
		oldScore            float64
		totalSent           int
		totalOpened         int
		totalReplied        int
		totalBounced        int
		lastContacted       sql.NullTime
		domainType          sql.NullString
		domainBounceRate    sql.NullFloat64
		domainSuppressed    sql.NullBool
		domainComplaintRate sql.NullFloat64
		emailStatus         string
		honeypotCount       int
	)

	// contactID is a Schema A contacts.id; look up outreach_contacts (Schema B) by email.
	err := db.QueryRowContext(ctx, `
		SELECT c.email, c.industry_tags, c.industry_confidence, c.company_size, c.targeting_score,
			c.total_sent, c.total_opened, c.total_replied, c.total_bounced,
			c.last_contacted,
			d.domain_type, d.bounce_rate, d.is_suppressed,
			COALESCE(d.complaint_rate, 0) as domain_complaint_rate,
			COALESCE(co.email_status, 'unverified') as email_status,
			(SELECT COUNT(*) FROM outreach_honeypot_signals h WHERE h.contact_id = c.id)
		FROM outreach_contacts c
		LEFT JOIN outreach_domains d ON c.domain_id = d.id
		LEFT JOIN companies co ON c.company_id = co.id
		WHERE c.email = (SELECT email FROM contacts WHERE id = $1)
	`, contactID).Scan(
		&email, &industryTagsRaw, &industryConfidence, &companySize, &oldScore,
		&totalSent, &totalOpened, &totalReplied, &totalBounced,
		&lastContacted,
		&domainType, &domainBounceRate, &domainSuppressed,
		&domainComplaintRate, &emailStatus,
		&honeypotCount,
	)
	if err == sql.ErrNoRows {
		// Schema A/B sync gap: contacts row exists but no outreach_contacts
		// mirror. Common for legacy imports that pre-date Schema B. Recalc
		// is best-effort scoring — skip silently rather than warn-spam every
		// send. Return (0, nil) so the runner's post-send goroutine
		// classifies this as a no-op, not an error.
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("load contact %d: %w", contactID, err)
	}

	storedConf := 0.5
	if industryConfidence.Valid {
		storedConf = industryConfidence.Float64
	}
	tags := parseIndustryTagsFromDB(industryTagsRaw, storedConf)

	input := TargetingInput{
		IndustryTags:            tags,
		TargetIndustries:        targetIndustries,
		CompanySize:             nullString(companySize),
		DomainType:              DomainType(nullString(domainType)),
		IsRoleBased:             IsRoleBasedEmail(email),
		EmailVerificationStatus: emailStatus,
		DomainBounceRate:        nullFloat(domainBounceRate),
		DomainComplaintRate:     nullFloat(domainComplaintRate),
		DomainSuppressed:        nullBool(domainSuppressed),
		TotalSent:               totalSent,
		TotalOpened:             totalOpened,
		TotalReplied:            totalReplied,
		TotalBounced:            totalBounced,
		HoneypotSignals:         honeypotCount,
	}
	if lastContacted.Valid {
		t := lastContacted.Time
		input.LastContacted = &t
	}

	newScore, factors := CalculateTargeting(input)
	factorsJSON, _ := json.Marshal(factors)

	_, err = db.ExecContext(ctx, `
		UPDATE outreach_contacts
		SET targeting_score = $1, targeting_factors = $2, last_score_update = now(), updated_at = now()
		WHERE id = $3
	`, newScore, string(factorsJSON), contactID)
	if err != nil {
		return 0, fmt.Errorf("update contact %d: %w", contactID, err)
	}

	diff := newScore - oldScore
	if diff < 0 {
		diff = -diff
	}
	if diff > 0.01 {
		db.ExecContext(ctx, `
			INSERT INTO outreach_score_history (contact_id, old_score, new_score, old_tier, new_tier, trigger)
			VALUES ($1, $2, $3, $4, $5, 'event')
		`, contactID, oldScore, newScore, scoreTier(oldScore), scoreTier(newScore)) //nolint:errcheck
	}

	return newScore, nil
}

func parseIndustryTagsFromDB(raw sql.NullString, confidence float64) []IndustryTag {
	if !raw.Valid || raw.String == "" || raw.String == "{}" {
		return nil
	}
	// Postgres array format: {tag1,tag2,tag3}
	s := raw.String
	s = s[1 : len(s)-1] // remove { }
	if s == "" {
		return nil
	}
	parts := splitComma(s)
	tags := make([]IndustryTag, len(parts))
	for i, p := range parts {
		tags[i] = IndustryTag{Tag: p, Confidence: confidence}
	}
	return tags
}

func splitComma(s string) []string {
	var parts []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == ',' {
			parts = append(parts, s[start:i])
			start = i + 1
		}
	}
	parts = append(parts, s[start:])
	return parts
}

func nullString(ns sql.NullString) string {
	if ns.Valid { return ns.String }
	return ""
}

func nullFloat(nf sql.NullFloat64) float64 {
	if nf.Valid { return nf.Float64 }
	return 0
}

func nullBool(nb sql.NullBool) bool {
	if nb.Valid { return nb.Bool }
	return false
}
