//go:build integration

package watchdog

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"mailboxes/mailbox"

	_ "github.com/lib/pq"
)

// TestWatchdogAuthFailAlert_Integration seeds 3 auth_fail rows for a test
// mailbox, runs one daemon Tick, then asserts a watchdog_events row was
// inserted with event_type='auth_fail_alert'. Cleans up its own rows.
//
// Skipped unless TEST_DATABASE_URL (or DB_HOST + friends) is exported and
// the DB is reachable. Follows the same convention as internal/mailbox
// integration tests.
func TestWatchdogAuthFailAlert_Integration(t *testing.T) {
	dsn := resolveIntegrationDSN()
	if dsn == "" {
		t.Skip("no TEST_DATABASE_URL / DB_HOST env — skipping")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		t.Skipf("postgres unreachable (%v) — skipping", err)
	}
	ctx := context.Background()

	// Arrange: unique mailbox + 3 unresolved auth fails inside the 15min window.
	suffix := time.Now().UnixNano()
	addr := fmt.Sprintf("alerttest-%d@sender.test", suffix)
	var mailboxID int64
	err = db.QueryRowContext(ctx, `
		INSERT INTO outreach_mailboxes (from_address, display_name, smtp_host, smtp_port, imap_host, imap_port, status, password)
		VALUES ($1, 'Alert Test', 'smtp.example.com', 465, 'imap.example.com', 993, 'active', 'xxxxxxxxxx')
		RETURNING id
	`, addr).Scan(&mailboxID)
	if err != nil {
		t.Fatalf("insert mailbox: %v", err)
	}
	t.Cleanup(func() {
		// Clean up in reverse dependency order. watchdog_events + auth_fails
		// first, then the mailbox. Errors are logged, not fatal, so one
		// failure doesn't hide others.
		if _, err := db.ExecContext(ctx, `DELETE FROM watchdog_events WHERE mailbox_id = $1`, mailboxID); err != nil {
			t.Logf("cleanup watchdog_events: %v", err)
		}
		if _, err := db.ExecContext(ctx, `DELETE FROM mailbox_auth_fails WHERE mailbox_id = $1`, mailboxID); err != nil {
			t.Logf("cleanup mailbox_auth_fails: %v", err)
		}
		if _, err := db.ExecContext(ctx, `DELETE FROM outreach_mailboxes WHERE id = $1`, mailboxID); err != nil {
			t.Logf("cleanup outreach_mailboxes: %v", err)
		}
	})

	// Seed 3 auth fails spanning the last 10 minutes.
	for i := 0; i < 3; i++ {
		_, err := db.ExecContext(ctx, `
			INSERT INTO mailbox_auth_fails (mailbox_id, smtp_response, failed_at)
			VALUES ($1, $2, now() - ($3 || ' seconds')::interval)
		`, mailboxID, fmt.Sprintf("535 5.7.8 auth failed #%d", i), (3-i)*120)
		if err != nil {
			t.Fatalf("seed auth fail %d: %v", i, err)
		}
	}

	// Act: run one tick with real stores.
	store := mailbox.NewPGStore(db)
	d := NewDaemon(DaemonConfig{
		Store:     store,
		Events:    NewEventRecorder(db),
		AuthFails: NewAuthFailStore(db),
		// Circuit is nil → trip path disabled so the alert has a clean
		// slate. Proxy pool nil → no swaps.
		AuthThresh: 3,
		AuthWindow: time.Hour,
	})
	if err := d.Tick(ctx); err != nil {
		t.Fatalf("Tick: %v", err)
	}

	// Assert: exactly one auth_fail_alert row was inserted for this mailbox.
	var count int
	if err := db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM watchdog_events
		WHERE mailbox_id = $1 AND event_type = 'auth_fail_alert'
	`, mailboxID).Scan(&count); err != nil {
		t.Fatalf("count alert events: %v", err)
	}
	if count != 1 {
		t.Fatalf("watchdog_events auth_fail_alert count = %d, want 1", count)
	}

	// Assert: metadata carries fail_count and window_min for operators.
	var metaRaw []byte
	if err := db.QueryRowContext(ctx, `
		SELECT metadata FROM watchdog_events
		WHERE mailbox_id = $1 AND event_type = 'auth_fail_alert'
		LIMIT 1
	`, mailboxID).Scan(&metaRaw); err != nil {
		t.Fatalf("fetch metadata: %v", err)
	}
	var meta map[string]any
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		t.Fatalf("unmarshal metadata: %v (raw=%s)", err, string(metaRaw))
	}
	if fc, ok := meta["fail_count"].(float64); !ok || int(fc) != 3 {
		t.Errorf("metadata fail_count = %v, want 3", meta["fail_count"])
	}
	if wm, ok := meta["window_min"].(float64); !ok || int(wm) != 15 {
		t.Errorf("metadata window_min = %v, want 15", meta["window_min"])
	}
}

func resolveIntegrationDSN() string {
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
	port := envOrDefault("DB_PORT", "5432")
	name := envOrDefault("DB_NAME", "outreach")
	user := envOrDefault("DB_USER", "outreach")
	pass := envOrDefault("DB_PASSWORD", "outreach")
	ssl := envOrDefault("DB_SSL_MODE", "disable")
	return fmt.Sprintf("host=%s port=%s dbname=%s user=%s password=%s sslmode=%s",
		host, port, name, user, pass, ssl)
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
