//go:build integration

package mailbox

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"
)

// ─── Schema invariants: outreach_mailboxes (migration 035) ───────────────────

func TestSchema_OutreachMailboxes_Columns(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	wantCols := map[string]string{
		"id":                   "bigint",
		"from_address":         "text",
		"display_name":         "text",
		"persona_slug":         "text",
		"smtp_host":            "text",
		"smtp_port":            "integer",
		"smtp_username":        "text",
		"imap_host":            "text",
		"imap_port":            "integer",
		"imap_username":        "text",
		"daily_cap_override":   "integer",
		"tz":                   "text",
		"locale":               "text",
		"status":               "text",
		"status_reason":        "text",
		"last_send_at":         "timestamp with time zone",
		"consecutive_bounces":  "integer",
		"total_sent":           "bigint",
		"total_bounced":        "bigint",
		"created_at":           "timestamp with time zone",
		"updated_at":           "timestamp with time zone",
		"canary_remaining":     "integer",
		"released_at":          "timestamp with time zone",
		"retired_candidate":    "boolean",
		"last_canary_send":     "timestamp with time zone",
		"circuit_opened_at":    "timestamp with time zone",
		"circuit_trip_count":   "integer",
		"environment":          "text", // migration 055 (J3/H6.3)
		"preferred_country":    "text", // migration 065
	}

	got, err := describeColumns(db, "outreach_mailboxes")
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	for col, want := range wantCols {
		t.Run(col, func(t *testing.T) {
			have, ok := got[col]
			if !ok {
				t.Fatalf("column %q missing from outreach_mailboxes", col)
			}
			if have != want {
				t.Errorf("column %q type = %q, want %q", col, have, want)
			}
		})
	}
}

func TestSchema_OutreachMailboxes_NotNullColumns(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	notNull := []string{
		"id", "from_address", "display_name",
		"smtp_host", "smtp_port",
		"tz", "locale",
		"status",
		"consecutive_bounces", "total_sent", "total_bounced",
		"created_at", "updated_at",
		"canary_remaining", "retired_candidate",
		"circuit_trip_count",
	}
	for _, col := range notNull {
		t.Run(col, func(t *testing.T) {
			if !columnIsNotNull(t, db, "outreach_mailboxes", col) {
				t.Errorf("column %q must be NOT NULL", col)
			}
		})
	}
}

func TestSchema_OutreachMailboxes_Defaults(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	cases := map[string]string{
		"smtp_port":           "587",
		"imap_port":           "993",
		"tz":                  "'Europe/Prague'",
		"locale":              "'cs-CZ'",
		"status":              "'active'",
		"consecutive_bounces": "0",
		"total_sent":          "0",
		"total_bounced":       "0",
		"canary_remaining":    "0",
		"retired_candidate":   "false",
		"circuit_trip_count":  "0",
	}
	for col, want := range cases {
		t.Run(col, func(t *testing.T) {
			got := columnDefault(t, db, "outreach_mailboxes", col)
			if !strings.Contains(got, strings.Trim(want, "'")) {
				t.Errorf("column %q default = %q, want contains %q", col, got, want)
			}
		})
	}
}

// ─── Status CHECK constraint ─────────────────────────────────────────────────

func TestCheckConstraint_Status_AcceptsValid(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	valid := []string{"active", "paused", "bounce_hold", "retired"}
	for _, s := range valid {
		t.Run(s, func(t *testing.T) {
			withTxRollback(t, db, func(tx *sql.Tx) {
				_, err := tx.ExecContext(context.Background(), `
					INSERT INTO outreach_mailboxes
					    (from_address, display_name, smtp_host, status)
					VALUES ($1, $2, 'smtp.example.com', $3)
				`, fmt.Sprintf("status-%s@test.local", s), "T", s)
				if err != nil {
					t.Fatalf("valid status %q rejected: %v", s, err)
				}
			})
		})
	}
}

