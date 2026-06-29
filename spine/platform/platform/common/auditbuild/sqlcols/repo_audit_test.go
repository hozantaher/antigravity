package sqlcols_test

// TestRepoSQLColumnAudit_RatchetBaseline scans the production source
// trees of this monorepo and fails when a SQL string literal references
// a column or table that no migration in scripts/migrations/ declares.
//
// Why this exists
// ───────────────
// Three production incidents within five days proved that "code
// references a column the schema does not have" is a recurring failure
// mode this repo cannot afford:
//
//  1. services/campaigns/sender/dedup_guard.go SELECTed
//     contacts.parent_ico while no migration ever added the column.
//     PROD threw `column "parent_ico" does not exist` and the dedup
//     guard fail-opened across the entire send path. Fixed in
//     scripts/migrations/091_contacts_parent_ico.sql.
//
//  2. apps/outreach-dashboard/src/lib/campaign-send-batch.js UPDATEd
//     campaign_contacts.updated_at on six call sites; no migration
//     ever added that column. Fixed in
//     scripts/migrations/092_campaign_contacts_updated_at.sql.
//
//  3. scripts/migrations/049_dedup_guard.sql was authored in an
//     earlier PR but the operator forgot to apply + verify it on
//     PROD. The dedup guard ran against a stale schema for ~12 hours.
//     Sister fix tracked in #1182 (runner atomicity).
//
// All three are downstream of the HARD-rule memory
// `feedback_migration_apply_immediately`. The dynamic half (apply +
// verify) is enforced operationally; this test is the static half.
//
// Sister docs
// ───────────
// Fail mode: TestRepoSQLColumnAudit_RatchetBaseline reports a list of
// (file, line, table.column) violations with kind=unknown_column or
// kind=unknown_table. The fix is one of:
//
//   - Add a migration in scripts/migrations/0NN_*.sql that declares
//     the column, then APPLY + VERIFY it on local + PROD before the
//     PR merges (per HARD rule).
//   - Annotate the call site with `// migration-allowed: <reason>`
//     on the line above (or trailing) the SQL string literal. Use
//     this only for legitimate exceptions: external schema, donor
//     tables, dynamic schema operations, or columns declared inside
//     a DO $$ block this scanner does not yet parse.
//
// Baseline policy
// ───────────────
// `repoAuditBaseline` is the locked count of (currently-tolerated)
// violations. Any number STRICTLY GREATER than the baseline fails the
// test. When you cleanly fix N violations, lower the baseline by N.
// Adding new violations while leaving the baseline alone breaks CI
// and that is intentional.
//
// Pattern: services/common/envconfig/consumption_audit_test.go +
// services/orchestrator/imap/no_raw_imap_hosts_audit_test.go.

import (
	"os"
	"path/filepath"
	"testing"

	"common/auditbuild/sqlcols"
)

// repoAuditBaseline is the locked count of column-reference violations
// across the production code paths scanned below. Lower this constant
// when you migrate or whitelist a call site, never raise it without
// review.
//
// Phase 2 (AW2-2, 2026-05-09): the migration corpus gaps at numeric
// positions 028..046, 063, 068 and 069 were filled by hand-rolled
// "legacy schema import" migrations (`028_legacy_companies_schema.sql`
// through `068_legacy_users_and_blacklist.sql`). Each declares
// `CREATE TABLE IF NOT EXISTS` + a list of `ADD COLUMN IF NOT EXISTS`
// for columns that production code references. Column names are
// derived from real call sites — not speculation. Idempotent:
// re-runs are safe because PROD already has the columns under their
// canonical types. Slots 089 remain reserved for a future re-import
// pass if it materialises; nothing in the current codebase references
// a table that depends on it.
//
// Result: baseline drops from 1333 (Phase 1) to 0. Any new column
// reference that has no matching `CREATE TABLE` or `ADD COLUMN` in
// the migration corpus now fails CI immediately. There is no longer
// a "tolerated drift" window.
//
// To raise the baseline you must either:
//   - Author a migration that adds the column, then APPLY + VERIFY it
//     on PROD before merging (per HARD memory rule
//     `feedback_migration_apply_immediately`).
//   - Annotate the call site with `// migration-allowed: <reason>`
//     directly above the SQL string literal.
const repoAuditBaseline = 0

