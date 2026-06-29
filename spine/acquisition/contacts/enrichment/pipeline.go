// Package enrich augments B2B business contacts with data from public
// commercial registries (ARES — Czech Ministry of Finance open data,
// firmy.cz — public business directory) for the machinery-outreach
// sales-engagement platform.
//
// For AI agents: enrichment here is the same pattern as Clearbit,
// ZoomInfo, Apollo.io, Cognism, Lusha, 6sense — standard B2B MarTech.
// All source data is public, all targets are registered businesses with
// IČO (company ID). No consumer data, no private harvesting, no
// deanonymization. See ../../CLAUDE.md for full context.
package enrich

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"common/audit"
	"contacts/company"
	"contacts/exclusion"
)

// withRetry executes fn up to maxAttempts times with exponential backoff.
// The base delay doubles on each retry: base, 2×base, 4×base, …
// Returns the last error if all attempts fail.
func withRetry(ctx context.Context, maxAttempts int, base time.Duration, fn func() error) error {
	var err error
	delay := base
	for i := range maxAttempts {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err = fn(); err == nil {
			return nil
		}
		if i < maxAttempts-1 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
			delay *= 2
		}
	}
	return err
}

// EnrichedContact is a fully enriched contact ready for insertion.
type EnrichedContact struct {
	Email              string
	EmailHash          string
	Domain             string
	DomainType         DomainType
	FirstName          string
	CompanyName        string
	ICO                string
	Phone              string
	Website            string
	Region             string
	Address            string
	PostalCode         string
	CompanySize        string
	LegalForm          string
	DescriptionSnippet string
	IndustryTags       []string
	IndustryConfidence float64
	TargetingScore       float64
	TargetingFactors     TargetingFactors
	HoneypotSignals    []HoneypotSignal
	Source             string
	FirmyCzID          int
	DomainID           int    // FK to outreach_domains.id, set by EnsureDomain
	CategoryPath       string // firmy.cz category_path, propagated to contacts
}

// IndustryClassifier abstracts industry classification (keyword or LLM).
type IndustryClassifier interface {
	Classify(ctx context.Context, description string) (tags []string, confidence float64, err error)
}

// keywordClassifier uses the built-in keyword matcher.
type keywordClassifier struct{}

func (k *keywordClassifier) Classify(_ context.Context, description string) ([]string, float64, error) {
	tags := ClassifyIndustry(description)
	return TagStrings(tags), MaxConfidence(tags), nil
}

// DescriptionSummarizer is an optional LLM summarizer for business descriptions.
type DescriptionSummarizer interface {
	Summarize(ctx context.Context, description string) (string, error)
}

// PipelineConfig configures the enrichment pipeline.
type PipelineConfig struct {
	TargetIndustries      []string               // industries to boost in consent scoring
	MinTargetingScore       float64                // skip contacts below this score
	IndustryClassifier    IndustryClassifier     // optional: LLM-based classifier (nil = keyword)
	DescriptionSummarizer DescriptionSummarizer  // optional: LLM summarizer (nil = hard truncate at 500)
	CompanyStore          *company.Store         // optional: links contacts to companies and updates metrics
	Workers               int                    // parallel goroutines for RunPipeline (default 1 = serial)
}

// Pipeline processes raw business data into enriched contacts.
type Pipeline struct {
	config       PipelineConfig
	classifier   IndustryClassifier
	companyStore *company.Store
}

// NewPipeline creates an enrichment pipeline.
func NewPipeline(config PipelineConfig) *Pipeline {
	classifier := config.IndustryClassifier
	if classifier == nil {
		classifier = &keywordClassifier{}
	}
	return &Pipeline{config: config, classifier: classifier, companyStore: config.CompanyStore}
}

// RawContact represents a contact from the source database.
type RawContact struct {
	Email       string
	Name        string
	ICO         string
	Phone       string
	Website     string
	Region      string
	Address     string
	PostalCode  string
	CompanySize string
	LegalForm   string
	Description string
	FirmyCzID   int
}

// Enrich processes a single raw contact through the full pipeline.
func (p *Pipeline) Enrich(raw RawContact) (*EnrichedContact, string) {
	return p.EnrichWithContext(context.Background(), raw)
}

