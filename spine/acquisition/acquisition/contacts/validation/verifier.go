package validation

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// EmailStatus represents the verification outcome.
type EmailStatus string

const (
	StatusUnverified EmailStatus = "unverified"
	StatusValid      EmailStatus = "valid"
	StatusInvalid    EmailStatus = "invalid"
	StatusRisky      EmailStatus = "risky"
	StatusCatchAll   EmailStatus = "catch_all"
	StatusSpamtrap   EmailStatus = "spamtrap"
	StatusRoleOnly   EmailStatus = "role_only"
	StatusNoEmail    EmailStatus = "no_email"
)

// Per-MX-host SMTP probe rate-limit intervals.
// Keying by MX host (not domain) means all @gmail.com addresses share the
// gmail-smtp-in.l.google.com slot, while probes to different MX hosts never
// contend with each other.
//
// Rationale for each value:
//   - Gmail  : documented "1 RCPT TO per 2s" heuristic from postmaster feedback.
//   - Outlook: conservative — Microsoft flags aggressive probing as abuse (3s).
//   - Default: safe floor for unknown providers (1s avoids connection storm).
const (
	MXProbeIntervalGmail   = 2 * time.Second // gmail-smtp-in.l.google.com
	MXProbeIntervalOutlook = 3 * time.Second // *.protection.outlook.com
	MXProbeIntervalDefault = 1 * time.Second // all other MX hosts
)

// mxProbeInterval returns the per-MX rate-limit interval for a given MX host.
func mxProbeInterval(mxHost string) time.Duration {
	switch {
	case strings.HasSuffix(mxHost, ".google.com"):
		return MXProbeIntervalGmail
	case strings.HasSuffix(mxHost, ".outlook.com"):
		return MXProbeIntervalOutlook
	default:
		return MXProbeIntervalDefault
	}
}

// VerificationResult is the full result stored as JSONB.
type VerificationResult struct {
	SyntaxValid  bool   `json:"syntax_valid"`
	MXExists     bool   `json:"mx_exists"`
	SMTPValid    *bool  `json:"smtp_valid,omitempty"`
	IsCatchAll   bool   `json:"is_catch_all"`
	IsDisposable bool   `json:"is_disposable"`
	IsSpamtrap   bool   `json:"is_spamtrap"`
	IsRole       bool   `json:"is_role"`
	RiskLevel    string `json:"risk_level"` // low, medium, high
	Detail       string `json:"detail,omitempty"`
}

// DomainCache stores domain-level verification results to avoid redundant lookups.
type DomainCache struct {
	mu      sync.RWMutex
	domains map[string]*domainEntry
}

type domainEntry struct {
	mxExists       bool
	mxHost         string
	isCatchAll     *bool // nil = not checked
	isDisposable   bool
	isSpamtrap     bool
	smtpConnectable *bool // nil = not checked
	checkedAt      time.Time
}

func NewDomainCache() *DomainCache {
	return &DomainCache{domains: make(map[string]*domainEntry)}
}

func (c *DomainCache) Get(domain string) (*domainEntry, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.domains[domain]
	return e, ok
}

func (c *DomainCache) Set(domain string, entry *domainEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.domains[domain] = entry
}

// domainCacheTTL is how long a domain entry is considered fresh.
const domainCacheTTL = 30 * 24 * time.Hour

// Verifier is the full email verification engine.
type Verifier struct {
	DB          *sql.DB
	FromDomain  string        // HELO domain for SMTP probes (unused post-R6; relay owns HELO)
	SMTPTimeout time.Duration // per-connection timeout
	EnableSMTP  bool          // whether to do SMTP RCPT TO probes
	DryRun      bool          // don't write to DB
	RelayURL    string        // anti-trace-relay base URL (empty → probes disabled)
	RelayToken  string        // bearer token for relay auth

	cache      *DomainCache
	syntax     *SyntaxValidator
	disposable *DisposableValidator
	spamtrap   *SpamtrapValidator
	role       *RoleValidator
	mx         *MXValidator

	// lastProbeMX tracks the last SMTP probe time keyed by MX host (not domain).
	// All addresses sharing the same MX server (e.g. gmail-smtp-in.l.google.com)
	// contend on one slot; probes to distinct MX hosts never block each other.
	lastProbeMX   map[string]time.Time
	lastProbeMXMu sync.Mutex
}

