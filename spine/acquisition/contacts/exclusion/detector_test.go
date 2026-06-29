package exclusion

import "testing"

func TestDetect(t *testing.T) {
	tests := []struct {
		name         string
		input        Input
		wantDecision Decision
		wantReview   bool
	}{
		// === Commercial entities — always PASS ===
		{"s.r.o. plain", Input{PravniForma: "Společnost s ručením omezeným"}, Pass, false},
		{"a.s. plain", Input{PravniForma: "Akciová společnost"}, Pass, false},
		{"s.r.o. with Městské in name", Input{
			Name: "Městské lesy Brno a.s.", PravniForma: "Akciová společnost",
		}, Pass, false},
		{"s.r.o. with Státní in name", Input{
			Name: "Státní zkušebna s.r.o.", PravniForma: "Společnost s ručením omezeným",
		}, Pass, false},
		{"private school s.r.o.", Input{
			Name:        "Soukromá střední škola podnikání s.r.o.",
			PravniForma: "Společnost s ručením omezeným",
		}, Pass, false},
		{"OSVČ", Input{PravniForma: "Podnikající fyzická osoba"}, Pass, false},
		{"družstvo", Input{PravniForma: "Družstvo"}, Pass, false},
		{"city-owned a.s.", Input{
			Name:        "Dopravní podnik hl. m. Prahy, akciová společnost",
			PravniForma: "Akciová společnost",
		}, Pass, false},
		{"state-owned a.s.", Input{
			Name: "ČD Cargo, a.s.", PravniForma: "Akciová společnost",
		}, Pass, false},
		{"commercial with hard NACE", Input{
			PravniForma: "Společnost s ručením omezeným",
			NACECodes:   []string{"2562"},
		}, Pass, false},

		// === Hard block — legal form ===
		{"státní podnik", Input{
			Name: "Lesy České republiky, s.p.", PravniForma: "Státní podnik",
		}, HardBlock, false},
		{"organizační složka státu", Input{
			Name:        "Ministerstvo průmyslu a obchodu",
			PravniForma: "Organizační složka státu",
		}, HardBlock, false},
		{"územní samosprávný celek", Input{
			Name: "Město Brno", PravniForma: "Územní samosprávný celek",
		}, HardBlock, false},
		{"státní příspěvková org", Input{
			PravniForma: "Státní příspěvková organizace",
		}, HardBlock, false},

		// === Soft block — legal form ===
		{"příspěvková organizace", Input{
			Name:        "Základní škola Horní Počernice",
			PravniForma: "Příspěvková organizace",
		}, SoftBlock, false},
		{"spolek", Input{
			Name: "Český zahrádkářský svaz", PravniForma: "Spolek",
		}, SoftBlock, false},
		{"nadace", Input{
			Name: "Nadace ČEZ", PravniForma: "Nadace",
		}, SoftBlock, false},
		{"politická strana", Input{
			PravniForma: "Politická strana, politické hnutí",
		}, SoftBlock, false},
		{"SVJ", Input{
			PravniForma: "Společenství vlastníků jednotek",
		}, SoftBlock, false},

		// === ARES flags ===
		{"v likvidaci", Input{
			Name: "Kovárna Přeštice s.r.o. v likvidaci", VLikvidaci: true,
		}, HardBlock, false},
		{"v insolvenci", Input{
			Name: "Ocel Plus s.r.o.", VInsolvenci: true,
		}, SoftBlock, false},
		// ARES flags take precedence over a commercial legal form: a company
		// in liquidation/insolvency must still be blocked even as an s.r.o./a.s.
		{"commercial s.r.o. in liquidation", Input{
			Name: "Stroje Novák s.r.o.", PravniForma: "Společnost s ručením omezeným",
			VLikvidaci: true,
		}, HardBlock, false},
		{"commercial a.s. in insolvency", Input{
			Name: "Ocel Plus a.s.", PravniForma: "Akciová společnost",
			VInsolvenci: true,
		}, SoftBlock, false},

		// === NACE ===
		{"NACE 8423 justice", Input{NACECodes: []string{"8423"}}, HardBlock, false},
		{"NACE 8411 public admin", Input{NACECodes: []string{"8411"}}, HardBlock, false},
		{"NACE 9900 exterritorial", Input{NACECodes: []string{"9900"}}, HardBlock, false},
		{"soft NACE 9499", Input{NACECodes: []string{"9499"}}, SoftBlock, false},

		// === Email domain ===
		{"justice.cz email", Input{Email: "podatelna@justice.cz"}, HardBlock, false},
		{"policie.cz email", Input{Email: "info@policie.cz"}, HardBlock, false},
		{".gov.cz catch-all", Input{Email: "info@stavebniurad.gov.cz"}, HardBlock, false},
		{"normal email", Input{Email: "info@stroje-novak.cz"}, Pass, false},

		// === Name patterns ===
		{"Ministerstvo without form", Input{
			Name: "Ministerstvo financí",
		}, SoftBlock, true},
		{"Krajský soud with form", Input{
			Name:        "Krajský soud v Brně",
			PravniForma: "Organizační složka státu",
		}, HardBlock, false},
		{"Základní škola without form", Input{
			Name: "Základní škola T.G.Masaryka",
		}, SoftBlock, true},
		{"Finanční úřad", Input{
			Name: "Finanční úřad pro Prahu 1",
		}, SoftBlock, true},
		{"Městská knihovna soft", Input{
			Name: "Městská knihovna v Praze",
		}, SoftBlock, true},

		// === Clean PASS ===
		{"normal company", Input{
			Name:        "Stroje Novák s.r.o.",
			PravniForma: "Společnost s ručením omezeným",
			Email:       "info@stroje-novak.cz",
		}, Pass, false},
		{"empty input", Input{}, Pass, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := Detect(tt.input)
			if result.Decision != tt.wantDecision {
				t.Errorf("Detect() decision = %s, want %s (reasons: %v)",
					result.Decision, tt.wantDecision, result.Reasons)
			}
			if result.NeedsReview != tt.wantReview {
				t.Errorf("NeedsReview = %v, want %v", result.NeedsReview, tt.wantReview)
			}
		})
	}
}