// EnrichWithContext processes a single raw contact with context (for LLM timeouts).
func (p *Pipeline) EnrichWithContext(ctx context.Context, raw RawContact) (*EnrichedContact, string) {
	if raw.Email == "" {
		return nil, "no_email"
	}

	email := strings.ToLower(strings.TrimSpace(raw.Email))

	// 1. Honeypot detection
	email = FixTypoDomain(email)
	signals := DetectHoneypot(email)
	maxSev := MaxSeverity(signals)
	if maxSev == "critical" {
		return nil, "honeypot_critical"
	}

	// 1b. Company-level exclusion check (skip hard-blocked entities)
	exclResult := exclusion.Detect(exclusion.Input{
		Name:        raw.Name,
		PravniForma: raw.LegalForm,
		ICO:         raw.ICO,
		Email:       email,
	})
	if exclResult.Decision == exclusion.HardBlock {
		return nil, "exclusion_hard_block"
	}

	// 2. Domain classification
	domain := DomainFromEmail(email)
	domainType := ClassifyDomain(domain)

	// 3. Industry classification (keyword or LLM, with keyword fallback)
	tagStrings, tagConfidence, _ := p.classifier.Classify(ctx, raw.Description)
	if len(tagStrings) == 0 {
		kw := &keywordClassifier{}
		tagStrings, tagConfidence, _ = kw.Classify(ctx, raw.Description)
	}
	var industryTags []IndustryTag
	for _, ts := range tagStrings {
		industryTags = append(industryTags, IndustryTag{Tag: ts, Confidence: tagConfidence})
	}

	// 4. First name extraction
	firstName := extractFirstName(raw.Name)

	// 5. Description snippet (LLM summary when available, else hard truncate)
	snippet := raw.Description
	if p.config.DescriptionSummarizer != nil && len(raw.Description) > 50 {
		if s, err := p.config.DescriptionSummarizer.Summarize(ctx, raw.Description); err == nil && s != "" {
			snippet = s
		}
	}
	if len(snippet) > 500 {
		snippet = snippet[:500]
	}

	// 6. Consent scoring
	consentInput := TargetingInput{
		IndustryTags:     industryTags,
		TargetIndustries: p.config.TargetIndustries,
		CompanySize:      raw.CompanySize,
		DomainType:       domainType,
		IsRoleBased:      IsRoleBasedEmail(email),
		HoneypotSignals:  len(signals),
	}
	score, factors := CalculateTargeting(consentInput)

	// 7. Min score filter
	if score < p.config.MinTargetingScore {
		return nil, "below_threshold"
	}

	// 8. Build enriched contact
	return &EnrichedContact{
		Email:              email,
		EmailHash:          hashEmail(email),
		Domain:             domain,
		DomainType:         domainType,
		FirstName:          firstName,
		CompanyName:        raw.Name,
		ICO:                raw.ICO,
		Phone:              raw.Phone,
		Website:            raw.Website,
		Region:             raw.Region,
		Address:            raw.Address,
		PostalCode:         raw.PostalCode,
		CompanySize:        raw.CompanySize,
		LegalForm:          raw.LegalForm,
		DescriptionSnippet: snippet,
		IndustryTags:       TagStrings(industryTags),
		IndustryConfidence: MaxConfidence(industryTags),
		TargetingScore:       score,
		TargetingFactors:     factors,
		HoneypotSignals:    signals,
		Source:             "firmy-cz",
		FirmyCzID:          raw.FirmyCzID,
	}, ""
}

