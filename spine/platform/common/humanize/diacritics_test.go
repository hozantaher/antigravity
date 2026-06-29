package humanize

import (
	"math"
	"strings"
	"testing"
	"time"
	"unicode"
)

func TestRestoreDiacritics_KeepProb1_AlwaysRestores(t *testing.T) {
	cases := []struct{ in, want string }{
		{"dobry den", "dobrý den"},
		{"vazeny pane", "vážený pane"},
		{"hledame stroje", "hledáme stroje"},
		{"dekuji", "děkuji"},
		{"vase poptavka", "vaše poptávka"},
		{"prikladam cenik", "přikládám ceník"},
		{"nas stroj", "náš stroj"},
		{"tesim se", "těším se"},
		{"prejeme dobry den", "přejeme dobrý den"},
		{"behem pristich tydnu", "během příštích týdnů"},
	}
	for _, c := range cases {
		got := RestoreDiacritics(c.in, 1.0)
		if got != c.want {
			t.Errorf("RestoreDiacritics(%q, 1.0) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestRestoreDiacritics_KeepProb0_NeverRestores(t *testing.T) {
	in := "dobry den, vazeny pane Novak. dekuji za vase odpovedi."
	got := RestoreDiacritics(in, 0.0)
	if got != in {
		t.Errorf("RestoreDiacritics(_, 0.0) should be no-op; got %q want %q", got, in)
	}
}

func TestRestoreDiacritics_PreservesPunctuation(t *testing.T) {
	in := "Dobry den, pane Novak. Dekuji."
	got := RestoreDiacritics(in, 1.0)
	if !strings.Contains(got, ",") || !strings.Contains(got, ".") {
		t.Errorf("punctuation lost: %q", got)
	}
	if !strings.Contains(got, "Novak") {
		t.Errorf("non-dictionary word should be untouched: %q", got)
	}
}

func TestRestoreDiacritics_CasePreservation(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Dobry", "Dobrý"},
		{"DOBRY", "DOBRÝ"},
		{"dobry", "dobrý"},
		{"Vazeny", "Vážený"},
		{"VAZENY", "VÁŽENÝ"},
	}
	for _, c := range cases {
		got := RestoreDiacritics(c.in, 1.0)
		if got != c.want {
			t.Errorf("RestoreDiacritics(%q, 1.0) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestRestoreDiacritics_EmptyInput(t *testing.T) {
	if got := RestoreDiacritics("", 1.0); got != "" {
		t.Errorf("empty input should stay empty, got %q", got)
	}
	if got := RestoreDiacritics("", 0.0); got != "" {
		t.Errorf("empty input zero prob should stay empty, got %q", got)
	}
}

// TestRestoreDiacritics_Idempotent — already-diacritised words MUST
// NOT be double-substituted (FIX 1 spec edge case).
func TestRestoreDiacritics_Idempotent(t *testing.T) {
	in := "dobrý den, hledáme stroje"
	got := RestoreDiacritics(in, 1.0)
	if got != in {
		t.Errorf("already-diacritised input must pass through unchanged; got %q", got)
	}
}

func TestRestoreDiacritics_ProbabilisticDistribution(t *testing.T) {
	const trials = 400
	const expectedMid = trials / 2
	var restored int
	for i := 0; i < trials; i++ {
		got := RestoreDiacritics("dobry", 0.5)
		if got == "dobrý" {
			restored++
		}
	}
	if restored < expectedMid/2 || restored > 3*expectedMid/2 {
		t.Errorf("expected ~%d restorations at keepProb=0.5, got %d/%d", expectedMid, restored, trials)
	}
}

func TestRestoreDiacritics_MultiWord(t *testing.T) {
	in := "dobry den vazeny pane hledame stroje dekuji"
	got := RestoreDiacritics(in, 1.0)
	for _, want := range []string{"dobrý", "vážený", "hledáme", "děkuji"} {
		if !strings.Contains(got, want) {
			t.Errorf("multi-word restore missing %q in %q", want, got)
		}
	}
	for _, keep := range []string{"den", "pane", "stroje"} {
		if !strings.Contains(got, keep) {
			t.Errorf("non-dictionary word %q lost from %q", keep, got)
		}
	}
}

func TestRestoreDiacritics_HasDiacriticAfterRestore(t *testing.T) {
	in := "Dobry den, hledame stroje. Dekuji za odpoved."
	got := RestoreDiacritics(in, 1.0)
	hasDiacritic := false
	for _, r := range got {
		if r > unicode.MaxASCII {
			hasDiacritic = true
			break
		}
	}
	if !hasDiacritic {
		t.Errorf("restored output must contain at least one non-ASCII rune: %q", got)
	}
}

func TestRestoreDiacritics_DoesNotTouchAlnumIDs(t *testing.T) {
	in := "vazeny abc123 pane"
	got := RestoreDiacritics(in, 1.0)
	if !strings.Contains(got, "abc123") {
		t.Errorf("alnum token corrupted: %q", got)
	}
}

// TestRestoreDiacritics_50Sentences_80PercentDensity — FIX 1 success
// criterion: 50 distinct ASCII Czech sentences → at least 80% of
// dictionary-eligible words restored at keepProb=1.0.
func TestRestoreDiacritics_50Sentences_80PercentDensity(t *testing.T) {
	sentences := []string{
		"dobry den vazeny pane",
		"hledame stroje pro nasi firmu",
		"dekuji za vasi rychlou odpoved",
		"prikladam cenik a nasi nabidku",
		"posilam vam poptavku na stroje",
		"prejeme dobry den a hezky tyden",
		"behem pristich dnu vam zavolam",
		"radi bychom se s vami spojili",
		"muzete prosim potvrdit nasi nabidku",
		"chteli bychom rozsirit nasi spolupraci",
		"vase poptavka byla zaregistrovana",
		"telefon: +420 123 456",
		"emailu posilam vasi cenovou nabidku",
		"reaguji na vas dotaz ohledne stroje",
		"navazuji na nasi predchozi komunikaci",
		"klidne se ozvete kdykoli behem dne",
		"snadno vam pripravime nabidku",
		"urcite vam odpovime jeste dnes",
		"vas zajem nas potesil",
		"mame pro vas vetsi nabidku",
		"velmi nas potesila vase poptavka",
		"radi vam vyjdeme vstric s cenou",
		"jeste tento tyden vam posilam nabidku",
		"v zajmu spoluprace vam vyjdeme vstric",
		"vime ze hledate konkretni stroje",
		"ozvu se vam behem zitrejsiho dne",
		"reseni mame pripraveno",
		"odpovidame na vasi poptavku z minuleho tydne",
		"odpovedi vam zaslem do konce tydne",
		"prubeh nasi spolupraci jsme nastavili",
		"behem pristich mesicu rozsirime nabidku",
		"telefon i email jsou v podpisu",
		"zpravu vam zaslem co nejdrive",
		"ceniku se priklada nase nabidka",
		"krasny den vam preji",
		"spolupracujeme rad",
		"loucim se a preji hezky den",
		"s pozdravem a uctou",
		"chtel bych vam predstavit nasi firmu",
		"rad bych vam predstavil nase stroje",
		"zitra vam zavolam ohledne nabidky",
		"dnes jsem vam poslal cenik",
		"vcera jsem se ozyval ohledne poptavky",
		"v ramci nasi spoluprace vam nabizime",
		"opravdu nas potesila vase odpoved",
		"ozvete se prosim nejpozdeji do patku",
		"reaguji na vasi zpravu z dnesniho rana",
		"navazuji na minulou poptavku z minuleho tydne",
		"behem pristich dnu mate moznost odpovedet",
		"chteji nase stroje pristich roku rozsirit",
	}

	const minRestoreRate = 0.80
	totalRestored := 0
	totalEligible := 0

	for _, s := range sentences {
		for _, w := range strings.Fields(s) {
			cleaned := strings.TrimFunc(w, func(r rune) bool {
				return !unicode.IsLetter(r)
			})
			if cleaned == "" {
				continue
			}
			lower := strings.ToLower(cleaned)
			if _, ok := diacriticsRestoreMap[lower]; ok {
				totalEligible++
			}
		}
		got := RestoreDiacritics(s, 1.0)
		for _, w := range strings.Fields(got) {
			for _, r := range w {
				if r > unicode.MaxASCII {
					totalRestored++
					break
				}
			}
		}
	}

	if totalEligible == 0 {
		t.Fatal("test corpus contained no dictionary-eligible words — bad corpus")
	}
	rate := float64(totalRestored) / float64(totalEligible)
	if rate < minRestoreRate {
		t.Errorf("restore rate %.2f%% below %.0f%% threshold (restored=%d, eligible=%d)",
			rate*100, minRestoreRate*100, totalRestored, totalEligible)
	}
}

func TestApplyCase_AllUpper(t *testing.T) {
	if got := applyCase("DOBRY", "dobrý"); got != "DOBRÝ" {
		t.Errorf("applyCase all-upper = %q, want DOBRÝ", got)
	}
}

func TestApplyCase_Capitalized(t *testing.T) {
	if got := applyCase("Dobry", "dobrý"); got != "Dobrý" {
		t.Errorf("applyCase capitalised = %q, want Dobrý", got)
	}
}

func TestApplyCase_AllLower(t *testing.T) {
	if got := applyCase("dobry", "dobrý"); got != "dobrý" {
		t.Errorf("applyCase all-lower = %q, want dobrý", got)
	}
}

func TestApplyCase_EmptySource(t *testing.T) {
	if got := applyCase("", "dobrý"); got != "dobrý" {
		t.Errorf("applyCase empty source = %q, want dobrý", got)
	}
}

// TestRestoreDiacritics_NegativeProbTreatedAsZero — invalid keepProb < 0
// must behave identically to keepProb == 0 (no-op). Defensive contract:
// callers that compute probabilities from data sources may emit small
// negative deltas, and silently restoring them would be a foot-gun.
func TestRestoreDiacritics_NegativeProbTreatedAsZero(t *testing.T) {
	in := "dobry den, hledame stroje"
	for _, prob := range []float64{-0.0001, -0.5, -1.0, -1e9} {
		got := RestoreDiacritics(in, prob)
		if got != in {
			t.Errorf("RestoreDiacritics(_, %v) should be no-op; got %q", prob, got)
		}
	}
}

// TestRestoreDiacritics_AboveOneClampedToOne — keepProb > 1 must clamp
// to 1.0 (always-restore), matching the documented contract.
func TestRestoreDiacritics_AboveOneClampedToOne(t *testing.T) {
	in := "dobry den, hledame stroje"
	want := "dobrý den, hledáme stroje"
	for _, prob := range []float64{1.0001, 1.5, 2.0, 100.0} {
		got := RestoreDiacritics(in, prob)
		if got != want {
			t.Errorf("RestoreDiacritics(_, %v) should clamp to 1.0; got %q want %q", prob, got, want)
		}
	}
}

// TestRestoreDiacritics_NaNTreatedAsZero — NaN comparisons return
// false in Go, so the keepProb<=0 early-return path correctly catches
// it. This test pins that contract: NaN MUST NOT silently fall
// through to the random-fallback code path.
func TestRestoreDiacritics_NaNTreatedAsZero(t *testing.T) {
	in := "dobry den, hledame stroje"
	got := RestoreDiacritics(in, math.NaN())
	if got != in {
		t.Errorf("RestoreDiacritics(_, NaN) should be no-op; got %q", got)
	}
}

// TestRestoreDiacritics_NoEligibleWords — input containing only
// non-dictionary tokens (numbers, names, gibberish) must pass through
// unchanged regardless of keepProb.
func TestRestoreDiacritics_NoEligibleWords(t *testing.T) {
	in := "Novak xyz123 abcdef ghijkl"
	for _, prob := range []float64{0.0, 0.5, 1.0} {
		got := RestoreDiacritics(in, prob)
		if got != in {
			t.Errorf("RestoreDiacritics(%q, %v) should be no-op; got %q", in, prob, got)
		}
	}
}

// TestRestoreDiacritics_AllEligibleAtProbOne — input where every
// whitespace-separated word is dictionary-eligible must restore every
// word at prob=1.
func TestRestoreDiacritics_AllEligibleAtProbOne(t *testing.T) {
	in := "dobry vazeny hledame dekuji prosim"
	want := "dobrý vážený hledáme děkuji prosím"
	got := RestoreDiacritics(in, 1.0)
	if got != want {
		t.Errorf("RestoreDiacritics(%q, 1.0) = %q, want %q", in, got, want)
	}
}

// TestEngine_WithVoice_DefaultProfileOverrideApplies — pins the F1.2
// fix. Passing DefaultVoiceProfile() with DiacriticsRestoreProb=0
// MUST override the engine's default voice rather than be treated as
// a zero-value no-op. Regression test for the WithVoice guard logic.
func TestEngine_WithVoice_DefaultProfileOverrideApplies(t *testing.T) {
	persona := Persona{Name: "Test", Email: "t@example.cz"}
	off := DefaultVoiceProfile()
	off.DiacriticsRestoreProb = 0
	engine := NewEngine(persona).WithVoice(off)

	if engine.Voice.DiacriticsRestoreProb != 0 {
		t.Errorf("override of DiacriticsRestoreProb=0 was rejected; got %v",
			engine.Voice.DiacriticsRestoreProb)
	}
	if engine.Voice.Name != "default" {
		t.Errorf("voice profile name not bound; got %q", engine.Voice.Name)
	}
}

// TestEngine_ZeroProb_SubjectAndBody — companion to the audit-level
// test in diacritics_audit_test.go. Both subject and body restoration
// gates share the same DiacriticsRestoreProb>0 check; this test pins
// the subject side independently so a future split cannot regress
// only one path.
func TestEngine_ZeroProb_SubjectAndBody(t *testing.T) {
	persona := Persona{Name: "Test", Email: "t@example.cz"}
	off := DefaultVoiceProfile()
	off.DiacriticsRestoreProb = 0
	engine := NewEngine(persona).WithVoice(off)

	out := engine.PrepareEmail("poptavka stroje", "hledame poptavku", 0,
		time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC),
		"", "", "", "", time.Time{})

	if strings.Contains(out.Subject, "poptávka") {
		t.Errorf("DiacriticsRestoreProb=0 must not restore subject; got %q", out.Subject)
	}
	parts := strings.Split(out.Body, "\n\n")
	if len(parts) < 3 {
		t.Fatalf("body did not split into greeting/body/closing as expected: %q", out.Body)
	}
	bodyFragment := parts[1]
	if strings.Contains(bodyFragment, "hledáme") || strings.Contains(bodyFragment, "poptávku") {
		t.Errorf("DiacriticsRestoreProb=0 must not restore body words; got %q", bodyFragment)
	}
}