// ── Name pattern branches with non-empty PravniForma ──

func TestDetect_HardNamePattern_WithForm(t *testing.T) {
	// "Neznámá forma" not in any form map → reaches name patterns
	// hard pattern match + pf != "" → HardBlock (line 103)
	result := Detect(Input{
		Name:        "Ministerstvo financí",
		PravniForma: "Neznámá forma",
	})
	if result.Decision != HardBlock {
		t.Errorf("hard name + non-empty form: want HardBlock, got %s", result.Decision)
	}
}

func TestDetect_SoftNamePattern_WithForm(t *testing.T) {
	// soft pattern match + pf != "" → SoftBlock (line 112)
	result := Detect(Input{
		Name:        "Základní škola T.G.M.",
		PravniForma: "Neznámá forma",
	})
	if result.Decision != SoftBlock {
		t.Errorf("soft name + non-empty form: want SoftBlock, got %s", result.Decision)
	}
	if result.NeedsReview {
		t.Error("NeedsReview should be false when form is set")
	}
}

func TestDetect_EmailWithoutAtSign(t *testing.T) {
	// domainFromEmail with no @ → returns "" → no domain match → PASS
	result := Detect(Input{Email: "notanemail"})
	if result.Decision != Pass {
		t.Errorf("no-@ email: want Pass, got %s", result.Decision)
	}
}

func TestCommercialFormAlwaysPassesRegardlessOfOtherSignals(t *testing.T) {
	// A commercial entity should PASS even with gov email, gov-sounding name, or gov NACE
	input := Input{
		Name:        "Městské lesy s.r.o.",
		PravniForma: "Společnost s ručením omezeným",
		Email:       "info@justice.cz",
		NACECodes:   []string{"8411"},
	}
	result := Detect(input)
	if result.Decision != Pass {
		t.Errorf("commercial form should always PASS, got %s (reasons: %v)",
			result.Decision, result.Reasons)
	}
}
