package sqlcols

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeFile is the same scratch-file helper used by the slogop tests.
// Keeps test code free of boilerplate around os.WriteFile error returns.
func writeFile(t *testing.T, dir, name, content string) {
	t.Helper()
	full := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(full), err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", full, err)
	}
}

// ── Schema-loading tests ───────────────────────────────────────────────

func TestLoadSchema_CreateTable(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "001_init.sql", `
		CREATE TABLE contacts (
			id SERIAL PRIMARY KEY,
			email TEXT NOT NULL,
			region TEXT,
			"crm_client_id" BIGINT
		);
	`)
	s, err := LoadSchemaFromMigrations(dir)
	if err != nil {
		t.Fatalf("LoadSchemaFromMigrations: %v", err)
	}
	if !s.HasTable("contacts") {
		t.Errorf("expected table contacts to be known")
	}
	for _, c := range []string{"id", "email", "region", "crm_client_id"} {
		if !s.HasColumn("contacts", c) {
			t.Errorf("expected contacts.%s to be known", c)
		}
	}
}

func TestLoadSchema_AlterTableAddColumn(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "001_init.sql", `CREATE TABLE foo (id INT);`)
	writeFile(t, dir, "002_extend.sql", `
		ALTER TABLE foo ADD COLUMN IF NOT EXISTS new_col TEXT;
		ALTER TABLE foo ADD COLUMN region TEXT;
	`)
	s, err := LoadSchemaFromMigrations(dir)
	if err != nil {
		t.Fatalf("LoadSchemaFromMigrations: %v", err)
	}
	if !s.HasColumn("foo", "new_col") {
		t.Errorf("expected foo.new_col to be known after ADD COLUMN IF NOT EXISTS")
	}
	if !s.HasColumn("foo", "region") {
		t.Errorf("expected foo.region to be known after ADD COLUMN")
	}
}

func TestLoadSchema_LineCommentsStripped(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "001.sql", `
		-- ALTER TABLE foo ADD COLUMN forbidden_col TEXT; -- a comment-only DDL
		CREATE TABLE foo (id INT);
	`)
	s, err := LoadSchemaFromMigrations(dir)
	if err != nil {
		t.Fatalf("LoadSchemaFromMigrations: %v", err)
	}
	if s.HasColumn("foo", "forbidden_col") {
		t.Errorf("commented-out DDL must not be absorbed into the schema")
	}
}

func TestLoadSchema_SchemaQualifiedNamesUnqualified(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "001.sql", `CREATE TABLE public.bar (id INT, label TEXT);`)
	s, err := LoadSchemaFromMigrations(dir)
	if err != nil {
		t.Fatalf("LoadSchemaFromMigrations: %v", err)
	}
	if !s.HasTable("bar") {
		t.Errorf("public.bar should be recorded as bar")
	}
	if !s.HasColumn("bar", "label") {
		t.Errorf("public.bar.label should be known")
	}
}

func TestLoadSchema_ViewsRecorded(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "001.sql", `
		CREATE TABLE base (id INT);
		CREATE OR REPLACE VIEW v_summary AS SELECT id FROM base;
	`)
	s, err := LoadSchemaFromMigrations(dir)
	if err != nil {
		t.Fatalf("LoadSchemaFromMigrations: %v", err)
	}
	if !s.HasView("v_summary") {
		t.Errorf("CREATE VIEW v_summary should be recorded")
	}
}

// ── ExtractColumnRefs tests ─────────────────────────────────────────────

func TestExtractColumnRefs_SelectFromSimple(t *testing.T) {
	refs := ExtractColumnRefs(
		`SELECT dnt, lifetime_touches, email_domain, region, parent_ico, crm_client_id
			 FROM contacts
			 WHERE id = $1`,
	)
	got := map[string]bool{}
	for _, r := range refs {
		if r.Table != "contacts" {
			t.Errorf("got table %q, want contacts", r.Table)
		}
		got[r.Column] = true
	}
	for _, want := range []string{"dnt", "lifetime_touches", "email_domain",
		"region", "parent_ico", "crm_client_id"} {
		if !got[want] {
			t.Errorf("expected column %q in extracted refs, got %+v", want, refs)
		}
	}
}

