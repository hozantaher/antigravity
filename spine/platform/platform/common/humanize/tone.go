package humanize

import (
	"math"
	"strings"
	"time"
)

// ToneEngine controls the emotional arc across a multi-step email sequence
// and models weekly fatigue effects.
type ToneEngine struct {
	email1WordsMean int
	email2WordsMean int
	email3WordsMean int
	weeklyFatigue   float64 // Thursday words = Monday * weeklyFatigue
	// randFloat returns a value in [0, 1). Injected so tests can supply a
	// deterministic source and so the per-step ±20% variance does not make
	// weekday-ordering assertions flaky. Production passes cryptoRandFloat.
	randFloat func() float64
}

// NewToneEngine creates a tone engine with realistic defaults.
func NewToneEngine() *ToneEngine {
	return &ToneEngine{
		email1WordsMean: 120,
		email2WordsMean: 75,
		email3WordsMean: 55,
		weeklyFatigue:   0.85,
		randFloat:       cryptoRandFloat,
	}
}

// NewToneEngineWithRand creates a tone engine using a caller-supplied RNG.
// Intended for tests that need determinism; production code should use
// NewToneEngine which wires the crypto-backed source.
func NewToneEngineWithRand(randFloat func() float64) *ToneEngine {
	e := NewToneEngine()
	if randFloat != nil {
		e.randFloat = randFloat
	}
	return e
}

// ToneProfile describes the desired tone for a specific email.
type ToneProfile struct {
	TargetWords   int     // Target word count (±20%)
	Formality     float64 // 0.0 = casual, 1.0 = very formal
	Warmth        float64 // 0.0 = cold/professional, 1.0 = warm/friendly
	Urgency       float64 // 0.0 = no pressure, 1.0 = high pressure
	SelfDeprecate bool    // Include self-deprecating language
	OfferExit     bool    // Explicitly offer to stop emailing
}

// ProfileForStep returns the tone profile for a given step in the sequence.
func (t *ToneEngine) ProfileForStep(step int, dayOfWeek time.Weekday) ToneProfile {
	// Base profile per step
	var profile ToneProfile

	switch step {
	case 0: // Email 1: Introduction
		profile = ToneProfile{
			TargetWords:   t.email1WordsMean,
			Formality:     0.8,
			Warmth:        0.3,
			Urgency:       0.1,
			SelfDeprecate: false,
			OfferExit:     false,
		}
	case 1: // Email 2: Follow-up
		profile = ToneProfile{
			TargetWords:   t.email2WordsMean,
			Formality:     0.5,
			Warmth:        0.6,
			Urgency:       0.2,
			SelfDeprecate: true,
			OfferExit:     false,
		}
	default: // Email 3+: Closer
		profile = ToneProfile{
			TargetWords:   t.email3WordsMean,
			Formality:     0.3,
			Warmth:        0.4,
			Urgency:       0.5,
			SelfDeprecate: false,
			OfferExit:     true,
		}
	}

	// Apply weekly fatigue
	fatigueFactor := t.fatigueFactor(dayOfWeek)
	profile.TargetWords = int(math.Round(float64(profile.TargetWords) * fatigueFactor))

	// Add variance (±20%)
	r := t.randFloat
	if r == nil {
		r = cryptoRandFloat
	}
	variance := 1.0 + (r()-0.5)*0.4
	profile.TargetWords = int(math.Round(float64(profile.TargetWords) * variance))

	if profile.TargetWords < 30 {
		profile.TargetWords = 30
	}

	return profile
}

// fatigueFactor models the weekly energy decline.
func (t *ToneEngine) fatigueFactor(dow time.Weekday) float64 {
	factors := map[time.Weekday]float64{
		time.Monday:    1.0,
		time.Tuesday:   1.05,
		time.Wednesday: 0.95,
		time.Thursday:  t.weeklyFatigue,
		time.Friday:    0.75,
		time.Saturday:  0.5,
		time.Sunday:    0.5,
	}
	if f, ok := factors[dow]; ok {
		return f
	}
	return 1.0
}

// isFeminineFirstName returns true for Czech first names that are typically feminine.
// Czech feminine first names almost always end in -a (Eva, Jana, Petra, Alena, …).
// A short list of common exceptions (Dagmar, Ester, …) is also covered.
func isFeminineFirstName(name string) bool {
	if name == "" {
		return false
	}
	lower := strings.ToLower(name)
	feminine := []string{"dagmar", "ester", "elen", "ren", "carmen", "judith", "ruth", "madeleine"}
	for _, f := range feminine {
		if lower == f {
			return true
		}
	}
	return strings.HasSuffix(lower, "a")
}

// GreetingForStep returns appropriate greeting for the step and formality level.
func (t *ToneEngine) GreetingForStep(step int, contactName string) string {
	switch step {
	case 0:
		if contactName != "" {
			title := "pane"
			vazeny := "Vážený pane"
			if isFeminineFirstName(contactName) {
				title = "paní"
				vazeny = "Vážená paní"
			}
			options := []string{
				vazeny + " " + contactName,
				"Dobrý den, " + title + " " + contactName,
			}
			return options[randMinute(0, len(options))]
		}
		options := []string{"Dobrý den", "Vážený pane / Vážená paní"}
		return options[randMinute(0, len(options))]
	case 1:
		if contactName != "" {
			return "Dobrý den, " + contactName
		}
		options := []string{"Dobrý den", "Zdravím"}
		return options[randMinute(0, len(options))]
	default:
		options := []string{"Dobrý den", "Zdravím"}
		return options[randMinute(0, len(options))]
	}
}

// ClosingForStep returns appropriate closing for the step.
func (t *ToneEngine) ClosingForStep(step int) string {
	switch step {
	case 0:
		options := []string{
			"Budu rád, když se ozvete.",
			"Budu rád za jakoukoliv odpověď.",
			"Těším se na odpověď.",
		}
		return options[randMinute(0, len(options))]
	case 1:
		options := []string{
			"Stačí krátká odpověď.",
			"Stačí odpovědět jednou větou.",
			"Dejte prosím vědět, jestli to má smysl.",
		}
		return options[randMinute(0, len(options))]
	default:
		options := []string{
			"Pokud to pro vás není aktuální, dejte vědět a nebudu dál psát.",
			"Pokud nemáte zájem, klidně dejte vědět a nebudu obtěžovat.",
			"Tímto se loučím, pokud se ozve potřeba, jsem k dispozici.",
		}
		return options[randMinute(0, len(options))]
	}
}
