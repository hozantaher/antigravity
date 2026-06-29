package humanize

import (
	"testing"
	"testing/quick"
	"time"
)

// ── ClassifyReply: output bounded ────────────────────────────────────────────
//
// ReplyType is an int; the valid set is the six defined constants.
// No matter what text ClassifyReply receives, it must return one of them.

func TestClassifyReply_Property_OutputBounded(t *testing.T) {
	resp := NewResponseEngine()
	validTypes := map[ReplyType]bool{
		ReplyInterested: true,
		ReplyMeeting:    true,
		ReplyLater:      true,
		ReplyObjection:  true,
		ReplyNegative:   true,
		ReplyAutoOOO:    true,
	}
	f := func(body string) bool {
		rt := resp.ClassifyReply(body)
		return validTypes[rt]
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── ClassifyReply: never panics ──────────────────────────────────────────────

func TestClassifyReply_NeverPanics_Property(t *testing.T) {
	resp := NewResponseEngine()
	f := func(body string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("ClassifyReply panicked on %q: %v", body, r)
			}
		}()
		_ = resp.ClassifyReply(body)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── ClassifyReply: empty body returns valid type ─────────────────────────────
//
// Empty string has no keywords → falls through to default (ReplyInterested).

func TestClassifyReply_EmptyBody_ReturnsInterested(t *testing.T) {
	resp := NewResponseEngine()
	rt := resp.ClassifyReply("")
	// Default path: ReplyInterested (better fast than slow)
	if rt != ReplyInterested {
		t.Errorf("empty body: expected ReplyInterested (%d), got %d", ReplyInterested, rt)
	}
}

// ── ClassifyReply: whitespace-only body ─────────────────────────────────────

func TestClassifyReply_WhitespaceOnly_NoPanic(t *testing.T) {
	resp := NewResponseEngine()
	cases := []string{" ", "\t", "\n", "   \n\t\r\n   "}
	for _, c := range cases {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("panic on %q: %v", c, r)
				}
			}()
			_ = resp.ClassifyReply(c)
		}()
	}
}

// ── ClassifyReply: keyword priority ordering ─────────────────────────────────
//
// When multiple keyword groups match, the first matched group wins.
// OOO keywords take highest priority (checked first), then negative, meeting,
// interested, later, then default.

func TestClassifyReply_OOO_TakesPriorityOverNegative(t *testing.T) {
	resp := NewResponseEngine()
	// Text contains both OOO and negative keywords — OOO wins.
	combined := "mimo kancelář do 15.4. nemáme zájem"
	rt := resp.ClassifyReply(combined)
	if rt != ReplyAutoOOO {
		t.Errorf("OOO + negative combined: expected ReplyAutoOOO, got %d", rt)
	}
}

func TestClassifyReply_NegativeBeforeMeeting(t *testing.T) {
	resp := NewResponseEngine()
	// Contains both negative and meeting keywords.
	combined := "nemáme zájem, zavolejte mi prosím"
	rt := resp.ClassifyReply(combined)
	if rt != ReplyNegative {
		t.Errorf("negative + meeting combined: expected ReplyNegative, got %d", rt)
	}
}

// ── ClassifyReply: all keyword groups reachable ──────────────────────────────

func TestClassifyReply_AllKeywordGroups(t *testing.T) {
	resp := NewResponseEngine()
	cases := []struct {
		name     string
		text     string
		expected ReplyType
	}{
		{"ooo_czech", "Jsem mimo kancelář do 15.4.", ReplyAutoOOO},
		{"ooo_en", "out of office until Monday", ReplyAutoOOO},
		{"ooo_vacation", "jsem na dovolená teď", ReplyAutoOOO},
		{"ooo_absent", "jsem nepřítomn v kanceláři", ReplyAutoOOO},
		{"negative_unsubscribe", "prosím odhlásit z odběru", ReplyNegative},
		{"negative_uninterested", "nemáme zájem, děkuji", ReplyNegative},
		{"negative_spam", "to je spam", ReplyNegative},
		{"meeting_call", "call mi zítra", ReplyMeeting},
		{"meeting_schedk", "sejděme se na schůzku", ReplyMeeting},
		{"meeting_term", "dohodněme termín", ReplyMeeting},
		{"interested_price", "kolik to stojí?", ReplyInterested},
		{"interested_offer", "pošlete nabídku", ReplyInterested},
		{"interested_catalog", "zašlete ceník", ReplyInterested},
		{"later_next_autumn", "ozvěte se na podzim", ReplyLater},
		{"later_later", "kontaktujte mě později", ReplyLater},
		{"later_now_no", "teď ne, možná příště", ReplyLater},
		{"default_generic", "Dobrý den, zapsali jsme.", ReplyInterested},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := resp.ClassifyReply(tc.text); got != tc.expected {
				t.Errorf("ClassifyReply(%q) = %d, want %d", tc.text, got, tc.expected)
			}
		})
	}
}

