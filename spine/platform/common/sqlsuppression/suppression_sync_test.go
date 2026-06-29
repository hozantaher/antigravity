package sqlsuppression

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Discipline tests for the migration files that mirror BOTH suppression
// tables into contacts.status:
//
//   - scripts/migrations/005_contacts_status_sync.sql
//     mirrors outreach_suppressions → contacts.status
//
//   - scripts/migrations/048_suppression_list_status_sync.sql
//     mirrors suppression_list      → contacts.status (S1.1)
//
// The system has two suppression tables (memory:
// project_two_suppression_tables). UI writes go to suppression_list, Go
// writes go to outreach_suppressions. Both must mirror to contacts.status,
// otherwise an enrollment path that filters only on contacts.status
// silently re-sends to a freshly-suppressed address.
//
// These tests are file-content checks (not sqlmock against a live DB).
// They guard against accidental refactor that would silently drop the
// trigger, the backfill, or one of the table references. Live behavior
// is verified by manual operator run on staging before applying to prod.

const (
	migration005Path = "../../../../scripts/migrations/005_contacts_status_sync.sql"
	migration048Path = "../../../../scripts/migrations/048_suppression_list_status_sync.sql"
)

// ── Migration 048 (S1.1) ────────────────────────────────────────────────

// TestMigration048_FilePresent confirms the new migration exists at the
// expected path. If this test fails, the migration was renamed / moved /
// deleted and the discipline trail is broken.
func TestMigration048_FilePresent(t *testing.T) {
	if _, err := os.ReadFile(migration048Path); err != nil {
		t.Fatalf("expected migration file at %s: %v", migration048Path, err)
	}
}

// TestMigration048_TargetsSuppressionList asserts the trigger fires on
// the suppression_list table (the JS/UI write surface). Migration 005
// already covers outreach_suppressions; this migration's reason for
// existence is the OTHER table.
func TestMigration048_TargetsSuppressionList(t *testing.T) {
	body := readMigration(t, migration048Path)
	// The CREATE TRIGGER ... AFTER INSERT ON suppression_list line is
	// load-bearing. Must exist or the trigger doesn't fire.
	if !regexp.MustCompile(`(?is)CREATE\s+TRIGGER[\s\S]*?ON\s+suppression_list`).Match(body) {
		t.Errorf("migration 048 missing CREATE TRIGGER ... ON suppression_list — trigger won't fire on UI writes")
	}
	if !regexp.MustCompile(`AFTER\s+INSERT`).Match(body) {
		t.Errorf("migration 048 missing AFTER INSERT — trigger must run after row commits, not BEFORE")
	}
}

// TestMigration048_HasTargetMarker enforces the "-- target: outreach-db
// only" header per memory project_railway_db_scope (T0 HARD RULE). The
// Railway workspace contains DBs from other projects; SQL must declare
// its target so an operator running it against the wrong DSN is
// immediately suspicious.
func TestMigration048_HasTargetMarker(t *testing.T) {
	body := readMigration(t, migration048Path)
	if !strings.Contains(string(body), "target: outreach-db") {
		t.Errorf("migration 048 missing '-- target: outreach-db only' header (T0 HARD RULE: project_railway_db_scope)")
	}
}

// TestMigration048_HasBackfill asserts the DO $sweep$ block exists. The
// trigger only handles future inserts; existing rows in suppression_list
// (added before this migration) need a one-time backfill or contacts.status
// stays out of sync.
func TestMigration048_HasBackfill(t *testing.T) {
	body := readMigration(t, migration048Path)
	// Must reference suppression_list inside a DO/PL-pgSQL block AND must
	// update contacts.status='suppressed'.
	hasDoBlock := regexp.MustCompile(`DO\s+\$sweep\$`).Match(body)
	hasUpdate := regexp.MustCompile(`(?is)UPDATE\s+contacts[\s\S]*?status\s*=\s*'suppressed'`).Match(body)
	hasJoin := regexp.MustCompile(`(?is)JOIN\s+suppression_list`).Match(body)
	if !hasDoBlock || !hasUpdate || !hasJoin {
		t.Errorf("migration 048 missing complete backfill (DO block: %v, contacts UPDATE: %v, JOIN suppression_list: %v) — existing rows won't sync",
			hasDoBlock, hasUpdate, hasJoin)
	}
}

