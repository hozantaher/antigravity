package watchdog

import (
	"testing"

	"common/auditbuild/slogop"
)

// BF-F2 — same discipline as services/campaigns/sender +
// services/orchestrator/web. Every slog.Error/Warn must include
// "op", "<package>.<func>/<branch>".
//
// Audit ratchet sweep 2026-04-30: baseline 15→14 — actual count drift
// down. Ratchets capture migration progress; no new slog code added.
//
// 2026-04-30 (PR #404): scanner extracted to common/auditbuild/slogop.
// 2026-05-02 (Sprint D3.2): baseline 14→0 after adding "op" to all slog calls.
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
		t.Logf("See docs/playbooks/slog-conventions.md.")
	}
}
