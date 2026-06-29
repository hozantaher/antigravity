package prodlike

import (
	"context"
	cryptorand "crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"time"
)

// ScenarioResult captures per-scenario row counts so the CLI can print
// a summary and tests can assert coverage.
type ScenarioResult struct {
	Name             string
	Campaigns        int
	Threads          int
	Messages         int
	SendEvents       int
	Bounces          int
	Replies          int
	Unsubscribes     int
	Suppressions     int
	HoneypotSignals  int // 3F: rows inserted into outreach_honeypot_signals
	CompaniesUpdated int // 3G: distinct companies mutated by exclusion scenario
}

// AllScenarios returns the scenario set in recommended execution order.
// The order matters — later scenarios may reference contacts created
// by earlier ones (e.g. campaign_completed picks up a slice of the
// prodlike contact pool).
func AllScenarios() []string {
	return []string{
		"campaign_running",
		"campaign_completed",
		"bounce_spiral",
		"replies_classified",
		"unsubscribe_flow",
		"honeypot_coverage",
		"exclusion_cases",
	}
}

// RunScenarios executes the named scenarios against the given database.
// Each scenario reads the current prodlike contact pool via
// `source LIKE 'prodlike-%'` and writes its own derived rows with a
// scenario-suffixed source tag so --clear-prodlike tears them all down
// together.
//
// A nil or empty `names` slice runs nothing — callers who want "all"
// should pass AllScenarios().
func RunScenarios(ctx context.Context, db *sql.DB, names []string) ([]ScenarioResult, error) {
	rng := NewRNG()
	now := time.Now().UTC()

	// Fetch the pool of prodlike contacts once. All scenarios sample
	// from this to avoid double-charging a single contact with two
	// conflicting statuses.
	contactPool, err := loadProdlikeContactPool(ctx, db)
	if err != nil {
		return nil, fmt.Errorf("load contact pool: %w", err)
	}
	if len(contactPool) == 0 {
		return nil, fmt.Errorf("no prodlike contacts found — run `seed --scale=small` first")
	}

	// Shuffle once per run so scenarios slice through the pool
	// deterministically (seeded RNG) but without positional bias.
	rng.Shuffle(len(contactPool), func(i, j int) {
		contactPool[i], contactPool[j] = contactPool[j], contactPool[i]
	})

	var results []ScenarioResult
	cursor := 0

	for _, name := range names {
		var (
			res ScenarioResult
			err error
		)
		switch name {
		case "campaign_running":
			res, err = scenarioCampaignRunning(ctx, db, contactPool, &cursor, rng, now)
		case "campaign_completed":
			res, err = scenarioCampaignCompleted(ctx, db, contactPool, &cursor, rng, now)
		case "bounce_spiral":
			res, err = scenarioBounceSpiral(ctx, db, contactPool, &cursor, rng, now)
		case "replies_classified":
			res, err = scenarioRepliesClassified(ctx, db, contactPool, &cursor, rng, now)
		case "unsubscribe_flow":
			res, err = scenarioUnsubscribeFlow(ctx, db, contactPool, &cursor, rng, now)
		case "honeypot_coverage":
			res, err = scenarioHoneypotCoverage(ctx, db, contactPool, &cursor, rng, now)
		case "exclusion_cases":
			res, err = scenarioExclusionCases(ctx, db, rng, now)
		default:
			return results, fmt.Errorf("unknown scenario %q", name)
		}
		if err != nil {
			return results, fmt.Errorf("scenario %s: %w", name, err)
		}
		res.Name = name
		results = append(results, res)
	}
	return results, nil
}

// ------------------------------------------------------------------
// Scenario A: campaign_running
// ------------------------------------------------------------------
// An active 3-step campaign with 200 enrolled contacts. Threads are
// spread across every state the dashboard filter exposes so each
// segment shows realistic counts without running a live campaign.