// TestMigration048_NormalizesEmails confirms the trigger and backfill
// both use lower(trim(email)) — case/whitespace drift between tables
// would otherwise leak unsync'd rows. The whole sqlsuppression package's
// reason to exist is that case-sensitive comparisons silently miss
// suppressed emails.
func TestMigration048_NormalizesEmails(t *testing.T) {
	body := readMigration(t, migration048Path)
	// Should appear at least 4 times: 2 in backfill (LHS + RHS of JOIN ON),
	// 2 in trigger function (LHS + RHS of WHERE).
	count := strings.Count(string(body), "lower(trim(")
	if count < 4 {
		t.Errorf("migration 048 has only %d lower(trim(...)) occurrences — expect ≥4 (backfill JOIN + trigger WHERE). Case drift leak risk.", count)
	}
}

// TestMigration048_DoesNotDowngradeStatus asserts the WHERE clause skips
// rows already in 'replied' or 'blacklisted'. A reply or blacklist is a
// stronger signal than 'suppressed' and overwriting them would lose
// information.
func TestMigration048_DoesNotDowngradeStatus(t *testing.T) {
	body := readMigration(t, migration048Path)
	// Both the backfill and trigger should guard against downgrade.
	guard := regexp.MustCompile(`status\s+NOT\s+IN\s*\(\s*'suppressed'\s*,\s*'replied'\s*,\s*'blacklisted'\s*\)`)
	matches := guard.FindAllIndex(body, -1)
	if len(matches) < 2 {
		t.Errorf("migration 048 has only %d status NOT IN guard(s) — expect ≥2 (backfill + trigger). Downgrade risk.",
			len(matches))
	}
}

// TestMigration048_IsIdempotent enforces the DROP TRIGGER IF EXISTS
// pattern — some Postgres versions don't support CREATE TRIGGER IF NOT
// EXISTS, so DROP-then-CREATE is the portable idempotency mechanism.
// Re-running this migration must be safe.
func TestMigration048_IsIdempotent(t *testing.T) {
	body := readMigration(t, migration048Path)
	if !regexp.MustCompile(`DROP\s+TRIGGER\s+IF\s+EXISTS\s+s11_mirror_suppression_list`).Match(body) {
		t.Errorf("migration 048 missing DROP TRIGGER IF EXISTS — re-running would fail with 'trigger already exists'")
	}
	// CREATE OR REPLACE FUNCTION is the idempotent function form.
	if !regexp.MustCompile(`CREATE\s+OR\s+REPLACE\s+FUNCTION\s+s11_mirror_suppression_list_to_contacts`).Match(body) {
		t.Errorf("migration 048 missing CREATE OR REPLACE FUNCTION — re-running would fail with 'function already exists'")
	}
}

// TestMigration048_WrappedInTransaction confirms BEGIN/COMMIT bracketing
// — partial application of the trigger without backfill (or vice versa)
// would leave the system in a half-synced state.
func TestMigration048_WrappedInTransaction(t *testing.T) {
	body := strings.TrimSpace(string(readMigration(t, migration048Path)))
	// Strip trailing comments to find the real last statement.
	lines := strings.Split(body, "\n")
	hasBegin := false
	hasCommit := false
	for _, line := range lines {
		trim := strings.TrimSpace(line)
		if trim == "BEGIN;" {
			hasBegin = true
		}
		if trim == "COMMIT;" {
			hasCommit = true
		}
	}
	if !hasBegin || !hasCommit {
		t.Errorf("migration 048 not wrapped in BEGIN/COMMIT (begin: %v, commit: %v) — partial apply risk", hasBegin, hasCommit)
	}
}

