package envconfig_test

// batch1_migration_test.go — verifies the ≥10 test-case contract from the
// PR description for the batch-1 os.Getenv → envconfig.GetOr/BoolOr migration.
//
// Tests 1–9 target GetOr and BoolOr semantics relevant to the migrated
// call sites. Test 10 exercises one migrated callsite (alert.New) end-to-end.
// Test 11 verifies the ratchet baseline reflects the actual count.

import (
	"os"
	"testing"

	"common/alert"
	"common/envconfig"
)

// ─── 1. GetOr returns env value when set ──────────────────────────────────────

func TestBatch1_GetOr_ReturnsValueWhenSet(t *testing.T) {
	t.Setenv("BATCH1_TEST_SET", "expected-value")
	got := envconfig.GetOr("BATCH1_TEST_SET", "fallback")
	if got != "expected-value" {
		t.Errorf("GetOr with set var: got %q, want %q", got, "expected-value")
	}
}

// ─── 2. GetOr returns fallback when unset ────────────────────────────────────

func TestBatch1_GetOr_ReturnsFallbackWhenUnset(t *testing.T) {
	os.Unsetenv("BATCH1_TEST_UNSET_9991")
	got := envconfig.GetOr("BATCH1_TEST_UNSET_9991", "default")
	if got != "default" {
		t.Errorf("GetOr with unset var: got %q, want %q", got, "default")
	}
}

// ─── 3. GetOr returns fallback on empty string ──────────────────────────────

func TestBatch1_GetOr_ReturnsFallbackOnEmpty(t *testing.T) {
	t.Setenv("BATCH1_TEST_EMPTY_9992", "")
	got := envconfig.GetOr("BATCH1_TEST_EMPTY_9992", "default")
	if got != "default" {
		t.Errorf("GetOr with empty var: got %q, want %q", got, "default")
	}
}

// ─── 4. BoolOr "1" → true ────────────────────────────────────────────────────

func TestBatch1_BoolOr_OneIsTrue(t *testing.T) {
	t.Setenv("BATCH1_BOOL_ONE", "1")
	if !envconfig.BoolOr("BATCH1_BOOL_ONE", false) {
		t.Error("BoolOr(\"1\") should be true")
	}
}

// ─── 5. BoolOr "0" → false ───────────────────────────────────────────────────

func TestBatch1_BoolOr_ZeroIsFalse(t *testing.T) {
	t.Setenv("BATCH1_BOOL_ZERO", "0")
	if envconfig.BoolOr("BATCH1_BOOL_ZERO", true) {
		t.Error("BoolOr(\"0\") should be false")
	}
}

// ─── 6. BoolOr "true" → true (case-insensitive) ─────────────────────────────

func TestBatch1_BoolOr_TrueCaseInsensitive(t *testing.T) {
	for _, v := range []string{"true", "TRUE", "True"} {
		t.Run(v, func(t *testing.T) {
			t.Setenv("BATCH1_BOOL_CI", v)
			if !envconfig.BoolOr("BATCH1_BOOL_CI", false) {
				t.Errorf("BoolOr(%q) should be true", v)
			}
		})
	}
}

// ─── 7. BoolOr "yes" → true; unknown → fallback ─────────────────────────────
// "yes"/"on" are accepted truthy aliases. "maybe" is not — falls back.

func TestBatch1_BoolOr_YesIsTrue_MaybeIsFallback(t *testing.T) {
	t.Setenv("BATCH1_BOOL_YES", "yes")
	if !envconfig.BoolOr("BATCH1_BOOL_YES", false) {
		t.Error("BoolOr(\"yes\") should be true")
	}

	t.Setenv("BATCH1_BOOL_MAYBE", "maybe")
	if envconfig.BoolOr("BATCH1_BOOL_MAYBE", false) {
		t.Error("BoolOr(\"maybe\") should return fallback=false")
	}
}

// ─── 8. BoolOr unset → fallback ──────────────────────────────────────────────

func TestBatch1_BoolOr_UnsetReturnsFallback(t *testing.T) {
	os.Unsetenv("BATCH1_BOOL_UNSET_7771")
	if envconfig.BoolOr("BATCH1_BOOL_UNSET_7771", true) != true {
		t.Error("BoolOr unset should return fallback=true")
	}
	if envconfig.BoolOr("BATCH1_BOOL_UNSET_7771", false) != false {
		t.Error("BoolOr unset should return fallback=false")
	}
}

// ─── 9. Required schema fails on missing ─────────────────────────────────────

func TestBatch1_Required_FailsOnMissing(t *testing.T) {
	os.Unsetenv("BATCH1_REQ_MISSING_8881")
	s := envconfig.Required("BATCH1_REQ_MISSING_8881")
	missing := envconfig.Validate(s)
	if len(missing) != 1 || missing[0] != "BATCH1_REQ_MISSING_8881" {
		t.Errorf("Required with missing key: got %v, want [BATCH1_REQ_MISSING_8881]", missing)
	}
}

// ─── 10. Integration: migrated callsite (alert.New) reads env correctly ──────
// alert.New() was migrated from os.Getenv to envconfig.GetOr.
// Verifying the observable behaviour is unchanged.

func TestBatch1_AlertNew_ReadsWebhookURLFromEnv(t *testing.T) {
	t.Setenv("ALERT_WEBHOOK_URL", "http://test-webhook.example.com/hook")
	c := alert.New()
	if !c.Enabled() {
		t.Error("alert.New() with ALERT_WEBHOOK_URL set should report Enabled()=true")
	}
}

func TestBatch1_AlertNew_DisabledWhenURLUnset(t *testing.T) {
	os.Unsetenv("ALERT_WEBHOOK_URL")
	c := alert.New()
	if c.Enabled() {
		t.Error("alert.New() with ALERT_WEBHOOK_URL unset should report Enabled()=false")
	}
}

// ─── 11. Audit ratchet baseline matches actual count ─────────────────────────
// The consumptionAuditBaseline constant must equal the real scanner result.
// If the actual count drops below the constant, this test warns (mirror of
// TestEnvconfigConsumption_RatchetBaseline's lower-bound warning).

func TestBatch1_AuditBaseline_IsCurrent(t *testing.T) {
	root := servicesRoot(t)
	violations, err := scanEnvconfigViolations(root)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	const expectedBaseline = consumptionAuditBaseline
	if len(violations) != expectedBaseline {
		t.Errorf("violation count %d != consumptionAuditBaseline %d — update the constant",
			len(violations), expectedBaseline)
		for _, v := range violations {
			t.Logf("  %s", v)
		}
	}
}
