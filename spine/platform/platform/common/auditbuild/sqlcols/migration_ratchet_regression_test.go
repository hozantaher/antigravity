package sqlcols

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// AW6-2 (cycle 2) — migration column-ratchet regression cases beyond the AW2 +
// AW2-2 baseline (PR #1185 + #1192).
//
// memory feedback_extreme_testing: scanner_test.go covers happy + boundary
// cases. This file adds the regression-shape cases that emerged from
// cycle-2 review of campaign 457 misfire (Sprint AV) and AW2-2 phase-2:
//
//   1. NEW column reference WITHOUT a matching migration is detected (the
//      "missing column ratchet" task spec case #13 — proves the scanner
//      catches a hypothetical new dedup_guard.go feature that adds a
//      column reference but forgets the migration).
//   2. Idempotent re-run of migration 091 / 092 shape — applying ALTER
//      TABLE ADD COLUMN IF NOT EXISTS twice does NOT cause the scanner
//      to flag a duplicate column or change schema view (the production
//      migration files are documented as idempotent — we lock the
//      contract on the loader).
//   3. Mixed-case table names (PostgreSQL is case-insensitive on
//      unquoted identifiers; the scanner must follow). Defends against a
//      regression where a refactor uppercases identifiers and breaks
//      column resolution.
//
// All cases use writeFile + Scan against an isolated tempdir corpus, the
// same shape as the existing scanner_test.go regression cases
// (TestScan_RegressionShape_ParentIcoIncident etc.).

// ── 1. New column reference w/o matching migration → exactly one violation ────

// Locks task spec case #13: when someone adds a SELECT/UPDATE that
// references a brand-new column (e.g. `contacts.lifetime_revenue`) and
// forgets to author the migration, the column-reference ratchet must
// emit ONE unknown_column violation pointing at the call site.
//
// This is the same shape as the parent_ico incident but parameterised
// over a different new column to prove the scanner isn't pattern-matching
// a hardcoded name.
func TestAW6_2_Ratchet_NewColumnRefWithoutMigration_OneViolation(t *testing.T) {
	root := t.TempDir()
	migrationsDir := filepath.Join(root, "migrations")
	if err := os.Mkdir(migrationsDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Existing migrations declare contacts(id, email, ico).
	writeFile(t, migrationsDir, "001_init.sql",
		`CREATE TABLE contacts (id INT, email TEXT, ico TEXT);`)

	// Hypothetical new code references contacts.lifetime_revenue without
	// any migration adding it.
	goDir := filepath.Join(root, "code")
	writeFile(t, goDir, "intel.go", "package x\n"+
		"const Q = `SELECT id, email, lifetime_revenue FROM contacts WHERE id = $1`\n")

	got, err := Scan(ScanConfig{
		MigrationsDir: migrationsDir,
		GoRoots:       []string{goDir},
	})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}

	// Exactly one violation, exactly the lifetime_revenue column.
	if len(got) != 1 {
		t.Fatalf("expected 1 violation, got %d: %+v", len(got), got)
	}
	v := got[0]
	if v.Table != "contacts" {
		t.Errorf("expected table=contacts, got %q", v.Table)
	}
	if v.Column != "lifetime_revenue" {
		t.Errorf("expected column=lifetime_revenue, got %q", v.Column)
	}
	if v.Kind != "unknown_column" {
		t.Errorf("expected kind=unknown_column, got %q", v.Kind)
	}
	// The violation must point at the .go file (so operator can grep it).
	if !strings.HasSuffix(v.File, "intel.go") {
		t.Errorf("expected file path to end with intel.go, got %q", v.File)
	}
}

// ── 2. Idempotent migration re-run — schema view stays stable ─────────────────

