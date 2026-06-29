package mailbox

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// DB abstracts *sql.DB for testability (kept compatible with contact.Store
// and the rest of the repository interfaces used in this service).
type DB interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// PGStore is the Postgres-backed implementation of Store, reading/writing
// outreach_mailboxes (migration 035). All mutations rely on the
// trg_outreach_mailboxes_updated_at trigger for updated_at, not Go-side time
// manipulation — keeps updated_at authoritative on the database.
type PGStore struct {
	db DB
}

// NewPGStore constructs a new Postgres-backed mailbox store.
func NewPGStore(db DB) *PGStore {
	return &PGStore{db: db}
}

// S5 phase 3 (mailbox encryption decrypt) is deferred to a separate PR
// after S2 first-send retro because:
//   - changing this read path requires modifying every List/Get/GetByAddress
//     caller to pass the secret as an additional parameter (high blast radius)
//   - production verification requires send-test against live mailboxes
//     with feature flag toggled (operator coordination)
//   - rollback needs careful staging if a query is missed
//
// Migration scripts 003+004 (add column, populate encrypted) are ready
// without this code change. Operator can run them anytime; reads still
// resolve from plaintext until phase 3 PR lands. See
// docs/playbooks/S5-mailbox-encryption.md for full rollout.
// mailboxColumns is the canonical SELECT projection for outreach_mailboxes
// rows. Every nullable column is wrapped in COALESCE so the Go-side Scan
// target can stay a plain string / int. Without this defense, a single NULL
// in tz / locale (e.g. a row inserted via the dashboard before defaults were
// applied, or a brand-new mailbox UPSERTed with empty config) crashes
// ActiveAddresses() with `converting NULL to string is unsupported` and the
// sender falls through to config-only mode — which means zero sends in
// production when only DB-only mailboxes are configured (incident 2026-05-13).
//
// The integer counter columns (consecutive_bounces, total_sent, total_bounced)
// are also COALESCEd to 0. A fresh row whose counters were left NULL by a
// dashboard insert path that forgot to default them would otherwise crash
// Scan with `converting NULL to int is unsupported`, taking down the entire
// List call — and OverlayRegistry with it. The 2026-05-13 incident's second
// failure mode was exactly this: NULL consecutive_bounces (column index 15)
// poisoned both ActiveAddresses AND OverlayRegistry at boot, leaving
// cfg.Mailboxes empty and the strict-mode sender refusing every send. See
// fix(engine) PR for the full RCA.
const mailboxColumns = `id, from_address, display_name,
    smtp_host, smtp_port, COALESCE(smtp_username, ''),
    COALESCE(imap_host, ''), COALESCE(imap_port, 0), COALESCE(imap_username, ''),
    daily_cap_override, COALESCE(tz, ''), COALESCE(locale, ''),
    status, COALESCE(status_reason, ''),
    last_send_at,
    COALESCE(consecutive_bounces, 0),
    COALESCE(total_sent, 0),
    COALESCE(total_bounced, 0),
    created_at, updated_at, COALESCE(password, ''), COALESCE(proxy_url, ''),
    COALESCE(environment, 'production'),
    COALESCE(preferred_country, ''),
    COALESCE(lifecycle_phase, 'warmup_d0')`

