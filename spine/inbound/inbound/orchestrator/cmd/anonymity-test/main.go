// Package main — anonymity-test CLI (Sprint S1)
//
// Dispatches 36 directed e-mails (4 senders × 3 receivers × 3 templates,
// self-skip) through the full sender.Engine + anti-trace-relay pipeline.
//
// # Engine routing (anti-bypass, CAD-M3)
//
// The previous implementation constructed sender.AntiTraceClient directly and
// bypassed 25 of 42 production gates documented in
// docs/subsystem-maps/anti-trace.md (G0-G12). This version routes through
// sender.Engine.WithAntiTrace().Run() — the identical path taken by the
// production campaign runner (see buildSendEngine in
// services/orchestrator/cmd/outreach/main.go:3008).
//
// # Subject-marker pairing (issue #552)
//
// Anti-trace-relay strips fingerprinting X-* headers at T2/D5. The previous
// X-Test-Run-ID header contract was not reliably preserved through the full
// relay pipeline. New approach: prepend "[A:<short>]" (first 8 hex chars of
// run_id after removing hyphens) to the rendered Subject before Enqueue. The
// harvest side parses this prefix from the delivered Subject — Subject is
// preserved verbatim by all relay layers and is unambiguous when test runs use
// unique run-ids (each run generates a fresh UUID v4).
//
// The short prefix is derived deterministically from run_id:
//
//	shortID(run_id) = run_id[0:8] with hyphens removed, first 8 hex chars
//
// Example Subject: "[A:1a2b3c4d] Váš stroj je připraven"
//
// # Usage
//
//	anonymity-test [flags]
//
//	--run-id=<uuid>            default: random UUID v4
//	--mailbox-ids=1,3,631,632  comma-separated outreach_mailboxes.id values
//	--templates=intro_machinery  template name (followups removed 2026-05-07)
//	--spacing-seconds=5        retained for CLI compat; Engine uses humanSendDelay
//	--dry-run                  plan only, no sends issued
//	--timeout-seconds=300      maximum seconds to wait for queue to drain
package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"campaigns/content"
	"campaigns/sender"
	"common/config"
	"common/db"
	"common/envconfig"
	"mailboxes/mailbox"
)

// TestRunHeader is retained for backward compatibility with any external
// tooling that reads raw request payloads before relay delivery. The header
// is injected into SendRequest.Headers but may be stripped by the relay
// privacy pipeline (T2/D5). Pairing on the harvest side uses Subject-marker
// instead — see injectSubjectMarker (issue #552 fix).
const TestRunHeader = "X-Test-Run-ID"

// subjectMarkerLen is the number of hex characters from the run_id (hyphens
// stripped) forming the "[A:<short>]" subject prefix. 8 chars = 32 bits of
// entropy — unique per run at the 36-send scale.
const subjectMarkerLen = 8

// DBMailbox holds the columns we need from outreach_mailboxes.
type DBMailbox struct {
	ID          int64
	FromAddress string
	SMTPHost    string
	SMTPPort    int
	Password    string
	Status      string
}

// Pair is one (sender, receiver, template) triple.
type Pair struct {
	Sender   DBMailbox
	Receiver DBMailbox
	Template string
}

// PairResult records the outcome of a single dispatch.
type PairResult struct {
	Pair  Pair
	Sent  bool
	Err   error
	MsgID string
}

// subjectShortID extracts the first subjectMarkerLen hex characters from a
// UUID v4 run_id (hyphens stripped) to form the "[A:<short>]" subject prefix.
//
// Example:
//
//	"1a2b3c4d-5e6f-4..." → "1a2b3c4d"
func subjectShortID(runID string) string {
	clean := strings.ReplaceAll(runID, "-", "")
	if len(clean) >= subjectMarkerLen {
		return clean[:subjectMarkerLen]
	}
	return clean
}

// injectSubjectMarker prepends "[A:<short>] " to a subject string.
// The prefix is unambiguous when test runs use unique run-ids.
func injectSubjectMarker(subject, runID string) string {
	return "[A:" + subjectShortID(runID) + "] " + subject
}

// parseSubjectMarker extracts the short run-id prefix from a subject that
// begins with "[A:<short>] ". Returns ("", false) when the subject has no
// marker or the marker is malformed. Used by cmd/anonymity-harvest.
func parseSubjectMarker(subject string) (short string, ok bool) {
	if !strings.HasPrefix(subject, "[A:") {
		return "", false
	}
	rest := subject[3:] // skip "[A:"
	end := strings.Index(rest, "]")
	if end < 0 {
		return "", false
	}
	return rest[:end], true
}