// ── ClassifyReply: case insensitivity ────────────────────────────────────────
//
// toLower is applied before matching — uppercase versions must behave the same.

func TestClassifyReply_CaseInsensitive(t *testing.T) {
	resp := NewResponseEngine()
	// Czech uppercase of "nemáme zájem"
	if rt := resp.ClassifyReply("NEMÁME ZÁJEM"); rt != ReplyNegative {
		t.Errorf("uppercase negative: expected ReplyNegative, got %d", rt)
	}
	if rt := resp.ClassifyReply("OUT OF OFFICE"); rt != ReplyAutoOOO {
		t.Errorf("uppercase OOO: expected ReplyAutoOOO, got %d", rt)
	}
}

// ── ClassifyReply: very long strings ─────────────────────────────────────────

func TestClassifyReply_VeryLongString_NoPanic(t *testing.T) {
	resp := NewResponseEngine()
	long := make([]byte, 1<<16) // 64 KB of zeros
	for i := range long {
		long[i] = 'a' + byte(i%26)
	}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on 64KB string: %v", r)
		}
	}()
	_ = resp.ClassifyReply(string(long))
}

// ── normalRand: range and distribution properties ────────────────────────────
//
// normalRand uses Box-Muller transform; the u1 < 1e-10 guard protects
// against log(0). We exercise it with many samples to maximize coverage
// of the clamp branch.

func TestNormalRand_Property_NeverPanics(t *testing.T) {
	for i := 0; i < 5000; i++ {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("normalRand panicked at iteration %d: %v", i, r)
				}
			}()
			_ = normalRand()
		}()
	}
}

func TestNormalRand_Property_FiniteOutput(t *testing.T) {
	for i := 0; i < 2000; i++ {
		v := normalRand()
		if v != v { // NaN check
			t.Fatalf("normalRand returned NaN at iteration %d", i)
		}
		// Box-Muller on u1∈[1e-10,1): extreme value is sqrt(-2*log(1e-10)) * 1 ≈ 6.8
		// We allow ±50 to account for theoretical tails in a stress test.
		if v > 50 || v < -50 {
			t.Fatalf("normalRand value %f is out of reasonable range [−50, 50]", v)
		}
	}
}

func TestNormalRand_Property_ZeroMean(t *testing.T) {
	// Over 5000 samples the sample mean must be close to 0.
	sum := 0.0
	const n = 5000
	for i := 0; i < n; i++ {
		sum += normalRand()
	}
	mean := sum / n
	if mean > 0.15 || mean < -0.15 {
		t.Errorf("normalRand mean = %f, expected near 0 (tolerance ±0.15)", mean)
	}
}

// TestNormalRand_U1Clamp exercises the u1 < 1e-10 guard by calling normalRand
// at very high volume. With 2^53 possible float64 values for u1 the probability
// per call is ~10^-10; over 50 000 calls we accumulate negligible probability
// but we still exercise the surrounding code paths.
func TestNormalRand_U1Clamp_HighVolume(t *testing.T) {
	const n = 50_000
	finite := 0
	for i := 0; i < n; i++ {
		v := normalRand()
		if v == v { // not NaN
			finite++
		}
	}
	if finite != n {
		t.Errorf("normalRand produced %d NaN values in %d calls", n-finite, n)
	}
}

// ── ReplyDelay: all reply types return bounded durations ─────────────────────

func TestReplyDelay_AllTypes_Property(t *testing.T) {
	resp := NewResponseEngine()
	types := []ReplyType{
		ReplyInterested, ReplyMeeting, ReplyLater,
		ReplyObjection, ReplyNegative, ReplyAutoOOO,
	}
	for _, rt := range types {
		for i := 0; i < 200; i++ {
			d := resp.ReplyDelay(rt)
			if rt == ReplyAutoOOO {
				if d != 0 {
					t.Errorf("OOO delay must be 0, got %v", d)
				}
				continue
			}
			if d < 5*time.Minute {
				t.Errorf("type=%d iter=%d: delay %v below 5-min floor", rt, i, d)
			}
			if d > 24*time.Hour {
				t.Errorf("type=%d iter=%d: delay %v above 24h cap", rt, i, d)
			}
		}
	}
}

// ── ReplyDelay: never panics on unknown type ─────────────────────────────────

func TestReplyDelay_UnknownType_NoPanic(t *testing.T) {
	resp := NewResponseEngine()
	for _, rt := range []ReplyType{ReplyType(-1), ReplyType(100), ReplyType(999)} {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("panic on ReplyType(%d): %v", int(rt), r)
				}
			}()
			_ = resp.ReplyDelay(rt)
		}()
	}
}
