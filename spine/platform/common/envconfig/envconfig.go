// Package envconfig — boot-time env-var validation.
//
// BF-G4 — every service has its own ad-hoc env-var unmarshalling. Some
// validate, some don't. A missing DATABASE_URL should crash at boot,
// not on first request. This package centralises the contract.
//
// Usage at the top of main.go:
//
//	cfg := envconfig.Required(
//	    "DATABASE_URL",
//	    "OUTREACH_API_KEY",
//	    "ANTI_TRACE_RELAY_TOKEN",
//	)
//	envconfig.OptionalDefault(&cfg, "APP_ENV", "development")
//	envconfig.MustValidate(cfg) // os.Exit(1) on missing required
//
// or, single-call:
//
//	envconfig.MustHave("DATABASE_URL", "OUTREACH_API_KEY")
package envconfig

import (
	"encoding/base64"
	"fmt"
	"log/slog"
	"os"
	"strings"
)

// Schema captures one service's expected env vars.
type Schema struct {
	required map[string]bool
	optional map[string]string // var → default
}

// Required builds a Schema with the given required env keys.
func Required(keys ...string) Schema {
	s := Schema{required: make(map[string]bool, len(keys)), optional: make(map[string]string)}
	for _, k := range keys {
		s.required[k] = true
	}
	return s
}

// OptionalDefault registers an optional var with a fallback. If the env
// is missing or empty, os.Setenv writes the default so subsequent
// os.Getenv calls in the program return it without re-checking.
func OptionalDefault(s *Schema, key, defaultVal string) {
	if s.optional == nil {
		s.optional = make(map[string]string)
	}
	s.optional[key] = defaultVal
	if os.Getenv(key) == "" {
		_ = os.Setenv(key, defaultVal)
	}
}

// Validate returns the list of missing required env keys, or nil.
// Required keys whose value is the empty string after trim are also reported.
func Validate(s Schema) []string {
	var missing []string
	for k := range s.required {
		if strings.TrimSpace(os.Getenv(k)) == "" {
			missing = append(missing, k)
		}
	}
	return missing
}

// MustValidate panics — actually os.Exit(1) — when any required key is missing.
// Use this at the top of main(); it must never be reached after server boot.
func MustValidate(s Schema) {
	if missing := Validate(s); len(missing) > 0 {
		slog.Error("envconfig: required env vars missing", "missing", missing)
		fmt.Fprintf(os.Stderr, "FATAL: missing required env vars: %s\n", strings.Join(missing, ", "))
		os.Exit(1)
	}
}

// MustHave is the one-line form: build + validate in a single call.
// Equivalent to MustValidate(Required(keys...)).
func MustHave(keys ...string) {
	MustValidate(Required(keys...))
}

// GetOr returns os.Getenv(key) when non-empty, otherwise fallback.
//
// Canonical replacement for the dozen ad-hoc envOr / envOrDefault
// helpers that previously lived in each service. Behaviour is the
// strict superset that all prior copies agreed on:
//
//	- empty string ("") falls back
//	- whitespace-only values are returned as-is (NOT trimmed)
//	- no parsing, no normalisation
//
// If you need parsing, layer it on top of GetOr in the caller.
func GetOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// RequireBase64Bytes reads key from the environment, base64-decodes the
// value, and returns the raw bytes. The decoded length must be at least
// minBytes — short keys are rejected at boot so a typo never silently
// downgrades HMAC strength to "weakly seeded".
//
// Both standard and URL-safe base64 alphabets are accepted (operators
// often paste output of `head -c 32 /dev/urandom | base64` which uses
// the standard alphabet, while some CI secret stores prefer URL-safe).
// Padding is auto-detected.
//
// Used at boot for MESSAGE_ID_HMAC_KEY (anti-trace anonymity bundle):
//
//	keyBytes, err := envconfig.RequireBase64Bytes("MESSAGE_ID_HMAC_KEY", 32)
//	if err != nil { os.Exit(1) }
//	engine.WithMessageIDHMACKey(keyBytes)
//
// Returns an error rather than os.Exit so the caller can compose with
// other boot-time validation and emit a single coherent error log.
func RequireBase64Bytes(key string, minBytes int) ([]byte, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return nil, fmt.Errorf("envconfig: required env var %s is missing", key)
	}
	// Try std with padding, std raw (no padding), URL with padding,
	// URL raw — in that order. Whichever succeeds wins.
	decoders := []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.URLEncoding,
		base64.RawURLEncoding,
	}
	for _, dec := range decoders {
		if decoded, err := dec.DecodeString(raw); err == nil {
			if len(decoded) < minBytes {
				return nil, fmt.Errorf(
					"envconfig: %s decodes to %d bytes, need >= %d (regenerate with `head -c %d /dev/urandom | base64`)",
					key, len(decoded), minBytes, minBytes,
				)
			}
			return decoded, nil
		}
	}
	return nil, fmt.Errorf("envconfig: %s is not valid base64 (tried std, raw-std, url, raw-url alphabets)", key)
}

// BoolOr parses an env var as a boolean using the operator-facing
// alias dialect documented for LAB_ONLY and similar gates:
//
//	true  ← "1" | "true" | "yes" | "on"   (case-insensitive, exact)
//	false ← "0" | "false" | "no" | "off"  (case-insensitive, exact)
//	fallback ← empty / unknown / value with surrounding whitespace
//
// This dialect was previously implemented inconsistently — some sites
// used strconv.ParseBool (which rejects "yes"/"on"), others used the
// allow-list above. The unified contract picks the allow-list because
// it matches what operators type in shell exports and what the
// LAB_ONLY runbook documents. Unknown values return fallback so a
// typo never silently flips operational behaviour.
//
// Whitespace-padded values (e.g. "yes ") are treated as unknown and
// return fallback — they indicate a mis-quoted shell export and
// we never silently normalise them.
func BoolOr(key string, fallback bool) bool {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	// Reject values with surrounding whitespace — they indicate a typo or
	// mis-quoted shell export. We never silently normalise.
	v := strings.ToLower(raw)
	if strings.TrimSpace(v) != v {
		return fallback
	}
	switch v {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return fallback
}
