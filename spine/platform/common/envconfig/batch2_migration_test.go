package envconfig_test

// batch2_migration_test.go — verifies the ≥10 test-case contract for the
// batch-2 os.Getenv → envconfig.GetOr/BoolOr migration (orchestrator + privacy-gateway).
//
// This batch zeroes out the consumption ratchet: baseline 14 → 0.
//
// Migrated callsites (services/orchestrator):
//   - cmd/outreach/main.go: LAB_ONLY, TRANSPORT_MODE slog fields → GetOr
//     + parseCSVEnv helper → GetOr(key, fallback)
//   - imap/poller.go: MAIL_MAX_SIZE_BYTES → GetOr
//   - intelligence/loop.go: ENABLE_SMTP_PROBE → BoolOr; ANTI_TRACE_URL,
//     ANTI_TRACE_TOKEN → GetOr
//   - intelligence/stubs.go: WATCHDOG_ADAPTIVE_RELEASE → GetOr
//   - seed/prodlike/rng.go: SEED_RNG → GetOr
//   - web/auth.go: OUTREACH_API_KEY → GetOr
//   - cmd/anonymity-{harvest,humanlike,score,test}/main.go: DATABASE_URL → GetOr
//
// Migrated callsites (services/privacy-gateway):
//   - internal/config/config.go: envOrDefault removed (Load() already uses GetOr);
//     envIntOrDefault + envPositiveIntOrDefault → GetOr internally.
//
// Tests 1–11 target GetOr/BoolOr semantics for the migrated call patterns.
// Tests 12–14 are boundary/error cases specific to batch-2 patterns.
// Test 15 verifies the ratchet baseline equals the actual count.

import (
	"os"
	"testing"

	"common/envconfig"
)

// ─── 1. GetOr returns env value for a string key (LAB_ONLY-style log field) ──

func TestBatch2_GetOr_StringKeyReturnedValue(t *testing.T) {
	t.Setenv("BATCH2_LAB_ONLY", "1")
	got := envconfig.GetOr("BATCH2_LAB_ONLY", "")
	if got != "1" {
		t.Errorf("GetOr with set string key: got %q, want %q", got, "1")
	}
}

// ─── 2. GetOr returns empty fallback when key unset (OUTREACH_API_KEY pattern) ─

func TestBatch2_GetOr_EmptyFallbackWhenUnset(t *testing.T) {
	os.Unsetenv("BATCH2_OUTREACH_API_KEY_9901")
	got := envconfig.GetOr("BATCH2_OUTREACH_API_KEY_9901", "")
	if got != "" {
		t.Errorf("GetOr unset key with empty fallback: got %q, want %q", got, "")
	}
}

// ─── 3. GetOr with non-empty fallback (parseCSVEnv pattern) ──────────────────
// parseCSVEnv called os.Getenv(key); if empty, used a hardcoded fallback.
// Now uses envconfig.GetOr(key, fallback) directly.

func TestBatch2_GetOr_WithNonEmptyFallback(t *testing.T) {
	os.Unsetenv("BATCH2_CSV_KEY_9902")
	got := envconfig.GetOr("BATCH2_CSV_KEY_9902", "default,csv,value")
	if got != "default,csv,value" {
		t.Errorf("GetOr with non-empty fallback: got %q, want %q", got, "default,csv,value")
	}
}

// ─── 4. GetOr env value overrides non-empty fallback ─────────────────────────

func TestBatch2_GetOr_EnvOverridesFallback(t *testing.T) {
	t.Setenv("BATCH2_CSV_OVERRIDE_9903", "actual,value")
	got := envconfig.GetOr("BATCH2_CSV_OVERRIDE_9903", "fallback,value")
	if got != "actual,value" {
		t.Errorf("GetOr with set env: got %q, want fallback overridden with %q", got, "actual,value")
	}
}

// ─── 5. BoolOr "1" true — ENABLE_SMTP_PROBE pattern ────────────────────────
// intelligence/loop.go: was `os.Getenv("ENABLE_SMTP_PROBE") == "1"`.
// Now uses envconfig.BoolOr which accepts "1" | "true" | "yes" | "on".

func TestBatch2_BoolOr_EnableSmtpProbeStyle_1(t *testing.T) {
	t.Setenv("BATCH2_SMTP_PROBE_9904", "1")
	if !envconfig.BoolOr("BATCH2_SMTP_PROBE_9904", false) {
		t.Error("BoolOr(\"1\") should be true")
	}
}

// ─── 6. BoolOr false when unset (ENABLE_SMTP_PROBE default) ─────────────────

func TestBatch2_BoolOr_UnsetDefaultsFalse(t *testing.T) {
	os.Unsetenv("BATCH2_SMTP_PROBE_UNSET_9905")
	if envconfig.BoolOr("BATCH2_SMTP_PROBE_UNSET_9905", false) {
		t.Error("BoolOr unset should return fallback=false")
	}
}

// ─── 7. BoolOr "0" false — WATCHDOG_ADAPTIVE_RELEASE pattern ────────────────
// intelligence/stubs.go: was `os.Getenv("WATCHDOG_ADAPTIVE_RELEASE") != "0"`.
// Now: envconfig.GetOr("WATCHDOG_ADAPTIVE_RELEASE", "0") != "0"
// Semantics: BoolOr should return false for "0".

func TestBatch2_BoolOr_ZeroFalse(t *testing.T) {
	t.Setenv("BATCH2_WATCHDOG_DISABLE_9906", "0")
	if envconfig.BoolOr("BATCH2_WATCHDOG_DISABLE_9906", true) {
		t.Error("BoolOr(\"0\") should be false")
	}
}

