package sqlcols_test

// TestRepoSQLTableExistence_RatchetBaseline extends the column-existence
// ratchet with a table-level check: when a code reference mentions a table
// that no migration declares with CREATE TABLE, the test fails.
//
// Why this exists
// ───────────────
// The column-existence ratchet catches cases where a table exists but a
// column is missing. However, if code references a completely unknown
// table (not in any migration), the Scan returns unknown_table violations
// only when IgnoreUnknownTables=true. A dedicated test ensures that:
//
//   1. Every table mentioned in code has a CREATE TABLE in migrations.
//   2. New tables cannot be introduced without being declared.
//   3. Baseline ratchet prevents accidental orphans.

import (
	"os"
	"path/filepath"
	"testing"

	"common/auditbuild/sqlcols"
)

// tableExistenceBaseline is the locked count of code references to tables
// that have no CREATE TABLE in the migration corpus. This is a companion
// to repoAuditBaseline in repo_audit_test.go. The two work together:
//   - repoAuditBaseline governs missing columns in known tables.
//   - tableExistenceBaseline governs completely unknown tables.
// When a new table lands in code, both tests must pass before merge.
const tableExistenceBaseline = 0

func TestRepoSQLTableExistence_RatchetBaseline(t *testing.T) {
	root, err := repoRoot()
	if err != nil {
		t.Fatalf("repoRoot: %v", err)
	}

	migrationsDir := filepath.Join(root, "scripts", "migrations")
	if _, err := os.Stat(migrationsDir); err != nil {
		t.Fatalf("migrations dir not found at %s: %v", migrationsDir, err)
	}

	servicesRoot := filepath.Join(root, "services")
	if _, err := os.Stat(servicesRoot); err != nil {
		t.Fatalf("services root not found at %s: %v", servicesRoot, err)
	}

	// JS scope: the BFF lib + server.js.
	bffLib := filepath.Join(root, "apps", "outreach-dashboard", "src")
	bffServer := filepath.Join(root, "apps", "outreach-dashboard", "server.js")
	jsFiles := []string{}
	if _, err := os.Stat(bffServer); err == nil {
		jsFiles = append(jsFiles, bffServer)
	}

	cfg := sqlcols.ScanConfig{
		MigrationsDir:       migrationsDir,
		GoRoots:             []string{servicesRoot},
		JSFiles:             jsFiles,
		IgnoreUnknownTables: false, // Fail on unknown tables.
	}
	if _, err := os.Stat(bffLib); err == nil {
		cfg.JSRoots = []string{bffLib}
	}

	violations, err := sqlcols.Scan(cfg)
	if err != nil {
		t.Fatalf("sqlcols.Scan: %v", err)
	}

	// Filter to only unknown_table violations.
	var tableViolations []sqlcols.Violation
	for _, v := range violations {
		if v.Kind == "unknown_table" {
			tableViolations = append(tableViolations, v)
		}
	}

	if len(tableViolations) > tableExistenceBaseline {
		t.Errorf("AW2-3 table-existence ratchet: %d SQL table references "+
			"with no CREATE TABLE in migrations (baseline %d).",
			len(tableViolations), tableExistenceBaseline)
		pretty := make([]string, 0, len(tableViolations))
		for _, v := range tableViolations {
			rel, relErr := filepath.Rel(root, v.File)
			if relErr != nil {
				rel = v.File
			}
			rel = filepath.ToSlash(rel)
			pretty = append(pretty, rel+":"+itoa(v.Line)+": table "+
				v.Table+" ("+v.Origin+")")
		}
		for i, line := range pretty {
			if i >= 15 {
				t.Logf("  ... %d more", len(pretty)-15)
				break
			}
			t.Logf("  %s", line)
		}
		t.Logf("Fix:")
		t.Logf("  - Add a migration in scripts/migrations/0NN_*.sql that " +
			"declares the table with CREATE TABLE, then APPLY + VERIFY " +
			"it locally before merge.")
		t.Logf("  - Then lower tableExistenceBaseline by the number you fixed.")
	}
	if len(tableViolations) < tableExistenceBaseline {
		t.Logf("Table violations dropped from %d to %d. Lower tableExistenceBaseline.",
			tableExistenceBaseline, len(tableViolations))
	}
}
