package prodlike

import (
	"math/rand/v2"
	"os"
	"strings"
	"testing"
	"time"
)

// ─── rng.go ──────────────────────────────────────────────────────────────────

func TestNewRNGFromSeed_Deterministic(t *testing.T) {
	r1 := NewRNGFromSeed(42)
	r2 := NewRNGFromSeed(42)
	v1 := r1.Int64()
	v2 := r2.Int64()
	if v1 != v2 {
		t.Fatalf("same seed produced different values: %d vs %d", v1, v2)
	}
}

func TestNewRNGFromSeed_DifferentSeeds(t *testing.T) {
	r1 := NewRNGFromSeed(1)
	r2 := NewRNGFromSeed(2)
	if r1.Int64() == r2.Int64() {
		t.Fatal("different seeds should (very likely) produce different first value")
	}
}

func TestNewRNGFromSeed_ZeroSeed_NonNil(t *testing.T) {
	r := NewRNGFromSeed(0)
	if r == nil {
		t.Fatal("expected non-nil RNG for seed=0")
	}
}

func TestNewRNG_NonNil(t *testing.T) {
	r := NewRNG()
	if r == nil {
		t.Fatal("expected non-nil RNG")
	}
}

func TestSeedFromEnv_NoEnv_DefaultSeed(t *testing.T) {
	os.Unsetenv("SEED_RNG")
	got := seedFromEnv()
	if got != DefaultSeed {
		t.Fatalf("expected DefaultSeed=%d, got %d", DefaultSeed, got)
	}
}

func TestSeedFromEnv_ValidEnv(t *testing.T) {
	os.Setenv("SEED_RNG", "999")
	defer os.Unsetenv("SEED_RNG")
	if got := seedFromEnv(); got != 999 {
		t.Fatalf("expected 999, got %d", got)
	}
}

func TestSeedFromEnv_InvalidEnv_Fallback(t *testing.T) {
	os.Setenv("SEED_RNG", "notanumber")
	defer os.Unsetenv("SEED_RNG")
	if got := seedFromEnv(); got != DefaultSeed {
		t.Fatalf("expected DefaultSeed fallback, got %d", got)
	}
}

// ─── edge_cases.go ───────────────────────────────────────────────────────────

func TestTitleCase_LowerInput(t *testing.T) {
	if got := titleCase("novak"); got != "Novak" {
		t.Fatalf("expected Novak, got %q", got)
	}
}

func TestTitleCase_AlreadyUpper(t *testing.T) {
	if got := titleCase("Novak"); got != "Novak" {
		t.Fatalf("expected Novak, got %q", got)
	}
}

func TestTitleCase_Empty(t *testing.T) {
	if got := titleCase(""); got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
}

func TestPad3_SingleDigit(t *testing.T) {
	if got := pad3(7); got != "007" {
		t.Fatalf("expected 007, got %q", got)
	}
}

func TestPad3_TwoDigit(t *testing.T) {
	if got := pad3(42); got != "042" {
		t.Fatalf("expected 042, got %q", got)
	}
}

func TestPad3_ThreeDigit(t *testing.T) {
	if got := pad3(123); got != "123" {
		t.Fatalf("expected 123, got %q", got)
	}
}

func TestItoaSmall_Zero(t *testing.T) {
	if got := itoaSmall(0); got != "0" {
		t.Fatalf("expected 0, got %q", got)
	}
}

func TestItoaSmall_Positive(t *testing.T) {
	if got := itoaSmall(42); got != "42" {
		t.Fatalf("expected 42, got %q", got)
	}
}

func TestItoaSmall_Negative(t *testing.T) {
	if got := itoaSmall(-5); got != "-5" {
		t.Fatalf("expected -5, got %q", got)
	}
}

func TestSplitLocalNameGuess_DotFormat(t *testing.T) {
	first, last := splitLocalNameGuess("jan.novak@firma.cz")
	if first != "Jan" || last != "Novak" {
		t.Fatalf("expected Jan Novak, got %q %q", first, last)
	}
}