func scenarioCampaignRunning(
	ctx context.Context, db *sql.DB, pool []int, cursor *int,
	rng *rand.Rand, now time.Time,
) (ScenarioResult, error) {
	res := ScenarioResult{}
	if *cursor+200 > len(pool) {
		return res, fmt.Errorf("campaign_running needs 200 contacts, have %d", len(pool)-*cursor)
	}
	slice := pool[*cursor : *cursor+200]
	*cursor += 200

	campaignID, err := insertCampaign(ctx, db,
		"Prodlike Running Campaign",
		"running",
		threeStepSequence(),
	)
	if err != nil {
		return res, err
	}
	res.Campaigns = 1

	// State distribution across 200 threads:
	//   50 sent (1 outbound only), 30 replied, 10 bounced,
	//   5 paused, 20 scheduled (next_action_at in future),
	//   85 still new (step 0, just enrolled).
	plan := []struct {
		Status string
		Count  int
	}{
		{"sent", 50},
		{"replied", 30},
		{"bounced", 10},
		{"paused", 5},
		{"scheduled", 20},
		{"new", 85},
	}

	idx := 0
	for _, p := range plan {
		for i := 0; i < p.Count; i++ {
			contactID := slice[idx]
			idx++

			if err := enrollInCampaign(ctx, db, campaignID, contactID, p.Status); err != nil {
				return res, err
			}

			threadID, err := insertThread(ctx, db, contactID, campaignID, p.Status, threadStepFor(p.Status), rng, now)
			if err != nil {
				return res, err
			}
			res.Threads++

			// Emit outbound messages matching the status' implied history.
			switch p.Status {
			case "sent", "scheduled":
				_, err = insertOutbound(ctx, db, threadID, 0, now.Add(-2*24*time.Hour), false)
			case "replied":
				_, err = insertOutbound(ctx, db, threadID, 0, now.Add(-3*24*time.Hour), false)
				if err == nil {
					_, err = insertReplyMessage(ctx, db, threadID, "interested", now.Add(-24*time.Hour))
					if err == nil {
						res.Replies++
					}
				}
			case "bounced":
				mid, e := insertOutbound(ctx, db, threadID, 0, now.Add(-4*24*time.Hour), false)
				err = e
				if err == nil {
					if err = markBounced(ctx, db, threadID, mid, contactID, "hard", "5.1.1", now.Add(-4*24*time.Hour)); err == nil {
						res.Bounces++
					}
				}
			case "paused", "new":
				// No outbound yet — thread is queued.
			}
			if err != nil {
				return res, err
			}
			res.Messages++
		}
	}
	return res, nil
}

// ------------------------------------------------------------------
// Scenario B: campaign_completed
// ------------------------------------------------------------------
// A 14-day-old finished campaign with 100 threads, all final. Provides
// historical volume for analytics pages.

func scenarioCampaignCompleted(
	ctx context.Context, db *sql.DB, pool []int, cursor *int,
	rng *rand.Rand, now time.Time,
) (ScenarioResult, error) {
	res := ScenarioResult{}
	if *cursor+100 > len(pool) {
		return res, fmt.Errorf("campaign_completed needs 100 contacts, have %d", len(pool)-*cursor)
	}
	slice := pool[*cursor : *cursor+100]
	*cursor += 100

	start := now.AddDate(0, 0, -21)
	campaignID, err := insertCampaign(ctx, db,
		"Prodlike Completed Campaign Q1",
		"completed",
		threeStepSequence(),
	)
	if err != nil {
		return res, err
	}
	// Backdate the started_at / completed_at to make it look historical.
	if _, err := db.ExecContext(ctx, `UPDATE campaigns SET started_at=$1, completed_at=$2 WHERE id=$3`,
		start, now.AddDate(0, 0, -7), campaignID); err != nil {
		return res, err
	}
	res.Campaigns = 1

	for i, contactID := range slice {
		if err := enrollInCampaign(ctx, db, campaignID, contactID, "completed"); err != nil {
			return res, err
		}
		threadID, err := insertThread(ctx, db, contactID, campaignID, "completed", 3, rng, start)
		if err != nil {
			return res, err
		}
		res.Threads++

		// Three outbound messages spaced by the step delays.
		for step := 0; step < 3; step++ {
			when := start.AddDate(0, 0, step*5)
			mid, err := insertOutbound(ctx, db, threadID, step, when, step > 0)
			if err != nil {
				return res, err
			}
			res.Messages++
			// Mark half of the first-step messages as opened.
			if step == 0 && i%2 == 0 {
				if _, err := db.ExecContext(ctx,
					`UPDATE outreach_messages SET opened_at=$1 WHERE id=$2`,
					when.Add(8*time.Hour), mid,
				); err != nil {
					return res, err
				}
			}
			res.SendEvents++
		}
	}
	return res, nil
}

