package humanize

import (
	"strings"
	"testing"
)

// TestNewImperfectEngineSAFE_PreservesDiacritics verifies the SAFE
// profile keeps Czech diacritics verbatim across subject, greeting and
// body. Regression for J3 audit (2026-05-04): the legacy 70%/85%/40%
// keepProb produces "vážený" / "vazeny" mixed paragraphs that match a
// definitive machine-translation fingerprint and trigger Seznam-class
// spam-flagging.
func TestNewImperfectEngineSAFE_PreservesDiacritics(t *testing.T) {
	const original = "Vážený pane řediteli, děkuji za schůzku — pošlu připomínky."
	e := NewImperfectEngineSAFE()

	t.Run("ApplyToSubject", func(t *testing.T) {
		out := e.ApplyToSubject(original)
		if out != original {
			t.Fatalf("subject diacritics lost: want %q got %q", original, out)
		}
	})

	t.Run("ApplyToGreeting", func(t *testing.T) {
		out := e.ApplyToGreeting(original)
		if out != original {
			t.Fatalf("greeting diacritics lost: want %q got %q", original, out)
		}
	})

	t.Run("ApplyToBody", func(t *testing.T) {
		// ApplyToBody runs degrade per-line then injectTypo typoCount times.
		// SAFE profile sets typoCountMax=0 → typo loop is skipped → body
		// content is byte-identical to input.
		out := e.ApplyToBody(original)
		if out != original {
			t.Fatalf("body diacritics or typos altered: want %q got %q", original, out)
		}
	})

	t.Run("ApplyToBody_MultiLine", func(t *testing.T) {
		body := "Vážený zákazníku,\n\nposílám příručku.\n\nS pozdravem,\nředitel"
		out := e.ApplyToBody(body)
		if out != body {
			t.Fatalf("multi-line body altered:\nwant %q\ngot  %q", body, out)
		}
	})
}

// TestNewImperfectEngineSAFE_NoTypoInjection confirms the SAFE profile
// disables the comma/period typo injector — the additional layer that
// would otherwise mutate body bytes even at keepProb=1.0.
func TestNewImperfectEngineSAFE_NoTypoInjection(t *testing.T) {
	e := NewImperfectEngineSAFE()
	if e.typoCountMin != 0 || e.typoCountMax != 0 {
		t.Fatalf("SAFE profile must zero typo bounds; got min=%d max=%d", e.typoCountMin, e.typoCountMax)
	}
}

// TestNewImperfectEngine_LegacyDefaultUnchanged guards the legacy
// constructor from accidental drift — the SAFE profile is opt-in via
// HUMANIZE_DIACRITICS_DEGRADE=false; default callers must keep the
// fingerprint behavior.
func TestNewImperfectEngine_LegacyDefaultUnchanged(t *testing.T) {
	e := NewImperfectEngine()
	if e.diacriticsBodyProb != 0.70 {
		t.Fatalf("legacy diacriticsBodyProb drifted: want 0.70 got %v", e.diacriticsBodyProb)
	}
	if e.typoCountMax == 0 {
		t.Fatalf("legacy typo injector must remain enabled (max>0)")
	}
}

// TestNewEngine_HumanizeDiacriticsDegradeFlag exercises the env-flag
// dispatch in NewEngine. Default → legacy ImperfectEngine. Flag=false →
// SAFE ImperfectEngine.
func TestNewEngine_HumanizeDiacriticsDegradeFlag(t *testing.T) {
	persona := Persona{Email: "a.mazher@email.cz", Name: "A. Mazher"}

	t.Run("Default_LegacyImperfect", func(t *testing.T) {
		t.Setenv("HUMANIZE_DIACRITICS_DEGRADE", "")
		e := NewEngine(persona)
		if e.Imperfect.diacriticsBodyProb != 0.70 {
			t.Fatalf("default constructor must use legacy ImperfectEngine; got bodyProb=%v", e.Imperfect.diacriticsBodyProb)
		}
	})

	t.Run("ExplicitTrue_LegacyImperfect", func(t *testing.T) {
		t.Setenv("HUMANIZE_DIACRITICS_DEGRADE", "true")
		e := NewEngine(persona)
		if e.Imperfect.diacriticsBodyProb != 0.70 {
			t.Fatalf("HUMANIZE_DIACRITICS_DEGRADE=true must use legacy ImperfectEngine")
		}
	})

	t.Run("False_SAFEImperfect", func(t *testing.T) {
		t.Setenv("HUMANIZE_DIACRITICS_DEGRADE", "false")
		e := NewEngine(persona)
		if e.Imperfect.diacriticsBodyProb != 1.0 {
			t.Fatalf("HUMANIZE_DIACRITICS_DEGRADE=false must use SAFE profile (keepProb=1.0); got %v", e.Imperfect.diacriticsBodyProb)
		}
		if e.Imperfect.typoCountMax != 0 {
			t.Fatalf("SAFE profile must disable typo injection")
		}
	})

	t.Run("False_PreservesDiacriticsEndToEnd", func(t *testing.T) {
		t.Setenv("HUMANIZE_DIACRITICS_DEGRADE", "false")
		e := NewEngine(persona)
		const body = "Vážený, příští týden pošlu příručku — děkuji."
		out := e.Imperfect.ApplyToBody(body)
		if !strings.Contains(out, "Vážený") || !strings.Contains(out, "příští") || !strings.Contains(out, "děkuji") {
			t.Fatalf("SAFE profile dropped diacritics end-to-end: %q", out)
		}
	})
}