func TestExtractColumnRefs_UpdateSet(t *testing.T) {
	refs := ExtractColumnRefs(
		`UPDATE campaign_contacts SET status='queued', updated_at=NOW()
		 WHERE campaign_id=$1`,
	)
	got := map[string]bool{}
	for _, r := range refs {
		if r.Table != "campaign_contacts" {
			t.Errorf("got table %q, want campaign_contacts", r.Table)
		}
		got[r.Column] = true
	}
	for _, want := range []string{"status", "updated_at"} {
		if !got[want] {
			t.Errorf("expected column %q in UPDATE refs, got %+v", want, refs)
		}
	}
}

func TestExtractColumnRefs_InsertExplicitColumns(t *testing.T) {
	refs := ExtractColumnRefs(
		`INSERT INTO send_events (campaign_id, contact_id, status)
		 VALUES ($1, $2, 'queued')`,
	)
	got := map[string]bool{}
	for _, r := range refs {
		if r.Table != "send_events" {
			t.Errorf("got table %q, want send_events", r.Table)
		}
		got[r.Column] = true
	}
	for _, want := range []string{"campaign_id", "contact_id", "status"} {
		if !got[want] {
			t.Errorf("expected column %q in INSERT refs", want)
		}
	}
}

func TestExtractColumnRefs_SelectWithJoinSkipped(t *testing.T) {
	// A SELECT that immediately follows the table with a JOIN clause
	// is intentionally NOT parsed — alias resolution would be required.
	refs := ExtractColumnRefs(
		`SELECT a, b FROM contacts c JOIN campaigns ca ON c.id = ca.id`,
	)
	if len(refs) != 0 {
		t.Errorf("expected no refs from JOIN-shaped SELECT (alias resolution skipped); got %+v", refs)
	}
}

func TestExtractColumnRefs_SelectWithFunctionsSkipped(t *testing.T) {
	// We deliberately ignore SELECT lists with function calls.
	refs := ExtractColumnRefs(`SELECT COUNT(*) FROM contacts`)
	if len(refs) != 0 {
		t.Errorf("expected SELECT COUNT(*) to be skipped, got %+v", refs)
	}
}

func TestExtractColumnRefs_UpdateWithAliasPrefix(t *testing.T) {
	refs := ExtractColumnRefs(
		`UPDATE contacts c SET c.region='cz', updated_at=NOW() WHERE c.id=$1`,
	)
	got := map[string]bool{}
	for _, r := range refs {
		got[r.Column] = true
	}
	if !got["region"] {
		t.Errorf("expected region from c.region (alias matches table)")
	}
	if !got["updated_at"] {
		t.Errorf("expected updated_at from un-prefixed assignment")
	}
}

func TestExtractColumnRefs_InsertSelectFormSkipped(t *testing.T) {
	// INSERT INTO foo SELECT ... has no column list — the regex must
	// not invent one.
	refs := ExtractColumnRefs(`INSERT INTO foo SELECT id, name FROM bar`)
	// Expect zero INSERT refs against foo. (The SELECT side is then
	// matched against table "bar", which IS valid.)
	for _, r := range refs {
		if r.Table == "foo" {
			t.Errorf("INSERT INTO foo SELECT should not produce refs against foo, got %+v", r)
		}
	}
}

func TestExtractColumnRefs_LineCommentsStripped(t *testing.T) {
	refs := ExtractColumnRefs(
		`SELECT id, -- a, b, c
		   name FROM contacts`,
	)
	got := map[string]bool{}
	for _, r := range refs {
		got[r.Column] = true
	}
	if got["a"] || got["b"] || got["c"] {
		t.Errorf("commented-out column tokens must not be extracted, got %+v", refs)
	}
	if !got["id"] || !got["name"] {
		t.Errorf("expected id and name to remain after comment strip, got %+v", refs)
	}
}

// ── Scan integration tests ─────────────────────────────────────────────

