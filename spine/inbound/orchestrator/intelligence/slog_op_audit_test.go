package intelligence

import (
	"testing"

	"common/auditbuild/slogop"
)

// BF-F2 — discipline test: every slog.Error/Warn call in this package
// must include an "op" string-keyed argument. Without it, log-search by
// operation is broken (we can grep "error":"db connection lost" but
// not "op":"intelligence.RunOnce/domain_health").
//
// Test asserts the count of violations is at most a known baseline.
// Adding a new slog.Error without "op" → test fails. Migrating an
// existing one → operator can lower the baseline.
//
// Audit ratchet sweep 2026-05-05: baseline 0 (PR #756 discipline
// applied to all 50 violations in intelligence/ — split 2 of 3).
// Floor lock — any new slog.Error/Warn without "op" will break test.
const sloggerOpAuditBaseline = 0

func TestSlogOpAudit_PackageHasOpField(t *testing.T) {
	violations, err := slogop.Scan(".")
	if err != nil {
		t.Fatalf("slogop.Scan: %v", err)
	}
	if len(violations) > sloggerOpAuditBaseline {
		t.Errorf("slog.Error/Warn calls without 'op' field: %d (baseline %d)",
			len(violations), sloggerOpAuditBaseline)
		for _, v := range violations {
			t.Logf("  %s", v)
		}
		t.Logf("Add `\"op\", \"<package>.<func>/<branch>\"` as the FIRST keyed arg.")
		t.Logf("See docs/playbooks/slog-conventions.md.")
	}
}