// ------------------------------------------------------------------
// Scenario C: bounce_spiral
// ------------------------------------------------------------------
// Targets a single domain with 50 contacts, 35 hard + 5 soft bounces.
// Generated bounce_rate on outreach_domains crosses 10 %, triggering
// auto-suppression. Exercises the domain-health pipeline.

func scenarioBounceSpiral(
	ctx context.Context, db *sql.DB, pool []int, cursor *int,
	rng *rand.Rand, now time.Time,
) (ScenarioResult, error) {
	res := ScenarioResult{}
	if *cursor+50 > len(pool) {
		return res, fmt.Errorf("bounce_spiral needs 50 contacts, have %d", len(pool)-*cursor)
	}
	slice := pool[*cursor : *cursor+50]
	*cursor += 50

	// Create (or reuse) a dedicated bounce-heavy domain.
	var domainID int
	err := db.QueryRowContext(ctx, `
		INSERT INTO outreach_domains (domain, domain_type, mx_verified, daily_send_cap, total_sent, total_bounced, is_suppressed, suppressed_reason)
		VALUES ('blocked-domain.test', 'unknown', false, 1, 40, 35, true, 'auto_suppress_high_bounce_rate')
		ON CONFLICT (domain) DO UPDATE SET
			total_sent = 40, total_bounced = 35,
			is_suppressed = true, suppressed_reason = 'auto_suppress_high_bounce_rate'
		RETURNING id
	`).Scan(&domainID)
	if err != nil {
		return res, err
	}

	// Move 50 contacts to this domain and create threads with bounced
	// outbound messages for 40 of them (35 hard + 5 soft).
	for i, contactID := range slice {
		if _, err := db.ExecContext(ctx,
			`UPDATE outreach_contacts SET domain_id=$1 WHERE id=$2`, domainID, contactID,
		); err != nil {
			return res, err
		}

		threadStatus := "new"
		if i < 40 {
			threadStatus = "bounced"
		}
		threadID, err := insertThread(ctx, db, contactID, 0, threadStatus, 0, rng, now)
		if err != nil {
			return res, err
		}
		res.Threads++

		if i < 40 {
			mid, err := insertOutbound(ctx, db, threadID, 0, now.Add(-5*24*time.Hour), false)
			if err != nil {
				return res, err
			}
			res.Messages++

			bounceType := "hard"
			code := "5.1.1"
			if i >= 35 {
				bounceType = "soft"
				code = "4.2.2"
			}
			if err := markBounced(ctx, db, threadID, mid, contactID, bounceType, code, now.Add(-5*24*time.Hour+2*time.Hour)); err != nil {
				return res, err
			}
			res.Bounces++
		}
	}

	// Domain-level suppression entry.
	if _, err := db.ExecContext(ctx, `
		INSERT INTO outreach_suppressions (domain, reason)
		VALUES ('blocked-domain.test', 'high_bounce_rate')
		ON CONFLICT DO NOTHING`); err != nil {
		return res, err
	}
	res.Suppressions++
	return res, nil
}

// ------------------------------------------------------------------
// Scenario D: replies_classified
// ------------------------------------------------------------------
// 20 threads with inbound replies classified across every reply_type
// the intelligence loop recognises.

