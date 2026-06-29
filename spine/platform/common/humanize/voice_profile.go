package humanize

import (
	"hash/fnv"
	"strings"
	"time"
)

// VoiceProfile describes a per-sender writing voice. Each mailbox is
// bound to one VoiceProfile (FK outreach_mailboxes.voice_profile_id —
// see migration 027_voice_profiles.sql) so emails sent FROM the same
// mailbox cluster together stylistically while emails from DIFFERENT
// mailboxes look distinct. This is the per-sender tone consistency
// lever measured at 52% in the 2026-05-01 brutal scoring, where only
// 2 distinct greetings appeared across 36 sends.
type VoiceProfile struct {
	// ID is the database primary key. Zero means "not loaded from DB" —
	// engine falls back to DefaultVoiceProfile() in that case.
	ID int64

	// Name is the operator-facing label ("warm", "terse",
	// "consultative", "mobile"). Names are diagnostic — multiple
	// mailboxes may map to the same profile.
	Name string

	// GreetingsStep0 / GreetingsStep1 / GreetingsStep2 are the closed
	// sets of greeting phrases this voice may emit at each step. Empty
	// slice = fall through to ToneEngine's default greeting set.
	GreetingsStep0 []string
	GreetingsStep1 []string
	GreetingsStep2 []string

	// SignatureClosings are the phrases that appear directly above
	// the signature line ("S pozdravem", "Děkuji"). Empty = no closing.
	SignatureClosings []string

	// CommaDensity is target average commas per sentence. 0 = no
	// preference; 1.0–2.5 = typical Czech business email range.
	// Currently advisory.
	CommaDensity float64

	// HedgingProb in [0, 1] is the probability of injecting a hedging
	// adverb. HedgingProb=0 produces direct/terse copy.
	HedgingProb float64

	// DiacriticsRestoreProb in [0, 1] is the per-word restoration
	// probability passed to RestoreDiacritics. 0 disables restoration.
	DiacriticsRestoreProb float64
}

// DefaultVoiceProfile returns the fallback voice used when no profile
// is bound to a mailbox. Restores diacritics at moderate density to
// clear the "0/36 with diacritics" brutal-test floor.
func DefaultVoiceProfile() VoiceProfile {
	return VoiceProfile{
		ID:                    0,
		Name:                  "default",
		GreetingsStep0:        nil,
		GreetingsStep1:        nil,
		GreetingsStep2:        nil,
		SignatureClosings:     []string{"S pozdravem", "Děkuji"},
		CommaDensity:          1.8,
		HedgingProb:           0.0,
		DiacriticsRestoreProb: 0.55,
	}
}

