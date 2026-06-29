// Tests for humanlike_score.go — Sprint S4 / X1 / AF.
//
// Sender fixtures: synthetic constants defined below. Production values come from
// outreach_mailboxes.sender_phone / outreach_mailboxes.sender_name (migration 057).
// Test fixtures are intentionally synthetic and contain no real PII.
//
// Sprint AF: scoreContent is now a method on HumanlikeScorer.
// Tests use a package-level scorer with nil Loader (legacy path) or a mock loader.
package content

import (
	"context"
	"strings"
	"testing"
)

// legacyScorer is a convenience scorer with nil Loader (uses hardcoded regexes).
var legacyScorer = &HumanlikeScorer{Loader: nil}

// scoreContent is a package-level shim so existing direct calls compile.
// Delegates to legacyScorer for backward compat with tests.
func scoreContent(msg HumanlikeMessage) (int, []Telltale) {
	return legacyScorer.scoreContent(context.Background(), msg)
}

// ─────────────────────────────────────────────────────────────────────────────
// Sender fixtures — synthetic values, no PII.
// Production values are stored in outreach_mailboxes.sender_phone / .sender_name
// (migration 057_outreach_mailboxes_sender_profile) and populated at call-site.
// ─────────────────────────────────────────────────────────────────────────────

const (
	fixturePhone      = "700 111 222" // synthetic — not a real mailbox number
	fixtureSenderName = "Pavel Kovář"  // synthetic — not a real person
)

// goodBody is a representative intro_machinery body that should score highly.
const goodBody = `Dobrý den,

obracím se na Vás s dotazem, zda neplánujete prodávat nějakou techniku.
Vykupuji techniku pro investory. Stačí pár fotek, ozvěte se na ` + fixturePhone + `.

Děkuji,

--
` + fixtureSenderName + `, BALKAN MOTORS INT DOO
Oktobarske revolucije 130, 81000 Podgorica, PIB 03387194`

// ─────────────────────────────────────────────────────────────────────────────
// 1. Variance: all 12 sibling subjects identical → Variance subject = 0
// ─────────────────────────────────────────────────────────────────────────────

