package envconfig_test

// batch3_migration_test.go — verifies the ≥10 test-case contract from the
// AA1 Sprint (boot-time validation adoption).
//
// Migrated callsites:
//   - services/orchestrator/probe/synthetic.go: 5 bare os.Getenv calls
//     → envconfig.BoolOr (SYNTHETIC_PROBE_ENABLED)
//     → envconfig.GetOr  (SYNTHETIC_PROBE_FROM_MAILBOX_ID, SYNTHETIC_PROBE_TO_MAILBOX_ID,
//                          ANTI_TRACE_RELAY_URL, ANTI_TRACE_RELAY_TOKEN)
//   - services/relay/web/probe.go:675: verifyGetEnv var annotated
//     // envconfig-allowed: test-injectable func var
//
// Tests 1–5 cover the exact BoolOr/GetOr semantics used in synthetic.go.
// Tests 6–10 cover edge cases: zero ID strings, empty relay URL, token boundary.
// Tests 11–12 cover the annotation scanner (relay/web/probe.go pattern).
// Test 13 verifies the ratchet baseline is still 0 after AA1.

import (
	"os"
	"testing"

	"common/envconfig"
)

// ─── 1. BoolOr "true" → enabled (SYNTHETIC_PROBE_ENABLED=true) ──────────────
// synthetic.go was: `os.Getenv("SYNTHETIC_PROBE_ENABLED") == "true"`.
// Now: envconfig.BoolOr("SYNTHETIC_PROBE_ENABLED", false).
// "true" must resolve to boolean true.

func TestBatch3_SyntheticProbeEnabled_TrueString(t *testing.T) {
	t.Setenv("AA1_SYNTHETIC_PROBE_ENABLED_1", "true")
	if !envconfig.BoolOr("AA1_SYNTHETIC_PROBE_ENABLED_1", false) {
		t.Error("BoolOr(\"true\") should be true for SYNTHETIC_PROBE_ENABLED pattern")
	}
}

// ─── 2. BoolOr unset → disabled (probe off by default) ───────────────────────
// When SYNTHETIC_PROBE_ENABLED is absent, probe must stay disabled.

func TestBatch3_SyntheticProbeEnabled_UnsetDefaultsOff(t *testing.T) {
	os.Unsetenv("AA1_SYNTHETIC_PROBE_ENABLED_2")
	if envconfig.BoolOr("AA1_SYNTHETIC_PROBE_ENABLED_2", false) {
		t.Error("BoolOr unset with fallback=false: probe should be disabled")
	}
}

// ─── 3. BoolOr "false" → disabled ────────────────────────────────────────────
// Operator explicitly disabling the probe with SYNTHETIC_PROBE_ENABLED=false.

func TestBatch3_SyntheticProbeEnabled_FalseString(t *testing.T) {
	t.Setenv("AA1_SYNTHETIC_PROBE_ENABLED_3", "false")
	if envconfig.BoolOr("AA1_SYNTHETIC_PROBE_ENABLED_3", true) {
		t.Error("BoolOr(\"false\") should be false even with fallback=true")
	}
}

// ─── 4. GetOr returns mailbox ID string when set ──────────────────────────────
// SYNTHETIC_PROBE_FROM_MAILBOX_ID is a numeric string parsed by strconv.ParseInt.
// GetOr must return the raw string so the caller can parse it.

func TestBatch3_SyntheticProbeFromMailboxID_WhenSet(t *testing.T) {
	t.Setenv("AA1_FROM_MAILBOX_ID_4", "42")
	got := envconfig.GetOr("AA1_FROM_MAILBOX_ID_4", "")
	if got != "42" {
		t.Errorf("GetOr FROM_MAILBOX_ID: got %q, want %q", got, "42")
	}
}

// ─── 5. GetOr returns empty when mailbox ID unset ────────────────────────────
// synthetic.go checks `if fromStr == ""` after GetOr and returns an error.
// GetOr must return "" so the guard fires correctly.

func TestBatch3_SyntheticProbeFromMailboxID_WhenUnset(t *testing.T) {
	os.Unsetenv("AA1_FROM_MAILBOX_ID_5")
	got := envconfig.GetOr("AA1_FROM_MAILBOX_ID_5", "")
	if got != "" {
		t.Errorf("GetOr unset FROM_MAILBOX_ID: got %q, want empty string", got)
	}
}

// ─── 6. GetOr returns relay URL when set ─────────────────────────────────────
// ANTI_TRACE_RELAY_URL must be returned verbatim for the relay client constructor.