func scenarioRepliesClassified(
	ctx context.Context, db *sql.DB, pool []int, cursor *int,
	rng *rand.Rand, now time.Time,
) (ScenarioResult, error) {
	res := ScenarioResult{}
	plan := []struct {
		ReplyType string
		Sentiment string
		Count     int
	}{
		{"interested", "positive", 3},
		{"meeting", "positive", 3},
		{"later", "neutral", 5},
		{"objection", "neutral", 3},
		{"negative", "negative", 3},
		{"ooo", "neutral", 3},
	}
	total := 0
	for _, p := range plan {
		total += p.Count
	}
	if *cursor+total > len(pool) {
		return res, fmt.Errorf("replies_classified needs %d contacts, have %d", total, len(pool)-*cursor)
	}

	idx := 0
	for _, p := range plan {
		for i := 0; i < p.Count; i++ {
			contactID := pool[*cursor+idx]
			idx++

			threadID, err := insertThread(ctx, db, contactID, 0, "replied", 1, rng, now)
			if err != nil {
				return res, err
			}
			res.Threads++

			if _, err := insertOutbound(ctx, db, threadID, 0, now.Add(-5*24*time.Hour), false); err != nil {
				return res, err
			}
			res.Messages++
			if _, err := insertReplyMessage(ctx, db, threadID, p.ReplyType, now.Add(-2*24*time.Hour)); err != nil {
				return res, err
			}
			// Attach sentiment on the reply message we just created.
			if _, err := db.ExecContext(ctx, `
				UPDATE outreach_messages SET sentiment=$1
				WHERE thread_id=$2 AND direction='in' AND reply_type=$3`,
				p.Sentiment, threadID, p.ReplyType,
			); err != nil {
				return res, err
			}
			res.Replies++
			res.Messages++
		}
	}
	*cursor += idx
	return res, nil
}

// ------------------------------------------------------------------
// Scenario E: unsubscribe_flow
// ------------------------------------------------------------------
// 5 opt-outs written to outreach_suppressions with varying reason codes
// so the dashboard's suppressions panel and filter UI have representative
// rows. Migration 036 dropped the legacy unsubscribes and
// category_suppressions tables; the operational signal now lives entirely
// in outreach_suppressions + outreach_contacts.status='unsubscribed'.

func scenarioUnsubscribeFlow(
	ctx context.Context, db *sql.DB, pool []int, cursor *int,
	_ *rand.Rand, now time.Time,
) (ScenarioResult, error) {
	res := ScenarioResult{}
	if *cursor+5 > len(pool) {
		return res, fmt.Errorf("unsubscribe_flow needs 5 contacts, have %d", len(pool)-*cursor)
	}
	slice := pool[*cursor : *cursor+5]
	_ = now
	*cursor += 5

	reasons := []string{
		"unsubscribe_link",
		"unsubscribe_link",
		"unsubscribe_reply",
		"category_optout",
		"manual_block",
	}
	for i, id := range slice {
		email, err := contactEmail(ctx, db, id)
		if err != nil {
			return res, err
		}
		if _, err := db.ExecContext(ctx, `
			INSERT INTO outreach_suppressions (email, reason)
			VALUES ($1, $2) ON CONFLICT DO NOTHING`, email, reasons[i]); err != nil {
			return res, err
		}
		if _, err := db.ExecContext(ctx, `
			UPDATE outreach_contacts SET status='unsubscribed' WHERE id=$1`, id); err != nil {
			return res, err
		}
		res.Suppressions++
		res.Unsubscribes++
	}
	return res, nil
}

