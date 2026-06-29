//go:build integration

package mailbox

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	_ "github.com/lib/pq"
)

// openTestDB returns a *sql.DB pointing at the integration postgres instance.
// Skips the test if no TEST_DATABASE_URL / DB_HOST is present. Each caller
// should wrap its work in a transaction and rollback — the helper returns a
// shared connection, not an isolated database.
func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := resolveTestDSN()
	if dsn == "" {
		t.Skip("no TEST_DATABASE_URL / DB_HOST env — skipping integration test")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	if err := db.Ping(); err != nil {
		t.Skipf("postgres unreachable (%v) — skipping integration test", err)
	}
	return db
}

func resolveTestDSN() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	if v := os.Getenv("DATABASE_URL_TEST"); v != "" {
		return v
	}
	host := os.Getenv("DB_HOST")
	if host == "" {
		return ""
	}
	port := envOr("DB_PORT", "5432")
	name := envOr("DB_NAME", "outreach")
	user := envOr("DB_USER", "outreach")
	pass := envOr("DB_PASSWORD", "outreach")
	ssl := envOr("DB_SSL_MODE", "disable")
	return fmt.Sprintf("host=%s port=%s dbname=%s user=%s password=%s sslmode=%s",
		host, port, name, user, pass, ssl)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// migrationsOnce ensures the full migration chain has been applied exactly
// once per test binary. Parallel tests share the same schema.
var migrationsOnce sync.Once
var migrationsErr error

// ensureMigrationsApplied walks modules/outreach/db/migrations/*.sql in
// lexical order and executes each file. Idempotent statements in the
// migrations themselves guard against redundant runs.
func ensureMigrationsApplied(t *testing.T, db *sql.DB) {
	t.Helper()
	migrationsOnce.Do(func() {
		migrationsErr = applyMigrations(db)
	})
	if migrationsErr != nil {
		t.Fatalf("migrations: %v", migrationsErr)
	}
}

func applyMigrations(db *sql.DB) error {
	dir := migrationsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read migrations dir %s: %w", dir, err)
	}
	var files []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)
	for _, name := range files {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}
		if _, err := db.Exec(string(raw)); err != nil {
			return fmt.Errorf("apply %s: %w", name, err)
		}
	}
	return nil
}

// migrationsDir resolves to the outreach migrations directory relative to the
// current test's working dir (internal/mailbox or internal/sender).
func migrationsDir() string {
	candidates := []string{
		"../db/migrations",
		"../../internal/db/migrations",
		"./internal/db/migrations",
	}
	for _, c := range candidates {
		abs, err := filepath.Abs(c)
		if err != nil {
			continue
		}
		if info, err := os.Stat(abs); err == nil && info.IsDir() {
			return abs
		}
	}
	return "../db/migrations"
}

// withTxRollback runs fn inside a transaction that is always rolled back.
// This is how every integration test isolates its writes without
// coordination. Panic-safe via deferred rollback.
func withTxRollback(t *testing.T, db *sql.DB, fn func(*sql.Tx)) {
	t.Helper()
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer func() {
		if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
			t.Logf("rollback: %v", err)
		}
	}()
	fn(tx)
}

// mustExec fails the test on error — use for arrange-phase SQL.
func mustExec(t *testing.T, tx *sql.Tx, query string, args ...any) {
	t.Helper()
	if _, err := tx.ExecContext(context.Background(), query, args...); err != nil {
		t.Fatalf("exec failed: %v\nSQL: %s\nargs: %v", err, query, args)
	}
}

// queryInt runs a COUNT/single-int query and returns the result.
func queryInt(t *testing.T, tx *sql.Tx, query string, args ...any) int {
	t.Helper()
	var n int
	if err := tx.QueryRowContext(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("scan int: %v\nSQL: %s", err, query)
	}
	return n
}

// queryString runs a single-string query and returns the result.
func queryString(t *testing.T, tx *sql.Tx, query string, args ...any) string {
	t.Helper()
	var s string
	if err := tx.QueryRowContext(context.Background(), query, args...).Scan(&s); err != nil {
		t.Fatalf("scan string: %v\nSQL: %s", err, query)
	}
	return s
}
