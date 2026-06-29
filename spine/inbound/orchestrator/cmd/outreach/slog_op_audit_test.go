package main

import (
	"testing"

	"common/auditbuild/slogop"
)

// BF-F2 — discipline test: every slog.Error/Warn call in cmd/outreach
// must include an "op" string-keyed argument. Without it, log-search by
// operation is broken (we can grep "error":"db connection lost" but
// not "op":"outreach.main/migrate").
//
// Test asserts the count of violations is at most a known baseline.
// Adding a new slog.Error without "op" → test fails. Migrating an
// existing one → operator can lower the baseline.
//
// 2026-05-05 (PR #8XX): orchestrator/cmd/outreach fixed with canonical
// op fields per "outreach.main/<case>" pattern. Baseline: 0.
// All 126 violations in main.go now have "op", "error" keyed correctly.
// Floor lock — any new slog.Error/Warn without "op" breaks test.
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
		t.Logf("Add `\"op\", \"outreach.main/<case>\"` as the FIRST keyed arg.")
		t.Logf("See docs/playbooks/slog-conventions.md.")
	}
}
