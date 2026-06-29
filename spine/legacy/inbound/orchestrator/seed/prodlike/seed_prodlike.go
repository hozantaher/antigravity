package prodlike

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Result aggregates the row counts inserted by SeedProdLikeWith.
// Used by the CLI to print a final report.
type Result struct {
	Scale             Scale
	Domains           int
	Companies         int
	Contacts          int
	EdgeContacts      int // edge-case contacts (honeypot coverage)
	HoneypotSignals   int // rows inserted into outreach_honeypot_signals
}

// Options controls optional seed behaviours such as edge-case coverage.
// Empty Options == baseline prodlike without scenarios.
type Options struct {
	// WithEdgeCases, when true, appends ~100 curated edge-case contacts
	// that exercise every honeypot detection rule plus the prospect
	// filter skip paths. Each contact's expected HoneypotSignals are
	// written into outreach_honeypot_signals as if the live detector
	// had run.
	WithEdgeCases bool
}

// SeedProdLikeWith populates outreach_domains, companies, and outreach_contacts
// with a statistically prod-like dataset. Idempotency check: if any rows
// with source LIKE 'prodlike-%' already exist the call is a no-op (use
// ClearProdLike first to re-seed).
func SeedProdLikeWith(ctx context.Context, db *sql.DB, scale Scale, opts Options) (*Result, error) {
	if err := ensureNotAlreadySeeded(ctx, db); err != nil {
		return nil, err
	}

	rng := NewRNG()
	ratios := DefaultRatios()
	counts := ResolveCounts(scale)
	now := time.Now().UTC()

	// Determine a safe firmy_cz_id offset so our surrogate IDs never
	// collide with real firmy-cz rows already synced into `companies`.
	// Localhost dev dbs frequently carry a full 1M+ production mirror;
	// a fixed low-range offset would conflict.
	offset, err := computeFirmyCzIDOffset(ctx, db)
	if err != nil {
		return nil, fmt.Errorf("compute firmy_cz_id offset: %w", err)
	}

	// --- Generate in memory first (determinism + independent of DB) ---
	domains := GenerateDomains(rng, counts.Domains, ratios)
	companies := GenerateCompanies(rng, counts.Companies, ratios, now)
	// Apply offset so inserts don't collide with existing rows.
	for i := range companies {
		companies[i].FirmyCzID += offset
	}
	contacts := GenerateContacts(rng, counts.Contacts, companies, domains, ratios, now)

	// --- Insert in a single transaction ---
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }() // no-op if committed

	domainIDs, err := insertDomains(ctx, tx, domains)
	if err != nil {
		return nil, fmt.Errorf("insert domains: %w", err)
	}
	companyIDs, err := insertCompanies(ctx, tx, companies)
	if err != nil {
		return nil, fmt.Errorf("insert companies: %w", err)
	}
	if err := insertContacts(ctx, tx, contacts, domainIDs, companyIDs); err != nil {
		return nil, fmt.Errorf("insert contacts: %w", err)
	}

	// --- Edge cases (opt-in) ---
	// Inserted inside the same transaction so a partial failure of
	// either the baseline seed or the edge-case append leaves the
	// database untouched.
	var edgeContacts, edgeSignals int
	if opts.WithEdgeCases {
		edgeContacts, edgeSignals, err = insertEdgeCases(ctx, tx, now)
		if err != nil {
			return nil, fmt.Errorf("insert edge cases: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}

	return &Result{
		Scale:           scale,
		Domains:         len(domains),
		Companies:       len(companies),
		Contacts:        len(contacts),
		EdgeContacts:    edgeContacts,
		HoneypotSignals: edgeSignals,
	}, nil
}

// insertEdgeCases writes the curated edge-case contacts plus their
// expected outreach_honeypot_signals rows. Returns (contactCount, signalCount).
//
// Schema-level safety:
//   - Rows with empty email go into contacts (Schema A) only, using a
//     distinct source tag so --clear-prodlike still finds them.
//   - outreach_contacts cannot carry an empty email (email_hash would
//     collide), so those are intentionally skipped.
//
// Domains: each edge-case address uses its own unique .test domain;
// the helper ensures the outreach_domains row exists before linking.
func insertEdgeCases(ctx context.Context, tx *sql.Tx, now time.Time) (int, int, error) {
	drafts := GenerateEdgeCases()
	contactCount := 0
	signalCount := 0

	// Cache domain → id so multiple contacts on the same domain share.
	domainIDs := map[string]int{}

	for _, e := range drafts {
		if e.Email == "" {
			// Edge case that exercises the empty-email skip path.
			// Insert into contacts (Schema A) only, where the column
			// is nullable; outreach_contacts would reject on email_hash.
			_, err := tx.ExecContext(ctx, `
				INSERT INTO contacts (email, email_hash, first_name, last_name, company_name, region, industry, score, status, source)
				VALUES ('', '', 'Unknown', 'Edge', $1, 'Praha', 'construction', 0, 'invalid', $2)
				ON CONFLICT (email_hash) DO NOTHING`,
				"Edge-case "+e.Category, SourceTag+"-edge")
			if err != nil {
				// UNIQUE (email_hash) collision on subsequent inserts with
				// hash=''; skip silently so the rest of the batch proceeds.
				continue
			}
			contactCount++
			continue
		}

		// Invalid-format drafts: no '@' or malformed. Skip Schema B
		// insertion because the enrichment path would never see them.
		if !strings.Contains(e.Email, "@") {
			continue
		}

		domain := e.Email[strings.IndexByte(e.Email, '@')+1:]
		if domain == "" {
			continue
		}

		// Ensure domain row exists.
		did, ok := domainIDs[domain]
		if !ok {
			err := tx.QueryRowContext(ctx, `
				INSERT INTO outreach_domains (domain, domain_type, mx_verified, daily_send_cap)
				VALUES ($1, 'corporate', false, 1)
				ON CONFLICT (domain) DO UPDATE SET domain_type = outreach_domains.domain_type
				RETURNING id`,
				domain,
			).Scan(&did)
			if err != nil {
				return contactCount, signalCount, err
			}
			domainIDs[domain] = did
		}

		draft := e.ToContactDraft(domain, now)
		factorsJSON, _ := json.Marshal(draft.TargetingFactors)

		var contactID int
		err := tx.QueryRowContext(ctx, `
			INSERT INTO outreach_contacts (
				email, email_hash, domain_id, first_name, last_name,
				company_name, region, industry_tags, industry_confidence,
				targeting_score, targeting_factors, status, source,
				created_at, updated_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
			ON CONFLICT (email_hash) DO NOTHING
			RETURNING id`,
			draft.Email, draft.EmailHash, nullableInt(domainIDs[domain]),
			draft.FirstName, draft.LastName, draft.CompanyName, draft.Region,
			pgTextArray(draft.IndustryTags), draft.IndustryConfidence,
			draft.TargetingScore, string(factorsJSON), draft.Status,
			draft.Source, now,
		).Scan(&contactID)
		if err != nil {
			// Most likely email_hash collision with an earlier edge-case
			// row (pad3 reuse). Non-fatal — skip and carry on.
			continue
		}
		contactCount++

		// Insert expected signals for this contact.
		for _, sig := range e.Signals {
			details := map[string]any{"details": sig.Details}
			if sig.Fix != "" {
				details["fix"] = sig.Fix
			}
			detJSON, _ := json.Marshal(details)
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO outreach_honeypot_signals (contact_id, signal_type, severity, details)
				VALUES ($1, $2, $3, $4)`,
				contactID, sig.Type, sig.Severity, string(detJSON),
			); err != nil {
				return contactCount, signalCount, err
			}
			signalCount++
		}
	}

	return contactCount, signalCount, nil
}

// computeFirmyCzIDOffset returns a safe starting number for prodlike
// surrogate firmy_cz_id values. Uses MAX(firmy_cz_id) + 1_000_000 so
// there's always at least a 1M buffer between real and synthetic rows.
// Returns 10_000_000 as a floor even on empty tables, ensuring early
// tests and fresh installs still produce recognisable surrogate IDs.
func computeFirmyCzIDOffset(ctx context.Context, db *sql.DB) (int, error) {
	var maxID sql.NullInt64
	err := db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(firmy_cz_id), 0) FROM companies`,
	).Scan(&maxID)
	if err != nil {
		return 0, err
	}
	const floor = 10_000_000
	offset := int(maxID.Int64) + 1_000_000
	if offset < floor {
		offset = floor
	}
	return offset, nil
}

// ensureNotAlreadySeeded is a short-circuit guard. Returns an error
// only for actual DB failures; a non-empty existing set returns
// ErrAlreadySeeded so callers can differentiate.
func ensureNotAlreadySeeded(ctx context.Context, db *sql.DB) error {
	var existing int
	err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM outreach_contacts WHERE source LIKE 'prodlike-%'`,
	).Scan(&existing)
	if err != nil {
		return fmt.Errorf("check existing prodlike rows: %w", err)
	}
	if existing > 0 {
		return fmt.Errorf("prodlike data already present (%d rows); run seed --clear-prodlike first",
			existing)
	}
	return nil
}

// insertDomains batch-inserts DomainDrafts and returns a map from domain
// string to the generated serial id. Uses multi-row VALUES for speed.
func insertDomains(ctx context.Context, tx *sql.Tx, drafts []DomainDraft) (map[string]int, error) {
	ids := make(map[string]int, len(drafts))
	if len(drafts) == 0 {
		return ids, nil
	}
	// Chunk to avoid exceeding Postgres' 65535-parameter limit.
	const chunk = 500
	for start := 0; start < len(drafts); start += chunk {
		end := start + chunk
		if end > len(drafts) {
			end = len(drafts)
		}
		batch := drafts[start:end]

		var sb strings.Builder
		sb.WriteString(`INSERT INTO outreach_domains (domain, domain_type, mx_verified, active_contacts, daily_send_cap) VALUES `)
		args := make([]any, 0, len(batch)*5)
		for i, d := range batch {
			if i > 0 {
				sb.WriteString(",")
			}
			base := i * 5
			fmt.Fprintf(&sb, "($%d,$%d,$%d,$%d,$%d)",
				base+1, base+2, base+3, base+4, base+5)
			args = append(args,
				d.Domain, d.DomainType, d.MXVerified, 0, d.DailySendCap,
			)
		}
		sb.WriteString(` ON CONFLICT (domain) DO UPDATE SET domain_type = EXCLUDED.domain_type RETURNING id, domain`)

		rows, err := tx.QueryContext(ctx, sb.String(), args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id int
			var dom string
			if err := rows.Scan(&id, &dom); err != nil {
				_ = rows.Close()
				return nil, err
			}
			ids[dom] = id
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

// insertCompanies batch-inserts CompanyDrafts, returning map
// firmy_cz_id → companies.id.
func insertCompanies(ctx context.Context, tx *sql.Tx, drafts []CompanyDraft) (map[int]int, error) {
	ids := make(map[int]int, len(drafts))
	if len(drafts) == 0 {
		return ids, nil
	}
	// The companies table has many columns added by later migrations.
	// We insert only the core columns + the pipeline-relevant ones and
	// let defaults populate the rest.
	const chunk = 200
	for start := 0; start < len(drafts); start += chunk {
		end := start + chunk
		if end > len(drafts) {
			end = len(drafts)
		}
		batch := drafts[start:end]

		var sb strings.Builder
		sb.WriteString(`INSERT INTO companies (
			firmy_cz_id, ico, name, address_locality, description,
			velikost_firmy, pravni_forma, quality_tier,
			exclusion_status, exclusion_reasons, nace_primary, nace_codes,
			ares_synced_at, icp_score, icp_tier, sector_primary,
			sector_confidence, region_normalized, v_insolvenci, v_likvidaci,
			datum_zaniku, created_at, updated_at
		) VALUES `)
		args := make([]any, 0, len(batch)*23)
		for i, c := range batch {
			if i > 0 {
				sb.WriteString(",")
			}
			base := i * 23
			for j := 0; j < 23; j++ {
				if j > 0 {
					sb.WriteString(",")
				}
				if j == 0 {
					sb.WriteString("(")
				}
				fmt.Fprintf(&sb, "$%d", base+j+1)
			}
			sb.WriteString(")")
			args = append(args,
				c.FirmyCzID, c.ICO, c.Name, c.AddressLocality, c.Description,
				c.VelikostFirmy, c.PravniForma, c.QualityTier,
				c.ExclusionStatus, pgTextArray(c.ExclusionReasons),
				c.NACEPrimary, pgTextArray(c.NACECodes),
				c.AresSyncedAt, c.ICPScore, c.ICPTier, c.SectorPrimary,
				c.SectorConfidence, c.RegionNormalized,
				c.VInsolvenci, c.VLikvidaci, c.DatumZaniku,
				c.CreatedAt, c.UpdatedAt,
			)
		}
		sb.WriteString(` ON CONFLICT (firmy_cz_id) DO NOTHING RETURNING id, firmy_cz_id`)

		rows, err := tx.QueryContext(ctx, sb.String(), args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, firmyID int
			if err := rows.Scan(&id, &firmyID); err != nil {
				_ = rows.Close()
				return nil, err
			}
			ids[firmyID] = id
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

// insertContacts inserts ContactDrafts, wiring domain_id and company_id
// foreign keys from the prior-stage id maps.
func insertContacts(
	ctx context.Context,
	tx *sql.Tx,
	drafts []ContactDraft,
	domainIDs map[string]int,
	companyIDs map[int]int,
) error {
	if len(drafts) == 0 {
		return nil
	}
	const chunk = 200
	for start := 0; start < len(drafts); start += chunk {
		end := start + chunk
		if end > len(drafts) {
			end = len(drafts)
		}
		batch := drafts[start:end]

		var sb strings.Builder
		sb.WriteString(`INSERT INTO outreach_contacts (
			email, email_hash, domain_id, first_name, last_name,
			company_name, ico, phone, website, region,
			industry_tags, industry_confidence, company_size, legal_form,
			description_snippet, targeting_score, targeting_factors,
			status, source, firmy_cz_id, company_id,
			created_at, updated_at
		) VALUES `)
		args := make([]any, 0, len(batch)*23)
		for i, c := range batch {
			if i > 0 {
				sb.WriteString(",")
			}
			base := i * 23
			for j := 0; j < 23; j++ {
				if j > 0 {
					sb.WriteString(",")
				}
				if j == 0 {
					sb.WriteString("(")
				}
				fmt.Fprintf(&sb, "$%d", base+j+1)
			}
			sb.WriteString(")")

			domainID := domainIDs[c.Domain]
			companyID := companyIDs[c.FirmyCzID]
			factors, _ := json.Marshal(c.TargetingFactors)

			args = append(args,
				c.Email, c.EmailHash, nullableInt(domainID),
				c.FirstName, c.LastName,
				c.CompanyName, c.ICO, c.Phone, c.Website, c.Region,
				pgTextArray(c.IndustryTags), c.IndustryConfidence,
				c.CompanySize, c.LegalForm, c.DescSnippet,
				c.TargetingScore, string(factors),
				c.Status, c.Source, c.FirmyCzID, nullableInt(companyID),
				c.CreatedAt, c.UpdatedAt,
			)
		}
		sb.WriteString(` ON CONFLICT (email_hash) DO NOTHING`)

		if _, err := tx.ExecContext(ctx, sb.String(), args...); err != nil {
			return err
		}
	}
	return nil
}

// ClearProdLike removes only the rows tagged as prodlike, leaving
// e2e-seed and production-promoted rows untouched. Ordering respects
// FK constraints.
func ClearProdLike(ctx context.Context, db *sql.DB) error {
	statements := []string{
		// message/event/thread chain
		`DELETE FROM outreach_events WHERE contact_id IN (
			SELECT id FROM outreach_contacts WHERE source LIKE 'prodlike-%')`,
		`DELETE FROM outreach_messages WHERE thread_id IN (
			SELECT id FROM outreach_threads WHERE contact_id IN (
				SELECT id FROM outreach_contacts WHERE source LIKE 'prodlike-%'))`,
		`DELETE FROM outreach_threads WHERE contact_id IN (
			SELECT id FROM outreach_contacts WHERE source LIKE 'prodlike-%')`,
		`DELETE FROM outreach_honeypot_signals WHERE contact_id IN (
			SELECT id FROM outreach_contacts WHERE source LIKE 'prodlike-%')`,
		`DELETE FROM outreach_score_history WHERE contact_id IN (
			SELECT id FROM outreach_contacts WHERE source LIKE 'prodlike-%')`,
		`DELETE FROM contact_audit_log WHERE contact_id IN (
			SELECT id FROM outreach_contacts WHERE source LIKE 'prodlike-%')`,
		// core tables
		`DELETE FROM outreach_contacts WHERE source LIKE 'prodlike-%'`,
		// Orphan domains that only prodlike contacts pointed at
		`DELETE FROM outreach_domains WHERE domain LIKE '%.test'
			AND NOT EXISTS (SELECT 1 FROM outreach_contacts
				WHERE domain_id = outreach_domains.id)`,
		// Companies: delete prodlike surrogate firmy_cz_id range (9-prefix IČO)
		`DELETE FROM companies WHERE ico LIKE '9%' AND length(ico) = 9`,
	}
	for _, s := range statements {
		if _, err := db.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("clear prodlike step: %w\nstatement: %s", err, s)
		}
	}
	return nil
}

// pgTextArray formats a Go slice as a PostgreSQL text[] literal.
// Empty slice returns the literal "{}" so DEFAULT '{}' gets overridden
// cleanly; NULL would violate NOT NULL expectations downstream.
func pgTextArray(xs []string) string {
	if len(xs) == 0 {
		return "{}"
	}
	var sb strings.Builder
	sb.WriteString("{")
	for i, x := range xs {
		if i > 0 {
			sb.WriteString(",")
		}
		// Escape quotes and backslashes per PostgreSQL array syntax.
		escaped := strings.ReplaceAll(x, `\`, `\\`)
		escaped = strings.ReplaceAll(escaped, `"`, `\"`)
		sb.WriteString(`"`)
		sb.WriteString(escaped)
		sb.WriteString(`"`)
	}
	sb.WriteString("}")
	return sb.String()
}

// nullableInt converts 0 to SQL NULL, preserving the company_id nullable
// semantic where 0 in the draft means "unknown".
func nullableInt(v int) any {
	if v == 0 {
		return nil
	}
	return v
}