func TestCheckConstraint_Status_RejectsInvalid(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	invalid := []string{"", "unknown", "ACTIVE", "Paused", "closed", "deleted", "banned", "hold"}
	for _, s := range invalid {
		t.Run(fmt.Sprintf("status=%q", s), func(t *testing.T) {
			withTxRollback(t, db, func(tx *sql.Tx) {
				_, err := tx.ExecContext(context.Background(), `
					INSERT INTO outreach_mailboxes
					    (from_address, display_name, smtp_host, status)
					VALUES ('rej-status@test.local', 'T', 'smtp.example.com', $1)
				`, s)
				if err == nil {
					t.Fatalf("invalid status %q should be rejected by CHECK", s)
				}
			})
		})
	}
}

// ─── daily_cap_override CHECK ────────────────────────────────────────────────

func TestCheckConstraint_DailyCap_AllowsNull(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	withTxRollback(t, db, func(tx *sql.Tx) {
		_, err := tx.ExecContext(context.Background(), `
			INSERT INTO outreach_mailboxes
			    (from_address, display_name, smtp_host, daily_cap_override)
			VALUES ('cap-null@test.local', 'T', 'smtp.example.com', NULL)
		`)
		if err != nil {
			t.Fatalf("NULL daily_cap_override must be allowed: %v", err)
		}
	})
}

func TestCheckConstraint_DailyCap_AllowsNonNeg(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	for _, cap := range []int{0, 1, 5, 50, 500, 10000} {
		t.Run(fmt.Sprint(cap), func(t *testing.T) {
			withTxRollback(t, db, func(tx *sql.Tx) {
				_, err := tx.ExecContext(context.Background(), `
					INSERT INTO outreach_mailboxes
					    (from_address, display_name, smtp_host, daily_cap_override)
					VALUES ($1, 'T', 'smtp.example.com', $2)
				`, fmt.Sprintf("cap-%d@test.local", cap), cap)
				if err != nil {
					t.Fatalf("daily_cap=%d rejected: %v", cap, err)
				}
			})
		})
	}
}

func TestCheckConstraint_DailyCap_RejectsNegative(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	for _, cap := range []int{-1, -5, -100, -2147483647} {
		t.Run(fmt.Sprint(cap), func(t *testing.T) {
			withTxRollback(t, db, func(tx *sql.Tx) {
				_, err := tx.ExecContext(context.Background(), `
					INSERT INTO outreach_mailboxes
					    (from_address, display_name, smtp_host, daily_cap_override)
					VALUES ($1, 'T', 'smtp.example.com', $2)
				`, fmt.Sprintf("capneg-%d@test.local", cap), cap)
				if err == nil {
					t.Fatalf("negative daily_cap=%d should be rejected", cap)
				}
			})
		})
	}
}

// ─── ports_sane CHECK ────────────────────────────────────────────────────────

func TestCheckConstraint_Ports_AllowsInRange(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	cases := []struct {
		smtp, imap int
	}{
		{25, 143},
		{465, 993},
		{587, 993},
		{2525, 143},
		{1, 1},
		{65535, 65535},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("smtp=%d_imap=%d", c.smtp, c.imap), func(t *testing.T) {
			withTxRollback(t, db, func(tx *sql.Tx) {
				_, err := tx.ExecContext(context.Background(), `
					INSERT INTO outreach_mailboxes
					    (from_address, display_name, smtp_host, smtp_port, imap_host, imap_port)
					VALUES ($1, 'T', 'smtp.example.com', $2, 'imap.example.com', $3)
				`, fmt.Sprintf("ports-%d-%d@test.local", c.smtp, c.imap), c.smtp, c.imap)
				if err != nil {
					t.Fatalf("valid ports (%d,%d) rejected: %v", c.smtp, c.imap, err)
				}
			})
		})
	}
}

func TestCheckConstraint_Ports_RejectsOutOfRange(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	cases := []struct {
		smtp, imap int
	}{
		{0, 993},
		{-1, 993},
		{65536, 993},
		{70000, 993},
		{587, 0},
		{587, -5},
		{587, 65536},
		{587, 99999},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("smtp=%d_imap=%d", c.smtp, c.imap), func(t *testing.T) {
			withTxRollback(t, db, func(tx *sql.Tx) {
				_, err := tx.ExecContext(context.Background(), `
					INSERT INTO outreach_mailboxes
					    (from_address, display_name, smtp_host, smtp_port, imap_host, imap_port)
					VALUES ($1, 'T', 'smtp.example.com', $2, 'imap.example.com', $3)
				`, fmt.Sprintf("badports@test.local"), c.smtp, c.imap)
				if err == nil {
					t.Fatalf("out-of-range ports (%d,%d) must be rejected", c.smtp, c.imap)
				}
			})
		})
	}
}