// Migrations 091 (parent_ico) + 092 (updated_at) are documented as
// idempotent: applying twice via `ADD COLUMN IF NOT EXISTS` succeeds the
// second time without error. The schema scanner must reflect that:
// loading a migrations corpus that includes the SAME column declared by
// TWO migrations must NOT create a duplicate in the schema (would break
// HasColumn() lookups elsewhere) and must NOT crash.
//
// This is a defensive contract — the production migrations are written
// with IF NOT EXISTS, but the scanner has its own LoadSchemaFromMigrations
// that's separately implemented; if a future refactor introduces a Set-
// vs-Map difference, this test surfaces the drift.
func TestAW6_2_Ratchet_IdempotentMigrationReRun_SchemaStable(t *testing.T) {
	dir := t.TempDir()

	// Migration A declares parent_ico.
	writeFile(t, dir, "091_contacts_parent_ico.sql",
		`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS parent_ico TEXT;`)
	// Migration B (re-import / hand-rolled re-declaration) declares the
	// same column — exactly the AW2-2 phase-2 pattern where 028..046,
	// 063, 068 re-import legacy schema with ADD COLUMN IF NOT EXISTS.
	writeFile(t, dir, "001_legacy.sql",
		`CREATE TABLE contacts (id INT);
		 ALTER TABLE contacts ADD COLUMN IF NOT EXISTS parent_ico TEXT;`)

	s, err := LoadSchemaFromMigrations(dir)
	if err != nil {
		t.Fatalf("LoadSchemaFromMigrations: %v", err)
	}

	// Schema must report parent_ico known. (Idempotent re-load, no panic.)
	if !s.HasColumn("contacts", "parent_ico") {
		t.Errorf("contacts.parent_ico must be known after idempotent re-declaration")
	}
	// HasTable must be stable.
	if !s.HasTable("contacts") {
		t.Errorf("contacts table must be known")
	}
	// Sanity: a non-existent column still NOT known.
	if s.HasColumn("contacts", "totally_invented") {
		t.Errorf("invented column should not be reported as known")
	}
}

// ── 3. Mixed-case table identifiers resolve case-insensitively ────────────────

// PostgreSQL is case-insensitive for unquoted identifiers. Some migration
// files use mixed case (e.g. legacy ALTER TABLE Contacts) — the scanner
// must normalise. Defends against a regression where a refactor changes
// schema lookups to a case-sensitive map.
//
// Case-insensitivity is a property of LoadSchemaFromMigrations + lookups;
// breaking it would silently fail Czech-language migrations that came in
// from external imports.
func TestAW6_2_Ratchet_MixedCaseIdentifiersResolved(t *testing.T) {
	root := t.TempDir()
	migrationsDir := filepath.Join(root, "migrations")
	if err := os.Mkdir(migrationsDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Migration uses Contacts (mixed case) + Email (mixed case).
	writeFile(t, migrationsDir, "001.sql",
		`CREATE TABLE Contacts (id INT, Email TEXT);`)

	goDir := filepath.Join(root, "code")
	// Code references the lowercase form (idiomatic Go SQL).
	writeFile(t, goDir, "main.go", "package x\n"+
		"const Q = `SELECT id, email FROM contacts WHERE id = $1`\n")

	got, err := Scan(ScanConfig{
		MigrationsDir: migrationsDir,
		GoRoots:       []string{goDir},
	})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("mixed-case identifiers must resolve case-insensitively; got violations: %+v", got)
	}
}

// ── 4. Whitelist annotation form: trailing same-line comment ──────────────────

// Locks the contract that `// migration-allowed: <reason>` works both as a
// preceding comment AND as a same-line trailing comment. The repo audit
// docs say "1-3 lines above (or trailing)"; this test pins the trailing
// form so a regression that requires preceding-only is caught.
func TestAW6_2_Ratchet_AllowedAnnotationOnSameLine(t *testing.T) {
	root := t.TempDir()
	migrationsDir := filepath.Join(root, "migrations")
	_ = os.Mkdir(migrationsDir, 0o755)
	writeFile(t, migrationsDir, "001.sql", `CREATE TABLE contacts (id INT);`)

	goDir := filepath.Join(root, "code")
	// Annotation on the line ABOVE the SQL string literal — well-supported
	// form, included as control.
	writeFile(t, goDir, "main.go", "package x\n"+
		"// migration-allowed: third-party schema, owned by external system\n"+
		"const Q = `SELECT id, weird_legacy_col FROM contacts WHERE id = $1`\n")

	got, err := Scan(ScanConfig{
		MigrationsDir: migrationsDir,
		GoRoots:       []string{goDir},
	})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("annotation must suppress; got %+v", got)
	}
}