func main() {
	var (
		runID          string
		mailboxIDsStr           string
		templatesStr            string
		spacingSec              int
		dryRun                  bool
		templatesDir            string
		timeoutSeconds          int
		allowPlaceholderPasswd  bool
	)

	flag.StringVar(&runID, "run-id", "", "UUID for this test run (default: random UUID v4)")
	flag.StringVar(&mailboxIDsStr, "mailbox-ids", "1,3,631,632", "comma-separated outreach_mailboxes.id values")
	flag.StringVar(&templatesStr, "templates", "intro_machinery", "comma-separated template names")
	flag.IntVar(&spacingSec, "spacing-seconds", 5, "seconds to sleep between dispatches (not used in Engine mode)")
	flag.BoolVar(&dryRun, "dry-run", false, "plan only, do not send")
	flag.StringVar(&templatesDir, "templates-dir", "", "override template directory (default: TEMPLATES_DIR env or configs/templates)")
	flag.IntVar(&timeoutSeconds, "timeout-seconds", 300, "maximum seconds to wait for queue to drain")
	flag.BoolVar(&allowPlaceholderPasswd, "allow-placeholder-password", false, "skip the IsPlaceholderPassword pre-flight gate (use only when test passwords legitimately match the placeholder heuristic, e.g. repeated trigram patterns)")
	flag.Parse()

	_ = spacingSec // retained for CLI compatibility; Engine uses humanSendDelay internally

	// Resolve run-id.
	if runID == "" {
		var err error
		runID, err = generateUUIDv4()
		if err != nil {
			slog.Error("failed to generate run-id", "op", "anonymity-test.main/uuid", "error", err)
			os.Exit(1)
		}
	}

	// Parse mailbox IDs.
	mailboxIDs := parseIntList(mailboxIDsStr)
	if len(mailboxIDs) == 0 {
		slog.Error("no mailbox IDs specified", "op", "anonymity-test.main/flags")
		os.Exit(1)
	}

	// Parse template names.
	templates := parseStringList(templatesStr)
	if len(templates) == 0 {
		slog.Error("no templates specified", "op", "anonymity-test.main/flags")
		os.Exit(1)
	}

	// Template directory.
	if templatesDir == "" {
		templatesDir = envconfig.GetOr("TEMPLATES_DIR", "configs/templates")
	}

	// DB connection.
	dsn := envconfig.GetOr("DATABASE_URL", "")
	if dsn == "" {
		slog.Error("DATABASE_URL not set", "op", "anonymity-test.main/db")
		os.Exit(1)
	}
	database, err := db.Connect(dsn)
	if err != nil {
		slog.Error("DB connect failed", "op", "anonymity-test.main/db", "error", err)
		os.Exit(1)
	}
	defer database.Close()

	ctx := context.Background()

	// Load mailboxes.
	mailboxes, loadErr := loadMailboxes(ctx, database, mailboxIDs)
	if loadErr != nil {
		slog.Error("load mailboxes failed", "op", "anonymity-test.main/loadMailboxes", "error", loadErr)
		os.Exit(1)
	}

	// Validate mailboxes.
	if valErr := validateMailboxes(mailboxes, mailboxIDs, allowPlaceholderPasswd); valErr != nil {
		slog.Error("mailbox validation failed", "op", "anonymity-test.main/validateMailboxes", "error", valErr)
		os.Exit(1)
	}

	// Build pair list.
	pairs := buildPairs(mailboxes, templates)
	if len(pairs) == 0 {
		fmt.Printf("[anon-test] run=%s no pairs to dispatch\n", runID)
		os.Exit(0)
	}

	if dryRun {
		fmt.Printf("[anon-test] DRY-RUN run=%s — %d pairs planned (subject_prefix=[A:%s]):\n",
			runID, len(pairs), subjectShortID(runID))
		for i, p := range pairs {
			fmt.Printf("  [%02d] %s -> %s tmpl=%s\n", i+1, p.Sender.FromAddress, p.Receiver.FromAddress, p.Template)
		}
		os.Exit(0)
	}

	// Build anti-trace config.
	cfg := config.LoadFromEnv()
	if !cfg.AntiTrace.Enabled {
		slog.Error("ANTI_TRACE_URL not configured — anti-trace relay required",
			"op", "anonymity-test.main/antiTrace")
		os.Exit(1)
	}

	// Convert DBMailbox slice to config.MailboxConfig slice for Engine.
	// DailyLimit=100 provides a generous permissive cap for test mode.
	cfgMailboxes := make([]config.MailboxConfig, len(mailboxes))
	for i, mb := range mailboxes {
		cfgMailboxes[i] = config.MailboxConfig{
			Address:    mb.FromAddress,
			SMTPHost:   mb.SMTPHost,
			SMTPPort:   mb.SMTPPort,
			Username:   mb.FromAddress,
			Password:   mb.Password,
			DailyLimit: 100,
		}
	}

	// Synthetic SendingConfig: permissive send window (0-23), fast pacing for tests.
	// MaxPerDomainHour=1000 because Engine.allowDomain treats 0 literally
	// (returns counts<0=false), not as unlimited. 1000 covers any test matrix.
	testSending := config.SendingConfig{
		WindowStart:      0,
		WindowEnd:        23,
		Timezone:         "UTC",
		MinDelaySeconds:  1,
		MaxDelaySeconds:  2,
		MaxPerDomainHour: 1000,
	}

	testSafety := config.SafetyConfig{
		MaxBounceRate:    1.0,  // permissive
		MaxComplaints24h: 1000, // permissive
	}

	// Build Engine following buildSendEngine pattern from main.go:3008.
	// engine-bypass-allowed: test-mode Engine construction — AntiTraceClient is
	// passed straight to Engine.WithAntiTrace; never invoked directly.
	// Documented in docs/subsystem-maps/anti-trace.md G10.
	antiTraceClient := sender.NewAntiTraceClient(cfg.AntiTrace.URL, cfg.AntiTrace.Token)
	engine := sender.NewEngine(cfgMailboxes, testSending, testSafety).
		WithAntiTrace(antiTraceClient)
	// Skip warmup limiter and DailyCapFunc: static DailyLimit=100 is sufficient.
	// Skip MailboxRegistry: test runs are ephemeral.

	// Content engine.
	contentEngine := content.NewEngine(templatesDir, nil)

	// Phase 1: render all pairs and enqueue to engine.
	// Track per-pair enqueue state so we know the expected dispatch count.
	enqueuedCount := 0
	for i, p := range pairs {
		contactID := deterministicContactID(runID, i)
		vars := content.TemplateVars{
			Firma:    "Test Recipient",
			UnsubURL: "https://example.com/unsubscribe",
		}

		rendered, renderErr := contentEngine.Render(p.Template, vars, contactID, 1)
		if renderErr != nil {
			slog.Error("render failed",
				"op", "anonymity-test.main/render",
				"template", p.Template,
				"sender", p.Sender.FromAddress,
				"receiver", p.Receiver.FromAddress,
				"error", renderErr)
			fmt.Printf("[anon-test] run=%s pair=%s->%s tmpl=%s render_err=%v\n",
				runID, p.Sender.FromAddress, p.Receiver.FromAddress, p.Template, renderErr)
			continue
		}

		// Inject Subject-marker for harvest-side pairing (issue #552 fix).
		// Subject is preserved verbatim through T2 SanitizeIntake, metamin
		// padding/encryption (T4-T8), drain unpadding (D3), and BuildMessage (D6).
		// Header-based pairing (X-Test-Run-ID) is unreliable: T2/D5 strip X-*
		// fingerprinting headers.
		markedSubject := injectSubjectMarker(rendered.Subject, runID)

		headers := make(map[string]string, len(rendered.Headers)+1)
		for k, v := range rendered.Headers {
			headers[k] = v
		}
		// Retain legacy header for tooling that reads pre-relay payloads.
		headers[TestRunHeader] = runID

		req := sender.SendRequest{
			CampaignID:   0, // sentinel: not part of a campaign
			ContactID:    contactID,
			Step:         1,
			ToAddress:    p.Receiver.FromAddress,
			Subject:      markedSubject,
			BodyPlain:    rendered.BodyPlain,
			BodyHTML:     rendered.BodyHTML,
			Headers:      headers,
			SkipHumanize: rendered.SkipHumanize,
			// SMTP credentials from SENDER mailbox for Engine.pickMailbox auth.
			SMTPHost:     p.Sender.SMTPHost,
			SMTPPort:     p.Sender.SMTPPort,
			SMTPUsername: p.Sender.FromAddress,
			SMTPPassword: p.Sender.Password,
		}

		engine.Enqueue(req)
		enqueuedCount++
	}

	if enqueuedCount == 0 {
		fmt.Printf("[anon-test] run=%s no pairs enqueued (all renders failed)\n", runID)
		os.Exit(1)
	}

	fmt.Printf("[anon-test] run=%s enqueued=%d subject_prefix=[A:%s]\n",
		runID, enqueuedCount, subjectShortID(runID))

	// Phase 2: run Engine until all enqueued sends complete or timeout.
	// Engine.Run blocks until ctx is cancelled; we cancel when the last
	// send completes via onSent callback.
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	var (
		mu       sync.Mutex
		results  []PairResult
		doneOnce sync.Once
	)

	// checkDone cancels the engine context once all expected sends are collected.
	checkDone := func() {
		mu.Lock()
		n := len(results)
		mu.Unlock()
		if n >= enqueuedCount {
			doneOnce.Do(cancel)
		}
	}

	onSent := func(req sender.SendRequest, result sender.SendResult) {
		pairStr := req.SMTPUsername + "->" + req.ToAddress
		mu.Lock()
		if result.Error != nil {
			results = append(results, PairResult{
				Pair: Pair{
					Sender:   DBMailbox{FromAddress: req.SMTPUsername},
					Receiver: DBMailbox{FromAddress: req.ToAddress},
					Template: req.Subject,
				},
				Err: result.Error,
			})
			mu.Unlock()
			slog.Error("[anon-test] send failed",
				"op", "anonymity-test.onSent/error",
				"run", runID,
				"pair", pairStr,
				"error", result.Error)
			fmt.Printf("[anon-test] run=%s pair=%s err=%v\n", runID, pairStr, result.Error)
		} else {
			results = append(results, PairResult{
				Pair: Pair{
					Sender:   DBMailbox{FromAddress: req.SMTPUsername},
					Receiver: DBMailbox{FromAddress: req.ToAddress},
					Template: req.Subject,
				},
				Sent:  true,
				MsgID: result.MessageID,
			})
			mu.Unlock()
			fmt.Printf("[anon-test] run=%s pair=%s ok msgid=%s\n", runID, pairStr, result.MessageID)
		}
		checkDone()
	}

	// Engine.Run blocks; run it directly. Context cancel (via onSent or timeout)
	// terminates the loop.
	if err := engine.Run(runCtx, onSent); err != nil && runCtx.Err() == nil {
		slog.Error("engine.Run terminated unexpectedly",
			"op", "anonymity-test.main/engineRun",
			"run", runID,
			"error", err)
	}

	// Persist send_events rows (best-effort).
	mu.Lock()
	finalResults := make([]PairResult, len(results))
	copy(finalResults, results)
	mu.Unlock()
	persistResults(ctx, database, runID, finalResults)

	// Summary.
	sent, errs := 0, 0
	for _, r := range finalResults {
		if r.Sent {
			sent++
		} else {
			errs++
		}
	}
	fmt.Printf("[anon-test] run=%s DONE: enqueued=%d sent=%d errors=%d\n",
		runID, enqueuedCount, sent, errs)
	if errs > 0 {
		os.Exit(1)
	}
}