// ─── 8. GetOr MAIL_MAX_SIZE_BYTES: numeric string returned as-is ─────────────
// imap/poller.go calls envconfig.GetOr("MAIL_MAX_SIZE_BYTES", "") then
// parses with strconv.Atoi. GetOr must preserve the raw string.

func TestBatch2_GetOr_NumericStringPreserved(t *testing.T) {
	t.Setenv("BATCH2_MAIL_MAX_SIZE_9907", "10485760")
	got := envconfig.GetOr("BATCH2_MAIL_MAX_SIZE_9907", "")
	if got != "10485760" {
		t.Errorf("GetOr numeric string: got %q, want %q", got, "10485760")
	}
}

// ─── 9. GetOr DATABASE_URL — non-empty when set ───────────────────────────────
// cmd/anonymity-*/main.go: `cfg.databaseURL = envconfig.GetOr("DATABASE_URL", "")`
// followed by an empty-string check. GetOr must return the value when set.

func TestBatch2_GetOr_DatabaseURLWhenSet(t *testing.T) {
	t.Setenv("BATCH2_DATABASE_URL_9908", "postgres://user:pass@host/db?sslmode=disable")
	got := envconfig.GetOr("BATCH2_DATABASE_URL_9908", "")
	if got != "postgres://user:pass@host/db?sslmode=disable" {
		t.Errorf("GetOr with DSN: got %q", got)
	}
}

// ─── 10. GetOr DATABASE_URL — empty fallback when unset ─────────────────────
// Same pattern: the caller checks `if got == ""` and returns an error.

func TestBatch2_GetOr_DatabaseURLWhenUnset(t *testing.T) {
	os.Unsetenv("BATCH2_DATABASE_URL_UNSET_9909")
	got := envconfig.GetOr("BATCH2_DATABASE_URL_UNSET_9909", "")
	if got != "" {
		t.Errorf("GetOr unset DATABASE_URL: got %q, want empty string", got)
	}
}

// ─── 11. BoolOr "true" (case-insensitive) — gate-flag pattern ───────────────

func TestBatch2_BoolOr_TrueCI(t *testing.T) {
	for _, v := range []string{"true", "TRUE", "True", "yes", "YES", "on", "ON"} {
		t.Run(v, func(t *testing.T) {
			t.Setenv("BATCH2_BOOL_CI_9910", v)
			if !envconfig.BoolOr("BATCH2_BOOL_CI_9910", false) {
				t.Errorf("BoolOr(%q) should be true", v)
			}
		})
	}
}

// ─── 12. GetOr empty string env var falls through to fallback ────────────────
// ANTI_TRACE_URL: if operator sets to "" accidentally, GetOr must
// still return the fallback so the caller's non-empty guard works correctly.

func TestBatch2_GetOr_EmptyEnvFallsToFallback(t *testing.T) {
	t.Setenv("BATCH2_ANTI_TRACE_URL_9911", "")
	got := envconfig.GetOr("BATCH2_ANTI_TRACE_URL_9911", "http://default-relay:8080")
	if got != "http://default-relay:8080" {
		t.Errorf("GetOr empty env should fall to fallback: got %q", got)
	}
}

// ─── 13. GetOr whitespace-only value is returned as-is (not trimmed) ────────
// Spec: "whitespace-only values are returned as-is (NOT trimmed)" per envconfig.go.
// This guards against an operator typing "  " getting silently mapped to fallback.

func TestBatch2_GetOr_WhitespaceReturnedVerbatim(t *testing.T) {
	t.Setenv("BATCH2_WHITESPACE_9912", "   ")
	got := envconfig.GetOr("BATCH2_WHITESPACE_9912", "fallback")
	if got != "   " {
		t.Errorf("GetOr whitespace-only value should NOT be trimmed: got %q, want %q", got, "   ")
	}
}

// ─── 14. BoolOr unknown value returns fallback (typo safety) ─────────────────
// Protects against operators typing "enabled" or "yes " (with trailing space)
// for ENABLE_SMTP_PROBE and similar flags. Should fall back, not guess.

func TestBatch2_BoolOr_UnknownValueReturnsFallback(t *testing.T) {
	for _, v := range []string{"enabled", "disabled", "yes ", " 1", "maybe", "2"} {
		t.Run(v, func(t *testing.T) {
			t.Setenv("BATCH2_BOOL_TYPO_9913", v)
			// Both fallback=true and fallback=false — must return the fallback.
			gotFalse := envconfig.BoolOr("BATCH2_BOOL_TYPO_9913", false)
			gotTrue := envconfig.BoolOr("BATCH2_BOOL_TYPO_9913", true)
			if gotFalse != false {
				t.Errorf("BoolOr(%q, false): unknown value should return fallback=false, got %v", v, gotFalse)
			}
			if gotTrue != true {
				t.Errorf("BoolOr(%q, true): unknown value should return fallback=true, got %v", v, gotTrue)
			}
		})
	}
}

// ─── 15. Audit ratchet baseline matches actual count (baseline=0) ────────────
// Mirrors TestBatch1_AuditBaseline_IsCurrent but locked to the batch-2 target.
// Fails both ways (too high: missing migration; too low: impossible with ratchet).

func TestBatch2_AuditBaseline_IsZero(t *testing.T) {
	root := servicesRoot(t)
	violations, err := scanEnvconfigViolations(root)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	const target = 0
	if len(violations) != target {
		t.Errorf("expected %d violations after batch-2 migration, got %d", target, len(violations))
		for _, v := range violations {
			t.Logf("  remaining: %s", v)
		}
		t.Logf("Fix: replace bare os.Getenv with envconfig.GetOr / BoolOr, or annotate")
		t.Logf("     // envconfig-allowed: <reason>  (1–3 lines above or same-line trailing comment).")
	}
}