func NewVerifier(db *sql.DB) *Verifier {
	return &Verifier{
		DB:          db,
		FromDomain:  "verify.local",
		SMTPTimeout: 10 * time.Second,
		EnableSMTP:  false,
		cache:       NewDomainCache(),
		syntax:      &SyntaxValidator{},
		disposable:  &DisposableValidator{},
		spamtrap:    &SpamtrapValidator{},
		role:        &RoleValidator{},
		mx:          &MXValidator{},
		lastProbeMX: make(map[string]time.Time),
	}
}

// LoadDomainCache pre-loads domain cache from the email_domains table.
func (v *Verifier) LoadDomainCache(ctx context.Context) error {
	if v.DB == nil {
		return nil
	}
	rows, err := v.DB.QueryContext(ctx,
		`SELECT domain, mx_exists, mx_host, is_catch_all, is_disposable, is_spamtrap, smtp_connectable, checked_at
		 FROM email_domains
		 WHERE checked_at > now() - interval '30 days'`)
	if err != nil {
		return fmt.Errorf("load domain cache: %w", err)
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var (
			domain         string
			mxExists       sql.NullBool
			mxHost         sql.NullString
			isCatchAll     sql.NullBool
			isDisposable   sql.NullBool
			isSpamtrap     sql.NullBool
			smtpConn       sql.NullBool
			checkedAt      time.Time
		)
		if err := rows.Scan(&domain, &mxExists, &mxHost, &isCatchAll, &isDisposable, &isSpamtrap, &smtpConn, &checkedAt); err != nil {
			return fmt.Errorf("scan domain: %w", err)
		}
		entry := &domainEntry{
			mxExists:     mxExists.Bool,
			mxHost:       mxHost.String,
			isDisposable: isDisposable.Bool,
			isSpamtrap:   isSpamtrap.Bool,
			checkedAt:    checkedAt,
		}
		if isCatchAll.Valid {
			val := isCatchAll.Bool
			entry.isCatchAll = &val
		}
		if smtpConn.Valid {
			val := smtpConn.Bool
			entry.smtpConnectable = &val
		}
		v.cache.Set(domain, entry)
		count++
	}
	if count > 0 {
		slog.Info("loaded domain cache", "domains", count)
	}
	return nil
}

