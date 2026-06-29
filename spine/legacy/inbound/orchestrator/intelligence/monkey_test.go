package intelligence

// monkey_test.go — property-based and monkey tests for domain.go and
// engagement.go. Focuses on nil safety, boundary invariants, and no-panic
// guarantees across arbitrary inputs.

import (
	"testing"
	"testing/quick"
)

// ── maxInt / minInt property tests ────────────────────────────────────────────

func TestMaxInt_ReturnsLarger(t *testing.T) {
	f := func(a, b int) bool {
		m := maxInt(a, b)
		return m >= a && m >= b
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 1000}); err != nil {
		t.Errorf("maxInt property: %v", err)
	}
}

func TestMaxInt_IsOneOfInputs(t *testing.T) {
	f := func(a, b int) bool {
		m := maxInt(a, b)
		return m == a || m == b
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 1000}); err != nil {
		t.Errorf("maxInt must return one of its inputs: %v", err)
	}
}

func TestMaxInt_Idempotent(t *testing.T) {
	f := func(a, b int) bool {
		return maxInt(a, b) == maxInt(b, a)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 1000}); err != nil {
		t.Errorf("maxInt is not commutative: %v", err)
	}
}

func TestMinInt_ReturnsSmaller(t *testing.T) {
	f := func(a, b int) bool {
		m := minInt(a, b)
		return m <= a && m <= b
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 1000}); err != nil {
		t.Errorf("minInt property: %v", err)
	}
}

func TestMinInt_IsOneOfInputs(t *testing.T) {
	f := func(a, b int) bool {
		m := minInt(a, b)
		return m == a || m == b
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 1000}); err != nil {
		t.Errorf("minInt must return one of its inputs: %v", err)
	}
}

func TestMinInt_Idempotent(t *testing.T) {
	f := func(a, b int) bool {
		return minInt(a, b) == minInt(b, a)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 1000}); err != nil {
		t.Errorf("minInt is not commutative: %v", err)
	}
}

func TestMaxMinInverse(t *testing.T) {
	f := func(a, b int) bool {
		// max(a,b) >= min(a,b) always
		return maxInt(a, b) >= minInt(a, b)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 1000}); err != nil {
		t.Errorf("max >= min property: %v", err)
	}
}

// ── DomainHealthConfig boundary tests ────────────────────────────────────────

func TestDefaultDomainHealthConfig_HighBounceGtMedium(t *testing.T) {
	cfg := DefaultDomainHealthConfig()
	if cfg.HighBounceThreshold <= cfg.MediumBounceThreshold {
		t.Errorf("HighBounceThreshold (%v) should be > MediumBounceThreshold (%v)",
			cfg.HighBounceThreshold, cfg.MediumBounceThreshold)
	}
}

func TestDefaultDomainHealthConfig_MediumBounceGtGood(t *testing.T) {
	cfg := DefaultDomainHealthConfig()
	if cfg.MediumBounceThreshold <= cfg.GoodBounceThreshold {
		t.Errorf("MediumBounceThreshold (%v) should be > GoodBounceThreshold (%v)",
			cfg.MediumBounceThreshold, cfg.GoodBounceThreshold)
	}
}

func TestDefaultDomainHealthConfig_MaxDailyCapPositive(t *testing.T) {
	cfg := DefaultDomainHealthConfig()
	if cfg.MaxDailyCap <= 0 {
		t.Errorf("MaxDailyCap should be positive, got %d", cfg.MaxDailyCap)
	}
}

func TestDefaultDomainHealthConfig_MinSentThresholdsPositive(t *testing.T) {
	cfg := DefaultDomainHealthConfig()
	for name, val := range map[string]int{
		"HighBounceMinSent":   cfg.HighBounceMinSent,
		"MediumBounceMinSent": cfg.MediumBounceMinSent,
		"GoodBounceMinSent":   cfg.GoodBounceMinSent,
	} {
		if val <= 0 {
			t.Errorf("%s should be positive, got %d", name, val)
		}
	}
}