// loadMailboxes fetches the requested mailboxes from the DB.
func loadMailboxes(ctx context.Context, database *sql.DB, ids []int64) ([]DBMailbox, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
		args[i] = id
	}
	query := fmt.Sprintf(
		`SELECT id, from_address, smtp_host, smtp_port, COALESCE(password,''), status
		 FROM outreach_mailboxes WHERE id IN (%s) AND environment = 'production' -- AP5: production boundary`,
		strings.Join(placeholders, ","),
	)
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query mailboxes: %w", err)
	}
	defer rows.Close()

	var out []DBMailbox
	for rows.Next() {
		var mb DBMailbox
		if err := rows.Scan(&mb.ID, &mb.FromAddress, &mb.SMTPHost, &mb.SMTPPort, &mb.Password, &mb.Status); err != nil {
			return nil, fmt.Errorf("scan mailbox: %w", err)
		}
		out = append(out, mb)
	}
	return out, rows.Err()
}

// validateMailboxes checks that all requested IDs were found and are active
// with a non-placeholder password. Returns an error on the first failure.
//
// allowPlaceholder=true skips the IsPlaceholderPassword gate. Operators
// flip this when test mailbox passwords legitimately match the placeholder
// heuristic (e.g. operator-set "123o123o123" — a repeated-trigram pattern
// that the heuristic catches). Production campaign code must never set it.
func validateMailboxes(mailboxes []DBMailbox, requestedIDs []int64, allowPlaceholder bool) error {
	found := make(map[int64]DBMailbox, len(mailboxes))
	for _, mb := range mailboxes {
		found[mb.ID] = mb
	}
	for _, id := range requestedIDs {
		mb, ok := found[id]
		if !ok {
			return fmt.Errorf("mailbox id=%d not found in DB", id)
		}
		if mb.Status != "active" {
			return fmt.Errorf("mailbox id=%d (%s) status=%q is not 'active'", id, mb.FromAddress, mb.Status)
		}
		if !allowPlaceholder && mailbox.IsPlaceholderPassword(mb.Password) {
			return fmt.Errorf("mailbox id=%d (%s) has a placeholder/empty password (use --allow-placeholder-password to override for diagnostic runs)", id, mb.FromAddress)
		}
	}
	return nil
}