// VerifyEmail runs the full verification chain for a single email.
func (v *Verifier) VerifyEmail(ctx context.Context, email string) (EmailStatus, *VerificationResult) {
	result := &VerificationResult{RiskLevel: "low"}

	email = strings.TrimSpace(email)
	if email == "" {
		result.Detail = "empty email"
		return StatusNoEmail, result
	}

	// 1. Syntax check
	ok, detail, _ := v.syntax.Validate(ctx, email)
	result.SyntaxValid = ok
	if !ok {
		result.RiskLevel = "high"
		result.Detail = detail
		return StatusInvalid, result
	}

	domain := domainFromEmail(email)

	// 2. Spamtrap check (before any network calls)
	ok, detail, _ = v.spamtrap.Validate(ctx, email)
	if !ok {
		result.IsSpamtrap = true
		result.RiskLevel = "high"
		result.Detail = detail
		return StatusSpamtrap, result
	}

	// 3. Role-based check
	ok, detail, _ = v.role.Validate(ctx, email)
	result.IsRole = !ok
	if !ok {
		// Dangerous roles → invalid, risky roles → risky
		if isDangerousRole(localFromEmail(email)) {
			result.RiskLevel = "high"
			result.Detail = detail
			return StatusInvalid, result
		}
		result.RiskLevel = "medium"
		result.Detail = detail
		// Continue — role addresses can still be valid
	}

	// 4. Domain-level checks (cached)
	domEntry := v.checkDomain(ctx, domain)

	// 4a. Disposable
	result.IsDisposable = domEntry.isDisposable
	if domEntry.isDisposable {
		result.RiskLevel = "high"
		result.Detail = "disposable domain"
		return StatusInvalid, result
	}

	// 4b. Domain-level spamtrap
	if domEntry.isSpamtrap {
		result.IsSpamtrap = true
		result.RiskLevel = "high"
		result.Detail = "spamtrap domain"
		return StatusSpamtrap, result
	}

	// 4c. MX check
	result.MXExists = domEntry.mxExists
	if !domEntry.mxExists {
		result.RiskLevel = "high"
		result.Detail = "no MX records"
		return StatusInvalid, result
	}

	// 4d. Catch-all
	if domEntry.isCatchAll != nil && *domEntry.isCatchAll {
		result.IsCatchAll = true
		// Catch-all domains accept everything — can't verify individual addresses
		if result.IsRole {
			result.RiskLevel = "high"
			result.Detail = "role address on catch-all domain"
			return StatusRoleOnly, result
		}
		result.RiskLevel = "medium"
		result.Detail = "catch-all domain"
		return StatusCatchAll, result
	}

	// 5. SMTP RCPT TO probe (optional, rate-limited)
	if v.EnableSMTP {
		if domEntry.smtpConnectable != nil && *domEntry.smtpConnectable {
			// MX is reachable → probe the actual mailbox. A definitive reject
			// (550) is StatusInvalid; an inconclusive greylist / temp-fail /
			// timeout leaves SMTPValid == nil so the greylist retry loop
			// re-queues the row instead of permanently marking it invalid.
			switch v.smtpProbe(ctx, email, domain) {
			case ProbeValid:
				ok := true
				result.SMTPValid = &ok
			case ProbeInvalid:
				rejected := false
				result.SMTPValid = &rejected
				result.RiskLevel = "high"
				result.Detail = "SMTP RCPT TO rejected"
				return StatusInvalid, result
			case ProbeUnknown:
				// SMTPValid stays nil → non-terminal; retry loop re-probes.
				result.RiskLevel = "medium"
				result.Detail = "SMTP probe inconclusive (greylist/temp-fail)"
				return StatusRisky, result
			}
		} else {
			// SMTP probing was requested but we never confirmed the mailbox
			// (MX unreachable, or connectability unknown). Don't report
			// "valid" on the strength of DNS alone — surface as unverified so
			// the row is re-probed, not shipped as deliverable.
			result.RiskLevel = "medium"
			if domEntry.smtpConnectable == nil {
				result.Detail = "SMTP probe enabled but connectability unknown"
			} else {
				result.Detail = "SMTP probe enabled but MX not connectable"
			}
			return StatusUnverified, result
		}
	}

	// Final status
	if result.IsRole {
		return StatusRoleOnly, result
	}
	if result.RiskLevel == "medium" {
		return StatusRisky, result
	}

	result.Detail = "verified"
	return StatusValid, result
}

// checkDomain performs domain-level checks with caching.
func (v *Verifier) checkDomain(ctx context.Context, domain string) *domainEntry {
	if entry, ok := v.cache.Get(domain); ok {
		fresh := entry.checkedAt.IsZero() || time.Since(entry.checkedAt) < domainCacheTTL
		// A cached entry that never recorded SMTP connectability (nil) is not
		// a completed probe when EnableSMTP is on — fall through and re-check
		// so step 5 can actually probe the mailbox instead of treating a
		// DNS-only cache hit as deliverable. Only forces a re-check for
		// probe-eligible domains (has MX, not disposable/spamtrap); for the
		// rest the nil is expected and the cached entry stands.
		probeIncomplete := v.EnableSMTP && entry.smtpConnectable == nil &&
			entry.mxExists && !entry.isDisposable && !entry.isSpamtrap
		if fresh && !probeIncomplete {
			return entry
		}
		// stale or probe-incomplete — fall through and re-check
	}

	entry := &domainEntry{checkedAt: time.Now()}

	// Disposable check
	ok, _, _ := v.disposable.Validate(ctx, "check@"+domain)
	entry.isDisposable = !ok

	// Spamtrap domain check
	spamOK, _, _ := v.spamtrap.Validate(ctx, "check@"+domain)
	entry.isSpamtrap = !spamOK

	// MX lookup
	mxOK, detail, _ := v.mx.Validate(ctx, "check@"+domain)
	entry.mxExists = mxOK
	if mxOK {
		// Extract MX host from detail
		if strings.HasPrefix(detail, "MX found: ") {
			entry.mxHost = strings.TrimPrefix(detail, "MX found: ")
		}
	}

	// SMTP connectivity test (can we even connect to port 25?)
	if v.EnableSMTP && entry.mxExists && !entry.isDisposable && !entry.isSpamtrap {
		connectable := v.testSMTPConnectivity(ctx, domain)
		entry.smtpConnectable = &connectable

		// Catch-all detection (only if connectable)
		if connectable {
			catchAllValidator := &CatchAllValidator{
				Timeout:    v.SMTPTimeout,
				FromDomain: v.FromDomain,
				RelayURL:   v.RelayURL,
				RelayToken: v.RelayToken,
			}
			notCatchAll, _, _ := catchAllValidator.Validate(ctx, "check@"+domain)
			isCatchAll := !notCatchAll
			entry.isCatchAll = &isCatchAll
		}
	}

	v.cache.Set(domain, entry)

	// Persist to DB
	v.saveDomainEntry(ctx, domain, entry)

	return entry
}

