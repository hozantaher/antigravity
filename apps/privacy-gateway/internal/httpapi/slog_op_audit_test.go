package httpapi

import (
	"testing"

	"common/auditbuild/slogop"
)

// BF-F2 — discipline: every slog.Error/Warn must include
// "op", "<package>.<func>/<branch>". See docs/playbooks/slog-conventions.md.
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
	}
}
