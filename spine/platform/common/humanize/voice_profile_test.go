package humanize

import (
	"strings"
	"testing"
	"time"
)

// ── DefaultVoiceProfile ─────────────────────────────────────────────

func TestDefaultVoiceProfile_HasDiacriticsRestoreEnabled(t *testing.T) {
	v := DefaultVoiceProfile()
	if v.DiacriticsRestoreProb <= 0 {
		t.Errorf("default voice must enable diacritics restore; got %f", v.DiacriticsRestoreProb)
	}
}

func TestDefaultVoiceProfile_HasClosings(t *testing.T) {
	v := DefaultVoiceProfile()
	if len(v.SignatureClosings) == 0 {
		t.Error("default voice must have at least one signature closing")
	}
}

// ── SeedVoiceProfiles ───────────────────────────────────────────────

func TestSeedVoiceProfiles_FourDistinct(t *testing.T) {
	profiles := SeedVoiceProfiles()
	if len(profiles) != 4 {
		t.Fatalf("expected 4 seeded profiles, got %d", len(profiles))
	}
	names := map[string]bool{}
	ids := map[int64]bool{}
	for _, p := range profiles {
		if names[p.Name] {
			t.Errorf("duplicate profile name: %s", p.Name)
		}
		if ids[p.ID] {
			t.Errorf("duplicate profile ID: %d", p.ID)
		}
		names[p.Name] = true
		ids[p.ID] = true
	}
}

func TestSeedVoiceProfiles_AllHaveStep0Greetings(t *testing.T) {
	for _, p := range SeedVoiceProfiles() {
		if len(p.GreetingsStep0) == 0 {
			t.Errorf("profile %s missing step-0 greetings", p.Name)
		}
	}
}

// ── SelectGreeting ──────────────────────────────────────────────────

func TestVoiceProfile_SelectGreeting_NameSubstitution(t *testing.T) {
	v := SeedVoiceProfiles()[0]
	got, ok := v.SelectGreeting(0, "Novák", time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC))
	if !ok {
		t.Fatal("SelectGreeting should succeed for profile with step-0 greetings")
	}
	if !strings.Contains(got, "Novák") {
		t.Errorf("greeting should contain name: %q", got)
	}
	if strings.Contains(got, "%NAME%") {
		t.Errorf("placeholder not substituted: %q", got)
	}
}

func TestVoiceProfile_SelectGreeting_NoName(t *testing.T) {
	v := SeedVoiceProfiles()[0]
	got, ok := v.SelectGreeting(0, "", time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC))
	if !ok {
		t.Fatal("SelectGreeting should succeed even with empty name")
	}
	if strings.Contains(got, "%NAME%") {
		t.Errorf("placeholder not stripped on empty name: %q", got)
	}
	if got == "" {
		t.Error("greeting should not be empty after stripping placeholder")
	}
}

func TestVoiceProfile_SelectGreeting_EmptyPool(t *testing.T) {
	v := VoiceProfile{ID: 99, Name: "empty"}
	_, ok := v.SelectGreeting(0, "X", time.Now())
	if ok {
		t.Error("SelectGreeting should return ok=false for empty pool")
	}
}

func TestVoiceProfile_SelectGreeting_DeterministicWithinBucket(t *testing.T) {
	v := SeedVoiceProfiles()[0]
	t1 := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 5, 1, 10, 4, 59, 0, time.UTC)
	g1, _ := v.SelectGreeting(0, "Novák", t1)
	g2, _ := v.SelectGreeting(0, "Novák", t2)
	if g1 != g2 {
		t.Errorf("same bucket should yield same greeting: %q vs %q", g1, g2)
	}
}

// ── SelectClosing ───────────────────────────────────────────────────

func TestVoiceProfile_SelectClosing_NonEmpty(t *testing.T) {
	v := SeedVoiceProfiles()[0]
	got, ok := v.SelectClosing(time.Now())
	if !ok {
		t.Fatal("SelectClosing should succeed for seeded profile")
	}
	if got == "" {
		t.Error("closing should not be empty")
	}
}

func TestVoiceProfile_SelectClosing_EmptyPool(t *testing.T) {
	v := VoiceProfile{}
	if _, ok := v.SelectClosing(time.Now()); ok {
		t.Error("SelectClosing should return ok=false for empty pool")
	}
}