// List returns mailboxes matching the filter. An empty filter (after
// ApplyDefault) returns up to 100 mailboxes ordered by from_address.
func (s *PGStore) List(ctx context.Context, filter Filter) ([]Mailbox, error) {
	filter = filter.ApplyDefault()

	var (
		conds []string
		args  []any
		idx   = 1
	)

	if len(filter.Status) > 0 {
		placeholders := make([]string, len(filter.Status))
		for i, st := range filter.Status {
			placeholders[i] = fmt.Sprintf("$%d", idx)
			args = append(args, string(st))
			idx++
		}
		conds = append(conds, "status IN ("+strings.Join(placeholders, ",")+")")
	}
	if filter.Environment != "" {
		conds = append(conds, fmt.Sprintf("environment = $%d", idx))
		args = append(args, filter.Environment)
		idx++
	}

	where := ""
	if len(conds) > 0 {
		where = "WHERE " + strings.Join(conds, " AND ")
	}

	query := fmt.Sprintf(
		"SELECT %s FROM outreach_mailboxes %s ORDER BY from_address LIMIT $%d",
		mailboxColumns, where, idx,
	)
	args = append(args, filter.Limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Mailbox
	for rows.Next() {
		m, err := scanMailboxRows(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Get returns the mailbox with the given id. Returns ErrMailboxNotFound if
// the row does not exist.
func (s *PGStore) Get(ctx context.Context, id int64) (Mailbox, error) {
	row := s.db.QueryRowContext(ctx, fmt.Sprintf(
		"SELECT %s FROM outreach_mailboxes WHERE id = $1", mailboxColumns,
	), id)
	return scanMailboxRow(row)
}

// GetByAddress returns the mailbox for the given from_address. The address
// is normalised (lower-cased, trimmed) before lookup.
func (s *PGStore) GetByAddress(ctx context.Context, fromAddress string) (Mailbox, error) {
	addr := NormaliseAddress(fromAddress)
	if addr == "" {
		return Mailbox{}, errors.New("mailbox: empty from_address")
	}
	row := s.db.QueryRowContext(ctx, fmt.Sprintf(
		"SELECT %s FROM outreach_mailboxes WHERE from_address = $1", mailboxColumns,
	), addr)
	return scanMailboxRow(row)
}

// UpsertFromConfig inserts a new mailbox or updates the configuration-owned
// fields (display, SMTP/IMAP, tz, locale, daily cap override).
// Counter and lifecycle fields (status, bounces, last_send_at, total_*) are
// NOT touched — those are managed by the send / bounce pipelines and the
// cockpit. This keeps "reload config" idempotent and safe.
func (s *PGStore) UpsertFromConfig(ctx context.Context, m Mailbox) (Mailbox, error) {
	m.FromAddress = NormaliseAddress(m.FromAddress)
	if err := m.Validate(); err != nil {
		return Mailbox{}, err
	}

	var imapHost, imapUser any
	if m.IMAPHost != "" {
		imapHost = m.IMAPHost
	}
	if m.IMAPUsername != "" {
		imapUser = m.IMAPUsername
	}
	var imapPort any
	if m.IMAPPort != 0 {
		imapPort = m.IMAPPort
	}
	var smtpUser any
	if m.SMTPUsername != "" {
		smtpUser = m.SMTPUsername
	}

	row := s.db.QueryRowContext(ctx, fmt.Sprintf(`
		INSERT INTO outreach_mailboxes (
			from_address, display_name,
			smtp_host, smtp_port, smtp_username,
			imap_host, imap_port, imap_username,
			daily_cap_override, tz, locale, status, status_reason
		)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT (from_address) DO UPDATE SET
			display_name       = EXCLUDED.display_name,
			smtp_host          = EXCLUDED.smtp_host,
			smtp_port          = EXCLUDED.smtp_port,
			smtp_username      = EXCLUDED.smtp_username,
			imap_host          = EXCLUDED.imap_host,
			imap_port          = EXCLUDED.imap_port,
			imap_username      = EXCLUDED.imap_username,
			daily_cap_override = EXCLUDED.daily_cap_override,
			tz                 = EXCLUDED.tz,
			locale             = EXCLUDED.locale
		RETURNING %s`, mailboxColumns),
		m.FromAddress, m.DisplayName,
		m.SMTPHost, m.SMTPPort, smtpUser,
		imapHost, imapPort, imapUser,
		m.DailyCapOverride, m.TZ, m.Locale, string(m.Status), nullableString(m.StatusReason),
	)
	return scanMailboxRow(row)
}

// UpdateStatus moves the mailbox into a new lifecycle state. The reason is
// free-form text surfaced in the cockpit dashboard and audit log.
func (s *PGStore) UpdateStatus(ctx context.Context, id int64, status Status, reason string) (Mailbox, error) {
	if !status.Valid() {
		return Mailbox{}, fmt.Errorf("mailbox: unknown Status %q", status)
	}
	row := s.db.QueryRowContext(ctx, fmt.Sprintf(`
		UPDATE outreach_mailboxes
		SET status = $1, status_reason = $2
		WHERE id = $3
		RETURNING %s`, mailboxColumns),
		string(status), nullableString(reason), id,
	)
	return scanMailboxRow(row)
}

// TouchLastSend records a successful send. Also increments total_sent and
// resets consecutive_bounces — a send that made it through proves the
// mailbox is healthy again. Callers invoke this from the send pipeline.
func (s *PGStore) TouchLastSend(ctx context.Context, id int64, sentAt time.Time) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE outreach_mailboxes
		SET last_send_at        = $1,
		    total_sent          = COALESCE(total_sent, 0) + 1,
		    consecutive_bounces = 0
		WHERE id = $2`, sentAt, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrMailboxNotFound
	}
	return nil
}

// IncrementBounce records a bounce against the mailbox and returns the
// updated row so callers can decide whether ShouldAutoHold() fires.
func (s *PGStore) IncrementBounce(ctx context.Context, id int64) (Mailbox, error) {
	row := s.db.QueryRowContext(ctx, fmt.Sprintf(`
		UPDATE outreach_mailboxes
		SET consecutive_bounces = consecutive_bounces + 1,
		    total_bounced       = total_bounced + 1
		WHERE id = $1
		RETURNING %s`, mailboxColumns), id,
	)
	return scanMailboxRow(row)
}

// Create inserts a new mailbox from dashboard input. Fails with a
// duplicate-key error if from_address already exists (unlike
// UpsertFromConfig, which is idempotent).
func (s *PGStore) Create(ctx context.Context, m Mailbox) (Mailbox, error) {
	m.FromAddress = NormaliseAddress(m.FromAddress)
	if m.Status == "" {
		m.Status = StatusActive
	}
	if err := m.Validate(); err != nil {
		return Mailbox{}, err
	}

	var imapHost, imapUser, imapPort, smtpUser any
	if m.IMAPHost != "" {
		imapHost = m.IMAPHost
	}
	if m.IMAPUsername != "" {
		imapUser = m.IMAPUsername
	}
	if m.IMAPPort != 0 {
		imapPort = m.IMAPPort
	}
	if m.SMTPUsername != "" {
		smtpUser = m.SMTPUsername
	}

	row := s.db.QueryRowContext(ctx, fmt.Sprintf(`
		INSERT INTO outreach_mailboxes (
			from_address, display_name,
			smtp_host, smtp_port, smtp_username,
			imap_host, imap_port, imap_username,
			daily_cap_override, tz, locale, status, status_reason, password, proxy_url
		)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
		RETURNING %s`, mailboxColumns),
		m.FromAddress, m.DisplayName,
		m.SMTPHost, m.SMTPPort, smtpUser,
		imapHost, imapPort, imapUser,
		m.DailyCapOverride, m.TZ, m.Locale, string(m.Status), nullableString(m.StatusReason),
		nullableString(m.Password), nullableString(m.ProxyURL),
	)
	return scanMailboxRow(row)
}

// Update modifies configuration-owned fields from dashboard input.
// Leaves counters, status lifecycle and bounce stats untouched. An empty
// password is treated as "no change" (keep existing value) so form
// submits that omit the field don't wipe the credential.
func (s *PGStore) Update(ctx context.Context, id int64, m Mailbox) (Mailbox, error) {
	m.FromAddress = NormaliseAddress(m.FromAddress)
	if err := m.Validate(); err != nil {
		return Mailbox{}, err
	}

	var imapHost, imapUser, imapPort, smtpUser any
	if m.IMAPHost != "" {
		imapHost = m.IMAPHost
	}
	if m.IMAPUsername != "" {
		imapUser = m.IMAPUsername
	}
	if m.IMAPPort != 0 {
		imapPort = m.IMAPPort
	}
	if m.SMTPUsername != "" {
		smtpUser = m.SMTPUsername
	}

	row := s.db.QueryRowContext(ctx, fmt.Sprintf(`
		UPDATE outreach_mailboxes SET
			from_address       = $1,
			display_name       = $2,
			smtp_host          = $3,
			smtp_port          = $4,
			smtp_username      = $5,
			imap_host          = $6,
			imap_port          = $7,
			imap_username      = $8,
			daily_cap_override = $9,
			tz                 = $10,
			locale             = $11,
			password           = COALESCE(NULLIF($12, ''), password),
			proxy_url          = NULLIF($13, '')
		WHERE id = $14
		RETURNING %s`, mailboxColumns),
		m.FromAddress, m.DisplayName,
		m.SMTPHost, m.SMTPPort, smtpUser,
		imapHost, imapPort, imapUser,
		m.DailyCapOverride, m.TZ, m.Locale,
		m.Password, m.ProxyURL, id,
	)
	return scanMailboxRow(row)
}

// Delete removes the mailbox row. Fails with an FK error if an active
// campaign still references it.
func (s *PGStore) Delete(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM outreach_mailboxes WHERE id = $1`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrMailboxNotFound
	}
	return nil
}

// ResetBounce zeroes the consecutive bounce counter (e.g. after operator
// manually clears a bounce_hold).
func (s *PGStore) ResetBounce(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE outreach_mailboxes SET consecutive_bounces = 0 WHERE id = $1`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrMailboxNotFound
	}
	return nil
}

// Compile-time assertion that PGStore satisfies Store.
var _ Store = (*PGStore)(nil)

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanMailboxRow(row *sql.Row) (Mailbox, error) {
	m, err := scanMailbox(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Mailbox{}, ErrMailboxNotFound
	}
	return m, err
}

func scanMailboxRows(rows *sql.Rows) (Mailbox, error) {
	return scanMailbox(rows)
}

func scanMailbox(r rowScanner) (Mailbox, error) {
	var (
		m          Mailbox
		status     string
		dailyCap   sql.NullInt64
		imapPort   sql.NullInt64
		lastSendAt sql.NullTime
	)
	err := r.Scan(
		&m.ID, &m.FromAddress, &m.DisplayName,
		&m.SMTPHost, &m.SMTPPort, &m.SMTPUsername,
		&m.IMAPHost, &imapPort, &m.IMAPUsername,
		&dailyCap, &m.TZ, &m.Locale,
		&status, &m.StatusReason,
		&lastSendAt, &m.ConsecutiveBounces, &m.TotalSent, &m.TotalBounced,
		&m.CreatedAt, &m.UpdatedAt, &m.Password, &m.ProxyURL, &m.Environment,
		&m.PreferredCountry, &m.LifecyclePhase,
	)
	if err != nil {
		return Mailbox{}, err
	}
	m.Status = Status(status)
	if dailyCap.Valid {
		v := int(dailyCap.Int64)
		m.DailyCapOverride = &v
	}
	if imapPort.Valid {
		m.IMAPPort = int(imapPort.Int64)
	}
	if lastSendAt.Valid {
		t := lastSendAt.Time
		m.LastSendAt = &t
	}
	return m, nil
}