// buildPairs creates the cross-product (sender, receiver, template) with
// self-skip (sender.FromAddress == receiver.FromAddress is excluded).
func buildPairs(mailboxes []DBMailbox, templates []string) []Pair {
	var pairs []Pair
	for _, s := range mailboxes {
		for _, r := range mailboxes {
			if mailbox.NormaliseAddress(s.FromAddress) == mailbox.NormaliseAddress(r.FromAddress) {
				continue
			}
			for _, t := range templates {
				pairs = append(pairs, Pair{Sender: s, Receiver: r, Template: t})
			}
		}
	}
	return pairs
}

// persistResults inserts send_events rows for all successful sends.
// Failures are logged but do not abort the run (requirement 10).
func persistResults(ctx context.Context, database *sql.DB, runID string, results []PairResult) {
	for _, r := range results {
		if !r.Sent {
			continue
		}

		meta, _ := json.Marshal(map[string]string{
			"test_run": runID,
			"pair":     fmt.Sprintf("%s->%s", r.Pair.Sender.FromAddress, r.Pair.Receiver.FromAddress),
			"template": r.Pair.Template,
		})

		_, err := database.ExecContext(ctx,
			`INSERT INTO send_events
			  (campaign_id, contact_id, step, mailbox_used, message_id, subject, status, sent_at, test_run_id)
			 SELECT
			   (SELECT id FROM campaigns WHERE name ILIKE '%INTERNAL TEST%' ORDER BY id LIMIT 1),
			   (SELECT id FROM contacts WHERE email = $1 ORDER BY id LIMIT 1),
			   1,
			   $2,
			   $3,
			   $4,
			   'sent',
			   now(),
			   $5::uuid
			 WHERE (SELECT id FROM campaigns WHERE name ILIKE '%INTERNAL TEST%' LIMIT 1) IS NOT NULL
			   AND (SELECT id FROM contacts WHERE email = $1 LIMIT 1) IS NOT NULL`,
			r.Pair.Receiver.FromAddress, // $1
			r.Pair.Sender.FromAddress,   // $2 mailbox_used
			r.MsgID,                     // $3 message_id
			r.Pair.Template,             // $4 subject (template name as placeholder)
			runID,                       // $5 test_run_id
		)
		if err != nil {
			slog.Error("send_events insert failed",
				"op", "anonymity-test.persistResults/insert",
				"run", runID,
				"pair", string(meta),
				"error", err)
		}
	}
}