func TestSplitLocalNameGuess_NoDot(t *testing.T) {
	first, last := splitLocalNameGuess("jnovak@firma.cz")
	if first == "" {
		t.Fatal("expected non-empty first for no-dot local part")
	}
	if last != "" {
		t.Fatalf("expected empty last for no-dot, got %q", last)
	}
}

func TestSplitLocalNameGuess_Empty(t *testing.T) {
	first, last := splitLocalNameGuess("")
	if first != "" || last != "" {
		t.Fatalf("expected empty strings for empty input, got %q %q", first, last)
	}
}

func TestSplitLocalNameGuess_NoAt(t *testing.T) {
	first, last := splitLocalNameGuess("notanemail")
	if first != "" || last != "" {
		t.Fatalf("expected empty strings for no @, got %q %q", first, last)
	}
}

func TestGenerateEdgeCases_NonEmpty(t *testing.T) {
	cases := GenerateEdgeCases()
	if len(cases) == 0 {
		t.Fatal("expected non-empty edge cases list")
	}
}

func TestGenerateEdgeCases_MostHaveEmail(t *testing.T) {
	cases := GenerateEdgeCases()
	withEmail := 0
	for _, c := range cases {
		if c.Email != "" {
			withEmail++
		}
	}
	// Most edge cases should have an email (empty_email cases are the exception)
	if withEmail == 0 {
		t.Fatal("expected at least some edge cases to have an email")
	}
}

// ─── scenarios.go ────────────────────────────────────────────────────────────

func TestAllScenarios_NonEmpty(t *testing.T) {
	names := AllScenarios()
	if len(names) == 0 {
		t.Fatal("expected non-empty scenario list")
	}
}

func TestAllScenarios_KnownNames(t *testing.T) {
	names := AllScenarios()
	set := make(map[string]bool, len(names))
	for _, n := range names {
		set[n] = true
	}
	for _, want := range []string{"campaign_running", "bounce_spiral", "replies_classified"} {
		if !set[want] {
			t.Errorf("expected scenario %q in AllScenarios", want)
		}
	}
}

func TestInt64Array_Empty(t *testing.T) {
	if got := int64Array(nil); got != "{}" {
		t.Fatalf("expected {}, got %q", got)
	}
}

func TestInt64Array_Single(t *testing.T) {
	if got := int64Array([]int64{42}); got != "{42}" {
		t.Fatalf("expected {42}, got %q", got)
	}
}

func TestInt64Array_Multiple(t *testing.T) {
	got := int64Array([]int64{1, 2, 3})
	if got != "{1,2,3}" {
		t.Fatalf("expected {1,2,3}, got %q", got)
	}
}

func TestFmtAppendInt_Zero(t *testing.T) {
	b := fmtAppendInt(nil, 0)
	if string(b) != "0" {
		t.Fatalf("expected '0', got %q", b)
	}
}

func TestFmtAppendInt_Positive(t *testing.T) {
	b := fmtAppendInt(nil, 12345)
	if string(b) != "12345" {
		t.Fatalf("expected '12345', got %q", b)
	}
}

func TestFmtAppendInt_Negative(t *testing.T) {
	b := fmtAppendInt(nil, -99)
	if string(b) != "-99" {
		t.Fatalf("expected '-99', got %q", b)
	}
}

func TestThreadStepFor_Sent(t *testing.T) {
	if got := threadStepFor("sent"); got != 1 {
		t.Fatalf("expected 1 for sent, got %d", got)
	}
}

func TestThreadStepFor_Replied(t *testing.T) {
	if got := threadStepFor("replied"); got != 1 {
		t.Fatalf("expected 1 for replied, got %d", got)
	}
}

func TestThreadStepFor_Paused(t *testing.T) {
	if got := threadStepFor("paused"); got != 2 {
		t.Fatalf("expected 2 for paused, got %d", got)
	}
}

func TestThreadStepFor_Unknown(t *testing.T) {
	if got := threadStepFor("unknown"); got != 0 {
		t.Fatalf("expected 0 for unknown, got %d", got)
	}
}