// ─── UNIQUE (from_address) ───────────────────────────────────────────────────

func TestUniqueConstraint_FromAddress(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	withTxRollback(t, db, func(tx *sql.Tx) {
		_, err := tx.ExecContext(context.Background(), `
			INSERT INTO outreach_mailboxes (from_address, display_name, smtp_host)
			VALUES ('dup@test.local', 'T1', 'smtp.example.com')
		`)
		if err != nil {
			t.Fatalf("first insert failed: %v", err)
		}
		_, err = tx.ExecContext(context.Background(), `
			INSERT INTO outreach_mailboxes (from_address, display_name, smtp_host)
			VALUES ('dup@test.local', 'T2', 'smtp.other.com')
		`)
		if err == nil {
			t.Fatal("second insert with duplicate from_address should fail")
		}
	})
}

// ─── updated_at trigger ──────────────────────────────────────────────────────

func TestTrigger_UpdatedAt_AdvancesOnUpdate(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	withTxRollback(t, db, func(tx *sql.Tx) {
		var id int64
		if err := tx.QueryRowContext(context.Background(), `
			INSERT INTO outreach_mailboxes (from_address, display_name, smtp_host)
			VALUES ('trig@test.local', 'T', 'smtp.example.com')
			RETURNING id
		`).Scan(&id); err != nil {
			t.Fatalf("insert: %v", err)
		}
		var before time.Time
		if err := tx.QueryRowContext(context.Background(),
			`SELECT updated_at FROM outreach_mailboxes WHERE id=$1`, id,
		).Scan(&before); err != nil {
			t.Fatalf("scan before: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
		if _, err := tx.ExecContext(context.Background(),
			`UPDATE outreach_mailboxes SET display_name='T2' WHERE id=$1`, id,
		); err != nil {
			t.Fatalf("update: %v", err)
		}
		var after time.Time
		if err := tx.QueryRowContext(context.Background(),
			`SELECT updated_at FROM outreach_mailboxes WHERE id=$1`, id,
		).Scan(&after); err != nil {
			t.Fatalf("scan after: %v", err)
		}
		if !after.After(before) {
			t.Errorf("updated_at must advance on UPDATE: before=%v after=%v", before, after)
		}
	})
}

// ─── Status transitions ──────────────────────────────────────────────────────

func TestStatusTransitions_AllPairs(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	states := []string{"active", "paused", "bounce_hold", "retired"}
	for _, from := range states {
		for _, to := range states {
			t.Run(fmt.Sprintf("%s→%s", from, to), func(t *testing.T) {
				withTxRollback(t, db, func(tx *sql.Tx) {
					var id int64
					if err := tx.QueryRowContext(context.Background(), `
						INSERT INTO outreach_mailboxes (from_address, display_name, smtp_host, status)
						VALUES ($1, 'T', 'smtp.example.com', $2)
						RETURNING id
					`, fmt.Sprintf("trans-%s-%s@test.local", from, to), from).Scan(&id); err != nil {
						t.Fatalf("insert: %v", err)
					}
					if _, err := tx.ExecContext(context.Background(),
						`UPDATE outreach_mailboxes SET status=$2 WHERE id=$1`, id, to,
					); err != nil {
						t.Fatalf("transition %s→%s rejected: %v", from, to, err)
					}
				})
			})
		}
	}
}

// ─── Indexes ────────────────────────────────────────────────────────────────

func TestIndexes_OutreachMailboxesPresent(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	want := []string{
		"outreach_mailboxes_pkey",
		"outreach_mailboxes_from_address_unique",
		"idx_outreach_mailboxes_active_rotation",
		"idx_outreach_mailboxes_status",
		"idx_outreach_mailboxes_circuit_open",
	}
	got := indexesForTable(t, db, "outreach_mailboxes")
	for _, name := range want {
		t.Run(name, func(t *testing.T) {
			if !contains(got, name) {
				t.Errorf("expected index %q on outreach_mailboxes (have %v)", name, got)
			}
		})
	}
}

func TestIndexes_MailboxWarmupPresent(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	got := indexesForTable(t, db, "mailbox_warmup")
	want := []string{
		"mailbox_warmup_pkey",
		"idx_mailbox_warmup_not_paused",
	}
	for _, name := range want {
		t.Run(name, func(t *testing.T) {
			if !contains(got, name) {
				t.Errorf("expected index %q on mailbox_warmup (have %v)", name, got)
			}
		})
	}
}

func TestIndexes_WatchdogPresent(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	got := indexesForTable(t, db, "mailbox_auth_fails")
	if !contains(got, "idx_mailbox_auth_fails_recent") {
		t.Errorf("expected idx_mailbox_auth_fails_recent (have %v)", got)
	}
	got = indexesForTable(t, db, "watchdog_events")
	for _, n := range []string{"idx_watchdog_events_mailbox", "idx_watchdog_events_global"} {
		if !contains(got, n) {
			t.Errorf("expected %q on watchdog_events (have %v)", n, got)
		}
	}
}

func TestIndexes_CooldownLogPresent(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	got := indexesForTable(t, db, "mailbox_cooldown_log")
	for _, n := range []string{"idx_mailbox_cooldown_log_mailbox", "idx_mailbox_cooldown_log_open"} {
		if !contains(got, n) {
			t.Errorf("expected %q on mailbox_cooldown_log (have %v)", n, got)
		}
	}
}

// ─── mailbox_warmup ───────────────────────────────────────────────────────────

func TestMailboxWarmup_PrimaryKeyIsAddress(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	got := primaryKeyColumn(t, db, "mailbox_warmup")
	if got != "mailbox_address" {
		t.Errorf("PK = %q, want mailbox_address", got)
	}
}

func TestMailboxWarmup_DayCheckRejectsZeroAndNeg(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	for _, day := range []int{0, -1, -5, -100} {
		t.Run(fmt.Sprint(day), func(t *testing.T) {
			withTxRollback(t, db, func(tx *sql.Tx) {
				_, err := tx.ExecContext(context.Background(), `
					INSERT INTO mailbox_warmup (mailbox_address, warmup_day)
					VALUES ($1, $2)
				`, fmt.Sprintf("warmup-neg-%d@test.local", day), day)
				if err == nil {
					t.Fatalf("warmup_day=%d must be rejected (CHECK >=1)", day)
				}
			})
		})
	}
}

func TestMailboxWarmup_DayCheckAcceptsValid(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	for _, day := range []int{1, 2, 5, 14, 30, 60, 90, 365} {
		t.Run(fmt.Sprint(day), func(t *testing.T) {
			withTxRollback(t, db, func(tx *sql.Tx) {
				_, err := tx.ExecContext(context.Background(), `
					INSERT INTO mailbox_warmup (mailbox_address, warmup_day)
					VALUES ($1, $2)
				`, fmt.Sprintf("warmup-ok-%d@test.local", day), day)
				if err != nil {
					t.Fatalf("warmup_day=%d rejected: %v", day, err)
				}
			})
		})
	}
}

// ─── watchdog_events CHECK ────────────────────────────────────────────────────

func TestWatchdogEvents_TypeCheck_AcceptsValid(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	valid := []string{
		"proxy_swap", "bounce_decay", "auto_release",
		"auth_fail_spike", "circuit_breaker", "manual_trigger", "heartbeat",
	}
	for _, ev := range valid {
		t.Run(ev, func(t *testing.T) {
			withTxRollback(t, db, func(tx *sql.Tx) {
				_, err := tx.ExecContext(context.Background(), `
					INSERT INTO watchdog_events (event_type) VALUES ($1)
				`, ev)
				if err != nil {
					t.Fatalf("valid event %q rejected: %v", ev, err)
				}
			})
		})
	}
}

func TestWatchdogEvents_TypeCheck_RejectsInvalid(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	invalid := []string{
		"", "custom", "PROXY_SWAP", "bounce", "ratelimit",
		"breaker", "release", "health", "start",
	}
	for _, ev := range invalid {
		t.Run(fmt.Sprintf("ev=%q", ev), func(t *testing.T) {
			withTxRollback(t, db, func(tx *sql.Tx) {
				_, err := tx.ExecContext(context.Background(), `
					INSERT INTO watchdog_events (event_type) VALUES ($1)
				`, ev)
				if err == nil {
					t.Fatalf("invalid event_type %q must be rejected", ev)
				}
			})
		})
	}
}

func TestWatchdogEvents_MetadataJSONB(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	payloads := []string{
		`{}`,
		`{"old_proxy":"1.2.3.4:1080","new_proxy":"5.6.7.8:1080"}`,
		`{"nested":{"a":1,"b":[1,2,3]}}`,
		`{"unicode":"Příliš žluťoučký kůň"}`,
	}
	for i, p := range payloads {
		t.Run(fmt.Sprintf("payload-%d", i), func(t *testing.T) {
			withTxRollback(t, db, func(tx *sql.Tx) {
				_, err := tx.ExecContext(context.Background(), `
					INSERT INTO watchdog_events (event_type, metadata)
					VALUES ('heartbeat', $1::jsonb)
				`, p)
				if err != nil {
					t.Fatalf("jsonb %q rejected: %v", p, err)
				}
			})
		})
	}
}

// ─── Cascading FK: delete mailbox → auth_fails / watchdog / cooldown_log removed

func TestCascadingFK_DeletingMailbox(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	withTxRollback(t, db, func(tx *sql.Tx) {
		var mbID int64
		if err := tx.QueryRowContext(context.Background(), `
			INSERT INTO outreach_mailboxes (from_address, display_name, smtp_host)
			VALUES ('cascade@test.local', 'T', 'smtp.example.com')
			RETURNING id
		`).Scan(&mbID); err != nil {
			t.Fatalf("insert mailbox: %v", err)
		}
		mustExec(t, tx,
			`INSERT INTO mailbox_auth_fails (mailbox_id, smtp_response) VALUES ($1, 'test')`, mbID)
		mustExec(t, tx,
			`INSERT INTO watchdog_events (mailbox_id, event_type) VALUES ($1, 'heartbeat')`, mbID)
		mustExec(t, tx,
			`INSERT INTO mailbox_cooldown_log (mailbox_id) VALUES ($1)`, mbID)

		mustExec(t, tx, `DELETE FROM outreach_mailboxes WHERE id=$1`, mbID)

		for _, tbl := range []string{"mailbox_auth_fails", "watchdog_events", "mailbox_cooldown_log"} {
			n := queryInt(t, tx, fmt.Sprintf("SELECT COUNT(*) FROM %s WHERE mailbox_id=$1", tbl), mbID)
			if n != 0 {
				t.Errorf("%s: expected cascade delete, have %d rows", tbl, n)
			}
		}
	})
}

// ─── Idempotence: re-running migration must not fail ─────────────────────────

func TestMigrationIdempotence_OutreachMailboxesRecreated(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	// Re-applying migrations is already idempotent by design (CREATE TABLE
	// IF NOT EXISTS + ADD COLUMN IF NOT EXISTS). We verify by re-running.
	if err := applyMigrations(db); err != nil {
		t.Fatalf("re-applying migrations must succeed: %v", err)
	}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

func describeColumns(db *sql.DB, table string) (map[string]string, error) {
	rows, err := db.Query(`
		SELECT column_name, data_type
		FROM information_schema.columns
		WHERE table_name = $1 AND table_schema = 'public'
	`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]string)
	for rows.Next() {
		var name, dt string
		if err := rows.Scan(&name, &dt); err != nil {
			return nil, err
		}
		out[name] = dt
	}
	return out, rows.Err()
}

func columnIsNotNull(t *testing.T, db *sql.DB, table, col string) bool {
	t.Helper()
	var isNullable string
	if err := db.QueryRow(`
		SELECT is_nullable FROM information_schema.columns
		WHERE table_name=$1 AND column_name=$2
	`, table, col).Scan(&isNullable); err != nil {
		t.Fatalf("describe nullable: %v", err)
	}
	return isNullable == "NO"
}

func columnDefault(t *testing.T, db *sql.DB, table, col string) string {
	t.Helper()
	var def sql.NullString
	if err := db.QueryRow(`
		SELECT column_default FROM information_schema.columns
		WHERE table_name=$1 AND column_name=$2
	`, table, col).Scan(&def); err != nil {
		t.Fatalf("describe default: %v", err)
	}
	return def.String
}

func indexesForTable(t *testing.T, db *sql.DB, table string) []string {
	t.Helper()
	rows, err := db.Query(`
		SELECT indexname FROM pg_indexes WHERE tablename=$1
	`, table)
	if err != nil {
		t.Fatalf("pg_indexes: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, n)
	}
	return out
}

func primaryKeyColumn(t *testing.T, db *sql.DB, table string) string {
	t.Helper()
	var col string
	if err := db.QueryRow(`
		SELECT kcu.column_name
		FROM information_schema.table_constraints tc
		JOIN information_schema.key_column_usage kcu
		  ON tc.constraint_name = kcu.constraint_name
		WHERE tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
		LIMIT 1
	`, table).Scan(&col); err != nil {
		t.Fatalf("pk lookup: %v", err)
	}
	return col
}

func contains(slice []string, s string) bool {
	for _, x := range slice {
		if x == s {
			return true
		}
	}
	return false
}

// ─── preferred_country column (migration 065) ────────────────────────────────

// TestSchema_PreferredCountry_ConstraintRejectsNonISO verifies the CHECK
// constraint rejects non-two-letter-uppercase values.
func TestSchema_PreferredCountry_ConstraintRejectsNonISO(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	cases := []struct {
		val  string
		want bool // true = should succeed
	}{
		{"SK", true},
		{"RO", true},
		{"DE", true},
		{"", true},      // NULL semantics: empty = no preference (COALESCE handles it)
		{"czech", false}, // too long
		{"sk", false},    // lowercase
		{"S", false},     // too short
		{"123", false},   // digits
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.val, func(t *testing.T) {
			withTxRollback(t, db, func(tx *sql.Tx) {
				var id int64
				if err := tx.QueryRowContext(context.Background(), `
					INSERT INTO outreach_mailboxes (from_address, display_name, smtp_host)
					VALUES ('pc_constraint_test@test.local', 'T', 'smtp.example.com')
					RETURNING id
				`).Scan(&id); err != nil {
					t.Fatalf("insert base row: %v", err)
				}

				var setVal interface{}
				if tc.val != "" {
					setVal = tc.val
				} // nil = NULL

				_, err := tx.ExecContext(context.Background(),
					`UPDATE outreach_mailboxes SET preferred_country = $1 WHERE id = $2`,
					setVal, id,
				)
				if tc.want && err != nil {
					t.Errorf("expected success for %q, got error: %v", tc.val, err)
				}
				if !tc.want && err == nil {
					t.Errorf("expected constraint violation for %q, but UPDATE succeeded", tc.val)
				}
			})
		})
	}
}

// TestSchema_PreferredCountry_NullAllowed verifies the column allows NULL
// (no pin = use full pool rotation).
func TestSchema_PreferredCountry_NullAllowed(t *testing.T) {
	db := openTestDB(t)
	ensureMigrationsApplied(t, db)

	withTxRollback(t, db, func(tx *sql.Tx) {
		var id int64
		if err := tx.QueryRowContext(context.Background(), `
			INSERT INTO outreach_mailboxes (from_address, display_name, smtp_host)
			VALUES ('pc_null_test@test.local', 'T', 'smtp.example.com')
			RETURNING id
		`).Scan(&id); err != nil {
			t.Fatalf("insert: %v", err)
		}

		var got *string
		if err := tx.QueryRowContext(context.Background(),
			`SELECT preferred_country FROM outreach_mailboxes WHERE id = $1`, id,
		).Scan(&got); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if got != nil {
			t.Errorf("expected NULL preferred_country on fresh row, got %q", *got)
		}
	})
}
