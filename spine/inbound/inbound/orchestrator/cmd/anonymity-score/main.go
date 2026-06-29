// cmd/anonymity-score — Sprint S3 of the cross-mailbox anonymity test.
//
// Reads all rows from anonymity_test_messages for a given test_run_id,
// computes an anonymity score (0–100) per message using the rule-based scorer
// in campaigns/content, persists scores back to the DB, and writes a JSON +
// Markdown report to <output-dir>/<run-id>/.
//
// Usage:
//
//	anonymity-score \
//	    --run-id=<uuid>         (REQUIRED)
//	    --output-dir=reports/anonymity
//	    --llm-judge=false
//
// Exit codes:
//
//	0  scoring completed (possibly 0 rows — not an error)
//	1  runtime error (DB, I/O)
//	2  configuration error (missing flag, bad env)
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"campaigns/content"
	"common/db"
	"common/envconfig"
	"common/telemetry"
)

// ──────────────────────────────────────────────────────────────────────────────
// CLI config
// ──────────────────────────────────────────────────────────────────────────────

type config struct {
	runID       string
	outputDir   string
	llmJudge    bool
	databaseURL string
}

func parseFlags() (config, error) {
	var cfg config
	flag.StringVar(&cfg.runID, "run-id", "", "UUID of the test run (REQUIRED)")
	flag.StringVar(&cfg.outputDir, "output-dir", "reports/anonymity", "Base directory for report output")
	flag.BoolVar(&cfg.llmJudge, "llm-judge", false, "Run LLM-as-judge (opt-in, costs ~$0.20/run)")
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

// ──────────────────────────────────────────────────────────────────────────────
// DB row types
// ──────────────────────────────────────────────────────────────────────────────

type messageRow struct {
	id                 int64
	testRunID          string
	senderMailboxID    int64
	receiverMailboxID  int64
	templateName       string
	rawHeaders         map[string][]string
	receivedChain      []string
	messageID          string
	fromAddr           string
	returnPath         string
	dkimResult         *string
	spfResult          *string
	dmarcResult        *string
}

// ──────────────────────────────────────────────────────────────────────────────
// Report types
// ──────────────────────────────────────────────────────────────────────────────

// MessageScore is one scored message in the JSON report.
type MessageScore struct {
	ID                int64             `json:"id"`
	SenderMailboxID   int64             `json:"sender_mailbox_id"`
	ReceiverMailboxID int64             `json:"receiver_mailbox_id"`
	TemplateName      string            `json:"template_name"`
	Score             int               `json:"score"`
	L1IPLeak          int               `json:"l1_ip_leak"`
	L2HeaderFP        int               `json:"l2_header_fp"`
	L3Envelope        int               `json:"l3_envelope"`
	L4Auth            int               `json:"l4_auth"`
	LLMJudge          int               `json:"llm_judge"` // -1 when not run
	Leaks             []content.Leak    `json:"leaks"`
}

// AggRow is one aggregated row in the JSON report.
type AggRow struct {
	Key      string  `json:"key"`       // e.g. "sender:1 template:intro_machinery"
	Count    int     `json:"count"`
	AvgScore float64 `json:"avg_score"`
	StdDev   float64 `json:"stddev"`
	MaxScore int     `json:"max_score"`
	MinScore int     `json:"min_score"`
	LeakCnt  int     `json:"leak_count"` // total leaks across all messages in group
}

// Report is the top-level JSON output.
type Report struct {
	RunID        string          `json:"run_id"`
	GeneratedAt  time.Time       `json:"generated_at"`
	MessageCount int             `json:"message_count"`
	Messages     []MessageScore  `json:"messages"`
	BySenderTemplate  []AggRow  `json:"by_sender_template"`
	ByTemplate        []AggRow  `json:"by_template"`
	BySender          []AggRow  `json:"by_sender"`
}

// ──────────────────────────────────────────────────────────────────────────────
// main
// ──────────────────────────────────────────────────────────────────────────────

func main() {
	if err := telemetry.Init("anonymity-score"); err != nil {
		slog.Error("sentry init", "op", "main.sentry", "error", err)
	}
	defer telemetry.Flush()
	slog.SetDefault(slog.New(telemetry.NewSlogHandler(slog.NewJSONHandler(os.Stderr, nil))))

	cfg, err := parseFlags()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config error:", err)
		os.Exit(2)
	}

	database, err := db.Connect(cfg.databaseURL)
	if err != nil {
		slog.Error("DB connect", "op", "main.connect", "error", err)
		os.Exit(1)
	}
	defer database.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	if err := run(ctx, database, cfg); err != nil {
		slog.Error("scoring failed", "op", "main.run", "error", err)
		os.Exit(1)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// run — orchestration
// ──────────────────────────────────────────────────────────────────────────────

func run(ctx context.Context, database *sql.DB, cfg config) error {
	slog.Info("anonymity scorer starting",
		"op", "run.start",
		"run_id", cfg.runID,
		"llm_judge", cfg.llmJudge)

	// 1. Fetch messages.
	rows, err := fetchMessages(ctx, database, cfg.runID)
	if err != nil {
		return fmt.Errorf("fetch messages: %w", err)
	}
	slog.Info("fetched messages",
		"op", "run.fetch",
		"run_id", cfg.runID,
		"count", len(rows))

	// 2. Score each message and persist.
	scored := make([]MessageScore, 0, len(rows))
	for _, row := range rows {
		ms := scoreRow(row, cfg.llmJudge)
		scored = append(scored, ms)

		if err := persistScore(ctx, database, ms); err != nil {
			// Non-fatal: log and continue; report will still be written.
			slog.Warn("persist score failed",
				"op", "run.persist",
				"message_id", row.id,
				"error", err)
		}
	}

	// 3. Aggregate.
	report := buildReport(cfg.runID, scored)

	// 4. Write output.
	outDir := filepath.Join(cfg.outputDir, cfg.runID)
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return fmt.Errorf("create output dir %q: %w", outDir, err)
	}
	if err := writeJSON(filepath.Join(outDir, "scores.json"), report); err != nil {
		return fmt.Errorf("write JSON: %w", err)
	}
	if err := writeMarkdown(filepath.Join(outDir, "summary.md"), report); err != nil {
		return fmt.Errorf("write markdown: %w", err)
	}

	slog.Info("anonymity scorer done",
		"op", "run.done",
		"run_id", cfg.runID,
		"messages_scored", len(scored),
		"output_dir", outDir)
	return nil
}

// ──────────────────────────────────────────────────────────────────────────────
// fetchMessages — SELECT * from anonymity_test_messages for the given run.
// ──────────────────────────────────────────────────────────────────────────────

func fetchMessages(ctx context.Context, database *sql.DB, runID string) ([]messageRow, error) {
	const q = `
		SELECT id,
		       test_run_id,
		       sender_mailbox_id,
		       receiver_mailbox_id,
		       template_name,
		       raw_headers,
		       received_chain,
		       COALESCE(message_id, ''),
		       COALESCE(from_addr, ''),
		       COALESCE(return_path, ''),
		       dkim_result,
		       spf_result,
		       dmarc_result
		FROM anonymity_test_messages
		WHERE test_run_id = $1
		ORDER BY id`

	dbRows, err := database.QueryContext(ctx, q, runID)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer dbRows.Close()

	var out []messageRow
	for dbRows.Next() {
		var r messageRow
		var rawHeadersJSON []byte
		var chainLiteral string // PostgreSQL text[] as string literal

		if err := dbRows.Scan(
			&r.id,
			&r.testRunID,
			&r.senderMailboxID,
			&r.receiverMailboxID,
			&r.templateName,
			&rawHeadersJSON,
			&chainLiteral,
			&r.messageID,
			&r.fromAddr,
			&r.returnPath,
			&r.dkimResult,
			&r.spfResult,
			&r.dmarcResult,
		); err != nil {
			return nil, fmt.Errorf("scan row id=%d: %w", r.id, err)
		}

		if err := json.Unmarshal(rawHeadersJSON, &r.rawHeaders); err != nil {
			slog.Warn("failed to parse raw_headers jsonb",
				"op", "fetchMessages.parseHeaders",
				"message_id", r.id,
				"error", err)
			r.rawHeaders = map[string][]string{}
		}
		r.receivedChain = parsePGTextArray(chainLiteral)
		out = append(out, r)
	}
	return out, dbRows.Err()
}

// parsePGTextArray converts a PostgreSQL text[] literal like
// {"foo","bar","baz"} to a []string.
// This avoids importing lib/pq just for the Array type.
func parsePGTextArray(lit string) []string {
	lit = strings.TrimSpace(lit)
	if lit == "{}" || lit == "" {
		return nil
	}
	// Strip outer braces.
	if len(lit) >= 2 && lit[0] == '{' && lit[len(lit)-1] == '}' {
		lit = lit[1 : len(lit)-1]
	}
	// Simple CSV parser that respects double-quoted fields with escape sequences.
	var out []string
	var cur strings.Builder
	inQuote := false
	for i := 0; i < len(lit); i++ {
		ch := lit[i]
		if inQuote {
			if ch == '\\' && i+1 < len(lit) {
				i++
				cur.WriteByte(lit[i])
			} else if ch == '"' {
				inQuote = false
			} else {
				cur.WriteByte(ch)
			}
		} else {
			if ch == '"' {
				inQuote = true
			} else if ch == ',' {
				out = append(out, cur.String())
				cur.Reset()
			} else {
				cur.WriteByte(ch)
			}
		}
	}
	out = append(out, cur.String())
	return out
}

// ──────────────────────────────────────────────────────────────────────────────
// scoreRow — apply scorer + optional LLM judge.
// ──────────────────────────────────────────────────────────────────────────────

func scoreRow(row messageRow, runLLM bool) MessageScore {
	msg := content.AnonymityMessage{
		RawHeaders:    row.rawHeaders,
		ReceivedChain: row.receivedChain,
		MessageID:     row.messageID,
		FromAddr:      row.fromAddr,
		ReturnPath:    row.returnPath,
		DKIMResult:    row.dkimResult,
		SPFResult:     row.spfResult,
		DMARCResult:   row.dmarcResult,
	}

	result := content.ScoreAnonymity(msg)

	llmScore := -1 // -1 = not run
	if runLLM {
		llmScore = LLMJudge(msg) // phase 2 stub
	}

	return MessageScore{
		ID:                row.id,
		SenderMailboxID:   row.senderMailboxID,
		ReceiverMailboxID: row.receiverMailboxID,
		TemplateName:      row.templateName,
		Score:             result.Total,
		L1IPLeak:          result.L1IPLeak,
		L2HeaderFP:        result.L2HeaderFP,
		L3Envelope:        result.L3Envelope,
		L4Auth:            result.L4Auth,
		LLMJudge:          llmScore,
		Leaks:             result.Leaks,
	}
}

// LLMJudge is a Phase 2 stub. It always returns -1 (not run).
//
// TODO(phase2): integrate the Anthropic SDK (already in go.mod as
// github.com/anthropics/anthropic-sdk-go) to call claude-haiku with a prompt:
// "Below is the raw header set + body of an email. Score 0–100 (100 = human).
// Cite specific headers/phrases that indicate automation."
// The implementation should gate on cfg.llmJudge and honour the
// services/orchestrator CLAUDE.md haiku-tier routing rule.
//
//nolint:unparam
func LLMJudge(_ content.AnonymityMessage) int {
	return -1
}

// ──────────────────────────────────────────────────────────────────────────────
// persistScore — UPDATE anonymity_test_messages with computed score.
// ──────────────────────────────────────────────────────────────────────────────

func persistScore(ctx context.Context, database *sql.DB, ms MessageScore) error {
	leaksJSON, err := json.Marshal(ms.Leaks)
	if err != nil {
		return fmt.Errorf("marshal leaks: %w", err)
	}

	var judgeVal *int
	if ms.LLMJudge >= 0 {
		v := ms.LLMJudge
		judgeVal = &v
	}

	_, err = database.ExecContext(ctx, `
		UPDATE anonymity_test_messages
		SET anonymity_score = $1,
		    anonymity_judge = $2,
		    anonymity_leaks = $3,
		    scored_at       = now()
		WHERE id = $4`,
		ms.Score,
		judgeVal,
		leaksJSON,
		ms.ID,
	)
	return err
}

// ──────────────────────────────────────────────────────────────────────────────
// buildReport — aggregate scored messages into a Report.
// ──────────────────────────────────────────────────────────────────────────────

func buildReport(runID string, messages []MessageScore) Report {
	r := Report{
		RunID:        runID,
		GeneratedAt:  time.Now().UTC(),
		MessageCount: len(messages),
		Messages:     messages,
	}

	// Aggregate by (sender, template).
	type stKey struct{ sender int64; template string }
	stGroups := map[stKey][]int{}
	tGroups := map[string][]int{}
	sGroups := map[int64][]int{}
	leakCounts := map[string]int{} // key → total leaks

	for _, m := range messages {
		sk := stKey{m.SenderMailboxID, m.TemplateName}
		stGroups[sk] = append(stGroups[sk], m.Score)

		tGroups[m.TemplateName] = append(tGroups[m.TemplateName], m.Score)
		sGroups[m.SenderMailboxID] = append(sGroups[m.SenderMailboxID], m.Score)

		leakCounts[fmt.Sprintf("st:%d:%s", m.SenderMailboxID, m.TemplateName)] += len(m.Leaks)
		leakCounts[fmt.Sprintf("t:%s", m.TemplateName)] += len(m.Leaks)
		leakCounts[fmt.Sprintf("s:%d", m.SenderMailboxID)] += len(m.Leaks)
	}

	for k, scores := range stGroups {
		key := fmt.Sprintf("sender:%d template:%s", k.sender, k.template)
		r.BySenderTemplate = append(r.BySenderTemplate, aggRow(key, scores, leakCounts["st:"+fmt.Sprintf("%d:%s", k.sender, k.template)]))
	}
	for k, scores := range tGroups {
		r.ByTemplate = append(r.ByTemplate, aggRow("template:"+k, scores, leakCounts["t:"+k]))
	}
	for k, scores := range sGroups {
		r.BySender = append(r.BySender, aggRow(fmt.Sprintf("sender:%d", k), scores, leakCounts[fmt.Sprintf("s:%d", k)]))
	}

	return r
}

func aggRow(key string, scores []int, leakCnt int) AggRow {
	if len(scores) == 0 {
		return AggRow{Key: key}
	}
	sum := 0
	minS, maxS := scores[0], scores[0]
	for _, s := range scores {
		sum += s
		if s < minS {
			minS = s
		}
		if s > maxS {
			maxS = s
		}
	}
	avg := float64(sum) / float64(len(scores))

	var variance float64
	for _, s := range scores {
		diff := float64(s) - avg
		variance += diff * diff
	}
	variance /= float64(len(scores))

	return AggRow{
		Key:      key,
		Count:    len(scores),
		AvgScore: math.Round(avg*100) / 100,
		StdDev:   math.Round(math.Sqrt(variance)*100) / 100,
		MaxScore: maxS,
		MinScore: minS,
		LeakCnt:  leakCnt,
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// writeJSON / writeMarkdown
// ──────────────────────────────────────────────────────────────────────────────

func writeJSON(path string, report Report) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	return enc.Encode(report)
}

func writeMarkdown(path string, report Report) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	fmt.Fprintf(f, "# Anonymity Score Report\n\n")
	fmt.Fprintf(f, "**Run ID:** `%s`  \n", report.RunID)
	fmt.Fprintf(f, "**Generated:** %s  \n", report.GeneratedAt.Format(time.RFC3339))
	fmt.Fprintf(f, "**Messages scored:** %d  \n\n", report.MessageCount)

	// Per-template table.
	fmt.Fprintf(f, "## By Template\n\n")
	fmt.Fprintf(f, "| Template | Count | Avg Score | StdDev | Min | Max | Leaks |\n")
	fmt.Fprintf(f, "|----------|------:|----------:|-------:|----:|----:|------:|\n")
	for _, row := range report.ByTemplate {
		label := strings.TrimPrefix(row.Key, "template:")
		fmt.Fprintf(f, "| `%s` | %d | %.2f | %.2f | %d | %d | %d |\n",
			label, row.Count, row.AvgScore, row.StdDev, row.MinScore, row.MaxScore, row.LeakCnt)
	}

	// Per-sender table.
	fmt.Fprintf(f, "\n## By Sender Mailbox\n\n")
	fmt.Fprintf(f, "| Sender ID | Count | Avg Score | StdDev | Min | Max | Leaks |\n")
	fmt.Fprintf(f, "|-----------|------:|----------:|-------:|----:|----:|------:|\n")
	for _, row := range report.BySender {
		label := strings.TrimPrefix(row.Key, "sender:")
		fmt.Fprintf(f, "| `%s` | %d | %.2f | %.2f | %d | %d | %d |\n",
			label, row.Count, row.AvgScore, row.StdDev, row.MinScore, row.MaxScore, row.LeakCnt)
	}

	// Per-(sender, template) table.
	fmt.Fprintf(f, "\n## By Sender × Template\n\n")
	fmt.Fprintf(f, "| Key | Count | Avg Score | StdDev | Min | Max | Leaks |\n")
	fmt.Fprintf(f, "|-----|------:|----------:|-------:|----:|----:|------:|\n")
	for _, row := range report.BySenderTemplate {
		fmt.Fprintf(f, "| `%s` | %d | %.2f | %.2f | %d | %d | %d |\n",
			row.Key, row.Count, row.AvgScore, row.StdDev, row.MinScore, row.MaxScore, row.LeakCnt)
	}

	// Full message table.
	fmt.Fprintf(f, "\n## Per-Message Scores\n\n")
	fmt.Fprintf(f, "| ID | Sender | Receiver | Template | Score | L1 | L2 | L3 | L4 | LLM | Leaks |\n")
	fmt.Fprintf(f, "|----|-------:|---------:|----------|------:|---:|---:|---:|---:|----:|------:|\n")
	for _, m := range report.Messages {
		llmStr := "—"
		if m.LLMJudge >= 0 {
			llmStr = fmt.Sprintf("%d", m.LLMJudge)
		}
		fmt.Fprintf(f, "| %d | %d | %d | `%s` | %d | %d | %d | %d | %d | %s | %d |\n",
			m.ID, m.SenderMailboxID, m.ReceiverMailboxID, m.TemplateName,
			m.Score, m.L1IPLeak, m.L2HeaderFP, m.L3Envelope, m.L4Auth,
			llmStr, len(m.Leaks))
	}

	return nil
}
