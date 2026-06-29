package sender

import (
	"testing"

	"common/auditbuild/slogop"
)

// BF-F2 — discipline test: every slog.Error/Warn call in this package
// must include an "op" string-keyed argument. Without it, log-search by
// operation is broken (we can grep "error":"db connection lost" but
// not "op":"sender.recordSendResult/transient").
//
// Test asserts the count of violations is at most a known baseline.
// Adding a new slog.Error without "op" → test fails. Migrating an
// existing one → operator can lower the baseline.
//
// Audit ratchet sweep 2026-04-30: baseline 5→0 (all 3 remaining
// engine.go violations fixed: dailyCap fail-open, ActiveAddresses
// fallback, mailbox cooldown). Floor lock — any new slog.Error/Warn
// without "op" v sender package okamžitě zlomí test.
//
// 2026-04-30 (PR #404): scanner extracted to common/auditbuild/slogop.
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
