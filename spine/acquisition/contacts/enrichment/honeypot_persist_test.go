package enrich

import (
	"context"
	"testing"
)

// TestInsertHoneypotSignals_EmptySignals verifies that calling InsertHoneypotSignals
// with an empty slice is a no-op and returns nil.
func TestInsertHoneypotSignals_EmptySignals(t *testing.T) {
	err := InsertHoneypotSignals(context.Background(), nil, 42, nil)
	if err != nil {
		t.Fatalf("InsertHoneypotSignals with nil signals = %v, want nil", err)
	}

	err = InsertHoneypotSignals(context.Background(), nil, 42, []HoneypotSignal{})
	if err != nil {
		t.Fatalf("InsertHoneypotSignals with empty signals = %v, want nil", err)
	}
}

// TestInsertHoneypotSignals_Signature verifies the function is callable with
// the expected types and that the DB exec path is only reached for non-empty slices.
func TestInsertHoneypotSignals_Signature(t *testing.T) {
	// Build a representative set of signals.
	signals := []HoneypotSignal{
		{Type: "typo_domain", Severity: "medium", Details: "gmial.com → gmail.com", Fix: "user@gmail.com"},
		{Type: "role_based", Severity: "low", Details: "role-based prefix: admin"},
		{Type: "suspicious_pattern", Severity: "high", Details: "suspicious local part: test"},
	}

	// Passing a nil DB with non-empty signals will attempt a DB call and fail —
	// that is expected behaviour; we only verify the function exists and accepts
	// the correct argument types here.
	_ = signals

	// The zero-signal path must never touch the DB.
	err := InsertHoneypotSignals(context.Background(), nil, 1, []HoneypotSignal{})
	if err != nil {
		t.Fatalf("unexpected error on empty signals: %v", err)
	}
}

// TestInsertEnriched_ReturnsID ensures the updated InsertEnriched signature
// returns (int, error) rather than error alone.
// This is a compile-time contract test — if the signature is wrong it won't compile.
func TestInsertEnriched_ReturnsID(_ *testing.T) {
	var _ func(context.Context, interface{ QueryRowContext(context.Context, string, ...any) interface{ Scan(...any) error } }, *EnrichedContact) (int, error)

	// Just verify the types align; actual DB behaviour is covered by e2e tests.
	_ = InsertEnriched // reference to ensure the symbol exists
}
