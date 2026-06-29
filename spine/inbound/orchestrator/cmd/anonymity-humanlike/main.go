// cmd/anonymity-humanlike — Sprint S4 of the cross-mailbox anonymity test.
//
// Reads harvested messages from anonymity_test_messages (landed by S2 harvest),
// scores each template group on human-likeness using the rule-based scorer in
// services/campaigns/content, persists scores back to the table (migration 024),
// and writes JSON + Markdown report files to <output-dir>/<run-id>/.
//
// NON-OVERLAPPING with S3 (cmd/anonymity-score):
//   - S3 owns anonymity_score.go + migration 023 (anonymity_score columns).
//   - S4 owns humanlike_score.go + migration 024 (humanlike_score columns).
//
// Usage:
//
//	anonymity-humanlike \
//	    --run-id=<uuid>                    (REQUIRED)
//	    --output-dir=reports/anonymity     (default)
//
// Exit codes:
//
//	0  success (including 0-row runs — empty report written)
//	1  runtime error (DB query, file I/O)
//	2  fatal configuration error (missing flag / env)
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/lib/pq"

	"campaigns/content"
	"common/db"
	"common/envconfig"
	"common/telemetry"
)

// ─────────────────────────────────────────────────────────────────────────────
// CLI flags
// ─────────────────────────────────────────────────────────────────────────────

type config struct {
	runID       string
	outputDir   string
	databaseURL string
}