// ------------------------------------------------------------------
// Scenario F: honeypot_coverage
// ------------------------------------------------------------------
// Injects honeypot signals onto a handful of existing prodlike contacts
// so the dashboard's honeypot panel has representative rows beyond the
// curated edge-case pool (which lives behind the --with-edge-cases flag).
//
// Coverage matrix — the live detector produces exactly three signal_type
// values (typo_domain, role_based, suspicious_pattern) across the three
// severities low/medium/high. This scenario writes every non-empty cell
// of that matrix plus a few repeats so counts are non-trivial.
//
//	typo_domain/medium       ×2   (matches enrich.DetectHoneypot rule 1)
//	role_based/low           ×3   (rule 2)
//	suspicious_pattern/high  ×4   (rules 3, 5)
//	suspicious_pattern/med   ×4   (rules 4, 6, 7)
//	suspicious_pattern/low   ×2   (synthetic low-severity noise)
//	total                    =15
func scenarioHoneypotCoverage(
	ctx context.Context, db *sql.DB, pool []int, cursor *int,
	_ *rand.Rand, now time.Time,
) (ScenarioResult, error) {
	res := ScenarioResult{}
	const signalsWanted = 15
	if *cursor+signalsWanted > len(pool) {
		return res, fmt.Errorf(
			"honeypot_coverage needs %d contacts, have %d",
			signalsWanted, len(pool)-*cursor,
		)
	}
	slice := pool[*cursor : *cursor+signalsWanted]
	*cursor += signalsWanted

	type spec struct {
		Type     string
		Severity string
		Details  string
		Fix      string
	}
	matrix := []spec{
		{"typo_domain", "medium", "gmial.com → gmail.com", "user@gmail.com"},
		{"typo_domain", "medium", "outlok.com → outlook.com", "user@outlook.com"},
		{"role_based", "low", "role-based prefix: info", ""},
		{"role_based", "low", "role-based prefix: noreply", ""},
		{"role_based", "low", "role-based prefix: support", ""},
		{"suspicious_pattern", "high", "suspicious local part: test", ""},
		{"suspicious_pattern", "high", "suspicious local part: null", ""},
		{"suspicious_pattern", "high", "suspicious local part: xxx", ""},
		{"suspicious_pattern", "high", "local part exceeds 64 chars", ""},
		{"suspicious_pattern", "medium", "all-numeric local part: 1234567", ""},
		{"suspicious_pattern", "medium", "all-numeric local part: 98765", ""},
		{"suspicious_pattern", "medium", "consecutive dots in local part", ""},
		{"suspicious_pattern", "medium", "single character local part", ""},
		{"suspicious_pattern", "low", "ambiguous prefix (seed-only)", ""},
		{"suspicious_pattern", "low", "cold-list tracker keyword", ""},
	}

	_ = now // signals use now() default; kept for signature parity

	for i, s := range matrix {
		payload := map[string]any{"details": s.Details}
		if s.Fix != "" {
			payload["fix"] = s.Fix
		}
		det, _ := json.Marshal(payload)
		if _, err := db.ExecContext(ctx, `
			INSERT INTO outreach_honeypot_signals
			    (contact_id, signal_type, severity, details)
			VALUES ($1, $2, $3, $4)`,
			slice[i], s.Type, s.Severity, string(det),
		); err != nil {
			return res, err
		}
		res.HoneypotSignals++
	}
	return res, nil
}