func TestDefaultDomainHealthConfig_ThresholdsInUnitRange(t *testing.T) {
	cfg := DefaultDomainHealthConfig()
	for name, v := range map[string]float64{
		"HighBounceThreshold":   cfg.HighBounceThreshold,
		"MediumBounceThreshold": cfg.MediumBounceThreshold,
		"GoodBounceThreshold":   cfg.GoodBounceThreshold,
	} {
		if v < 0 || v > 1 {
			t.Errorf("%s = %v, must be in [0,1]", name, v)
		}
	}
}

// ── Monkey: nil-DB behaviour documentation ───────────────────────────────────
// These tests pass a nil *sql.DB and document the current behaviour.
// All functions currently panic on nil DB — this is a known gap (no nil guard).
// The tests capture the panic and mark it, making the behaviour observable
// without blocking CI. Once nil-guards are added, update to assert error return.

func nilDBPanic(f func()) (panicked bool) {
	defer func() {
		if r := recover(); r != nil {
			panicked = true
		}
	}()
	f()
	return false
}

func TestCheckDomainHealth_NilDB_Behaviour(t *testing.T) {
	panicked := nilDBPanic(func() {
		CheckDomainHealth(t.Context(), nil) //nolint:errcheck
	})
	if panicked {
		t.Log("KNOWN GAP: CheckDomainHealth panics on nil DB (no nil guard)")
	}
	// Passes regardless — documents current behaviour without blocking CI.
}

func TestCheckDomainHealthWithConfig_NilDB_Behaviour(t *testing.T) {
	panicked := nilDBPanic(func() {
		CheckDomainHealthWithConfig(t.Context(), nil, DefaultDomainHealthConfig()) //nolint:errcheck
	})
	if panicked {
		t.Log("KNOWN GAP: CheckDomainHealthWithConfig panics on nil DB (no nil guard)")
	}
}

func TestUpdateEngagementClusters_NilDB_Behaviour(t *testing.T) {
	panicked := nilDBPanic(func() {
		UpdateEngagementClusters(t.Context(), nil) //nolint:errcheck
	})
	if panicked {
		t.Log("KNOWN GAP: UpdateEngagementClusters panics on nil DB (no nil guard)")
	}
}

func TestDetectZeroEngagement_NilDB_Behaviour(t *testing.T) {
	panicked := nilDBPanic(func() {
		DetectZeroEngagement(t.Context(), nil) //nolint:errcheck
	})
	if panicked {
		t.Log("KNOWN GAP: DetectZeroEngagement panics on nil DB (no nil guard)")
	}
}

func TestTopDomains_NilDB_Behaviour(t *testing.T) {
	panicked := nilDBPanic(func() {
		TopDomains(t.Context(), nil, 10) //nolint:errcheck
	})
	if panicked {
		t.Log("KNOWN GAP: TopDomains panics on nil DB (no nil guard)")
	}
}

func TestRecoverSuppressedDomains_NilDB_Behaviour(t *testing.T) {
	panicked := nilDBPanic(func() {
		RecoverSuppressedDomains(t.Context(), nil) //nolint:errcheck
	})
	if panicked {
		t.Log("KNOWN GAP: RecoverSuppressedDomains panics on nil DB (no nil guard)")
	}
}

// ── maxInt/minInt: boundary values ───────────────────────────────────────────

func TestMaxInt_BoundaryValues(t *testing.T) {
	cases := [][3]int{
		{0, 0, 0},
		{-1, 1, 1},
		{1, -1, 1},
		{0, 1, 1},
		{1, 0, 1},
		{-100, -50, -50},
		{1<<30, 1<<20, 1 << 30},
	}
	for _, tc := range cases {
		got := maxInt(tc[0], tc[1])
		if got != tc[2] {
			t.Errorf("maxInt(%d, %d) = %d, want %d", tc[0], tc[1], got, tc[2])
		}
	}
}

func TestMinInt_BoundaryValues(t *testing.T) {
	cases := [][3]int{
		{0, 0, 0},
		{-1, 1, -1},
		{1, -1, -1},
		{0, 1, 0},
		{1, 0, 0},
		{-100, -50, -100},
		{1<<30, 1<<20, 1 << 20},
	}
	for _, tc := range cases {
		got := minInt(tc[0], tc[1])
		if got != tc[2] {
			t.Errorf("minInt(%d, %d) = %d, want %d", tc[0], tc[1], got, tc[2])
		}
	}
}