// testSMTPConnectivity asks the relay to verify a probe address and treats any
// definitive answer (valid/invalid) as "server responded → connectable".
// Returns false when relay is disabled or returns an unknown/error outcome.
func (v *Verifier) testSMTPConnectivity(ctx context.Context, domain string) bool {
	probe := &SMTPProbeValidator{
		Timeout:    v.SMTPTimeout,
		FromDomain: v.FromDomain,
		RelayURL:   v.RelayURL,
		RelayToken: v.RelayToken,
	}
	_, detail, _ := probe.Validate(ctx, "smtp-test-connectivity@"+domain)
	// Relay responded with definitive signal → connectable.
	// verify_disabled / relay error / http non-200 → not connectable.
	return !strings.Contains(detail, "verify_disabled") &&
		!strings.Contains(detail, "relay error") &&
		!strings.Contains(detail, "relay http") &&
		!strings.Contains(detail, "unknown status") &&
		!strings.Contains(detail, "no domain")
}

// smtpProbe does rate-limited SMTP RCPT TO verification and returns the
// tri-state ProbeOutcome so the caller can tell a definitive reject (550)
// apart from an inconclusive greylist / temp-fail result.
// Rate limiting is per-MX-host (not per-domain): all addresses that resolve
// to the same MX host share one slot, while different MX hosts never block
// each other. Intervals come from named constants (MXProbeInterval*).
func (v *Verifier) smtpProbe(ctx context.Context, email, domain string) ProbeOutcome {
	// Resolve MX host from domain cache; fall back to domain itself when
	// the cache entry is missing or has no MX recorded yet.
	mxHost := domain
	if entry, ok := v.cache.Get(domain); ok && entry.mxHost != "" {
		mxHost = entry.mxHost
	}
	interval := mxProbeInterval(mxHost)

	v.lastProbeMXMu.Lock()
	if last, ok := v.lastProbeMX[mxHost]; ok {
		elapsed := time.Since(last)
		if elapsed < interval {
			v.lastProbeMXMu.Unlock()
			select {
			case <-ctx.Done():
				return ProbeUnknown
			case <-time.After(interval - elapsed):
			}
			v.lastProbeMXMu.Lock()
		}
	}
	v.lastProbeMX[mxHost] = time.Now()
	v.lastProbeMXMu.Unlock()

	probe := &SMTPProbeValidator{
		Timeout:    v.SMTPTimeout,
		FromDomain: v.FromDomain,
		RelayURL:   v.RelayURL,
		RelayToken: v.RelayToken,
	}
	outcome, _, _ := probe.Probe(ctx, email)
	return outcome
}