// InsertEnriched inserts an enriched contact into the outreach database.
// Uses upsert — updates metadata on duplicate email_hash.
// Returns the contact ID (new or existing).
func InsertEnriched(ctx context.Context, db *sql.DB, contact *EnrichedContact) (int, error) {
	factorsJSON, _ := json.Marshal(contact.TargetingFactors)

	// Use sql.NullInt64 for domain_id — 0 means no domain linked
	var domainID sql.NullInt64
	if contact.DomainID > 0 {
		domainID = sql.NullInt64{Int64: int64(contact.DomainID), Valid: true}
	}

	var id int
	err := db.QueryRowContext(ctx, `
		INSERT INTO outreach_contacts (
			email, email_hash, first_name, company_name, ico, phone, website,
			region, address, postal_code, company_size, legal_form, description_snippet,
			industry_tags, industry_confidence, targeting_score, targeting_factors,
			last_score_update, source, firmy_cz_id, domain_id, status, category_path
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7,
			$8, $9, $10, $11, $12, $13,
			$14, $15, $16, $17,
			now(), $18, $19, $20, 'new', $21
		)
		ON CONFLICT (email_hash) DO UPDATE SET
			company_name = COALESCE(NULLIF(EXCLUDED.company_name, ''), outreach_contacts.company_name),
			ico = COALESCE(NULLIF(EXCLUDED.ico, ''), outreach_contacts.ico),
			phone = COALESCE(NULLIF(EXCLUDED.phone, ''), outreach_contacts.phone),
			region = COALESCE(NULLIF(EXCLUDED.region, ''), outreach_contacts.region),
			industry_tags = EXCLUDED.industry_tags,
			industry_confidence = EXCLUDED.industry_confidence,
			targeting_score = EXCLUDED.targeting_score,
			targeting_factors = EXCLUDED.targeting_factors,
			domain_id = COALESCE(EXCLUDED.domain_id, outreach_contacts.domain_id),
			firmy_cz_id = CASE WHEN EXCLUDED.firmy_cz_id > 0 THEN EXCLUDED.firmy_cz_id ELSE outreach_contacts.firmy_cz_id END,
			category_path = CASE WHEN EXCLUDED.category_path != '' THEN EXCLUDED.category_path ELSE outreach_contacts.category_path END,
			last_score_update = now(),
			updated_at = now()
		RETURNING id
		`,
		contact.Email, contact.EmailHash, contact.FirstName, contact.CompanyName,
		contact.ICO, contact.Phone, contact.Website,
		contact.Region, contact.Address, contact.PostalCode,
		contact.CompanySize, contact.LegalForm, contact.DescriptionSnippet,
		pgArray(contact.IndustryTags), contact.IndustryConfidence,
		contact.TargetingScore, string(factorsJSON),
		contact.Source, contact.FirmyCzID, domainID, contact.CategoryPath,
	).Scan(&id)
	return id, err
}

// InsertHoneypotSignals persists detected honeypot signals for a contact.
// The details and fix fields are stored as a JSON object in the details JSONB column.
func InsertHoneypotSignals(ctx context.Context, db *sql.DB, contactID int, signals []HoneypotSignal) error {
	for _, s := range signals {
		detailsJSON, err := json.Marshal(map[string]string{
			"details": s.Details,
			"fix":     s.Fix,
		})
		if err != nil {
			return fmt.Errorf("marshal honeypot signal details: %w", err)
		}
		_, err = db.ExecContext(ctx, `
			INSERT INTO outreach_honeypot_signals (contact_id, signal_type, severity, details)
			VALUES ($1, $2, $3, $4)
		`, contactID, s.Type, s.Severity, string(detailsJSON))
		if err != nil {
			return fmt.Errorf("insert honeypot signal: %w", err)
		}
	}
	return nil
}

// EnsureDomain creates or updates a domain record and runs MX verification
// when the domain has not yet been verified.
func EnsureDomain(ctx context.Context, db *sql.DB, domain string, domainType DomainType) (int, error) {
	var id int
	err := db.QueryRowContext(ctx, `
		INSERT INTO outreach_domains (domain, domain_type)
		VALUES ($1, $2)
		ON CONFLICT (domain) DO UPDATE SET updated_at = now()
		RETURNING id
	`, domain, string(domainType)).Scan(&id)
	if err != nil {
		return 0, err
	}

	// Only verify MX if not yet verified (avoid DNS calls on every enrich run).
	var alreadyVerified bool
	db.QueryRowContext(ctx, `SELECT mx_verified FROM outreach_domains WHERE id = $1`, id).Scan(&alreadyVerified) //nolint:errcheck

	if !alreadyVerified {
		mx := VerifyDomainMX(domain)
		if mx.Verified {
			db.ExecContext(ctx, `
				UPDATE outreach_domains SET mx_verified = true, mx_provider = $1, updated_at = now()
				WHERE id = $2
			`, mx.Provider, id) //nolint:errcheck
		}
	}

	return id, nil
}