// TestMigration048_AuditLogEntry confirms the migration writes a row to
// operator_audit_log so operators have a permanent record of when this
// trigger landed. Same convention as migration 005 / 007.
func TestMigration048_AuditLogEntry(t *testing.T) {
	body := readMigration(t, migration048Path)
	if !regexp.MustCompile(`(?is)INSERT\s+INTO\s+operator_audit_log[\s\S]*?'048_suppression_list_status_sync'`).Match(body) {
		t.Errorf("migration 048 missing operator_audit_log INSERT with own migration_id — observability gap")
	}
}

// ── Regression check: migration 005 still exists + still mirrors ────────

// TestMigration005_StillMirrorsOutreachSuppressions is a regression check.
// If a refactor accidentally deletes / renames migration 005, this catches
// it. The two migrations are companions — together they cover BOTH
// suppression-write surfaces.
func TestMigration005_StillMirrorsOutreachSuppressions(t *testing.T) {
	body := readMigration(t, migration005Path)
	hasTrigger := regexp.MustCompile(`(?is)CREATE\s+TRIGGER[\s\S]*?ON\s+outreach_suppressions`).Match(body)
	hasUpdate := regexp.MustCompile(`(?is)UPDATE\s+contacts[\s\S]*?status\s*=\s*'suppressed'`).Match(body)
	if !hasTrigger || !hasUpdate {
		t.Errorf("migration 005 regression: trigger=%v update=%v — outreach_suppressions sync would break", hasTrigger, hasUpdate)
	}
}

// TestMigrations_DistinctTriggerNames asserts the two migrations use
// distinct trigger names. If both used "mirror_suppression" the second
// would silently overwrite the first's trigger via DROP IF EXISTS, and
// outreach_suppressions stops mirroring. Trigger names live in the same
// namespace as their host table, so technically they could collide only
// across the same table, but the function names share the global schema
// namespace and MUST differ.
func TestMigrations_DistinctTriggerNames(t *testing.T) {
	body005 := string(readMigration(t, migration005Path))
	body048 := string(readMigration(t, migration048Path))

	// Function names are global. Each migration must define a distinct one.
	fn005 := "bf_e3_mirror_suppression_to_contacts"
	fn048 := "s11_mirror_suppression_list_to_contacts"
	if !strings.Contains(body005, fn005) {
		t.Errorf("migration 005 must define function %q", fn005)
	}
	if !strings.Contains(body048, fn048) {
		t.Errorf("migration 048 must define function %q", fn048)
	}
	if strings.Contains(body005, fn048) || strings.Contains(body048, fn005) {
		t.Errorf("migrations cross-reference each other's trigger function — namespace collision risk")
	}
}

// TestBothTablesCoveredByTriggers is the integrative discipline test.
// Concatenates both migration bodies and asserts that both suppression
// tables receive an AFTER INSERT trigger. If a future refactor deletes
// either migration, this test catches it.
func TestBothTablesCoveredByTriggers(t *testing.T) {
	body005 := string(readMigration(t, migration005Path))
	body048 := string(readMigration(t, migration048Path))
	combined := body005 + "\n" + body048

	tablesNeedingTriggers := []string{"outreach_suppressions", "suppression_list"}
	for _, table := range tablesNeedingTriggers {
		// Pattern: CREATE TRIGGER ... AFTER INSERT ON <table>
		pattern := regexp.MustCompile(`(?is)CREATE\s+TRIGGER[\s\S]{1,200}?AFTER\s+INSERT[\s\S]{1,50}?ON\s+` + table + `\b`)
		if !pattern.Match([]byte(combined)) {
			t.Errorf("no migration installs an AFTER INSERT trigger on %q — UI/Go writes to that table won't mirror to contacts.status", table)
		}
	}
}

// ── helper ──────────────────────────────────────────────────────────────

func readMigration(t *testing.T, path string) []byte {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if len(body) == 0 {
		t.Fatalf("migration %s is empty", path)
	}
	return body
}
