// Package content — variants.go (Sprint AR1)
//
// Deterministic greeting + sign-off rotation for AR1 fingerprint diversity.
// All functions use SHA256 seeding so the same envelopeKey always picks the
// same variant (auditable), while different envelopes get different forms.
//
// SAFE profile constraint (memory project_humanize_safe_profile):
//   - HUMANIZE_DIACRITICS_DEGRADE=false means diacritics are NEVER stripped.
//   - Variants here rotate equivalent Czech forms only; no ASCII downgrading.
package content

import (
	"crypto/sha256"
	"encoding/binary"
)

// ─────────────────────────────────────────────────────────────────────────────
// Greeting variants
// ─────────────────────────────────────────────────────────────────────────────

// greetingVariants are equivalent Czech B2B email opening formulations.
// All preserve diacritics (HUMANIZE_DIACRITICS_DEGRADE=false constraint).
// The caller substitutes {{jmeno}} or leaves the name token empty — these
// forms work with or without a contact name following.
var greetingVariants = []string{
	"Vážený",
	"Dobrý den vážený",
	"Dobrý den",
}

// PickGreetingVariant deterministically selects one greeting from
// greetingVariants using SHA256(envelopeKey + ":greeting") mod N.
// Exported so operators and tests can call it directly without going through Render.
func PickGreetingVariant(envelopeKey string) string {
	return pickStringVariant(envelopeKey, ":greeting", greetingVariants)
}

// ─────────────────────────────────────────────────────────────────────────────
// Sign-off variants
// ─────────────────────────────────────────────────────────────────────────────

// signOffTemplates are equivalent sign-off formulations. %s is the persona name;
// the caller substitutes the actual name before use.
// Three forms: name only / name + company / name + role.
// All forms retain Czech diacritics.
var signOffTemplates = []string{
	"%s",                         // persona name only
	"%s\nBalkan Motors",          // persona + company
	"%s\nObchodní zástupce",      // persona + role
}

// PickSignOffVariant deterministically selects one sign-off template from
// signOffTemplates using SHA256(envelopeKey + ":signoff") mod N.
// The caller must replace "%s" with the actual persona name (e.g. via fmt.Sprintf).
// Exported so tests can verify the selection independently.
func PickSignOffVariant(envelopeKey string) string {
	return pickStringVariant(envelopeKey, ":signoff", signOffTemplates)
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

// pickStringVariant picks deterministically from a slice using SHA256 hashing.
// Returns "" for empty slice (guard against misconfiguration).
func pickStringVariant(envelopeKey, salt string, variants []string) string {
	if len(variants) == 0 {
		return ""
	}
	h := sha256.Sum256([]byte(envelopeKey + salt))
	idx := int(binary.BigEndian.Uint32(h[:4])) % len(variants)
	return variants[idx]
}