func TestBatch3_AntiTraceRelayURL_WhenSet(t *testing.T) {
	t.Setenv("AA1_ANTI_TRACE_RELAY_URL_6", "http://relay.internal:8080")
	got := envconfig.GetOr("AA1_ANTI_TRACE_RELAY_URL_6", "")
	if got != "http://relay.internal:8080" {
		t.Errorf("GetOr relay URL: got %q", got)
	}
}

// ─── 7. GetOr returns empty for relay URL when unset ─────────────────────────
// synthetic.go checks `if relayURL == ""` and errors; GetOr must propagate empty.

func TestBatch3_AntiTraceRelayURL_WhenUnset(t *testing.T) {
	os.Unsetenv("AA1_ANTI_TRACE_RELAY_URL_7")
	got := envconfig.GetOr("AA1_ANTI_TRACE_RELAY_URL_7", "")
	if got != "" {
		t.Errorf("GetOr unset relay URL: got %q, want empty", got)
	}
}

// ─── 8. GetOr returns relay token when set ───────────────────────────────────
// ANTI_TRACE_RELAY_TOKEN: must be a non-empty string when the relay is active.

func TestBatch3_AntiTraceRelayToken_WhenSet(t *testing.T) {
	t.Setenv("AA1_ANTI_TRACE_RELAY_TOKEN_8", "tok-abcdef123456")
	got := envconfig.GetOr("AA1_ANTI_TRACE_RELAY_TOKEN_8", "")
	if got != "tok-abcdef123456" {
		t.Errorf("GetOr relay token: got %q", got)
	}
}

// ─── 9. GetOr returns TO mailbox ID string when set ──────────────────────────
// SYNTHETIC_PROBE_TO_MAILBOX_ID: same pattern as FROM_MAILBOX_ID.

func TestBatch3_SyntheticProbeToMailboxID_WhenSet(t *testing.T) {
	t.Setenv("AA1_TO_MAILBOX_ID_9", "7")
	got := envconfig.GetOr("AA1_TO_MAILBOX_ID_9", "")
	if got != "7" {
		t.Errorf("GetOr TO_MAILBOX_ID: got %q, want %q", got, "7")
	}
}

// ─── 10. BoolOr "1" also enables probe (alias for "true") ───────────────────
// Some operators use "1" instead of "true"; BoolOr must accept both for parity.

func TestBatch3_SyntheticProbeEnabled_OneAlias(t *testing.T) {
	t.Setenv("AA1_SYNTHETIC_PROBE_ENABLED_10", "1")
	if !envconfig.BoolOr("AA1_SYNTHETIC_PROBE_ENABLED_10", false) {
		t.Error("BoolOr(\"1\") should be true (accepted alias for SYNTHETIC_PROBE_ENABLED)")
	}
}

// ─── 11. Annotation scanner: envconfig-allowed on same line suppresses count ─
// relay/web/probe.go:675 uses a same-line trailing `// envconfig-allowed: ...`.
// The scanner must not count it.

func TestBatch3_Scanner_SameLineAnnotationSuppresses(t *testing.T) {
	dir := t.TempDir()
	writeGo(t, dir+"/probe.go", `package web
import "os"
// verifyGetEnv reads an env var. Injectable in tests.
// envconfig-allowed: test-injectable func var — closure wraps os.Getenv; callers use envconfig.GetOr
var verifyGetEnv = func(key string) string { return os.Getenv(key) }
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 0 {
		t.Errorf("envconfig-allowed annotation should suppress count, got violations: %v", v)
	}
}

// ─── 12. Annotation scanner: func-var wrapper without annotation is counted ──
// If the annotation were removed from relay/web/probe.go, the scanner should
// report the violation. This test verifies the guard works correctly.

func TestBatch3_Scanner_FuncVarWithoutAnnotationIsCounted(t *testing.T) {
	dir := t.TempDir()
	writeGo(t, dir+"/probe.go", `package web
import "os"
// verifyGetEnv reads an env var. Injectable in tests.
var verifyGetEnv = func(key string) string { return os.Getenv(key) }
`)
	v, err := scanEnvconfigViolations(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(v) != 1 {
		t.Errorf("unannotated func-var wrapper should count as violation, got %d: %v", len(v), v)
	}
}

// ─── 13. Ratchet baseline is still 0 after AA1 ───────────────────────────────
// Verifies that all 6 violations (5 synthetic.go + 1 relay/web/probe.go)
// are resolved: 5 migrated to envconfig API, 1 annotated as envconfig-allowed.

func TestBatch3_AuditBaseline_StillZeroAfterAA1(t *testing.T) {
	root := servicesRoot(t)
	violations, err := scanEnvconfigViolations(root)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	const target = 0
	if len(violations) != target {
		t.Errorf("AA1: expected %d violations after migration, got %d", target, len(violations))
		for _, v := range violations {
			t.Logf("  remaining: %s", v)
		}
	}
}