func TestVariance_AllSubjectsIdentical(t *testing.T) {
	msgs := make([]HumanlikeMessage, 12)
	for i := range msgs {
		msgs[i] = HumanlikeMessage{
			TemplateName: "intro_machinery",
			Subject:      "Plánujete prodej techniky?",
			Body:         goodBody,
			SenderName:   fixtureSenderName,
			SenderPhone:  fixturePhone,
		}
	}
	pts, _ := scoreVariance(msgs)
	// subject component must be 0 (unique ratio = 1/12 ≈ 8% < 30%)
	// So pts from subject = 0. Body lengths are identical (CV=0), sentences identical (stddev=0).
	if pts != 0 {
		t.Errorf("all identical subjects: want variance=0, got %d", pts)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Variance: 4/12 unique subjects (33%) → subject component = +10
// ─────────────────────────────────────────────────────────────────────────────

func TestVariance_FourOfTwelveUniqueSubjects(t *testing.T) {
	subjects := []string{
		"A", "B", "C", "D", // 4 unique
		"A", "B", "C", "D",
		"A", "B", "C", "D",
	}
	msgs := make([]HumanlikeMessage, len(subjects))
	for i, s := range subjects {
		msgs[i] = HumanlikeMessage{
			TemplateName: "intro_machinery",
			Subject:      s,
			Body:         goodBody,
			SenderName:   fixtureSenderName,
			SenderPhone:  fixturePhone,
		}
	}
	// 4 unique / 12 total = 33.3% ≥ 30% → subject pts = 10
	unique := countUnique(subjects)
	ratio := float64(unique) / float64(len(subjects))
	if ratio < 0.30 {
		t.Fatalf("test setup: expected ratio ≥ 0.30, got %.3f", ratio)
	}

	pts, _ := scoreVariance(msgs)
	// All bodies identical → body CV=0 → 0 pts for body
	// All sentence counts identical → stddev=0 → 0 pts for sentences
	// Only subject contributes +10
	if pts != 10 {
		t.Errorf("4/12 unique subjects: want variance=10, got %d", pts)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Variance: body lengths all 1000 chars (zero stddev) → body component = 0
// ─────────────────────────────────────────────────────────────────────────────

func TestVariance_BodyLengthsAllSame(t *testing.T) {
	body1000 := strings.Repeat("x", 1000)
	msgs := make([]HumanlikeMessage, 6)
	for i := range msgs {
		msgs[i] = HumanlikeMessage{
			TemplateName: "followup_1",
			Subject:      "subject",
			Body:         body1000,
		}
	}
	lengths := make([]float64, len(msgs))
	for i := range msgs {
		lengths[i] = float64(len(msgs[i].Body))
	}
	cv := coefficientOfVariation(lengths)
	if cv != 0 {
		t.Errorf("all bodies 1000 chars: expected CV=0, got %.4f", cv)
	}
	// CV < 0.05 → body component = 0
	if cv >= 0.05 {
		t.Errorf("CV should be below 0.05, got %.4f", cv)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Variance: body stddev/mean = 0.10 → body component = +10
// ─────────────────────────────────────────────────────────────────────────────

func TestVariance_BodyLengthCV_0_10(t *testing.T) {
	// mean=1000, CV=0.10 → stddev=100
	// Use 2 values: 900 and 1100 → mean=1000, stddev≈100
	lengths := []float64{900, 1100}
	cv := coefficientOfVariation(lengths)
	if cv < 0.05 {
		t.Errorf("expected CV ≥ 0.05, got %.4f", cv)
	}
	msgs := []HumanlikeMessage{
		{TemplateName: "t", Subject: "s", Body: strings.Repeat("a", 900)},
		{TemplateName: "t", Subject: "s", Body: strings.Repeat("a", 1100)},
	}
	pts, _ := scoreVariance(msgs)
	// subject unique ratio = 1/2 = 50% ≥ 30% → +10 subject
	// body CV ≥ 0.05 → +10 body
	// sentences: both have 0 sentences → stddev=0 → +0
	// total = 20
	if pts != 20 {
		t.Errorf("want 20 pts (subject+body), got %d", pts)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Variance: sentence count stddev ≥ 0.5 → sentence component = +10
// ─────────────────────────────────────────────────────────────────────────────

func TestVariance_SentenceCountStddev_0_6(t *testing.T) {
	// 2 messages: one with 1 sentence (1 period), one with 2 sentences (2 periods)
	// stddev of [1,2] = 0.5 — exactly at threshold
	msgs := []HumanlikeMessage{
		{TemplateName: "t", Subject: "X", Body: "Hello world."},
		{TemplateName: "t", Subject: "Y", Body: "Hello world. How are you?"},
	}
	counts := []float64{
		float64(countSentences(msgs[0].Body)),
		float64(countSentences(msgs[1].Body)),
	}
	sd := stddev(counts)
	if sd < 0.5 {
		t.Errorf("test setup: stddev=%.3f, need ≥0.5", sd)
	}
	pts, _ := scoreVariance(msgs)
	// subject: 2 unique / 2 = 100% → +10
	// body: CV not zero (different bodies) → +10
	// sentences: stddev≥0.5 → +10
	// total = 30
	if pts != 30 {
		t.Errorf("want 30 pts (all three), got %d", pts)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Content: Czech diakritika present → diakritika component = +15
// ─────────────────────────────────────────────────────────────────────────────

func TestContent_Diakritika_Present(t *testing.T) {
	msg := HumanlikeMessage{
		TemplateName: "intro_machinery",
		Subject:      "subject",
		Body:         goodBody,
		SenderName:   fixtureSenderName,
		SenderPhone:  fixturePhone,
	}
	pts, telltales := scoreContent(msg)
	for _, tt := range telltales {
		if tt.Rule == "no_diakritika" {
			t.Errorf("unexpected no_diakritika telltale; body has diakritika")
		}
	}
	// pts should include 15 for diakritika
	if pts < 15 {
		t.Errorf("expected ≥15 pts (diakritika), got %d", pts)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Content: ASCII-only Czech body → diakritika = 0 + critical telltale
// ─────────────────────────────────────────────────────────────────────────────

func TestContent_Diakritika_Absent(t *testing.T) {
	msg := HumanlikeMessage{
		TemplateName: "intro_machinery",
		Subject:      "subject",
		Body:         "Dobry den, prosim o informace. BALKAN MOTORS INT DOO ICO 23219700",
		SenderName:   fixtureSenderName,
	}
	pts, telltales := scoreContent(msg)
	if pts >= 15 {
		t.Errorf("expected <15 (no diakritika bonus), got %d", pts)
	}
	found := false
	for _, tt := range telltales {
		if tt.Rule == "no_diakritika" && tt.Severity == "critical" {
			found = true
		}
	}
	if !found {
		t.Error("expected critical 'no_diakritika' telltale, not found")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Content: phone "702 855 326" matches → phone component = +10
// ─────────────────────────────────────────────────────────────────────────────

func TestContent_Phone_Present(t *testing.T) {
	msg := HumanlikeMessage{
		Subject:     "subject",
		Body:        "Zavolejte na 702 855 326 pro více informací. BALKAN MOTORS INT DOO PIB 03387194",
		SenderPhone: fixturePhone,
	}
	pts, telltales := scoreContent(msg)
	for _, tt := range telltales {
		if tt.Rule == "phone_missing" {
			t.Errorf("unexpected phone_missing telltale; phone is in body")
		}
	}
	if pts < 10 {
		t.Errorf("expected ≥10 pts (phone), got %d", pts)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Content: no phone in body → phone component = 0 + warn telltale
// ─────────────────────────────────────────────────────────────────────────────

func TestContent_Phone_Absent(t *testing.T) {
	msg := HumanlikeMessage{
		Subject:    "subject",
		Body:       "Dobrý den, prosím o informace. BALKAN MOTORS INT DOO PIB 03387194",
		SenderName: fixtureSenderName,
	}
	_, telltales := scoreContent(msg)
	found := false
	for _, tt := range telltales {
		if tt.Rule == "phone_missing" {
			found = true
		}
	}
	if !found {
		t.Error("expected 'phone_missing' telltale, not found")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Content: sign-off matches sender_name → signoff = +15
// ─────────────────────────────────────────────────────────────────────────────

func TestContent_SignOff_Present(t *testing.T) {
	msg := HumanlikeMessage{
		Subject:    "subject",
		Body:       "Dobrý den,\n\ntext zprávy.\n\n--\n" + fixtureSenderName + "\nBALKAN MOTORS INT DOO PIB 03387194",
		SenderName: fixtureSenderName,
	}
	pts, telltales := scoreContent(msg)
	for _, tt := range telltales {
		if tt.Rule == "name_not_in_signoff" {
			t.Errorf("unexpected name_not_in_signoff telltale; name is present")
		}
	}
	if pts < 15 {
		t.Errorf("expected ≥15 pts (sign-off), got %d", pts)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Content: footer with "BALKAN MOTORS INT DOO, PIB 03387194" → footer = +5
// ─────────────────────────────────────────────────────────────────────────────

func TestContent_Footer_Present(t *testing.T) {
	msg := HumanlikeMessage{
		Subject:    "subject",
		Body:       "Text.\n\nBALKAN MOTORS INT DOO\nPIB 03387194",
		SenderName: fixtureSenderName,
	}
	pts, telltales := scoreContent(msg)
	for _, tt := range telltales {
		if tt.Rule == "gdpr_footer_missing" {
			t.Errorf("unexpected gdpr_footer_missing telltale")
		}
	}
	if pts < 5 {
		t.Errorf("expected ≥5 pts (footer present), got %d", pts)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Content: footer 8 lines long → footer-length component = 0 + warn telltale
// ─────────────────────────────────────────────────────────────────────────────

func TestContent_Footer_TooLong(t *testing.T) {
	longFooter := "BALKAN MOTORS INT DOO\n" +
		"PIB 03387194\n" +
		"Line 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\n"
	msg := HumanlikeMessage{
		Subject: "subject",
		Body:    "Text.\n\n" + longFooter,
	}
	footerLines := countFooterLines(msg.Body)
	if footerLines <= 6 {
		t.Fatalf("test setup: expected >6 footer lines, got %d", footerLines)
	}
	_, telltales := scoreContent(msg)
	found := false
	for _, tt := range telltales {
		if tt.Rule == "gdpr_footer_too_long" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected gdpr_footer_too_long telltale for %d-line footer", footerLines)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. Heuristics: subject all CAPS → heuristics = 10 (20 - 10)
// ─────────────────────────────────────────────────────────────────────────────

func TestHeuristics_AllCapsSubject(t *testing.T) {
	msg := HumanlikeMessage{
		Subject: "PLÁNUJETE PRODEJ TECHNIKY",
		Body:    "Text.",
	}
	pts, telltales := scoreHeuristics(msg)
	if pts != 10 {
		t.Errorf("all-caps subject: want 10 pts, got %d", pts)
	}
	found := false
	for _, tt := range telltales {
		if tt.Rule == "all_caps_subject" {
			found = true
		}
	}
	if !found {
		t.Error("expected 'all_caps_subject' telltale")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. Heuristics: "Lorem ipsum" in body → heuristics = 0 (capped at 0)
// ─────────────────────────────────────────────────────────────────────────────

func TestHeuristics_LoremIpsum(t *testing.T) {
	msg := HumanlikeMessage{
		Subject: "subject",
		Body:    "Lorem ipsum dolor sit amet. Click here for more.",
	}
	pts, telltales := scoreHeuristics(msg)
	if pts != 0 {
		t.Errorf("lorem ipsum: want 0 pts (20 - 20 - 5 capped to 0), got %d", pts)
	}
	found := false
	for _, tt := range telltales {
		if tt.Rule == "lorem_ipsum" && tt.Severity == "critical" {
			found = true
		}
	}
	if !found {
		t.Error("expected critical 'lorem_ipsum' telltale")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. Combined: ideal message → score ≥ 85
// ─────────────────────────────────────────────────────────────────────────────

func TestCombined_IdealMessage_HighScore(t *testing.T) {
	// 12 sibling messages with varied subjects and bodies.
	// Use mixed-case multi-word subjects to avoid all_caps_subject deduction.
	subjects := []string{
		"Plánujete prodej techniky?",
		"Re: Stavební stroje — dotaz",
		"Nákladní vozidla — poptávka",
		"Stavební technika k prodeji?",
		"Vykup techniky — zájem",
		"Stroje a vozidla",
		"Prodej zemědělské techniky",
		"Dotaz na techniku",
		"Zájem o výkup strojů",
		"Technika k prodeji",
		"Poptávka — strojní zařízení",
		"Váš zájem o prodej techniky",
	}
	bodyBase := "Dobrý den,\n\nobracím se na Vás s dotazem, zda neplánujete prodávat nějakou techniku — nákladní nebo užitkové vozidlo.\n\nVykupuji techniku pro investory. Stačí pár fotek, ozvěte se na " + fixturePhone + ".\n\nDěkuji,\n\n--\n" + fixtureSenderName + "\nBALKAN MOTORS INT DOO\nOktobarske revolucije 130, Podgorica, PIB 03387194"
	// Extra text to create body-length and sentence-count variance across siblings.
	// Half of the messages get a longer extension (~150 chars) to push body CV above 0.05
	// and sentence stddev above 0.5.
	extras := []string{
		"",
		"\n\nPřípadně se ozvěte na mobil. Rádi se domluvíme osobně nebo po telefonu.",
		"\n\nMůžete nás kontaktovat i emailem. Jsme k dispozici každý pracovní den.",
		"",
		"\n\nStačí krátká zpráva s fotkami. Dáme dobrou cenu a domluvíme se rychle.",
		"\n\nMáme zájem o různé typy strojů. Váš zájem nám napište nebo zavolejte.",
		"",
		"\n\nJsme k dispozici celý týden. Neváhejte nás kontaktovat kdykoliv.",
		"",
		"\n\nNeváhejte nás kontaktovat. Odpovíme co nejdříve a domluvíme se.",
		"",
		"\n\nTěšíme se na Vaši odpověď. Domluvíme se rychle a bez zbytečných průtahů.",
	}
	msgs := make([]HumanlikeMessage, 12)
	for i, s := range subjects {
		msgs[i] = HumanlikeMessage{
			TemplateName: "intro_machinery",
			Subject:      s,
			Body:         bodyBase + extras[i],
			SenderName:   fixtureSenderName,
			SenderPhone:  fixturePhone,
		}
	}
	results := ScoreHumanlikeBatch(msgs)
	score, ok := results["intro_machinery"]
	if !ok {
		t.Fatal("no score for intro_machinery")
	}
	if score.Total < 85 {
		t.Errorf("ideal message: want Total ≥ 85, got %d (rule=%d, variance=%d, content=%d, heuristics=%d)",
			score.Total, score.RuleScore, score.Variance, score.Content, score.Heuristics)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 16. Combined: worst message → score ≤ 20
// ─────────────────────────────────────────────────────────────────────────────

func TestCombined_WorstMessage_LowScore(t *testing.T) {
	// All identical subjects (no variance), ASCII body, no phone, lorem ipsum.
	msgs := make([]HumanlikeMessage, 6)
	for i := range msgs {
		msgs[i] = HumanlikeMessage{
			TemplateName: "bad_template",
			Subject:      "CLICK HERE NOW",
			Body:         "Lorem ipsum dolor sit amet. Click here to unsubscribe.",
			SenderName:   fixtureSenderName,
			SenderPhone:  fixturePhone,
		}
	}
	results := ScoreHumanlikeBatch(msgs)
	score, ok := results["bad_template"]
	if !ok {
		t.Fatal("no score for bad_template")
	}
	if score.Total > 20 {
		t.Errorf("worst message: want Total ≤ 20, got %d (rule=%d, variance=%d, content=%d, heuristics=%d)",
			score.Total, score.RuleScore, score.Variance, score.Content, score.Heuristics)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 17. LLM judge = -1 → Total = RuleScore (no weight applied)
// ─────────────────────────────────────────────────────────────────────────────

func TestApplyLLMWeight_Stubbed(t *testing.T) {
	ruleScore := 72
	total := applyLLMWeight(ruleScore, -1)
	if total != ruleScore {
		t.Errorf("LLMJudge=-1: want Total=%d, got %d", ruleScore, total)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 18. LLM judge = 80 → Total = round(0.6*rule + 0.4*80)
// ─────────────────────────────────────────────────────────────────────────────

func TestApplyLLMWeight_WithJudge(t *testing.T) {
	rule := 60
	llm := 80
	got := applyLLMWeight(rule, llm)
	// 0.6*60 + 0.4*80 = 36 + 32 = 68
	want := 68
	if got != want {
		t.Errorf("applyLLMWeight(%d, %d) = %d, want %d", rule, llm, got, want)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Bonus: unit tests for individual helpers
// ─────────────────────────────────────────────────────────────────────────────

func TestIsAllUpper(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"HELLO", true},
		{"Hello", false},
		{"hello", false},
		{"HELLO WORLD", true},
		{"", false},
		{"123", false},      // no letters
		{"ABC 123", true},   // letters all upper
		{"ABc 123", false},
	}
	for _, tc := range cases {
		got := isAllUpper(tc.in)
		if got != tc.want {
			t.Errorf("isAllUpper(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestNameInSignOff(t *testing.T) {
	// Uses fixtureSenderName ("Pavel Kovář") — synthetic, no real PII.
	name := fixtureSenderName
	cases := []struct {
		body   string
		name   string
		expect bool
	}{
		{"line1\nline2\n" + name, name, true},
		{"line1\nline2\nJan Novák\n" + name, name, true},
		{"line1\nline2\nline3\nline4\n" + name, name, true},
		{"body text only", name, false},
		{"line1\nJan Novák", name, false},
		{"", name, false},
		{"body\nsomething", "", false},
	}
	for _, tc := range cases {
		got := nameInSignOff(tc.body, tc.name)
		if got != tc.expect {
			t.Errorf("nameInSignOff body=%q name=%q: got %v, want %v",
				tc.body, tc.name, got, tc.expect)
		}
	}
}

func TestHasDiakritika(t *testing.T) {
	if !hasDiakritika("Dobrý den") {
		t.Error("'Dobrý den' should have diakritika")
	}
	if hasDiakritika("Dobry den") {
		t.Error("'Dobry den' should not have diakritika")
	}
}

func TestCountSentences(t *testing.T) {
	if n := countSentences("Hello. World."); n != 2 {
		t.Errorf("expected 2, got %d", n)
	}
	if n := countSentences("One! Two? Three."); n != 3 {
		t.Errorf("expected 3, got %d", n)
	}
	if n := countSentences("no terminators"); n != 0 {
		t.Errorf("expected 0, got %d", n)
	}
}

func TestCountFooterLines(t *testing.T) {
	body := "Body text.\n\nBALKAN MOTORS INT DOO\nPIB 03387194\nPodgorica"
	n := countFooterLines(body)
	if n != 3 {
		t.Errorf("expected 3 footer lines, got %d", n)
	}
	noFooter := "Body text only."
	if n := countFooterLines(noFooter); n != 0 {
		t.Errorf("expected 0 for missing footer, got %d", n)
	}
}

func TestScoreHumanlikeMessage_SingleMessage(t *testing.T) {
	msg := HumanlikeMessage{
		TemplateName: "intro_machinery",
		Subject:      "Plánujete prodej techniky?",
		Body:         goodBody,
		SenderName:   fixtureSenderName,
		SenderPhone:  fixturePhone,
	}
	score := ScoreHumanlikeMessage(msg)
	if score.Variance != 0 {
		t.Errorf("single message: Variance must be 0 (requires siblings), got %d", score.Variance)
	}
	if score.LLMJudge != -1 {
		t.Errorf("LLMJudge should be -1 (stubbed), got %d", score.LLMJudge)
	}
	if score.Total != score.RuleScore {
		t.Errorf("when LLMJudge=-1: Total should equal RuleScore; got Total=%d RuleScore=%d",
			score.Total, score.RuleScore)
	}
}

func TestScoreHumanlikeBatch_EmptySlice(t *testing.T) {
	results := ScoreHumanlikeBatch(nil)
	if len(results) != 0 {
		t.Errorf("empty input: expected 0 results, got %d", len(results))
	}
}

func TestLLMJudgeHumanlike_ReturnsMinusOne(t *testing.T) {
	result := LLMJudgeHumanlike("any body text")
	if result != -1 {
		t.Errorf("LLMJudgeHumanlike: expected -1 (stubbed), got %d", result)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Sprint AF: HumanlikeScorer with dynamic loader
// ─────────────────────────────────────────────────────────────────────────────

// mockLoader is a simple in-memory OperatorLoader for tests.
type mockLoader struct {
	m map[string]string
}

func newMockLoader(pairs ...string) *mockLoader {
	m := make(map[string]string, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		m[pairs[i]] = pairs[i+1]
	}
	return &mockLoader{m: m}
}

func (ml *mockLoader) Get(_ context.Context, key string) (string, error) {
	return ml.m[key], nil
}

// AF.1: Scorer with loader returning BALKAN MOTORS sees footer → +5 pts.
func TestScorer_DynamicLoader_ControllerNameInFooter_ScoresPositive(t *testing.T) {
	loader := newMockLoader(
		"controller_name", "BALKAN MOTORS INT DOO",
		"controller_id_label", "PIB",
		"controller_id_value", "03387194",
	)
	scorer := &HumanlikeScorer{Loader: loader}
	msg := HumanlikeMessage{
		Subject: "subject",
		Body:    "Text.\n\nBALKAN MOTORS INT DOO\nPIB 03387194",
	}
	pts, telltales := scorer.scoreContent(context.Background(), msg)
	for _, tt := range telltales {
		if tt.Rule == "gdpr_footer_missing" {
			t.Errorf("unexpected gdpr_footer_missing; body has footer. pts=%d", pts)
		}
	}
	if pts < 5 {
		t.Errorf("dynamic loader: expected ≥5 pts for footer present, got %d", pts)
	}
}

// AF.2: Scorer with loader returning different controller name still matches.
func TestScorer_DynamicLoader_CustomControllerName(t *testing.T) {
	loader := newMockLoader(
		"controller_name", "CUSTOM CORP LTD",
		"controller_id_label", "REG",
		"controller_id_value", "12345678",
	)
	scorer := &HumanlikeScorer{Loader: loader}
	msg := HumanlikeMessage{
		Subject: "subject",
		Body:    "Text.\n\nCUSTOM CORP LTD\nREG 12345678",
	}
	pts, telltales := scorer.scoreContent(context.Background(), msg)
	for _, tt := range telltales {
		if tt.Rule == "gdpr_footer_missing" {
			t.Errorf("custom controller: unexpected gdpr_footer_missing. pts=%d", pts)
		}
	}
	if pts < 5 {
		t.Errorf("custom controller: expected ≥5 pts for footer, got %d", pts)
	}
}

// AF.3: Scorer with loader but missing config falls back to legacy regex.
func TestScorer_DynamicLoader_FallbackOnMissingConfig(t *testing.T) {
	// Loader returns empty string for controller_name → fallback to hardcoded.
	loader := newMockLoader() // no keys
	scorer := &HumanlikeScorer{Loader: loader}
	msg := HumanlikeMessage{
		Subject: "subject",
		Body:    "Text.\n\nBALKAN MOTORS INT DOO\nPIB 03387194", // matches legacy regex
	}
	pts, telltales := scorer.scoreContent(context.Background(), msg)
	for _, tt := range telltales {
		if tt.Rule == "gdpr_footer_missing" {
			t.Errorf("fallback: unexpected gdpr_footer_missing. pts=%d", pts)
		}
	}
	if pts < 5 {
		t.Errorf("fallback: expected ≥5 pts (legacy regex matched), got %d", pts)
	}
}

// AF.4: Scorer with nil Loader logs a warning and uses legacy regex.
func TestScorer_NilLoader_UsesLegacyRegex(t *testing.T) {
	scorer := &HumanlikeScorer{Loader: nil}
	msg := HumanlikeMessage{
		Subject: "subject",
		Body:    "Dobrý den.\n\nBALKAN MOTORS INT DOO\nPIB 03387194",
	}
	pts, telltales := scorer.scoreContent(context.Background(), msg)
	for _, tt := range telltales {
		if tt.Rule == "gdpr_footer_missing" {
			t.Errorf("nil loader: unexpected gdpr_footer_missing. pts=%d", pts)
		}
	}
	if pts < 5 {
		t.Errorf("nil loader: expected ≥5 pts (legacy regex), got %d", pts)
	}
}

// AF.5: ScoreMessage uses the Loader's controller values end-to-end.
func TestScorer_ScoreMessage_UsesLoader(t *testing.T) {
	loader := newMockLoader(
		"controller_name", "BALKAN MOTORS INT DOO",
		"controller_id_label", "PIB",
		"controller_id_value", "03387194",
	)
	scorer := &HumanlikeScorer{Loader: loader}
	msg := HumanlikeMessage{
		Subject:    "Plánujete prodej techniky?",
		Body:       goodBody, // contains BALKAN MOTORS INT DOO + PIB 03387194
		SenderName: fixtureSenderName,
		SenderPhone: fixturePhone,
	}
	score := scorer.ScoreMessage(context.Background(), msg)
	if score.Content < 5 {
		t.Errorf("ScoreMessage with loader: expected Content ≥5 (footer pts), got %d", score.Content)
	}
}

// AF.6: ScoreBatch delegates to scoreContent for each message via Loader.
func TestScorer_ScoreBatch_UsesLoader(t *testing.T) {
	loader := newMockLoader(
		"controller_name", "BALKAN MOTORS INT DOO",
		"controller_id_label", "PIB",
		"controller_id_value", "03387194",
	)
	scorer := &HumanlikeScorer{Loader: loader}
	msgs := []HumanlikeMessage{
		{TemplateName: "t", Subject: "s1", Body: goodBody, SenderName: fixtureSenderName, SenderPhone: fixturePhone},
		{TemplateName: "t", Subject: "s2", Body: goodBody, SenderName: fixtureSenderName, SenderPhone: fixturePhone},
	}
	results := scorer.ScoreBatch(context.Background(), msgs)
	score, ok := results["t"]
	if !ok {
		t.Fatal("no score for template 't'")
	}
	if score.Content < 5 {
		t.Errorf("ScoreBatch with loader: expected Content ≥5, got %d", score.Content)
	}
}