func TestScan_FlagsMissingColumn_Go(t *testing.T) {
	root := t.TempDir()
	migrationsDir := filepath.Join(root, "migrations")
	if err := os.Mkdir(migrationsDir, 0o755); err != nil {
		t.Fatalf("mkdir migrations: %v", err)
	}
	writeFile(t, migrationsDir, "001.sql",
		`CREATE TABLE contacts (id INT, email TEXT);`)

	goDir := filepath.Join(root, "code")
	writeFile(t, goDir, "go.mod", "module x\n")
	writeFile(t, goDir, "main.go",
		"package x\n"+
			"const Q = `SELECT id, parent_ico FROM contacts WHERE id = $1`\n")

	got, err := Scan(ScanConfig{
		MigrationsDir: migrationsDir,
		GoRoots:       []string{goDir},
	})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 violation, got %d: %+v", len(got), got)
	}
	if got[0].Table != "contacts" || got[0].Column != "parent_ico" || got[0].Kind != "unknown_column" {
		t.Errorf("unexpected violation shape: %+v", got[0])
	}
}

func TestScan_ResolvesColumnAfterAlterAddColumn(t *testing.T) {
	root := t.TempDir()
	migrationsDir := filepath.Join(root, "migrations")
	_ = os.Mkdir(migrationsDir, 0o755)
	writeFile(t, migrationsDir, "001.sql", `CREATE TABLE contacts (id INT);`)
	writeFile(t, migrationsDir, "091.sql",
		`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS parent_ico TEXT;`)

	goDir := filepath.Join(root, "code")
	writeFile(t, goDir, "main.go",
		"package x\n"+
			"const Q = `SELECT id, parent_ico FROM contacts WHERE id = $1`\n")
	got, err := Scan(ScanConfig{
		MigrationsDir: migrationsDir,
		GoRoots:       []string{goDir},
	})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected zero violations after migration adds parent_ico; got %+v", got)
	}
}

func TestScan_FlagsMissingColumn_JS(t *testing.T) {
	root := t.TempDir()
	migrationsDir := filepath.Join(root, "migrations")
	_ = os.Mkdir(migrationsDir, 0o755)
	writeFile(t, migrationsDir, "001.sql",
		`CREATE TABLE campaign_contacts (id INT, status TEXT);`)

	jsDir := filepath.Join(root, "js")
	writeFile(t, jsDir, "send.js",
		"export async function f(pool) {\n"+
			"  await pool.query(`UPDATE campaign_contacts SET status='queued', updated_at=NOW() WHERE id=$1`, [1]);\n"+
			"}\n")

	got, err := Scan(ScanConfig{
		MigrationsDir: migrationsDir,
		JSRoots:       []string{jsDir},
	})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	var found bool
	for _, v := range got {
		if v.Table == "campaign_contacts" && v.Column == "updated_at" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected a missing-column violation for campaign_contacts.updated_at; got %+v", got)
	}
}

func TestScan_HonorsAllowedAnnotation_Go(t *testing.T) {
	root := t.TempDir()
	migrationsDir := filepath.Join(root, "migrations")
	_ = os.Mkdir(migrationsDir, 0o755)
	writeFile(t, migrationsDir, "001.sql",
		`CREATE TABLE contacts (id INT);`)

	goDir := filepath.Join(root, "code")
	writeFile(t, goDir, "main.go", "package x\n"+
		"// migration-allowed: third-party schema, owned by external process\n"+
		"const Q = `SELECT id, weird_col FROM contacts WHERE id = $1`\n")

	got, err := Scan(ScanConfig{
		MigrationsDir: migrationsDir,
		GoRoots:       []string{goDir},
	})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected annotation to suppress violation, got %+v", got)
	}
}

func TestScan_HonorsAllowedAnnotation_JS(t *testing.T) {
	root := t.TempDir()
	migrationsDir := filepath.Join(root, "migrations")
	_ = os.Mkdir(migrationsDir, 0o755)
	writeFile(t, migrationsDir, "001.sql",
		`CREATE TABLE foo (id INT);`)

	jsDir := filepath.Join(root, "js")
	writeFile(t, jsDir, "f.js",
		"// migration-allowed: legacy adapter, schema enforced by donor system\n"+
			"const Q = `SELECT id, weird_col FROM foo WHERE id = $1`;\n")

	got, err := Scan(ScanConfig{
		MigrationsDir: migrationsDir,
		JSRoots:       []string{jsDir},
	})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected annotation to suppress violation, got %+v", got)
	}
}

