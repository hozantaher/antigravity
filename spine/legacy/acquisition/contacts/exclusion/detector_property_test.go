package exclusion

import (
	"strings"
	"testing"
	"testing/quick"
)

// ── Property: Detect never panics on any input ──────────────────
func TestProperty_Detect_NoPanic(t *testing.T) {
	f := func(name, pf, ico, email, website string, insolv, likvid bool) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on input: %v", r)
			}
		}()
		_ = Detect(Input{
			Name:        name,
			PravniForma: pf,
			ICO:         ico,
			Email:       email,
			Website:     website,
			VInsolvenci: insolv,
			VLikvidaci:  likvid,
		})
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: Detect is deterministic ──────────────────────────
func TestProperty_Detect_Deterministic(t *testing.T) {
	f := func(name, pf string, insolv bool) bool {
		in := Input{Name: name, PravniForma: pf, VInsolvenci: insolv}
		a := Detect(in)
		b := Detect(in)
		return a.Decision == b.Decision &&
			a.Confidence == b.Confidence &&
			len(a.Reasons) == len(b.Reasons)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: commercial form → always Pass (priority 1) ───────
func TestProperty_Detect_CommercialFormAlwaysPass(t *testing.T) {
	// Commercial forms from rules.go — even combined with other blockers.
	commercial := []string{"s.r.o.", "a.s.", "spol. s r.o.", "v.o.s."}
	for _, pf := range commercial {
		if !CommercialForms[pf] {
			continue // skip if not in map (legal form registry may differ)
		}
		// Even with insolvency + liquidation flags, commercial form wins.
		in := Input{
			Name:        "Bankrupt Co",
			PravniForma: pf,
			VInsolvenci: true,
			VLikvidaci:  true,
		}
		result := Detect(in)
		if result.Decision != Pass {
			t.Fatalf("commercial form %q with insolv+likvid: want Pass, got %s", pf, result.Decision)
		}
		if result.Confidence != 1.0 {
			t.Fatalf("commercial form %q: want confidence=1.0, got %f", pf, result.Confidence)
		}
	}
}

// ── Property: v_likvidaci (non-commercial) → HardBlock ──────────
func TestProperty_Detect_Likvidaci_HardBlock(t *testing.T) {
	// Use a non-commercial form so it doesn't short-circuit to Pass.
	in := Input{
		Name:        "Test Co",
		PravniForma: "o.s.", // občanské sdružení — not commercial
		VLikvidaci:  true,
	}
	result := Detect(in)
	if result.Decision != HardBlock {
		t.Fatalf("v_likvidaci: want HardBlock, got %s", result.Decision)
	}
	hasReason := false
	for _, r := range result.Reasons {
		if strings.Contains(r, "likvidaci") {
			hasReason = true
			break
		}
	}
	if !hasReason {
		t.Fatalf("likvidaci block should list reason; got reasons=%v", result.Reasons)
	}
}

// ── Property: v_insolvenci (non-commercial) → SoftBlock ─────────
func TestProperty_Detect_Insolvenci_SoftBlock(t *testing.T) {
	in := Input{
		Name:        "Test Co",
		PravniForma: "o.s.",
		VInsolvenci: true,
	}
	result := Detect(in)
	if result.Decision != SoftBlock {
		t.Fatalf("v_insolvenci: want SoftBlock, got %s", result.Decision)
	}
}

// ── Property: decision values only from enum ───────────────────
func TestProperty_Detect_EnumValues(t *testing.T) {
	valid := map[Decision]bool{Pass: true, HardBlock: true, SoftBlock: true}
	f := func(name, pf, email string) bool {
		result := Detect(Input{Name: name, PravniForma: pf, Email: email})
		return valid[result.Decision]
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: Confidence in [0, 1] range ───────────────────────
func TestProperty_Detect_ConfidenceInRange(t *testing.T) {
	f := func(name, pf string, insolv, likvid bool) bool {
		r := Detect(Input{
			Name:        name,
			PravniForma: pf,
			VInsolvenci: insolv,
			VLikvidaci:  likvid,
		})
		return r.Confidence >= 0.0 && r.Confidence <= 1.0
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: legal form whitespace is trimmed ─────────────────
// "s.r.o." with leading/trailing whitespace should still be treated
// as commercial.
func TestProperty_Detect_LegalFormTrimmed(t *testing.T) {
	if !CommercialForms["s.r.o."] {
		t.Skip("s.r.o. not in CommercialForms (rules.go variant)")
	}
	forms := []string{"s.r.o.", "  s.r.o.", "s.r.o.  ", "  s.r.o.  "}
	for _, pf := range forms {
		r := Detect(Input{PravniForma: pf})
		if r.Decision != Pass {
			t.Fatalf("legal form %q (with whitespace) should Pass, got %s", pf, r.Decision)
		}
	}
}

// ── Property: empty input → not panics, returns deterministic result ──
func TestProperty_Detect_EmptyInput(t *testing.T) {
	r := Detect(Input{})
	if r.Confidence < 0.0 || r.Confidence > 1.0 {
		t.Fatalf("empty input confidence out of range: %f", r.Confidence)
	}
}

// ── Property: unicode in fields doesn't break detection ─────────
func TestProperty_Detect_UnicodeFields(t *testing.T) {
	inputs := []Input{
		{Name: "Alpha spółka z o.o. 🚀", PravniForma: "s.r.o."},
		{Name: "Firmα Beta", Email: "a@běžný.cz"},
		{Name: "石油公司"},
	}
	for _, in := range inputs {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic on %v: %v", in, r)
			}
		}()
		_ = Detect(in)
	}
}