// ------------------------------------------------------------------
// Scenario G: exclusion_cases
// ------------------------------------------------------------------
// Guarantees minimum representation of each exclusion category on the
// companies table, regardless of scale. The baseline generator samples
// from a weighted distribution so small-scale runs may miss the rare
// cells (e.g. liquidation, retail NACE). This scenario *updates* the
// tail of the prodlike company pool — leaving earlier companies (used
// by campaigns/threads) untouched.
//
// Targeted counts:
//
//	v_insolvenci=true + hard_block + reason='insolvence'   ×10
//	datum_zaniku set + v_likvidaci + soft_block            ×5
//	hard_block + reason='nace_exclusion' (no insolvence)   ×8
//	soft_block + reason='soft_nace'                        ×12
//	nace_primary='47.30' (retail fuel) + soft_block        ×3
//
// Total 38 companies updated. All updates are idempotent (running the
// scenario twice is a no-op on the second pass) because each UPDATE is
// scoped to the deterministic ORDER BY id DESC LIMIT N window.
func scenarioExclusionCases(
	ctx context.Context, db *sql.DB, _ *rand.Rand, now time.Time,
) (ScenarioResult, error) {
	res := ScenarioResult{}

	// Reserve the highest-id prodlike companies for exclusion updates so
	// active-campaign scenarios (which slice from the start of the pool)
	// don't end up with blocked senders.
	const reserved = 38 // 10+5+8+12+3

	rows, err := db.QueryContext(ctx, `
		SELECT id FROM companies
		 WHERE firmy_cz_id >= 10000000
		 ORDER BY id DESC
		 LIMIT $1`,
		reserved,
	)
	if err != nil {
		return res, fmt.Errorf("load prodlike companies: %w", err)
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return res, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return res, err
	}
	if len(ids) < reserved {
		return res, fmt.Errorf(
			"exclusion_cases needs %d prodlike companies, have %d; run a larger --scale",
			reserved, len(ids),
		)
	}

	// Partition slice into five disjoint windows.
	insolvWindow := ids[0:10]
	liquidWindow := ids[10:15]
	hardWindow := ids[15:23]
	softWindow := ids[23:35]
	retailWindow := ids[35:38]

	// 1. Insolvence (hard_block).
	if _, err := db.ExecContext(ctx, `
		UPDATE companies
		   SET v_insolvenci    = true,
		       exclusion_status = 'hard_block',
		       exclusion_reasons = ARRAY['insolvence'],
		       updated_at       = $1
		 WHERE id = ANY($2::bigint[])`,
		now, int64Array(insolvWindow),
	); err != nil {
		return res, fmt.Errorf("update insolvence rows: %w", err)
	}
	res.CompaniesUpdated += len(insolvWindow)

	// 2. Liquidace (datum_zaniku).
	zanikAt := now.AddDate(0, -3, 0)
	if _, err := db.ExecContext(ctx, `
		UPDATE companies
		   SET datum_zaniku    = $1,
		       v_likvidaci     = true,
		       exclusion_status = 'soft_block',
		       exclusion_reasons = ARRAY['likvidace'],
		       updated_at       = $2
		 WHERE id = ANY($3::bigint[])`,
		zanikAt, now, int64Array(liquidWindow),
	); err != nil {
		return res, fmt.Errorf("update liquidation rows: %w", err)
	}
	res.CompaniesUpdated += len(liquidWindow)

	// 3. Hard-block without insolvence (e.g. NACE exclusion).
	if _, err := db.ExecContext(ctx, `
		UPDATE companies
		   SET exclusion_status = 'hard_block',
		       exclusion_reasons = ARRAY['nace_exclusion'],
		       v_insolvenci    = false,
		       updated_at       = $1
		 WHERE id = ANY($2::bigint[])`,
		now, int64Array(hardWindow),
	); err != nil {
		return res, fmt.Errorf("update hard-block rows: %w", err)
	}
	res.CompaniesUpdated += len(hardWindow)

	// 4. Soft-block.
	if _, err := db.ExecContext(ctx, `
		UPDATE companies
		   SET exclusion_status = 'soft_block',
		       exclusion_reasons = ARRAY['soft_nace'],
		       updated_at       = $1
		 WHERE id = ANY($2::bigint[])`,
		now, int64Array(softWindow),
	); err != nil {
		return res, fmt.Errorf("update soft-block rows: %w", err)
	}
	res.CompaniesUpdated += len(softWindow)

	// 5. Retail NACE (47.30).
	if _, err := db.ExecContext(ctx, `
		UPDATE companies
		   SET nace_primary     = '47.30',
		       nace_codes       = ARRAY['47.30'],
		       exclusion_status = 'soft_block',
		       exclusion_reasons = ARRAY['retail_nace'],
		       updated_at       = $1
		 WHERE id = ANY($2::bigint[])`,
		now, int64Array(retailWindow),
	); err != nil {
		return res, fmt.Errorf("update retail-NACE rows: %w", err)
	}
	res.CompaniesUpdated += len(retailWindow)

	return res, nil
}