func parseFlags() (config, error) {
	var cfg config
	flag.StringVar(&cfg.runID, "run-id", "", "UUID of the test run (REQUIRED)")
	flag.StringVar(&cfg.outputDir, "output-dir", "reports/anonymity", "Output directory root for report files")
	flag.Parse()

	if cfg.runID == "" {
		return cfg, fmt.Errorf("--run-id is required")
	}
	cfg.databaseURL = envconfig.GetOr("DATABASE_URL", "")
	if cfg.databaseURL == "" {
		return cfg, fmt.Errorf("DATABASE_URL env not set")
	}
	return cfg, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// DB row
// ─────────────────────────────────────────────────────────────────────────────

type messageRow struct {
	id               int64
	templateName     string
	senderMailboxID  int64
	rawHeaders       []byte // jsonb
	rawBody          string
	senderPhone      string // from metadata — empty when absent
	senderName       string // from metadata — empty when absent
}

// ─────────────────────────────────────────────────────────────────────────────
// Report output types
// ─────────────────────────────────────────────────────────────────────────────

// TemplateReport is one entry in the JSON/MD report per template.
type TemplateReport struct {
	Template   string                  `json:"template"`
	Total      int                     `json:"total"`
	RuleScore  int                     `json:"rule_score"`
	Variance   int                     `json:"variance"`
	Content    int                     `json:"content"`
	Heuristics int                     `json:"heuristics"`
	LLMJudge   int                     `json:"llm_judge"`
	Telltales  []content.Telltale      `json:"telltales,omitempty"`
	MsgCount   int                     `json:"msg_count"`
}

// RunReport is the full JSON report for one run.
type RunReport struct {
	RunID      string           `json:"run_id"`
	ScoredAt   time.Time        `json:"scored_at"`
	Templates  []TemplateReport `json:"templates"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

func main() {
	if err := telemetry.Init("anonymity-humanlike"); err != nil {
		slog.Error("sentry init", "op", "main.init", "error", err)
	}
	defer telemetry.Flush()
	slog.SetDefault(slog.New(telemetry.NewSlogHandler(slog.NewJSONHandler(os.Stderr, nil))))

	cfg, err := parseFlags()
	if err != nil {
		fmt.Fprintln(os.Stderr, "usage error:", err)
		os.Exit(2)
	}

	database, err := db.Connect(cfg.databaseURL)
	if err != nil {
		slog.Error("DB connect", "op", "main.connect", "error", err)
		os.Exit(2)
	}
	defer database.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	if err := run(ctx, database, cfg); err != nil {
		slog.Error("anonymity-humanlike failed", "op", "main.run", "error", err)
		os.Exit(1)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// run — core logic, testable via dependency injection
// ─────────────────────────────────────────────────────────────────────────────

func run(ctx context.Context, database *sql.DB, cfg config) error {
	rows, err := loadMessages(ctx, database, cfg.runID)
	if err != nil {
		return fmt.Errorf("load messages: %w", err)
	}

	slog.Info("messages loaded",
		"op", "run.load",
		"run_id", cfg.runID,
		"count", len(rows))

	if len(rows) == 0 {
		slog.Info("no messages for run — writing empty report",
			"op", "run.empty",
			"run_id", cfg.runID)
		report := RunReport{
			RunID:     cfg.runID,
			ScoredAt:  time.Now().UTC(),
			Templates: []TemplateReport{},
		}
		return writeReports(cfg.outputDir, cfg.runID, report)
	}

	// Convert DB rows to HumanlikeMessage.
	msgs := make([]content.HumanlikeMessage, 0, len(rows))
	for _, r := range rows {
		subject := extractSubjectFromHeaders(r.rawHeaders)
		msgs = append(msgs, content.HumanlikeMessage{
			TemplateName:    r.templateName,
			SenderMailboxID: r.senderMailboxID,
			Subject:         subject,
			Body:            r.rawBody,
			SenderPhone:     r.senderPhone,
			SenderName:      r.senderName,
		})
	}

	// Score.
	scores := content.ScoreHumanlikeBatch(msgs)
	scoredAt := time.Now().UTC()

	// Persist scores back to DB.
	if err := persistScores(ctx, database, cfg.runID, rows, msgs, scores, scoredAt); err != nil {
		slog.Error("persist scores", "op", "run.persist", "error", err)
		// Non-fatal: still write report.
	}

	// Build report.
	report := buildReport(cfg.runID, scoredAt, rows, scores)

	if err := writeReports(cfg.outputDir, cfg.runID, report); err != nil {
		return fmt.Errorf("write reports: %w", err)
	}

	slog.Info("scoring complete",
		"op", "run.done",
		"run_id", cfg.runID,
		"templates_scored", len(scores))

	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// loadMessages — SELECT from anonymity_test_messages for a run.
// ─────────────────────────────────────────────────────────────────────────────

func loadMessages(ctx context.Context, database *sql.DB, runID string) ([]messageRow, error) {
	// sender_phone and sender_name are explicit text columns added in migration
	// 057_outreach_mailboxes_sender_profile. Falls back to empty string when NULL.
	query := `
		SELECT
			atm.id,
			COALESCE(atm.template_name, '') AS template_name,
			atm.sender_mailbox_id,
			atm.raw_headers,
			atm.raw_body,
			COALESCE(om.sender_phone, '') AS sender_phone,
			COALESCE(om.sender_name, '')  AS sender_name
		FROM anonymity_test_messages atm
		LEFT JOIN outreach_mailboxes om ON om.id = atm.sender_mailbox_id
		WHERE atm.test_run_id = $1
		ORDER BY atm.id`

	dbRows, err := database.QueryContext(ctx, query, runID)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer dbRows.Close()

	var out []messageRow
	for dbRows.Next() {
		var r messageRow
		if err := dbRows.Scan(
			&r.id, &r.templateName, &r.senderMailboxID,
			&r.rawHeaders, &r.rawBody,
			&r.senderPhone, &r.senderName,
		); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		out = append(out, r)
	}
	return out, dbRows.Err()
}

// ─────────────────────────────────────────────────────────────────────────────
// persistScores — UPDATE humanlike_* columns for each row.
// ─────────────────────────────────────────────────────────────────────────────

func persistScores(
	ctx context.Context,
	database *sql.DB,
	runID string,
	rows []messageRow,
	msgs []content.HumanlikeMessage,
	scores map[string]content.HumanlikeScore,
	scoredAt time.Time,
) error {
	if len(rows) != len(msgs) {
		return fmt.Errorf("rows/msgs length mismatch: %d vs %d", len(rows), len(msgs))
	}

	for i, r := range rows {
		tmpl := msgs[i].TemplateName
		score, ok := scores[tmpl]
		if !ok {
			continue
		}

		telltalesJSON, err := json.Marshal(score.Telltales)
		if err != nil {
			slog.Error("marshal telltales",
				"op", "persistScores.marshal",
				"id", r.id,
				"error", err)
			telltalesJSON = []byte("[]")
		}

		judgeVal := sql.NullInt64{Int64: int64(score.LLMJudge), Valid: score.LLMJudge >= 0}

		_, err = database.ExecContext(ctx, `
			UPDATE anonymity_test_messages
			SET
				humanlike_score      = $1,
				humanlike_judge      = $2,
				humanlike_telltales  = $3,
				humanlike_scored_at  = $4
			WHERE id = $5`,
			score.Total,
			judgeVal,
			telltalesJSON,
			scoredAt,
			r.id,
		)
		if err != nil {
			slog.Error("update humanlike scores",
				"op", "persistScores.update",
				"run_id", runID,
				"id", r.id,
				"error", err)
			// non-fatal per-row; continue
		}
	}
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// buildReport
// ─────────────────────────────────────────────────────────────────────────────

func buildReport(
	runID string,
	scoredAt time.Time,
	rows []messageRow,
	scores map[string]content.HumanlikeScore,
) RunReport {
	// Count messages per template.
	countByTmpl := make(map[string]int)
	for _, r := range rows {
		countByTmpl[r.templateName]++
	}

	var reports []TemplateReport
	for tmpl, score := range scores {
		reports = append(reports, TemplateReport{
			Template:   tmpl,
			Total:      score.Total,
			RuleScore:  score.RuleScore,
			Variance:   score.Variance,
			Content:    score.Content,
			Heuristics: score.Heuristics,
			LLMJudge:   score.LLMJudge,
			Telltales:  score.Telltales,
			MsgCount:   countByTmpl[tmpl],
		})
	}

	return RunReport{
		RunID:     runID,
		ScoredAt:  scoredAt,
		Templates: reports,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// writeReports — creates <output-dir>/<run-id>/humanlike.{json,md}
// ─────────────────────────────────────────────────────────────────────────────

func writeReports(outputDir, runID string, report RunReport) error {
	dir := filepath.Join(outputDir, runID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}

	// JSON.
	jsonPath := filepath.Join(dir, "humanlike.json")
	jsonData, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal json: %w", err)
	}
	if err := os.WriteFile(jsonPath, jsonData, 0o644); err != nil {
		return fmt.Errorf("write json: %w", err)
	}
	slog.Info("wrote JSON report", "op", "writeReports.json", "path", jsonPath)

	// Markdown.
	mdPath := filepath.Join(dir, "humanlike.md")
	mdData := buildMarkdown(report)
	if err := os.WriteFile(mdPath, []byte(mdData), 0o644); err != nil {
		return fmt.Errorf("write markdown: %w", err)
	}
	slog.Info("wrote Markdown report", "op", "writeReports.md", "path", mdPath)

	return nil
}

// buildMarkdown renders a human-readable Markdown table from the report.
func buildMarkdown(report RunReport) string {
	var sb strings.Builder

	sb.WriteString("# Human-likeness Scorer Report\n\n")
	sb.WriteString(fmt.Sprintf("**Run ID**: `%s`\n\n", report.RunID))
	sb.WriteString(fmt.Sprintf("**Scored at**: %s\n\n", report.ScoredAt.Format(time.RFC3339)))

	if len(report.Templates) == 0 {
		sb.WriteString("_No messages found for this run._\n")
		return sb.String()
	}

	sb.WriteString("## Scores by Template\n\n")
	sb.WriteString("| Template | Total | Rule | Variance | Content | Heuristics | LLM Judge | Messages |\n")
	sb.WriteString("|----------|------:|-----:|---------:|--------:|-----------:|----------:|---------:|\n")

	for _, r := range report.Templates {
		llmStr := "—"
		if r.LLMJudge >= 0 {
			llmStr = fmt.Sprintf("%d", r.LLMJudge)
		}
		sb.WriteString(fmt.Sprintf("| %-20s | %5d | %4d | %8d | %7d | %10d | %9s | %8d |\n",
			r.Template, r.Total, r.RuleScore, r.Variance, r.Content, r.Heuristics, llmStr, r.MsgCount))
	}

	sb.WriteString("\n## Telltales\n\n")
	for _, r := range report.Templates {
		if len(r.Telltales) == 0 {
			continue
		}
		sb.WriteString(fmt.Sprintf("### %s\n\n", r.Template))
		for _, tt := range r.Telltales {
			icon := "ℹ️"
			switch tt.Severity {
			case "critical":
				icon = "🚨"
			case "warn":
				icon = "⚠️"
			}
			sb.WriteString(fmt.Sprintf("- %s **%s** (`%s`): %s\n", icon, tt.Severity, tt.Rule, tt.Evidence))
		}
		sb.WriteString("\n")
	}

	return sb.String()
}

// ─────────────────────────────────────────────────────────────────────────────
// extractSubjectFromHeaders — parses Subject from raw_headers jsonb.
// raw_headers format: {"subject": ["value"], ...} (all keys lowercase per S2 harvester).
// ─────────────────────────────────────────────────────────────────────────────

func extractSubjectFromHeaders(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var headers map[string][]string
	if err := json.Unmarshal(raw, &headers); err != nil {
		return ""
	}
	// Try lowercase "subject" first (S2 stores lowercase keys).
	for _, key := range []string{"subject", "Subject"} {
		if vals, ok := headers[key]; ok && len(vals) > 0 {
			return strings.TrimSpace(vals[0])
		}
	}
	return ""
}