func TestScan_UnknownTableSurfacedByDefault(t *testing.T) {
	root := t.TempDir()
	migrationsDir := filepath.Join(root, "migrations")
	_ = os.Mkdir(migrationsDir, 0o755)
	writeFile(t, migrationsDir, "001.sql", `CREATE TABLE foo (id INT);`)

	goDir := filepath.Join(root, "code")
	writeFile(t, goDir, "main.go", "package x\n"+
		"const Q = `SELECT id FROM does_not_exist WHERE id = $1`\n")

	got, err := Scan(ScanConfig{
		MigrationsDir: migrationsDir,
		GoRoots:       []string{goDir},
	})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(got) != 1 || got[0].Kind != "unknown_table" {
		t.Errorf("expected unknown_table, got %+v", got)
	}

	got2, err := Scan(ScanConfig{
		MigrationsDir:       migrationsDir,
		GoRoots:             []string{goDir},
		IgnoreUnknownTables: true,
	})
	if err != nil {
		t.Fatalf("Scan ignore: %v", err)
	}
	if len(got2) != 0 {
		t.Errorf("IgnoreUnknownTables=true should suppress unknown_table; got %+v", got2)
	}
}

func TestScan_TestFilesIgnored(t *testing.T) {
	root := t.TempDir()
	migrationsDir := filepath.Join(root, "migrations")
	_ = os.Mkdir(migrationsDir, 0o755)
	writeFile(t, migrationsDir, "001.sql", `CREATE TABLE foo (id INT);`)

	goDir := filepath.Join(root, "code")
	// A *_test.go file with a deliberately-broken SELECT must NOT be
	// scanned.
	writeFile(t, goDir, "main_test.go", "package x\nfunc TestX(t any) {}\n"+
		"const Q = `SELECT broken_col FROM foo`\n")

	got, err := Scan(ScanConfig{
		MigrationsDir: migrationsDir,
		GoRoots:       []string{goDir},
	})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("test files must be ignored; got %+v", got)
	}
}

func TestScan_DeterministicOrdering(t *testing.T) {
	// Two violations across two files at known lines must come back in
	// (file, line, table, column) order regardless of walk order.
	root := t.TempDir()
	migrationsDir := filepath.Join(root, "migrations")
	_ = os.Mkdir(migrationsDir, 0o755)
	writeFile(t, migrationsDir, "001.sql", `CREATE TABLE foo (id INT);`)

	goDir := filepath.Join(root, "code")
	writeFile(t, goDir, "z.go", "package x\nconst Q = `SELECT z_col FROM foo`\n")
	writeFile(t, goDir, "a.go", "package x\nconst Q = `SELECT a_col FROM foo`\n")

	got, err := Scan(ScanConfig{
		MigrationsDir: migrationsDir,
		GoRoots:       []string{goDir},
	})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 violations, got %d: %+v", len(got), got)
	}
	if !strings.HasSuffix(got[0].File, "a.go") {
		t.Errorf("expected first violation to be in a.go; got %s", got[0].File)
	}
	if !strings.HasSuffix(got[1].File, "z.go") {
		t.Errorf("expected second violation to be in z.go; got %s", got[1].File)
	}
}

// ── Multi-line / multi-statement string literal cases ──────────────────

func TestExtractColumnRefs_MultiStatementString(t *testing.T) {
	refs := ExtractColumnRefs(`
		UPDATE foo SET x=1 WHERE id=$1;
		UPDATE bar SET y=2 WHERE id=$2;
	`)
	got := map[string]string{}
	for _, r := range refs {
		got[r.Table+"."+r.Column] = r.Origin
	}
	if got["foo.x"] == "" {
		t.Errorf("expected foo.x ref")
	}
	if got["bar.y"] == "" {
		t.Errorf("expected bar.y ref")
	}
}

// ── Regression simulation: AW2 incident shapes ─────────────────────────

