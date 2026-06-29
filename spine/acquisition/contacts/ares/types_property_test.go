package ares

import (
	"testing"
	"testing/quick"
)

// ── Property: ParseSubject never panics ───────────────────────
func TestProperty_ParseSubject_NoPanic(t *testing.T) {
	f := func(ico, name, pravniForma, vzniku string, nace []string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on ico=%q: %v", ico, r)
			}
		}()
		_ = ParseSubject(SubjectResponse{
			ICO:           ico,
			ObchodniJmeno: name,
			PravniForma:   pravniForma,
			DatumVzniku:   vzniku,
			CzNace:        nace,
		})
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: ParseSubject preserves ICO verbatim ─────────────
func TestProperty_ParseSubject_ICOPreserved(t *testing.T) {
	f := func(ico string) bool {
		out := ParseSubject(SubjectResponse{ICO: ico})
		return out.ICO == ico
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: ParseSubject preserves PravniForma verbatim ─────
func TestProperty_ParseSubject_PravniFormaPreserved(t *testing.T) {
	f := func(pf string) bool {
		out := ParseSubject(SubjectResponse{PravniForma: pf})
		return out.PravniForma == pf
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: NACECodes round-trip through NACECodes field ────
func TestProperty_ParseSubject_NACECodesPreserved(t *testing.T) {
	cases := [][]string{
		nil,
		{},
		{"62010"},
		{"62010", "62020", "62090"},
	}
	for _, nace := range cases {
		out := ParseSubject(SubjectResponse{CzNace: nace})
		if len(out.NACECodes) != len(nace) {
			t.Fatalf("NACECodes length mismatch: want %d, got %d", len(nace), len(out.NACECodes))
		}
		for i, c := range nace {
			if out.NACECodes[i] != c {
				t.Fatalf("NACECodes[%d]: want %q, got %q", i, c, out.NACECodes[i])
			}
		}
	}
}

// ── Property: NACEPrimary = first element or empty ────────────
func TestProperty_ParseSubject_NACEPrimaryFirst(t *testing.T) {
	cases := []struct {
		nace []string
		want string
	}{
		{nil, ""},
		{[]string{}, ""},
		{[]string{"62010"}, "62010"},
		{[]string{"62010", "62020"}, "62010"},
		{[]string{"42", "invalid"}, "42"},
	}
	for _, c := range cases {
		out := ParseSubject(SubjectResponse{CzNace: c.nace})
		if out.NACEPrimary != c.want {
			t.Fatalf("NACEPrimary: want %q, got %q (nace=%v)", c.want, out.NACEPrimary, c.nace)
		}
	}
}

// ── Property: DatumVzniku preserved verbatim ─────────────────
func TestProperty_ParseSubject_DatumVznikuPreserved(t *testing.T) {
	f := func(vzniku string) bool {
		out := ParseSubject(SubjectResponse{DatumVzniku: vzniku})
		return out.DatumVzniku == vzniku
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: Empty response gives deterministic empty data ──
func TestProperty_ParseSubject_EmptyInput(t *testing.T) {
	out := ParseSubject(SubjectResponse{})
	if out.ICO != "" || out.NACEPrimary != "" || out.DatumVzniku != "" || out.PravniForma != "" {
		t.Fatalf("empty input should yield empty fields, got %+v", out)
	}
	if len(out.NACECodes) != 0 {
		t.Fatalf("empty input NACECodes should be empty, got %v", out.NACECodes)
	}
}

// ── Property: deterministic ──────────────────────────────────
func TestProperty_ParseSubject_Deterministic(t *testing.T) {
	f := func(ico, pf string, nace []string) bool {
		resp := SubjectResponse{ICO: ico, PravniForma: pf, CzNace: nace}
		a := ParseSubject(resp)
		b := ParseSubject(resp)
		return a.ICO == b.ICO && a.PravniForma == b.PravniForma && a.NACEPrimary == b.NACEPrimary
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}