func TestThreeStepSequence_Length(t *testing.T) {
	seq := threeStepSequence()
	if len(seq) != 3 {
		t.Fatalf("expected 3 steps, got %d", len(seq))
	}
}

func TestThreeStepSequence_Steps(t *testing.T) {
	seq := threeStepSequence()
	if seq[0]["step"] != 0 || seq[1]["step"] != 1 || seq[2]["step"] != 2 {
		t.Fatal("steps not 0,1,2")
	}
}

func TestBodyForReplyType_Interested(t *testing.T) {
	body := bodyForReplyType("interested")
	if body == "" {
		t.Fatal("expected non-empty body for interested")
	}
}

func TestBodyForReplyType_AllTypes(t *testing.T) {
	for _, rt := range []string{"interested", "meeting", "later", "objection", "negative", "ooo"} {
		if body := bodyForReplyType(rt); body == "" {
			t.Errorf("empty body for reply type %q", rt)
		}
	}
}

func TestBodyForReplyType_Unknown(t *testing.T) {
	if body := bodyForReplyType("unknown_type"); body != "" {
		t.Fatalf("expected empty for unknown type, got %q", body)
	}
}

func TestRandomToken16_Length(t *testing.T) {
	tok := randomToken16()
	if len(tok) != 16 {
		t.Fatalf("expected 16-char hex token, got len=%d %q", len(tok), tok)
	}
}

func TestRandomToken16_Unique(t *testing.T) {
	t1 := randomToken16()
	t2 := randomToken16()
	if t1 == t2 {
		t.Fatal("two random tokens should differ (astronomically unlikely collision)")
	}
}

// ─── config.go ───────────────────────────────────────────────────────────────

func TestResolveCounts_Tiny(t *testing.T) {
	c := ResolveCounts(ScaleTiny)
	if c.Contacts != 60 {
		t.Fatalf("tiny: expected 60 contacts, got %d", c.Contacts)
	}
}

func TestResolveCounts_Medium(t *testing.T) {
	c := ResolveCounts(ScaleMedium)
	if c.Contacts != 10000 {
		t.Fatalf("medium: expected 10000 contacts, got %d", c.Contacts)
	}
}

func TestResolveCounts_Large(t *testing.T) {
	c := ResolveCounts(ScaleLarge)
	if c.Contacts != 100000 {
		t.Fatalf("large: expected 100000 contacts, got %d", c.Contacts)
	}
}

func TestResolveCounts_Default(t *testing.T) {
	c := ResolveCounts("unknown_scale")
	if c.Contacts != 1000 {
		t.Fatalf("default: expected 1000 contacts, got %d", c.Contacts)
	}
}

func TestDefaultRatios_SumsToOne(t *testing.T) {
	r := DefaultRatios()
	consentSum := r.ConsentAuto + r.ConsentLow + r.ConsentManual + r.ConsentBlock
	if consentSum < 0.99 || consentSum > 1.01 {
		t.Fatalf("consent ratios should sum to ~1.0, got %.4f", consentSum)
	}
}

func TestDefaultRatios_NonZeroLow(t *testing.T) {
	r := DefaultRatios()
	if r.ConsentLow == 0 {
		t.Fatal("ConsentLow should be dominant (>0)")
	}
}

// ─── seed_prodlike.go helpers ────────────────────────────────────────────────

func TestPgTextArray_Empty(t *testing.T) {
	if got := pgTextArray(nil); got != "{}" {
		t.Fatalf("expected {}, got %q", got)
	}
}

func TestPgTextArray_Single(t *testing.T) {
	got := pgTextArray([]string{"hello"})
	if got != `{"hello"}` {
		t.Fatalf("expected {\"hello\"}, got %q", got)
	}
}

func TestPgTextArray_MultipleWithQuotes(t *testing.T) {
	got := pgTextArray([]string{`say "hi"`, "world"})
	if !strings.Contains(got, `\"hi\"`) {
		t.Fatalf("expected escaped quotes in %q", got)
	}
}