// TestScan_RegressionShape_ParentIcoIncident reproduces the exact
// incident from 2026-05-09: dedup_guard.go SELECTs contacts.parent_ico
// before the migration adding it has been authored. The audit must
// emit a single unknown_column violation. Sister incident: campaign 457
// launch attempt; cf. scripts/migrations/091_contacts_parent_ico.sql.
func TestScan_RegressionShape_ParentIcoIncident(t *testing.T) {
	root := t.TempDir()
	migrationsDir := filepath.Join(root, "migrations")
	if err := os.Mkdir(migrationsDir, 0o755); err != nil {
		t.Fatalf("mkdir migrations: %v", err)
	}
	// Pretend the migration corpus is everything BEFORE 091. The
	// CREATE TABLE contacts already names dnt + lifetime_touches +
	// email_domain + region (these arrive via ALTER) but parent_ico
	// is intentionally absent.
	writeFile(t, migrationsDir, "001_init.sql",
		`CREATE TABLE contacts (id INT, email TEXT);`)
	writeFile(t, migrationsDir, "049_dedup_guard.sql", `
		ALTER TABLE contacts ADD COLUMN IF NOT EXISTS dnt BOOLEAN;
		ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lifetime_touches INT;
		ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_domain TEXT;
		ALTER TABLE contacts ADD COLUMN IF NOT EXISTS region TEXT;
	`)
	writeFile(t, migrationsDir, "050_crm.sql",
		`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS crm_client_id BIGINT;`)

	goDir := filepath.Join(root, "code")
	writeFile(t, goDir, "dedup_guard.go", "package x\n"+
		"const Q = `SELECT dnt, lifetime_touches, email_domain, region, "+
		"parent_ico, crm_client_id FROM contacts WHERE id = $1`\n")

	got, err := Scan(ScanConfig{
		MigrationsDir: migrationsDir,
		GoRoots:       []string{goDir},
	})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	// Exactly one violation, exactly the parent_ico column.
	if len(got) != 1 {
		t.Fatalf("expected 1 violation (parent_ico), got %d: %+v", len(got), got)
	}
	if got[0].Table != "contacts" || got[0].Column != "parent_ico" {
		t.Errorf("expected contacts.parent_ico, got %+v", got[0])
	}
	if got[0].Kind != "unknown_column" {
		t.Errorf("expected kind=unknown_column, got %q", got[0].Kind)
	}
}

// TestScan_RegressionShape_UpdatedAtIncident reproduces the second
// incident: campaign-send-batch.js UPDATEs campaign_contacts.updated_at
// before the migration adding it. The audit must flag updated_at on
// each call site. Sister incident: same evening as parent_ico.
func TestScan_RegressionShape_UpdatedAtIncident(t *testing.T) {
	root := t.TempDir()
	migrationsDir := filepath.Join(root, "migrations")
	_ = os.Mkdir(migrationsDir, 0o755)
	writeFile(t, migrationsDir, "001.sql",
		`CREATE TABLE campaign_contacts (id INT, status TEXT);`)

	jsDir := filepath.Join(root, "js")
	writeFile(t, jsDir, "send-batch.js",
		"export async function f(pool) {\n"+
			"  await pool.query(`UPDATE campaign_contacts SET status='queued', updated_at=NOW() WHERE id=$1`);\n"+
			"  await pool.query(`UPDATE campaign_contacts SET status='pending', updated_at=NOW() WHERE id=$2`);\n"+
			"  await pool.query(`UPDATE campaign_contacts SET status='in_sequence', current_step=0, next_send_at=NOW(), updated_at=NOW() WHERE id=$3`);\n"+
			"}\n")

	got, err := Scan(ScanConfig{
		MigrationsDir: migrationsDir,
		JSRoots:       []string{jsDir},
	})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	// Three updated_at violations (one per UPDATE) + violations for
	// current_step and next_send_at (also missing). updated_at is the
	// load-bearing one.
	updatedAtCount := 0
	for _, v := range got {
		if v.Table == "campaign_contacts" && v.Column == "updated_at" {
			updatedAtCount++
		}
	}
	if updatedAtCount != 3 {
		t.Errorf("expected 3 updated_at violations (one per UPDATE), got %d: %+v",
			updatedAtCount, got)
	}
}
