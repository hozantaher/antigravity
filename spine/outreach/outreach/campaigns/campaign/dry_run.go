package campaign

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"campaigns/content"
	"common/audit"
)

// KT-A5 — Dry-run mode.
//
// When campaigns.status = 'dry_run' the runner produces an audit log
// of "what would have been sent" without invoking the sender. The
// staircase playbook walks step 0 = dry-run (zero emails leave the
// system) and the operator inspects the audit before flipping to
// step 1.
//
// HARD-RULE alignment (memory feedback_campaign_send): this file
// MUST NEVER call sender.Engine.Send() — it is the audit-only path.
// The discipline test below asserts the file imports nothing from
// services/campaigns/sender to keep that contract structural.

// DryRunRecord captures one "would-be sent" decision. The shape is
// intentionally JSONB-friendly so it can be persisted into
// operator_audit_log.details verbatim.
type DryRunRecord struct {
	CampaignID  int64  `json:"campaign_id"`
	ContactID   int64  `json:"contact_id"`
	Step        int    `json:"step"`
	ToAddress   string `json:"to_address"`
	Template    string `json:"template"`
	Subject     string `json:"subject"`
	BodyPreview string `json:"body_preview"`
	BodyLength  int    `json:"body_length"`
}

// DryRunReport aggregates every record from one dry_run tick.
type DryRunReport struct {
	CampaignID    int64          `json:"campaign_id"`
	CampaignName  string         `json:"campaign_name"`
	GeneratedAt   time.Time      `json:"generated_at"`
	RecordCount   int            `json:"record_count"`
	Records       []DryRunRecord `json:"records"`
	SkippedReason []string       `json:"skipped,omitempty"`
}

// dryRunBodyPreviewLen is how many characters of rendered body we
// keep in the audit record. Long enough to confirm the template
// variant rendered correctly, short enough to keep operator_audit_log
// rows bounded — runaway campaign with 500 contacts × 1KB body each
// is half a megabyte per tick otherwise.
const dryRunBodyPreviewLen = 240

// RunDryRun performs the read-only equivalent of RunCampaign. It
// pulls the same eligible contacts (subject to the same suppression
// + status gates) and renders each, but never enqueues to the sender.
// The result is persisted to operator_audit_log under
// `action='campaign_dry_run'` and returned to the caller.
//
// Inputs:
//   - db: same DB interface RunCampaign uses; *sql.DB or sqlmock both work.
//   - cengine: content engine; must be non-nil (dry-run without rendering
//     is meaningless).
//   - campaignID: which campaign to dry-run.
//
// The function returns the report or a wrapped error. On error, no
// audit row is written — caller can retry.
//
// Maximum candidates inspected per dry-run = dryRunBatchLimit. This
// keeps a runaway audit row from blowing up operator_audit_log when
// an operator fat-fingers a 50k-contact segment.
const dryRunBatchLimit = 100