// int64Array renders a Go []int64 as a Postgres bigint[] literal using
// explicit cast. Avoids pulling in pq.Array for a single array driver
// dependency.
func int64Array(ids []int64) string {
	if len(ids) == 0 {
		return "{}"
	}
	buf := make([]byte, 0, len(ids)*10)
	buf = append(buf, '{')
	for i, id := range ids {
		if i > 0 {
			buf = append(buf, ',')
		}
		buf = fmtAppendInt(buf, id)
	}
	buf = append(buf, '}')
	return string(buf)
}

// fmtAppendInt is a tiny helper to avoid pulling in strconv just for
// building an array literal. Handles the full int64 range including
// negative values (though company ids are always positive).
func fmtAppendInt(buf []byte, n int64) []byte {
	if n < 0 {
		buf = append(buf, '-')
		n = -n
	}
	start := len(buf)
	if n == 0 {
		return append(buf, '0')
	}
	for n > 0 {
		buf = append(buf, byte('0'+n%10))
		n /= 10
	}
	// reverse the digits appended
	for i, j := start, len(buf)-1; i < j; i, j = i+1, j-1 {
		buf[i], buf[j] = buf[j], buf[i]
	}
	return buf
}

// ------------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------------

func loadProdlikeContactPool(ctx context.Context, db *sql.DB) ([]int, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id FROM outreach_contacts WHERE source LIKE 'prodlike-%' ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func insertCampaign(
	ctx context.Context, db *sql.DB,
	name, status string, sequence []map[string]any,
) (int64, error) {
	seqJSON, _ := json.Marshal(sequence)
	sendJSON, _ := json.Marshal(map[string]any{"dry_run": true})
	var id int64
	err := db.QueryRowContext(ctx, `
		INSERT INTO campaigns (name, status, sequence_config, sending_config)
		VALUES ($1, $2, $3, $4) RETURNING id`,
		name, status, seqJSON, sendJSON,
	).Scan(&id)
	return id, err
}

func enrollInCampaign(ctx context.Context, db *sql.DB, campaignID int64, contactID int, status string) error {
	// campaign_contacts.contact_id references Schema A (contacts). Look
	// up the Schema A row by email_hash; insert only if we find one.
	var cid int64
	err := db.QueryRowContext(ctx, `
		SELECT c.id FROM contacts c
		JOIN outreach_contacts oc ON oc.email_hash = c.email_hash
		WHERE oc.id = $1
		LIMIT 1`, contactID,
	).Scan(&cid)
	if errors.Is(err, sql.ErrNoRows) {
		// Schema A sync hasn't run for this contact yet; silently skip.
		return nil
	}
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `
		INSERT INTO campaign_contacts (campaign_id, contact_id, status, current_step)
		VALUES ($1, $2, $3, 0)
		ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
		campaignID, cid, status,
	)
	return err
}

func insertThread(
	ctx context.Context, db *sql.DB,
	contactID int, campaignID int64,
	status string, step int,
	rng *rand.Rand, now time.Time,
) (int64, error) {
	var nextAt *time.Time
	if status == "scheduled" {
		t := now.Add(time.Duration(rng.IntN(72)+1) * time.Hour)
		nextAt = &t
	} else if status == "paused" {
		t := now.AddDate(0, 0, 7)
		nextAt = &t
	}
	var campaignRef any
	if campaignID > 0 {
		campaignRef = campaignID
	}
	var id int64
	err := db.QueryRowContext(ctx, `
		INSERT INTO outreach_threads (contact_id, campaign_id, status, current_step, next_action_at)
		VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		contactID, campaignRef, status, step, nextAt,
	).Scan(&id)
	return id, err
}

func insertOutbound(ctx context.Context, db *sql.DB, threadID int64, step int, sentAt time.Time, isBump bool) (int64, error) {
	// Message-ID is stored WITHOUT angle brackets — matches the canonical
	// form used by the inbound processor (internal/thread/inbound.go
	// cleanMessageID strips the angle brackets before matching).
	// Keeping them in sync means our seed scenarios line up with what
	// poll would populate in production.
	msgID := fmt.Sprintf("%s@outreach.test", randomToken16())
	var id int64
	err := db.QueryRowContext(ctx, `
		INSERT INTO outreach_messages (thread_id, direction, message_id, subject, body_preview, sent_at, humanize_applied, is_bump)
		VALUES ($1, 'out', $2, $3, $4, $5, true, $6) RETURNING id`,
		threadID, msgID,
		fmt.Sprintf("Nabídka spolupráce (step %d)", step+1),
		"Dobrý den, dovolujeme si vás oslovit s nabídkou odkupu použitých strojů.",
		sentAt, isBump,
	).Scan(&id)
	return id, err
}