func TestNullableInt_Zero_ReturnsNil(t *testing.T) {
	if nullableInt(0) != nil {
		t.Fatal("0 should map to nil")
	}
}

func TestNullableInt_NonZero_ReturnsValue(t *testing.T) {
	got := nullableInt(42)
	if got != 42 {
		t.Fatalf("expected 42, got %v", got)
	}
}

// ─── generator_contacts.go helpers ──────────────────────────────────────────

func TestEmailHashForSeed_Length(t *testing.T) {
	h := emailHashForSeed("test@example.com")
	if len(h) != 16 {
		t.Fatalf("expected 16-char hex hash, got len=%d %q", len(h), h)
	}
}

func TestEmailHashForSeed_CaseInsensitive(t *testing.T) {
	h1 := emailHashForSeed("Test@Example.COM")
	h2 := emailHashForSeed("test@example.com")
	if h1 != h2 {
		t.Fatalf("case should not affect hash: %q vs %q", h1, h2)
	}
}

func TestAsciiFold_CzechDiacritics(t *testing.T) {
	cases := [][2]string{
		{"Novák", "Novak"},
		{"Štefan", "Stefan"},
		{"Žlutý", "Zluty"},
		{"Příliš", "Prilis"},
	}
	for _, tc := range cases {
		if got := asciiFold(tc[0]); got != tc[1] {
			t.Errorf("asciiFold(%q) = %q, want %q", tc[0], got, tc[1])
		}
	}
}

func TestAsciiFold_ASCII_Unchanged(t *testing.T) {
	if got := asciiFold("hello"); got != "hello" {
		t.Fatalf("ASCII should be unchanged, got %q", got)
	}
}

// ─── generator_companies.go helpers ─────────────────────────────────────────

func TestPickMedOrLow_OnlyMedOrLow(t *testing.T) {
	rng := NewRNGFromSeed(42)
	for i := 0; i < 50; i++ {
		v := pickMedOrLow(rng)
		if v != "med" && v != "low" {
			t.Fatalf("pickMedOrLow returned unexpected value: %q", v)
		}
	}
}

func TestNormaliseCity_WithComma(t *testing.T) {
	if got := normaliseCity("Praha, Vinohrady"); got != "Praha" {
		t.Fatalf("expected Praha, got %q", got)
	}
}

func TestNormaliseCity_NoComma(t *testing.T) {
	if got := normaliseCity("Brno"); got != "Brno" {
		t.Fatalf("expected Brno unchanged, got %q", got)
	}
}

// ─── distributions.go ────────────────────────────────────────────────────────

func TestTargetingScoreForTier0_Range(t *testing.T) {
	rng := NewRNGFromSeed(1)
	for i := 0; i < 20; i++ {
		s := TargetingScoreForTier(rng, 0)
		if s < 0.70 || s > 1.00 {
			t.Fatalf("tier 0 score %f out of [0.70, 1.00]", s)
		}
	}
}

func TestTargetingScoreForTier1_Range(t *testing.T) {
	rng := NewRNGFromSeed(2)
	for i := 0; i < 20; i++ {
		s := TargetingScoreForTier(rng, 1)
		if s < 0.40 || s > 0.70 {
			t.Fatalf("tier 1 score %f out of [0.40, 0.70]", s)
		}
	}
}

func TestTargetingScoreForTier2_Range(t *testing.T) {
	rng := NewRNGFromSeed(3)
	for i := 0; i < 20; i++ {
		s := TargetingScoreForTier(rng, 2)
		if s < 0.20 || s > 0.40 {
			t.Fatalf("tier 2 score %f out of [0.20, 0.40]", s)
		}
	}
}

func TestTargetingScoreForTierDefault_Range(t *testing.T) {
	rng := NewRNGFromSeed(4)
	for i := 0; i < 20; i++ {
		s := TargetingScoreForTier(rng, 99)
		if s < 0.00 || s > 0.20 {
			t.Fatalf("tier default score %f out of [0.00, 0.20]", s)
		}
	}
}