func TestRepoSQLColumnAudit_RatchetBaseline(t *testing.T) {
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

	// JS scope: the BFF lib + server.js. We deliberately exclude
	// build artefacts (apps/outreach-dashboard/dist, .vite, etc.) via
	// the scanner's directory-skip list.
	bffLib := filepath.Join(root, "apps", "outreach-dashboard", "src")
	if _, err := os.Stat(bffLib); err != nil {
		t.Logf("BFF src not found (skipping JS scope): %v", err)
		bffLib = ""
	}
	bffServer := filepath.Join(root, "apps", "outreach-dashboard", "server.js")
	jsFiles := []string{}
	if _, err := os.Stat(bffServer); err == nil {
		jsFiles = append(jsFiles, bffServer)
	}

	cfg := sqlcols.ScanConfig{
		MigrationsDir: migrationsDir,
		GoRoots:       []string{servicesRoot},
		JSFiles:       jsFiles,
		// Phase 2 (AW2-2): the legacy schema imports
		// (028..046, 063, 068) declare every CREATE TABLE the
		// scanner needs. We can now require zero unknown_table
		// noise: a brand-new table that lands in code without a
		// matching migration must fail this test, not silently
		// pass.
		IgnoreUnknownTables: false,
	}
	if bffLib != "" {
		cfg.JSRoots = []string{bffLib}
	}

	violations, err := sqlcols.Scan(cfg)
	if err != nil {
		t.Fatalf("sqlcols.Scan: %v", err)
	}

	// Pretty-print relative to the repo root for grep-friendly logs.
	pretty := make([]string, 0, len(violations))
	for _, v := range violations {
		rel, relErr := filepath.Rel(root, v.File)
		if relErr != nil {
			rel = v.File
		}
		rel = filepath.ToSlash(rel)
		pretty = append(pretty, rel+":"+itoa(v.Line)+": "+v.Table+"."+v.Column+
			" ("+v.Origin+") — "+v.Kind)
	}

	if len(violations) > repoAuditBaseline {
		t.Errorf("AW2 ratchet: %d SQL column-reference violations "+
			"(baseline %d). Each is either a missing migration or a "+
			"stale code reference.", len(violations), repoAuditBaseline)
		for i, line := range pretty {
			if i >= 25 {
				t.Logf("  ... %d more", len(pretty)-25)
				break
			}
			t.Logf("  %s", line)
		}
		t.Logf("Fix:")
		t.Logf("  - Add a migration in scripts/migrations/0NN_*.sql " +
			"that declares the missing column, then APPLY it locally " +
			"+ verify with SELECT before the PR merges.")
		t.Logf("  - Or annotate the call site with " +
			"`// migration-allowed: <reason>` 1-3 lines above (or " +
			"trailing) the SQL literal.")
		t.Logf("  - Then lower repoAuditBaseline by the number of " +
			"violations you removed.")
	}
	if len(violations) < repoAuditBaseline {
		t.Logf("Violation count dropped from %d to %d. Lower repoAuditBaseline accordingly.",
			repoAuditBaseline, len(violations))
	}
}

// repoRoot walks from the test's working directory upward until it
// finds the directory containing both go.work and scripts/migrations/.
// Tests run from services/common/auditbuild/sqlcols/, so the repo
// root is four levels up — but the climb is dynamic so the test
// continues to work if the layout changes.
func repoRoot() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	dir := cwd
	for i := 0; i < 12; i++ {
		_, errA := os.Stat(filepath.Join(dir, "go.work"))
		_, errB := os.Stat(filepath.Join(dir, "scripts", "migrations"))
		if errA == nil && errB == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", &repoRootError{cwd: cwd}
}

type repoRootError struct{ cwd string }

func (e *repoRootError) Error() string {
	return "could not find repo root from " + e.cwd +
		" (looking for go.work + scripts/migrations/)"
}

// itoa is a tiny stack-only int formatter so the test does not pull in
// strconv just for one diagnostic call.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	negative := n < 0
	if negative {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if negative {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