func RunDryRun(ctx context.Context, db DB, cengine *content.Engine, campaignID int64) (*DryRunReport, error) {
	if db == nil {
		return nil, fmt.Errorf("RunDryRun: db is nil")
	}
	if cengine == nil {
		return nil, fmt.Errorf("RunDryRun: content engine is nil")
	}

	var name, status string
	var seqJSON []byte
	err := db.QueryRowContext(ctx,
		`SELECT name, status, sequence_config FROM campaigns WHERE id = $1`,
		campaignID).Scan(&name, &status, &seqJSON)
	if err != nil {
		return nil, fmt.Errorf("load campaign: %w", err)
	}
	// Dry-run is permitted from any status — the operator may want to
	// preview what a paused campaign would have sent. We only refuse
	// when the campaign row doesn't exist (handled by ErrNoRows above).

	var steps []SequenceStep
	if err := json.Unmarshal(seqJSON, &steps); err != nil {
		return nil, fmt.Errorf("parse sequence: %w", err)
	}

	// Same eligibility predicates as RunCampaign minus mid-tick mutations:
	// the canonical suppression UNION, the full status NOT-IN list (incl.
	// 'suppressed'), and the companies.email_status='valid' gate the runner
	// applies in Go (EmailStatusAllowed). Brought to parity so the preview
	// does not overstate the sendable set versus what the runner would
	// actually touch — a contact with no company row (email_status '') or any
	// non-'valid' status is blocked here just as the runner blocks it.
	rows, err := db.QueryContext(ctx, `
		SELECT cc.id, cc.contact_id, cc.current_step, c.email, c.first_name, c.company_name, c.region
		FROM campaign_contacts cc
		JOIN contacts c ON c.id = cc.contact_id
		LEFT JOIN companies co ON co.ico = c.ico
		WHERE cc.campaign_id = $1
		  AND cc.status IN ('pending', 'in_sequence')
		  AND c.status NOT IN (
		      'bounced', 'blacklisted', 'invalid',
		      'unsubscribed', 'opted_out',
		      'human_handoff', 'paused_human',
		      'completed_no_reply', 'retention_expired',
		      'suppressed'
		  )
		  AND COALESCE(co.email_status, '') = 'valid'
		  AND `+suppressionFilterFor("c.email")+`
		ORDER BY cc.id
		LIMIT $2`, campaignID, dryRunBatchLimit)
	if err != nil {
		return nil, fmt.Errorf("query contacts: %w", err)
	}
	defer rows.Close()

	report := &DryRunReport{
		CampaignID:   campaignID,
		CampaignName: name,
		GeneratedAt:  time.Now().UTC(),
		Records:      make([]DryRunRecord, 0),
	}

	for rows.Next() {
		var ccID, contactID int64
		var currentStep int
		var email, firstName, companyName, region sql.NullString
		if err := rows.Scan(&ccID, &contactID, &currentStep, &email, &firstName, &companyName, &region); err != nil {
			report.SkippedReason = append(report.SkippedReason,
				fmt.Sprintf("scan cc=%d: %v", ccID, err))
			continue
		}
		if currentStep >= len(steps) {
			report.SkippedReason = append(report.SkippedReason,
				fmt.Sprintf("contact=%d step=%d past sequence end", contactID, currentStep))
			continue
		}
		step := steps[currentStep]
		vars := content.TemplateVars{
			Firma:    nullStr(companyName),
			Jmeno:    nullStr(firstName),
			Region:   nullStr(region),
			UnsubURL: buildUnsubURL(campaignID, contactID, email.String),
		}
		rendered, rerr := cengine.Render(step.TemplateName, vars, contactID, step.Step)
		if rerr != nil {
			report.SkippedReason = append(report.SkippedReason,
				fmt.Sprintf("contact=%d render %s: %v", contactID, step.TemplateName, rerr))
			continue
		}
		preview := rendered.BodyPlain
		if len(preview) > dryRunBodyPreviewLen {
			preview = preview[:dryRunBodyPreviewLen] + "…"
		}
		report.Records = append(report.Records, DryRunRecord{
			CampaignID:  campaignID,
			ContactID:   contactID,
			Step:        step.Step,
			ToAddress:   email.String,
			Template:    step.TemplateName,
			Subject:     rendered.Subject,
			BodyPreview: preview,
			BodyLength:  len(rendered.BodyPlain),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate contacts: %w", err)
	}
	report.RecordCount = len(report.Records)

	// Audit row — captures aggregate + first 20 records for quick
	// inspection. Full record list is intentionally NOT inlined so we
	// don't blow up operator_audit_log on 100-contact tests.
	auditDetails := map[string]any{
		"campaign_name":  name,
		"records":        firstNRecords(report.Records, 20),
		"record_count":   report.RecordCount,
		"skipped_count":  len(report.SkippedReason),
		"generated_at":   report.GeneratedAt.Format(time.RFC3339),
	}
	audit.Log(ctx, db, "campaign_dry_run", "campaign_runner",
		"campaign", fmt.Sprintf("%d", campaignID), auditDetails)

	slog.Info("kampaň: dry_run dokončen",
		"op", "RunDryRun",
		"campaign_id", campaignID,
		"campaign_name", name,
		"record_count", report.RecordCount,
		"skipped", len(report.SkippedReason))

	return report, nil
}

// firstNRecords returns up to n records, copied into a fresh slice so
// the caller can mutate the original without poisoning the audit
// payload.
func firstNRecords(in []DryRunRecord, n int) []DryRunRecord {
	if len(in) <= n {
		out := make([]DryRunRecord, len(in))
		copy(out, in)
		return out
	}
	out := make([]DryRunRecord, n)
	copy(out, in[:n])
	return out
}

// IsDryRunStatus reports whether the campaigns.status string represents
// the dry_run mode. Centralized so callers (runner, scheduler, BFF)
// don't drift on the string literal.
func IsDryRunStatus(status string) bool {
	return status == "dry_run"
}