// ── Property: per-sender greeting histograms cluster apart ──────────

func TestVoiceProfile_PerSenderGreetingClusters(t *testing.T) {
	profiles := SeedVoiceProfiles()
	if len(profiles) < 2 {
		t.Fatal("need at least 2 profiles for clustering test")
	}

	const renders = 100
	histograms := make([]map[string]int, len(profiles))
	base := time.Date(2026, 5, 1, 8, 0, 0, 0, time.UTC)
	for i, p := range profiles {
		histograms[i] = map[string]int{}
		for j := 0; j < renders; j++ {
			when := base.Add(time.Duration(j) * 7 * time.Minute)
			g, ok := p.SelectGreeting(0, "Novák", when)
			if !ok {
				t.Fatalf("profile %s step-0 empty", p.Name)
			}
			histograms[i][g]++
		}
	}

	for i, p := range profiles {
		allowed := map[string]bool{}
		for _, raw := range p.GreetingsStep0 {
			allowed[strings.ReplaceAll(raw, "%NAME%", "Novák")] = true
		}
		for got := range histograms[i] {
			if !allowed[got] {
				t.Errorf("profile %s emitted out-of-pool greeting %q", p.Name, got)
			}
		}
	}

	disjointFound := false
	for i := 0; i < len(profiles); i++ {
		for j := i + 1; j < len(profiles); j++ {
			if disjoint(histograms[i], histograms[j]) {
				disjointFound = true
			}
		}
	}
	if !disjointFound {
		t.Error("no pair of profiles produced disjoint greeting sets — per-sender clustering broken")
	}
}

func disjoint(a, b map[string]int) bool {
	for k := range a {
		if _, ok := b[k]; ok {
			return false
		}
	}
	return true
}

// ── Engine.WithVoice + PrepareEmail integration ─────────────────────

func TestEngine_WithVoice_AppliesGreeting(t *testing.T) {
	persona := Persona{Name: "Test", Email: "t@example.cz"}
	engine := NewEngine(persona).WithVoice(SeedVoiceProfiles()[3])
	sendTime := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)

	result := engine.PrepareEmail("Subj", "Body", 0, sendTime, "Novák", "", "", "", time.Time{})
	if result == nil {
		t.Fatal("nil result")
	}
	if !strings.Contains(strings.ToLower(result.Body), "zdrav") {
		t.Errorf("mobile profile should yield Zdravím-rooted greeting; body: %q",
			result.Body[:minInt(200, len(result.Body))])
	}
}

func TestEngine_WithVoice_ZeroValueIsNoop(t *testing.T) {
	persona := Persona{Name: "Test", Email: "t@example.cz"}
	engine := NewEngine(persona)
	original := engine.Voice
	engine = engine.WithVoice(VoiceProfile{})
	if engine.Voice.Name != original.Name {
		t.Errorf("zero-value WithVoice should preserve default; got %q", engine.Voice.Name)
	}
}

func TestEngine_VoiceRestoresDiacritics(t *testing.T) {
	persona := Persona{Name: "Test", Email: "t@example.cz"}
	engine := NewEngine(persona).WithVoice(SeedVoiceProfiles()[2])
	sendTime := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)

	body := "Hledame stroje a vozidla. Posilam vam nasi poptavku. Dekuji."

	const N = 30
	withDiacritic := 0
	for i := 0; i < N; i++ {
		result := engine.PrepareEmail("Poptavka stroje", body, 0,
			sendTime.Add(time.Duration(i)*time.Minute),
			"Novák", "", "", "", time.Time{})
		for _, r := range result.Body {
			if r > 127 {
				withDiacritic++
				break
			}
		}
	}
	if withDiacritic < N/2 {
		t.Errorf("at restoreProb=0.8, expected ≥%d/%d trials with diacritic; got %d", N/2, N, withDiacritic)
	}
}

func TestEngine_PerSenderRetryDeterminism(t *testing.T) {
	profiles := SeedVoiceProfiles()
	sendTime := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)

	for _, p := range profiles {
		g1, _ := p.SelectGreeting(0, "Novák", sendTime)
		g2, _ := p.SelectGreeting(0, "Novák", sendTime)
		if g1 != g2 {
			t.Errorf("profile %s: retry yielded different greeting (%q vs %q)", p.Name, g1, g2)
		}
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