func insertReplyMessage(ctx context.Context, db *sql.DB, threadID int64, replyType string, receivedAt time.Time) (int64, error) {
	// Inbound messages: the processor writes raw.MessageID via
	// cleanMessageID(), which strips angle brackets. Mirror that here
	// so the table is shaped like it would be in production.
	msgID := fmt.Sprintf("reply-%s@prospect.test", randomToken16())
	var id int64
	err := db.QueryRowContext(ctx, `
		INSERT INTO outreach_messages (thread_id, direction, message_id, subject, body_preview, sent_at, replied_at, reply_type)
		VALUES ($1, 'in', $2, 'Re: Nabídka spolupráce', $3, $4, $4, $5) RETURNING id`,
		threadID, msgID, bodyForReplyType(replyType), receivedAt, replyType,
	).Scan(&id)
	return id, err
}

func markBounced(
	ctx context.Context, db *sql.DB,
	threadID int64, messageID int64, contactID int,
	bounceType, dsnCode string, when time.Time,
) error {
	if _, err := db.ExecContext(ctx, `
		UPDATE outreach_messages SET bounced_at=$1, smtp_response=$2 WHERE id=$3`,
		when, fmt.Sprintf("550 %s Recipient address rejected", dsnCode), messageID,
	); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO outreach_events (contact_id, thread_id, event_type, metadata)
		VALUES ($1, $2, 'bounce', $3)`,
		contactID, threadID,
		jsonLiteral(map[string]any{"type": bounceType, "dsn": dsnCode}),
	); err != nil {
		return err
	}
	if bounceType == "hard" {
		// Mark the contact as bounced so consent code picks it up.
		if _, err := db.ExecContext(ctx,
			`UPDATE outreach_contacts SET status='bounced', total_bounced=total_bounced+1 WHERE id=$1`,
			contactID); err != nil {
			return err
		}
	}
	return nil
}

func contactEmail(ctx context.Context, db *sql.DB, id int) (string, error) {
	var email string
	err := db.QueryRowContext(ctx,
		`SELECT email FROM outreach_contacts WHERE id=$1`, id,
	).Scan(&email)
	return email, err
}

// threadStepFor maps a thread status to the current_step value that
// would have produced it in the production runner.
func threadStepFor(status string) int {
	switch status {
	case "sent", "scheduled":
		return 1
	case "replied", "bounced":
		return 1
	case "paused":
		return 2
	}
	return 0
}

func threeStepSequence() []map[string]any {
	return []map[string]any{
		{"step": 0, "delay_days": 0, "template": "initial"},
		{"step": 1, "delay_days": 3, "template": "bump"},
		{"step": 2, "delay_days": 7, "template": "final"},
	}
}

func bodyForReplyType(rt string) string {
	switch rt {
	case "interested":
		return "Dobrý den, rádi bychom o Vaší nabídce věděli víc."
	case "meeting":
		return "Dobrý den, pojďme si zavolat tento pátek ve 14:00."
	case "later":
		return "Teď nemáme kapacitu, ozvěte se nám prosím za 2 měsíce."
	case "objection":
		return "Cena je pro nás nad rámec — máte lepší nabídku?"
	case "negative":
		return "Nemáme zájem, odstraňte mě z databáze."
	case "ooo":
		return "I'm currently out of office until May 2nd."
	}
	return ""
}

func jsonLiteral(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func randomToken16() string {
	b := make([]byte, 8)
	_, _ = cryptorand.Read(b)
	return hex.EncodeToString(b)
}