// saveDomainEntry persists domain verification to the email_domains table.
func (v *Verifier) saveDomainEntry(ctx context.Context, domain string, entry *domainEntry) {
	if v.DB == nil || v.DryRun {
		return
	}

	_, err := v.DB.ExecContext(ctx, `
		INSERT INTO email_domains (domain, mx_exists, mx_host, is_catch_all, is_disposable, is_spamtrap, smtp_connectable, checked_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (domain) DO UPDATE SET
			mx_exists = EXCLUDED.mx_exists,
			mx_host = EXCLUDED.mx_host,
			is_catch_all = EXCLUDED.is_catch_all,
			is_disposable = EXCLUDED.is_disposable,
			is_spamtrap = EXCLUDED.is_spamtrap,
			smtp_connectable = EXCLUDED.smtp_connectable,
			checked_at = EXCLUDED.checked_at`,
		domain, entry.mxExists, nullString(entry.mxHost),
		nullBool(entry.isCatchAll), entry.isDisposable, entry.isSpamtrap,
		nullBool(entry.smtpConnectable), entry.checkedAt)
	if err != nil {
		slog.Warn("save domain entry failed", "domain", domain, "error", err)
	}
}

// SaveCompanyResult persists per-company verification to the companies table.
func (v *Verifier) SaveCompanyResult(ctx context.Context, companyID int64, status EmailStatus, result *VerificationResult) error {
	if v.DB == nil || v.DryRun {
		return nil
	}

	resultJSON, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("marshal verification result: %w", err)
	}

	_, err = v.DB.ExecContext(ctx, `
		UPDATE companies
		SET email_status = $1, email_verification = $2, email_verified_at = now()
		WHERE id = $3`,
		string(status), resultJSON, companyID)
	return err
}

// CompanyVerifyRow is one buffered result for batch writes.
type CompanyVerifyRow struct {
	ID     int64
	Status EmailStatus
	Result *VerificationResult
}

// SaveCompanyResultBatch persists multiple verification results in a single
// UPDATE … FROM unnest() round-trip instead of one UPDATE per row.
// Falls back to individual saves when the batch size is 1.
func (v *Verifier) SaveCompanyResultBatch(ctx context.Context, rows []CompanyVerifyRow) error {
	if v.DB == nil || v.DryRun || len(rows) == 0 {
		return nil
	}
	if len(rows) == 1 {
		return v.SaveCompanyResult(ctx, rows[0].ID, rows[0].Status, rows[0].Result)
	}

	ids := make([]int64, len(rows))
	statuses := make([]string, len(rows))
	jsons := make([][]byte, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
		statuses[i] = string(r.Status)
		b, err := json.Marshal(r.Result)
		if err != nil {
			return fmt.Errorf("marshal row %d: %w", r.ID, err)
		}
		jsons[i] = b
	}

	// Build the jsonb array literal manually so we can use unnest.
	// PostgreSQL $3 = ARRAY['{"syntax_valid":true,...}'::jsonb, ...]
	jsonStrs := make([]string, len(jsons))
	for i, b := range jsons {
		jsonStrs[i] = string(b)
	}

	_, err := v.DB.ExecContext(ctx, `
		UPDATE companies c
		SET email_status      = v.status,
		    email_verification = v.result::jsonb,
		    email_verified_at  = now()
		FROM (
		    SELECT
		        unnest($1::bigint[])  AS id,
		        unnest($2::text[])    AS status,
		        unnest($3::text[])    AS result
		) v
		WHERE c.id = v.id`,
		pqArray(ids), pqArray(statuses), pqArray(jsonStrs))
	return err
}

// pqArray converts a Go slice to a PostgreSQL array literal string
// accepted by lib/pq and pgx as a text-protocol array parameter.
func pqArray[T int64 | string](s []T) string {
	if len(s) == 0 {
		return "{}"
	}
	var sb strings.Builder
	sb.WriteByte('{')
	for i, v := range s {
		if i > 0 {
			sb.WriteByte(',')
		}
		formatted := fmt.Sprintf("%v", v)
		// Quote strings that may contain special chars
		switch any(v).(type) {
		case string:
			sb.WriteByte('"')
			sb.WriteString(strings.ReplaceAll(formatted, `"`, `\"`))
			sb.WriteByte('"')
		default:
			sb.WriteString(formatted)
		}
	}
	sb.WriteByte('}')
	return sb.String()
}

func isDangerousRole(local string) bool {
	for _, role := range dangerousRoles {
		if local == role {
			return true
		}
	}
	return false
}

func nullString(s string) sql.NullString {
	if s == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: s, Valid: true}
}

func nullBool(b *bool) sql.NullBool {
	if b == nil {
		return sql.NullBool{}
	}
	return sql.NullBool{Bool: *b, Valid: true}
}