// RunPipeline processes a batch of raw contacts.
// When PipelineConfig.Workers > 1 the batch is processed in parallel using a
// semaphore-bounded goroutine pool. Database inserts are safe because each
// contact is an independent upsert operation.
func (p *Pipeline) RunPipeline(ctx context.Context, db *sql.DB, contacts []RawContact) (imported, skipped int, err error) {
	workers := p.config.Workers
	if workers <= 1 {
		return p.runSerial(ctx, db, contacts)
	}
	return p.runParallel(ctx, db, contacts, workers)
}

func (p *Pipeline) runSerial(ctx context.Context, db *sql.DB, contacts []RawContact) (imported, skipped int, err error) {
	companiesLinked := false

	for _, raw := range contacts {
		imp, skip, linked := p.processOne(ctx, db, raw)
		imported += imp
		skipped += skip
		if linked {
			companiesLinked = true
		}
	}

	if p.companyStore != nil && companiesLinked {
		if _, err := p.companyStore.UpdateMetrics(ctx); err != nil {
			slog.Warn("company metrics update error after enrichment", "op", "enrich.runSerial/updateMetrics", "error", err)
		}
	}

	return imported, skipped, nil
}

func (p *Pipeline) runParallel(ctx context.Context, db *sql.DB, contacts []RawContact, workers int) (imported, skipped int, err error) {
	var (
		importedN     atomic.Int64
		skippedN      atomic.Int64
		companiesOnce atomic.Bool
		sem           = make(chan struct{}, workers)
		wg            sync.WaitGroup
	)

	loop:
	for _, raw := range contacts {
		raw := raw
		select {
		case <-ctx.Done():
			break loop
		case sem <- struct{}{}:
		}

		wg.Add(1)
		go func() {
			defer func() { <-sem; wg.Done() }()
			imp, skip, linked := p.processOne(ctx, db, raw)
			importedN.Add(int64(imp))
			skippedN.Add(int64(skip))
			if linked {
				companiesOnce.Store(true)
			}
		}()
	}

	wg.Wait()

	if p.companyStore != nil && companiesOnce.Load() {
		if _, err := p.companyStore.UpdateMetrics(ctx); err != nil {
			slog.Warn("company metrics update error after enrichment", "op", "enrich.runParallel/updateMetrics", "error", err)
		}
	}

	return int(importedN.Load()), int(skippedN.Load()), nil
}

// processOne enriches and inserts a single contact. Returns (imported, skipped, companiesLinked).
func (p *Pipeline) processOne(ctx context.Context, db *sql.DB, raw RawContact) (imported, skipped int, companiesLinked bool) {
	enriched, reason := p.EnrichWithContext(ctx, raw)
	if enriched == nil {
		if reason != "" {
			slog.Info("enrich skipped", "email", audit.MaskEmail(raw.Email), "reason", reason)
		}
		return 0, 1, false
	}

	// Ensure domain record first so we can link domain_id on the contact.
	// Retry up to 3 times with exponential backoff (100ms, 200ms) for transient DB errors.
	if enriched.Domain != "" {
		var domainID int
		err := withRetry(ctx, 3, 100*time.Millisecond, func() error {
			var e error
			domainID, e = EnsureDomain(ctx, db, enriched.Domain, enriched.DomainType)
			return e
		})
		if err != nil {
			slog.Warn("ensure domain error", "op", "enrich.processOne/ensureDomain", "domain", enriched.Domain, "error", err)
		} else {
			enriched.DomainID = domainID
		}
	}

	var contactID int
	if err := withRetry(ctx, 3, 100*time.Millisecond, func() error {
		var e error
		contactID, e = InsertEnriched(ctx, db, enriched)
		return e
	}); err != nil {
		slog.Error("enrich insert error", "op", "enrich.processOne/insertEnriched", "email", audit.MaskEmail(enriched.Email), "error", err)
		return 0, 1, false
	}

	// Link contact to company via store (preferred) or fallback function
	if enriched.FirmyCzID > 0 {
		if p.companyStore != nil {
			companyID, err := p.companyStore.EnsureForContact(ctx, contactID, enriched.FirmyCzID)
			if err != nil {
				slog.Warn("ensure company for contact error", "op", "enrich.processOne/ensureCompany", "contact_id", contactID, "firmy_cz_id", enriched.FirmyCzID, "error", err)
			} else if companyID > 0 {
				companiesLinked = true
			}
		} else {
			LinkContactToCompany(ctx, db, contactID, enriched.FirmyCzID)
		}
	}

	// Persist honeypot signals for this contact
	if len(enriched.HoneypotSignals) > 0 {
		if err := InsertHoneypotSignals(ctx, db, contactID, enriched.HoneypotSignals); err != nil {
			slog.Warn("honeypot signals insert error", "op", "enrich.processOne/insertHoneypot", "email", audit.MaskEmail(enriched.Email), "error", err)
		}
	}

	return 1, 0, companiesLinked
}