// parseIntList splits a comma-separated list of integers.
func parseIntList(s string) []int64 {
	var out []int64
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		n, err := strconv.ParseInt(part, 10, 64)
		if err != nil {
			continue
		}
		out = append(out, n)
	}
	return out
}

// parseStringList splits a comma-separated list of non-empty strings.
func parseStringList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

// deterministicContactID derives a stable int64 contact ID from the run UUID
// and an index. This gives each render a unique but reproducible seed so the
// content engine produces the same variant when re-run with the same --run-id.
func deterministicContactID(runID string, idx int) int64 {
	const fnvOffset uint64 = 14695981039346656037
	const fnvPrime uint64 = 1099511628211
	h := fnvOffset
	for _, b := range []byte(runID) {
		h ^= uint64(b)
		h *= fnvPrime
	}
	h ^= uint64(idx)
	h *= fnvPrime
	result := int64(h & 0x7FFFFFFFFFFFFFFF)
	if result == 0 {
		result = 1
	}
	return result
}

// generateUUIDv4 generates a random UUID v4 using crypto/rand.
// Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
func generateUUIDv4() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("crypto/rand read: %w", err)
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16]), nil
}

// isValidUUIDv4 validates UUID v4 format for testing.
func isValidUUIDv4(s string) bool {
	parts := strings.Split(s, "-")
	if len(parts) != 5 {
		return false
	}
	lens := []int{8, 4, 4, 4, 12}
	for i, p := range parts {
		if len(p) != lens[i] {
			return false
		}
		for _, c := range p {
			if !isHex(c) {
				return false
			}
		}
	}
	return len(parts[2]) >= 1 && parts[2][0] == '4'
}

func isHex(c rune) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