func TestPickString_ReturnsMember(t *testing.T) {
	rng := NewRNGFromSeed(5)
	xs := []string{"a", "b", "c"}
	for i := 0; i < 20; i++ {
		got := PickString(rng, xs)
		found := false
		for _, x := range xs {
			if got == x {
				found = true
			}
		}
		if !found {
			t.Fatalf("PickString returned non-member %q", got)
		}
	}
}

func TestPickString_EmptyPanics(t *testing.T) {
	rng := NewRNGFromSeed(6)
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic for empty slice")
		}
	}()
	PickString(rng, nil)
}

func TestCityByWeight_ReturnsCity(t *testing.T) {
	rng := NewRNGFromSeed(7)
	for i := 0; i < 10; i++ {
		city := CityByWeight(rng)
		if city == "" {
			t.Fatal("CityByWeight returned empty string")
		}
	}
}

func TestBernoulliCoverage_PZero_AlwaysFalse(t *testing.T) {
	rng := NewRNGFromSeed(8)
	for i := 0; i < 20; i++ {
		if BernoulliCoverage(rng, 0) {
			t.Fatal("p=0 should always return false")
		}
	}
}

func TestBernoulliCoverage_POne_AlwaysTrue(t *testing.T) {
	rng := NewRNGFromSeed(9)
	for i := 0; i < 20; i++ {
		if !BernoulliCoverage(rng, 1.0) {
			t.Fatal("p=1 should always return true")
		}
	}
}

func TestBernoulliCoverage_Half_MixedResults(t *testing.T) {
	rng := NewRNGFromSeed(10)
	trueCount := 0
	n := 100
	for i := 0; i < n; i++ {
		if BernoulliCoverage(rng, 0.5) {
			trueCount++
		}
	}
	// Statistically should be roughly 50% — allow wide tolerance
	if trueCount < 20 || trueCount > 80 {
		t.Fatalf("BernoulliCoverage(0.5): expected ~50%% true, got %d/%d", trueCount, n)
	}
}

func TestCachedCityPicker_ReturnsCity(t *testing.T) {
	rng := NewRNGFromSeed(11)
	picker := CachedCityPicker()
	for i := 0; i < 10; i++ {
		city := picker(rng)
		if city == "" {
			t.Fatal("CachedCityPicker returned empty city")
		}
	}
}

func TestRecentTimestamp_InPast(t *testing.T) {
	rng := NewRNGFromSeed(12)
	now := time.Now()
	ts := RecentTimestamp(rng, now, 30)
	if ts.After(now) {
		t.Fatal("RecentTimestamp should be in the past")
	}
	if ts.Before(now.Add(-31 * 24 * time.Hour)) {
		t.Fatal("RecentTimestamp should be within 30 days")
	}
}

func TestRecentTimestamp_ZeroDays_ReturnsNow(t *testing.T) {
	rng := NewRNGFromSeed(13)
	now := time.Now().Truncate(time.Second)
	ts := RecentTimestamp(rng, now, 0)
	if !ts.Equal(now) {
		t.Fatalf("days=0 should return now, got %v vs %v", ts, now)
	}
}

// ─── distributions.go: WeightedIndexer ────────────────────────────────────────

func TestNewWeightedIndexer_Pick(t *testing.T) {
	weights := []float64{1, 9} // 10% vs 90%
	idx := NewWeightedIndexer(weights)
	rng := NewRNGFromSeed(14)
	for i := 0; i < 20; i++ {
		p := idx.Pick(rng)
		if p < 0 || p >= len(weights) {
			t.Fatalf("Pick returned out-of-range index %d", p)
		}
	}
}

func TestWeightedChoice_ReturnsValidIndex(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	weights := []float64{1, 2, 3}
	for i := 0; i < 20; i++ {
		idx := WeightedChoice(rng, weights)
		if idx < 0 || idx >= len(weights) {
			t.Fatalf("WeightedChoice returned out-of-range index %d", idx)
		}
	}
}
