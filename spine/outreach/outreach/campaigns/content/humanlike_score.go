// Package content — humanlike_score.go (Sprint S4 / Sprint AF)
//
// Scores harvested anonymity-test messages on human-likeness (0–100).
// Sibling to anonymity_score.go (S3) — non-overlapping binaries and concerns.
//
// Weight breakdown:
//   - Rule-based score  (60% of Total): Variance(30) + Content(50) + Heuristics(20), cap [0,100]
//   - LLM judge         (40% of Total): stubbed → returns -1; when present: 0.6*rule + 0.4*llm
//
// Sprint AF: Controller entity identifiers (GDPR footer check) can now be
// loaded at runtime from operator_settings via a HumanlikeScorer.
// Callers that pass a nil Loader fall back to the hardcoded legacy regexes.
package content

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"regexp"
	"strings"
	"unicode"
)

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

// OperatorLoader is the interface the scorer requires for runtime config.
// Satisfied by *operatorconfig.Loader from services/common/operatorconfig.
// Passing nil falls back to legacy hardcoded regexes with a warn log.
type OperatorLoader interface {
	Get(ctx context.Context, key string) (string, error)
}

// HumanlikeScorer bundles an optional OperatorLoader with the scoring logic.
// The zero value (Loader == nil) is valid: legacy hardcoded regexes are used.
type HumanlikeScorer struct {
	Loader OperatorLoader
}

// ScoreHumanlikeMessage is a convenience wrapper that uses legacy (nil loader) mode.
// Callers that want dynamic controller config should use HumanlikeScorer.ScoreMessage.
//
// HumanlikeMessage is the input unit for the scorer.
// SenderPhone and SenderName come from outreach_mailboxes.sender_phone /
// outreach_mailboxes.sender_name (migration 057). Callers populate these fields
// before calling ScoreHumanlikeMessage or ScoreHumanlikeBatch.
// Test fixtures in humanlike_score_test.go use synthetic values (no PII).
type HumanlikeMessage struct {
	TemplateName    string
	SenderMailboxID int64
	Subject         string
	Body            string
	SenderPhone     string // expected phone pattern in body
	SenderName      string // expected name in sign-off zone
}

// HumanlikeScore is the result for one template (aggregate over siblings).
type HumanlikeScore struct {
	Total      int // 0–100, weighted: 60% rule + 40% LLM (LLM stubbed)
	RuleScore  int // 0–100 from rule-based checks
	Variance   int // 0–30, subject + body + sentence diversity
	Content    int // 0–50, diakritika, phone, sign-off, GDPR footer
	Heuristics int // 0–20, absence of spam-typical patterns

	// LLMJudge is -1 when not run, 0–100 when the LLM classifier has run.
	// Wire up LLMJudgeHumanlike(body) to populate this field in the future.
	LLMJudge int

	// Telltales are specific issues found during per-message scoring.
	// For batch scoring, telltales are collected from all messages and deduplicated.
	Telltales []Telltale
}

// Telltale is a specific finding from the rule-based checker.
type Telltale struct {
	Rule     string // "no_diakritika", "phone_missing", "all_caps_subject", etc.
	Severity string // "critical" | "warn" | "info"
	Evidence string // short excerpt or description
}

// ─────────────────────────────────────────────────────────────────────────────
// Regexp / constants
// ─────────────────────────────────────────────────────────────────────────────

var (
	phoneRe = regexp.MustCompile(`\d{3} ?\d{3} ?\d{3}`)
	emojiRe = regexp.MustCompile(`[\x{1F000}-\x{1FFFF}]`)
	clickRe = regexp.MustCompile(`(?i)(click here|klikni zde)`)
	loremRe = regexp.MustCompile(`(?i)lorem ipsum`)

	// Legacy hardcoded regexes — used when Loader is nil (backward compat).
	gdprNameRe = regexp.MustCompile(`(?i)BALKAN\s+MOTORS\s+INT\s+DOO`)
	gdprIcoRe  = regexp.MustCompile(`PIB\s*03387194`)
)

// czechDiakritika is the set of Czech diacritical characters that distinguish
// authentic Czech from ASCII-only machine-generated text.
const czechDiakritika = "áéíóúžščřěůťďý" + "ÁÉÍÓÚŽŠČŘĚŮŤĎÝ"

