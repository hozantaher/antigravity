package humanize

import (
	"strings"
	"testing"
	"time"
)

// TestDiacriticsAudit_AllProfilesClearFloor — ratchet on rendered body
// diacritic density (FIX 5).
//
// Trigger: 2026-05-01 brutal humanlike scoring measured 0/36 emails
// with diacritics. This audit pins the floor: when use_diacritics is
// enabled (DiacriticsRestoreProb > 0) the rendered body MUST contain
// at least 5 non-ASCII runes for every seeded profile across trials.
//
// Probability of all 20 trials having fewer than 5 diacritics at
// restoreProb≥0.40 over a body that contains ~10 dictionary-eligible
// words is negligible (well under 1e-9). If this audit ever fires in
// CI, the regression is real.
func TestDiacriticsAudit_AllProfilesClearFloor(t *testing.T) {
	persona := Persona{Name: "Test Sender", Email: "test@example.cz"}
	sendTime := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)

	body := strings.Join([]string{
		"hledame stroje a vozidla pro vasi firmu.",
		"posilam vam nasi poptavku.",
		"dekuji za vas zajem o spolupraci.",
		"prejeme dobry den a tesime se na odpoved.",
	}, "\n")

	const minDiacriticsPerBody = 5
	const trials = 20

	for _, profile := range SeedVoiceProfiles() {
		profile := profile
		t.Run(profile.Name, func(t *testing.T) {
			engine := NewEngine(persona).WithVoice(profile)

			passing := 0
			for i := 0; i < trials; i++ {
				when := sendTime.Add(time.Duration(i) * time.Minute)
				out := engine.PrepareEmail("Poptavka", body, 0, when, "Novák",
					"", "", "", time.Time{})
				if countDiacritics(out.Body) >= minDiacriticsPerBody {
					passing++
				}
			}

			if passing < trials/2 {
				t.Errorf("profile %s: only %d/%d renders contained ≥%d diacritics — regression on diacritic floor",
					profile.Name, passing, trials, minDiacriticsPerBody)
			}
		})
	}
}

// TestDiacriticsAudit_ZeroProbDisablesRestore — guard the off-switch.
// Engine MUST NOT restore body words when DiacriticsRestoreProb=0.
func TestDiacriticsAudit_ZeroProbDisablesRestore(t *testing.T) {
	persona := Persona{Name: "Test", Email: "t@example.cz"}
	off := DefaultVoiceProfile()
	off.DiacriticsRestoreProb = 0
	engine := NewEngine(persona).WithVoice(off)

	body := "hledame poptavku"
	out := engine.PrepareEmail("Subj", body, 0,
		time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC),
		"", "", "", "", time.Time{})

	parts := strings.Split(out.Body, "\n\n")
	if len(parts) < 3 {
		t.Fatalf("body did not split into greeting/body/closing as expected: %q", out.Body)
	}
	bodyFragment := parts[1]
	if strings.Contains(bodyFragment, "hledáme") || strings.Contains(bodyFragment, "poptávku") {
		t.Errorf("DiacriticsRestoreProb=0 must not restore body words; got %q", bodyFragment)
	}
}

func countDiacritics(s string) int {
	n := 0
	for _, r := range s {
		if r > 127 {
			n++
		}
	}
	return n
}