// SeedVoiceProfiles is the canonical operator-facing seed set.
// Migration 027_voice_profiles.sql inserts these four; tests assert
// that each profile's greeting set is disjoint from at least one
// other profile, so per-sender renders cluster apart in the property
// test.
func SeedVoiceProfiles() []VoiceProfile {
	return []VoiceProfile{
		{
			ID:   1,
			Name: "warm",
			GreetingsStep0: []string{
				"Dobrý den, %NAME%",
				"Vážený pane %NAME%",
				"Vážená paní %NAME%",
				"Krásný den, %NAME%",
			},
			GreetingsStep1: []string{
				"Ještě jednou dobrý den, %NAME%",
				"Dobrý den, %NAME%",
				"Zdravím Vás, %NAME%",
			},
			GreetingsStep2: []string{
				"Dobrý den, %NAME%",
				"Zdravím, %NAME%",
			},
			SignatureClosings:     []string{"S přátelským pozdravem", "S pozdravem a přáním hezkého dne", "Děkuji a přeji hezký den"},
			CommaDensity:          2.2,
			HedgingProb:           0.25,
			DiacriticsRestoreProb: 0.75,
		},
		{
			ID:   2,
			Name: "terse",
			GreetingsStep0: []string{
				"Dobrý den, %NAME%",
				"Dobrý den",
			},
			GreetingsStep1: []string{
				"Zdravím",
				"Dobrý den",
			},
			GreetingsStep2: []string{
				"Zdravím",
			},
			SignatureClosings:     []string{"Díky", "S pozdravem"},
			CommaDensity:          1.2,
			HedgingProb:           0.0,
			DiacriticsRestoreProb: 0.50,
		},
		{
			ID:   3,
			Name: "consultative",
			GreetingsStep0: []string{
				"Vážený pane %NAME%",
				"Vážená paní %NAME%",
				"Dobrý den, pane %NAME%",
				"Dobrý den, paní %NAME%",
			},
			GreetingsStep1: []string{
				"Vážený pane %NAME%",
				"Dobrý den, pane %NAME%",
			},
			GreetingsStep2: []string{
				"Vážený pane %NAME%",
				"Dobrý den",
			},
			SignatureClosings:     []string{"S úctou", "S pozdravem", "S pozdravem a přáním všeho dobrého"},
			CommaDensity:          2.5,
			HedgingProb:           0.30,
			DiacriticsRestoreProb: 0.80,
		},
		{
			ID:   4,
			Name: "mobile",
			GreetingsStep0: []string{
				"Zdravím, %NAME%",
				"Zdravím Vás",
			},
			GreetingsStep1: []string{
				"Zdravím",
				"Zdravím, %NAME%",
			},
			GreetingsStep2: []string{
				"Zdravím",
			},
			SignatureClosings:     []string{"Díky", "Měj se", "S pozdravem"},
			CommaDensity:          1.0,
			HedgingProb:           0.05,
			DiacriticsRestoreProb: 0.40,
		},
	}
}

// SelectGreeting returns a greeting for the given step, substituting
// %NAME% with contactName when present. When the profile has no
// greeting set for the step, ok=false signals the caller to fall back
// to ToneEngine's default behaviour.
//
// Selection is deterministic per (profile.ID, step, contactName,
// sendTime 5-minute bucket): same inputs yield same greeting within
// same minute, but rotate across the day.
func (v VoiceProfile) SelectGreeting(step int, contactName string, sendTime time.Time) (string, bool) {
	var pool []string
	switch step {
	case 0:
		pool = v.GreetingsStep0
	case 1:
		pool = v.GreetingsStep1
	default:
		pool = v.GreetingsStep2
	}
	if len(pool) == 0 {
		return "", false
	}

	idx := profileIndex(v.ID, step, contactName, sendTime, len(pool))
	chosen := pool[idx]
	if contactName != "" {
		chosen = strings.ReplaceAll(chosen, "%NAME%", contactName)
	} else {
		chosen = strings.ReplaceAll(chosen, ", %NAME%", "")
		chosen = strings.ReplaceAll(chosen, " %NAME%", "")
		chosen = strings.ReplaceAll(chosen, "%NAME%", "")
	}
	return chosen, true
}

// SelectClosing returns a closing phrase for the signature block.
// Returns ok=false when the profile has no closings set.
func (v VoiceProfile) SelectClosing(sendTime time.Time) (string, bool) {
	if len(v.SignatureClosings) == 0 {
		return "", false
	}
	idx := profileIndex(v.ID, -1, "", sendTime, len(v.SignatureClosings))
	return v.SignatureClosings[idx], true
}

// profileIndex hashes (profileID, step, name, time-bucket) to a stable
// index in [0, n). 5-minute bucket — deterministic retries within
// same bucket; rotates across the day.
func profileIndex(profileID int64, step int, name string, sendTime time.Time, n int) int {
	if n <= 0 {
		return 0
	}
	h := fnv.New64a()
	var b [8]byte
	pid := uint64(profileID)
	for i := 0; i < 8; i++ {
		b[i] = byte(pid >> (i * 8))
	}
	_, _ = h.Write(b[:])
	_, _ = h.Write([]byte{byte(step)})
	_, _ = h.Write([]byte(name))
	bucket := sendTime.Unix() / 300
	for i := 0; i < 8; i++ {
		b[i] = byte(uint64(bucket) >> (i * 8))
	}
	_, _ = h.Write(b[:])
	return int(h.Sum64() % uint64(n))
}

