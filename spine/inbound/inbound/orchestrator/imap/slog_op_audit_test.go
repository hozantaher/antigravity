package imap

import (
	"testing"

	"common/auditbuild/slogop"
)

// Discipline test: every slog.Error/Warn call in this package
// must include an "op" string-keyed argument.
// See docs/playbooks/slog-conventions.md.
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
