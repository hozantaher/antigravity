package web

import (
	"testing"

	"common/auditbuild/slogop"
)

// BF-F2 — discipline test: every slog.Error/Warn call in this package
// must include an "op" string-keyed argument. Without it, log-search by
// operation is broken (we can grep "error":"db connection lost" but
// not "op":"web.handleOpenPixel/insert").
//
// Mirrors services/campaigns/sender/slog_op_audit_test.go. Each service
// keeps its own ratchet count so a regression in one doesn't drag the
// other down. New code without "op" → test fails. Migrating an existing
// one → operator may lower the baseline.
//
// Audit ratchet sweep 2026-04-30: baseline 2→0 (server.go dashboard
// stats Scan loops + scanStat helper migrated). Floor lock.
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