// ─────────────────────────────────────────────────────────────────────────────
// ScoreHumanlikeMessage scores ONE message in isolation (Content + Heuristics).
// Variance is zero when called in isolation — use ScoreHumanlikeBatch for full scoring.
// Uses legacy hardcoded regexes (nil Loader). Prefer HumanlikeScorer.ScoreMessage
// for runtime-configurable controller config.
// ─────────────────────────────────────────────────────────────────────────────

func ScoreHumanlikeMessage(msg HumanlikeMessage) HumanlikeScore {
	s := HumanlikeScorer{Loader: nil}
	return s.scoreMessageWithContext(context.Background(), msg)
}

// ScoreMessage scores ONE message, fetching controller config from Loader when
// available. Loader == nil falls back to legacy hardcoded regexes with a warn log.
func (s *HumanlikeScorer) ScoreMessage(ctx context.Context, msg HumanlikeMessage) HumanlikeScore {
	return s.scoreMessageWithContext(ctx, msg)
}

func (s *HumanlikeScorer) scoreMessageWithContext(ctx context.Context, msg HumanlikeMessage) HumanlikeScore {
	content, contentTelltales := s.scoreContent(ctx, msg)
	heuristics, heuristicTelltales := scoreHeuristics(msg)

	ruleScore := clampScore(content+heuristics, 100)

	all := make([]Telltale, 0, len(contentTelltales)+len(heuristicTelltales))
	all = append(all, contentTelltales...)
	all = append(all, heuristicTelltales...)

	return HumanlikeScore{
		Total:      applyLLMWeight(ruleScore, -1),
		RuleScore:  ruleScore,
		Variance:   0, // requires siblings — use ScoreHumanlikeBatch
		Content:    content,
		Heuristics: heuristics,
		LLMJudge:   -1,
		Telltales:  all,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// ScoreHumanlikeBatch scores all messages sharing a template_name together.
// Variance is computed across siblings. Returns one HumanlikeScore per template.
// Uses legacy hardcoded regexes (nil Loader). Prefer HumanlikeScorer.ScoreBatch
// for runtime-configurable controller config.
// ─────────────────────────────────────────────────────────────────────────────

func ScoreHumanlikeBatch(msgs []HumanlikeMessage) map[string]HumanlikeScore {
	s := HumanlikeScorer{Loader: nil}
	return s.ScoreBatch(context.Background(), msgs)
}

// ScoreBatch scores all messages sharing a template_name, fetching controller
// config from Loader when available.
func (s *HumanlikeScorer) ScoreBatch(ctx context.Context, msgs []HumanlikeMessage) map[string]HumanlikeScore {
	// Group by template.
	grouped := make(map[string][]HumanlikeMessage)
	for _, m := range msgs {
		grouped[m.TemplateName] = append(grouped[m.TemplateName], m)
	}

	results := make(map[string]HumanlikeScore, len(grouped))
	for tmpl, group := range grouped {
		variance, varianceTelltales := scoreVariance(group)

		var contentSum, heuristicsSum int
		allTelltales := make([]Telltale, 0, len(varianceTelltales))
		allTelltales = append(allTelltales, varianceTelltales...)

		for _, m := range group {
			c, ct := s.scoreContent(ctx, m)
			h, ht := scoreHeuristics(m)
			contentSum += c
			heuristicsSum += h
			allTelltales = append(allTelltales, ct...)
			allTelltales = append(allTelltales, ht...)
		}

		n := len(group)
		avgContent := contentSum / n
		avgHeuristics := heuristicsSum / n

		ruleScore := clampScore(variance+avgContent+avgHeuristics, 100)

		results[tmpl] = HumanlikeScore{
			Total:      applyLLMWeight(ruleScore, -1),
			RuleScore:  ruleScore,
			Variance:   variance,
			Content:    avgContent,
			Heuristics: avgHeuristics,
			LLMJudge:   -1,
			Telltales:  deduplicateTelltales(allTelltales),
		}
	}
	return results
}

// ─────────────────────────────────────────────────────────────────────────────
// LLMJudgeHumanlike — stubbed; returns -1.
// Future: call an LLM API and return 0–100.
// ─────────────────────────────────────────────────────────────────────────────

func LLMJudgeHumanlike(_ string) int {
	return -1
}

// ─────────────────────────────────────────────────────────────────────────────
// scoreVariance — 0..30 pts across siblings
// ─────────────────────────────────────────────────────────────────────────────

func scoreVariance(msgs []HumanlikeMessage) (int, []Telltale) {
	if len(msgs) == 0 {
		return 0, nil
	}

	var pts int
	var telltales []Telltale

	// Subject diversity: unique-subject-ratio ≥ 30% → +10 pts.
	subjects := make([]string, len(msgs))
	for i, m := range msgs {
		subjects[i] = m.Subject
	}
	uniqueRatio := float64(countUnique(subjects)) / float64(len(subjects))
	if uniqueRatio >= 0.30 {
		pts += 10
	} else {
		telltales = append(telltales, Telltale{
			Rule:     "low_subject_diversity",
			Severity: "warn",
			Evidence: fmt.Sprintf("%.0f%% unique subjects (need ≥30%%)", uniqueRatio*100),
		})
	}

	// Body length stddev / mean ≥ 0.05 → +10 pts.
	lengths := make([]float64, len(msgs))
	for i, m := range msgs {
		lengths[i] = float64(len(m.Body))
	}
	cv := coefficientOfVariation(lengths)
	if cv >= 0.05 {
		pts += 10
	} else {
		telltales = append(telltales, Telltale{
			Rule:     "low_body_length_variance",
			Severity: "info",
			Evidence: fmt.Sprintf("body length CV=%.3f (need ≥0.05)", cv),
		})
	}

	// Sentence count stddev ≥ 0.5 → +10 pts.
	sentCounts := make([]float64, len(msgs))
	for i, m := range msgs {
		sentCounts[i] = float64(countSentences(m.Body))
	}
	sd := stddev(sentCounts)
	if sd >= 0.5 {
		pts += 10
	} else {
		telltales = append(telltales, Telltale{
			Rule:     "low_sentence_count_variance",
			Severity: "info",
			Evidence: fmt.Sprintf("sentence count stddev=%.2f (need ≥0.5)", sd),
		})
	}

	return pts, telltales
}

// ─────────────────────────────────────────────────────────────────────────────
// scoreContent — 0..50 pts per message
// ─────────────────────────────────────────────────────────────────────────────

// scoreContent is a method on HumanlikeScorer so it can access Loader.
// When Loader is nil, falls back to legacy hardcoded regexes.
func (s *HumanlikeScorer) scoreContent(ctx context.Context, msg HumanlikeMessage) (int, []Telltale) {
	var pts int
	var telltales []Telltale

	// Czech diakritika present (+15).
	if hasDiakritika(msg.Body) {
		pts += 15
	} else {
		telltales = append(telltales, Telltale{
			Rule:     "no_diakritika",
			Severity: "critical",
			Evidence: "no Czech diacritical characters found in body",
		})
	}

	// Phone matches pattern (+10).
	if phoneRe.MatchString(msg.Body) {
		pts += 10
	} else {
		telltales = append(telltales, Telltale{
			Rule:     "phone_missing",
			Severity: "warn",
			Evidence: `no phone number matching \d{3} ?\d{3} ?\d{3} in body`,
		})
	}

	// Sender name in sign-off zone (last 3 non-empty lines) (+15).
	if msg.SenderName != "" && nameInSignOff(msg.Body, msg.SenderName) {
		pts += 15
	} else if msg.SenderName != "" {
		telltales = append(telltales, Telltale{
			Rule:     "name_not_in_signoff",
			Severity: "warn",
			Evidence: fmt.Sprintf("sender name %q not found in last 3 lines", msg.SenderName),
		})
	}

	// GDPR footer present: controller name + ID label + ID value (+5).
	// When Loader is available, fetch from operator_settings; otherwise use legacy regexes.
	nameRe, icoRe := s.resolveGDPRRegexes(ctx)
	hasGdprName := nameRe.MatchString(msg.Body)
	hasGdprIco := icoRe.MatchString(msg.Body)
	if hasGdprName && hasGdprIco {
		pts += 5
	} else {
		telltales = append(telltales, Telltale{
			Rule:     "gdpr_footer_missing",
			Severity: "critical",
			Evidence: fmt.Sprintf("controller_name=%v id=%v", hasGdprName, hasGdprIco),
		})
	}

	// GDPR footer length: ≤4 non-empty lines → +5; >6 lines → 0 (looks like ad block).
	footerLines := countFooterLinesWithRe(msg.Body, nameRe)
	if footerLines >= 1 && footerLines <= 4 {
		pts += 5
	} else if footerLines > 6 {
		telltales = append(telltales, Telltale{
			Rule:     "gdpr_footer_too_long",
			Severity: "warn",
			Evidence: fmt.Sprintf("footer is %d lines (>6, looks like ad block)", footerLines),
		})
	}

	return pts, telltales
}

// resolveGDPRRegexes returns compiled name/ICO regexes, fetched from the
// operator_settings loader when available, falling back to the hardcoded legacy
// regexes on error or absent Loader.
func (s *HumanlikeScorer) resolveGDPRRegexes(ctx context.Context) (*regexp.Regexp, *regexp.Regexp) {
	if s.Loader == nil {
		slog.Warn("humanlike_score: Loader is nil, falling back to hardcoded GDPR regexes",
			"op", "content.resolveGDPRRegexes/nil-loader")
		return gdprNameRe, gdprIcoRe
	}

	controllerName, err := s.Loader.Get(ctx, "controller_name")
	if err != nil || controllerName == "" {
		slog.Warn("humanlike_score: could not load controller_name from operator_settings, using legacy regex",
			"op", "content.resolveGDPRRegexes/fallback", "error", err)
		return gdprNameRe, gdprIcoRe
	}

	idLabel, _ := s.Loader.Get(ctx, "controller_id_label")
	idValue, _ := s.Loader.Get(ctx, "controller_id_value")
	if idLabel == "" {
		idLabel = "PIB"
	}
	if idValue == "" {
		idValue = "03387194"
	}

	// Build dynamic regex: escape the raw strings, allow flexible whitespace.
	namePattern := `(?i)` + regexp.QuoteMeta(controllerName)
	namePattern = strings.ReplaceAll(namePattern, `\ `, `\s+`) // allow multi-space
	icoPattern := regexp.QuoteMeta(idLabel) + `\s*` + regexp.QuoteMeta(idValue)

	nameRe, err1 := regexp.Compile(namePattern)
	icoRe, err2 := regexp.Compile(icoPattern)
	if err1 != nil || err2 != nil {
		slog.Warn("humanlike_score: failed to compile dynamic GDPR regexes, using legacy",
			"op", "content.resolveGDPRRegexes/compile-err",
			"nameErr", err1, "icoErr", err2)
		return gdprNameRe, gdprIcoRe
	}
	return nameRe, icoRe
}

// ─────────────────────────────────────────────────────────────────────────────
// scoreHeuristics — starts at 20, deductions applied
// ─────────────────────────────────────────────────────────────────────────────

func scoreHeuristics(msg HumanlikeMessage) (int, []Telltale) {
	pts := 20
	var telltales []Telltale

	// Subject all-uppercase → -10 pts.
	if isAllUpper(msg.Subject) {
		pts -= 10
		telltales = append(telltales, Telltale{
			Rule:     "all_caps_subject",
			Severity: "warn",
			Evidence: fmt.Sprintf("subject is all-caps: %q", msg.Subject),
		})
	}

	// "Lorem ipsum" anywhere → -20 pts (floor at 0 below).
	if loremRe.MatchString(msg.Body) {
		pts -= 20
		telltales = append(telltales, Telltale{
			Rule:     "lorem_ipsum",
			Severity: "critical",
			Evidence: "lorem ipsum placeholder text found",
		})
	}

	// More than 2 emoji in body → -5 pts.
	if emojiCount := countEmoji(msg.Body); emojiCount > 2 {
		pts -= 5
		telltales = append(telltales, Telltale{
			Rule:     "too_many_emoji",
			Severity: "warn",
			Evidence: fmt.Sprintf("%d emoji found (max 2)", emojiCount),
		})
	}

	// "Click here" / "klikni zde" → -5 pts.
	if clickRe.MatchString(msg.Body) {
		pts -= 5
		telltales = append(telltales, Telltale{
			Rule:     "click_here_phrase",
			Severity: "warn",
			Evidence: "body contains 'click here' or 'klikni zde'",
		})
	}

	if pts < 0 {
		pts = 0
	}
	return pts, telltales
}

// ─────────────────────────────────────────────────────────────────────────────
// applyLLMWeight combines rule score and LLM judge.
// LLMJudge == -1 → Total = RuleScore.
// LLMJudge 0–100 → Total = round(0.6*rule + 0.4*llm).
// ─────────────────────────────────────────────────────────────────────────────

func applyLLMWeight(ruleScore, llmJudge int) int {
	if llmJudge < 0 {
		return ruleScore
	}
	return int(math.Round(0.6*float64(ruleScore) + 0.4*float64(llmJudge)))
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

func hasDiakritika(s string) bool {
	for _, r := range s {
		if strings.ContainsRune(czechDiakritika, r) {
			return true
		}
	}
	return false
}

// nameInSignOff checks whether senderName (or any token ≥3 chars) appears in
// the last 3 non-empty lines of body (the sign-off zone).
func nameInSignOff(body, senderName string) bool {
	if senderName == "" {
		return false
	}
	lines := nonEmptyLines(body)
	n := len(lines)
	if n == 0 {
		return false
	}
	start := n - 3
	if start < 0 {
		start = 0
	}
	signOff := strings.ToLower(strings.Join(lines[start:], " "))
	nameLower := strings.ToLower(senderName)
	if strings.Contains(signOff, nameLower) {
		return true
	}
	// Individual tokens (first / last name).
	for _, tok := range strings.Fields(senderName) {
		if len(tok) >= 3 && strings.Contains(signOff, strings.ToLower(tok)) {
			return true
		}
	}
	return false
}

// countFooterLines counts non-empty lines in the GDPR footer block using the
// legacy hardcoded controller-name regex. Kept for backward compat with tests.
func countFooterLines(body string) int {
	return countFooterLinesWithRe(body, gdprNameRe)
}

// countFooterLinesWithRe is the parameterised form used by scoreContent.
func countFooterLinesWithRe(body string, nameRe *regexp.Regexp) int {
	idx := nameRe.FindStringIndex(body)
	if idx == nil {
		return 0
	}
	footerPart := body[idx[0]:]
	count := 0
	for _, l := range strings.Split(footerPart, "\n") {
		if strings.TrimSpace(l) != "" {
			count++
		}
	}
	return count
}

func isAllUpper(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return false
	}
	hasLetter := false
	for _, r := range s {
		if unicode.IsLetter(r) {
			hasLetter = true
			if unicode.IsLower(r) {
				return false
			}
		}
	}
	return hasLetter
}

func countEmoji(s string) int {
	return len(emojiRe.FindAllString(s, -1))
}

func countSentences(s string) int {
	count := 0
	for _, r := range s {
		if r == '.' || r == '!' || r == '?' {
			count++
		}
	}
	return count
}

func nonEmptyLines(s string) []string {
	parts := strings.Split(s, "\n")
	out := make([]string, 0, len(parts))
	for _, l := range parts {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out
}

func countUnique(ss []string) int {
	m := make(map[string]struct{}, len(ss))
	for _, s := range ss {
		m[s] = struct{}{}
	}
	return len(m)
}

func mean(vs []float64) float64 {
	if len(vs) == 0 {
		return 0
	}
	var sum float64
	for _, v := range vs {
		sum += v
	}
	return sum / float64(len(vs))
}

func stddev(vs []float64) float64 {
	if len(vs) < 2 {
		return 0
	}
	m := mean(vs)
	var variance float64
	for _, v := range vs {
		d := v - m
		variance += d * d
	}
	return math.Sqrt(variance / float64(len(vs)))
}

func coefficientOfVariation(vs []float64) float64 {
	m := mean(vs)
	if m == 0 {
		return 0
	}
	return stddev(vs) / m
}

func clampScore(v, max int) int {
	if v < 0 {
		return 0
	}
	if v > max {
		return max
	}
	return v
}

func deduplicateTelltales(tt []Telltale) []Telltale {
	seen := make(map[string]struct{}, len(tt))
	out := make([]Telltale, 0, len(tt))
	for _, t := range tt {
		if _, ok := seen[t.Rule]; !ok {
			seen[t.Rule] = struct{}{}
			out = append(out, t)
		}
	}
	return out
}