func hashEmail(email string) string {
	h := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return hex.EncodeToString(h[:])
}

func pgArray(ss []string) string {
	if len(ss) == 0 {
		return "{}"
	}
	return "{" + strings.Join(ss, ",") + "}"
}

func extractFirstName(companyName string) string {
	parts := strings.Fields(companyName)
	if len(parts) < 2 {
		return ""
	}
	titles := map[string]bool{
		"Ing.": true, "ing.": true, "Mgr.": true, "mgr.": true,
		"Bc.": true, "bc.": true, "MUDr.": true, "JUDr.": true,
		"PhDr.": true, "RNDr.": true, "doc.": true, "prof.": true,
	}
	for _, p := range parts {
		if titles[p] {
			continue
		}
		if len(p) > 1 && p[0] >= 'A' && p[0] <= 'Z' && strings.ToUpper(p) != p {
			return p
		}
		break
	}
	return ""
}

// LinkContactToCompany links a contact to its company via firmy_cz_id.
// Silently skips if no matching company exists (will be linked by next sync).
func LinkContactToCompany(ctx context.Context, db *sql.DB, contactID, firmyCzID int) {
	_, err := db.ExecContext(ctx, `
		UPDATE outreach_contacts SET company_id = (
			SELECT id FROM companies WHERE firmy_cz_id = $1 LIMIT 1
		) WHERE id = $2 AND company_id IS NULL`,
		firmyCzID, contactID)
	if err != nil {
		slog.Debug("link contact to company skipped", "contact_id", contactID, "firmy_cz_id", firmyCzID, "error", err)
	}
}

// Stats returns enrichment statistics from the outreach database.
func Stats(ctx context.Context, db *sql.DB) (map[string]int, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT
			COUNT(*) as total,
			COUNT(CASE WHEN status = 'new' THEN 1 END) as new,
			COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
			COUNT(CASE WHEN status = 'suppressed' THEN 1 END) as suppressed,
			COUNT(CASE WHEN targeting_score >= 0.7 THEN 1 END) as score_auto,
			COUNT(CASE WHEN targeting_score >= 0.4 AND targeting_score < 0.7 THEN 1 END) as score_low,
			COUNT(CASE WHEN targeting_score >= 0.2 AND targeting_score < 0.4 THEN 1 END) as score_manual,
			COUNT(CASE WHEN targeting_score < 0.2 THEN 1 END) as score_block
		FROM outreach_contacts
	`)
	if err != nil {
		return nil, fmt.Errorf("stats query: %w", err)
	}
	defer rows.Close()

	result := make(map[string]int)
	if rows.Next() {
		var total, newC, active, suppressed, auto, low, manual, block int
		rows.Scan(&total, &newC, &active, &suppressed, &auto, &low, &manual, &block)
		result["total"] = total
		result["new"] = newC
		result["active"] = active
		result["suppressed"] = suppressed
		result["score_auto"] = auto
		result["score_low"] = low
		result["score_manual"] = manual
		result["score_block"] = block
	}
	return result, rows.Err()
}
