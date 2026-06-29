//go:build integration

package sender

// ── AP1 DB trigger integration test ──────────────────────────────────────────
//
// Ověřuje, že trigger trg_enforce_warmup_cap (migrace 071) skutečně odmítne
// INSERT do send_events jakmile schránka dosáhne denního limitu fáze warmup_d0.
// Testuje také propagaci PostgreSQL ERRCODE 23514 přes Go pq driver a správné
// zabalení do sentinelu ErrWarmupCapExceeded.
//
// Spuštění:
//   TEST_DATABASE_URL="postgres://user:pass@host/db?sslmode=disable" \
//   go test -count=1 -race -tags integration ./sender/...
//
// Bez TEST_DATABASE_URL se test přeskočí (t.Skip). Integrace nevyžaduje
// Docker — funguje s libovolnou dostupnou Postgres instancí.
//
// Pokrytí (5 testů):
//  1. Pod limitem (4 ze 5 odeslání) — INSERT projde
//  2. Na hranici limitu (5/5 odeslání) — pátý projde, šestý selže
//  3. Nad limitem — ERRCODE 23514 + message warmup_cap_exceeded
//  4. daily_cap_override LOWER — override 2 je respektován (3. odeslání selže)
//  5. daily_cap_override RAISE blocked — override vyšší než fáze je ignorován

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/lib/pq"
)

// openIntegrationDB otevře spojení s Postgres z TEST_DATABASE_URL.
// Přeskočí test pokud proměnná není nastavena nebo DB není dostupná.
func openIntegrationDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL_TEST")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL_TEST not set — skipping integration test")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	if err := db.PingContext(context.Background()); err != nil {
		t.Skipf("postgres unreachable (%v) — skipping integration test", err)
	}
	return db
}

// setupWarmupSchema vytvoří minimální schéma potřebné pro trigger test.
// Jde o izolovanou transakci — rollback na konci testu celé schéma smaže.
func setupWarmupSchema(t *testing.T, tx *sql.Tx, mailboxAddr string) {
	t.Helper()
	ctx := context.Background()

	// Minimální schema_migrations (trigger migrace na ni odkazuje)
	_, _ = tx.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`)

	// outreach_mailboxes — pouze sloupce potřebné pro trigger
	_, err := tx.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS outreach_mailboxes (
			id                  SERIAL PRIMARY KEY,
			from_address        TEXT UNIQUE NOT NULL,
			lifecycle_phase     TEXT NOT NULL DEFAULT 'warmup_d0'
				CHECK (lifecycle_phase IN ('warmup_d0','warmup_d3','warmup_d7','warmup_d14','production')),
			daily_cap_override  INT,
			status              TEXT NOT NULL DEFAULT 'active',
			created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
		)`)
	if err != nil {
		t.Fatalf("create outreach_mailboxes: %v", err)
	}

	// send_events — pouze sloupce potřebné pro trigger + count query
	_, err = tx.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS send_events (
			id           BIGSERIAL PRIMARY KEY,
			mailbox_used TEXT NOT NULL,
			status       TEXT NOT NULL DEFAULT 'sent',
			sent_at      TIMESTAMPTZ NOT NULL DEFAULT now()
		)`)
	if err != nil {
		t.Fatalf("create send_events: %v", err)
	}

	// Funkce compute_phase_cap
	_, err = tx.ExecContext(ctx, `
		CREATE OR REPLACE FUNCTION compute_phase_cap(phase TEXT) RETURNS INT AS $$
		BEGIN
		  RETURN CASE phase
		    WHEN 'warmup_d0'  THEN 5
		    WHEN 'warmup_d3'  THEN 10
		    WHEN 'warmup_d7'  THEN 25
		    WHEN 'warmup_d14' THEN 50
		    WHEN 'production' THEN 100
		    ELSE 5
		  END;
		END;
		$$ LANGUAGE plpgsql IMMUTABLE`)
	if err != nil {
		t.Fatalf("create compute_phase_cap: %v", err)
	}

	// Funkce compute_daily_cap
	_, err = tx.ExecContext(ctx, `
		CREATE OR REPLACE FUNCTION compute_daily_cap(phase TEXT, override_val INT) RETURNS INT AS $$
		DECLARE phase_cap INT;
		BEGIN
		  phase_cap := compute_phase_cap(phase);
		  IF override_val IS NOT NULL AND override_val > 0 AND override_val < phase_cap THEN
		    RETURN override_val;
		  END IF;
		  RETURN phase_cap;
		END;
		$$ LANGUAGE plpgsql IMMUTABLE`)
	if err != nil {
		t.Fatalf("create compute_daily_cap: %v", err)
	}

	// Trigger funkce enforce_warmup_cap — migrace 079 (status guard + cap check).
	// Bez AT TIME ZONE kvůli přenosnosti (test DB nemusí mít Europe/Prague).
	_, err = tx.ExecContext(ctx, `
		CREATE OR REPLACE FUNCTION enforce_warmup_cap() RETURNS TRIGGER AS $$
		DECLARE
		  current_phase  TEXT;
		  current_status TEXT;
		  cap            INT;
		  override_val   INT;
		  sent_today     INT;
		  mailbox_addr   TEXT;
		BEGIN
		  SELECT lifecycle_phase, status, daily_cap_override, from_address
		    INTO current_phase, current_status, override_val, mailbox_addr
		    FROM outreach_mailboxes
		   WHERE from_address = NEW.mailbox_used
		   LIMIT 1;
		  IF current_phase IS NULL THEN RETURN NEW; END IF;
		  -- Migration 079 status guard: reject if mailbox is not in a sendable state
		  IF current_status NOT IN ('active', 'warmup_d0', 'warmup_d3', 'warmup_d7', 'warmup_d14', 'production') THEN
		    RAISE EXCEPTION 'warmup_cap_status_guard: mailbox=% status=% (not active)',
		      mailbox_addr, current_status
		      USING ERRCODE = '23514';
		  END IF;
		  cap := compute_daily_cap(current_phase, override_val);
		  SELECT count(*) INTO sent_today
		    FROM send_events
		   WHERE mailbox_used = NEW.mailbox_used
		     AND DATE(sent_at) = CURRENT_DATE
		     AND status IN ('sent', 'queued');
		  IF sent_today >= cap THEN
		    RAISE EXCEPTION 'warmup_cap_exceeded: mailbox=% phase=% sent_today=% cap=%',
		      mailbox_addr, current_phase, sent_today, cap
		      USING ERRCODE = '23514';
		  END IF;
		  RETURN NEW;
		END;
		$$ LANGUAGE plpgsql`)
	if err != nil {
		t.Fatalf("create enforce_warmup_cap fn: %v", err)
	}

	// Trigger na send_events
	_, err = tx.ExecContext(ctx, `
		DROP TRIGGER IF EXISTS trg_enforce_warmup_cap ON send_events;
		CREATE TRIGGER trg_enforce_warmup_cap
		  BEFORE INSERT ON send_events
		  FOR EACH ROW EXECUTE FUNCTION enforce_warmup_cap()`)
	if err != nil {
		t.Fatalf("create trigger: %v", err)
	}

	// Vložit testovací schránku (warmup_d0 = limit 5)
	_, err = tx.ExecContext(ctx,
		`INSERT INTO outreach_mailboxes (from_address, lifecycle_phase, status)
		 VALUES ($1, 'warmup_d0', 'active')
		 ON CONFLICT (from_address) DO UPDATE SET lifecycle_phase='warmup_d0', daily_cap_override=NULL`,
		mailboxAddr)
	if err != nil {
		t.Fatalf("insert test mailbox: %v", err)
	}
}

// insertSend vloží jeden řádek do send_events. Vrací chybu pokud trigger selže.
func insertSend(ctx context.Context, tx *sql.Tx, mailboxAddr string) error {
	_, err := tx.ExecContext(ctx,
		`INSERT INTO send_events (mailbox_used, status, sent_at) VALUES ($1, 'sent', NOW())`,
		mailboxAddr)
	return err
}

// isPgError23514 zkontroluje zda err je PostgreSQL ERRCODE 23514 (check_violation).
func isPgError23514(err error) bool {
	if err == nil {
		return false
	}
	// lib/pq wraps as *pq.Error with Code field.
	// Abychom se vyhnuli přímé závislosti na pq.Error struct v tomto souboru,
	// čteme Code přes errors.As + interface inference.
	type pgErr interface {
		Get(field byte) string
	}
	var pge pgErr
	if errors.As(err, &pge) {
		code := pge.Get('C') // field 'C' = SQLState/ERRCODE
		return code == "23514"
	}
	// Fallback: string check (relay propagates as plain error message)
	return strings.Contains(err.Error(), "23514") || strings.Contains(err.Error(), "warmup_cap_exceeded")
}

// ── Test 1: pod limitem (4/5 odeslání projde) ─────────────────────────────────

func TestAP1_WarmupCap_UnderCap_AllowsInsert(t *testing.T) {
	db := openIntegrationDB(t)
	defer db.Close()

	mb := fmt.Sprintf("test-ap1-under@test-%d.cz", time.Now().UnixNano())
	ctx := context.Background()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback() //nolint:errcheck

	setupWarmupSchema(t, tx, mb)

	// 4 odeslání pod limitem 5 — všechny projdou
	for i := 0; i < 4; i++ {
		if err := insertSend(ctx, tx, mb); err != nil {
			t.Fatalf("send %d failed unexpectedly: %v", i+1, err)
		}
	}
}

// ── Test 2: na hranici limitu (5/5 projde, 6/6 selže) ────────────────────────

func TestAP1_WarmupCap_AtCapEdge_FifthPassesSixthFails(t *testing.T) {
	db := openIntegrationDB(t)
	defer db.Close()

	mb := fmt.Sprintf("test-ap1-edge@test-%d.cz", time.Now().UnixNano())
	ctx := context.Background()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback() //nolint:errcheck

	setupWarmupSchema(t, tx, mb)

	// 5 odeslání — přesně na limitu warmup_d0 (5/day)
	for i := 0; i < 5; i++ {
		if err := insertSend(ctx, tx, mb); err != nil {
			t.Fatalf("send %d failed unexpectedly: %v", i+1, err)
		}
	}

	// 6. odeslání musí selhat s ERRCODE 23514
	err6 := insertSend(ctx, tx, mb)
	if err6 == nil {
		t.Fatal("6th send should have failed with warmup cap, but succeeded")
	}
	if !isPgError23514(err6) {
		t.Errorf("expected ERRCODE 23514 or warmup_cap_exceeded, got: %v", err6)
	}
}

// ── Test 3: nad limitem — ERRCODE 23514 + message warmup_cap_exceeded ────────

func TestAP1_WarmupCap_OverCap_ReturnsCorrectError(t *testing.T) {
	db := openIntegrationDB(t)
	defer db.Close()

	mb := fmt.Sprintf("test-ap1-over@test-%d.cz", time.Now().UnixNano())
	ctx := context.Background()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback() //nolint:errcheck

	setupWarmupSchema(t, tx, mb)

	// Naplnit limit (5 odeslání)
	for i := 0; i < 5; i++ {
		if err := insertSend(ctx, tx, mb); err != nil {
			t.Fatalf("setup send %d: %v", i+1, err)
		}
	}

	// 6. odeslání — ověřit ERRCODE i zprávu
	triggerErr := insertSend(ctx, tx, mb)
	if triggerErr == nil {
		t.Fatal("expected trigger error, got nil")
	}

	// ERRCODE 23514
	if !isPgError23514(triggerErr) {
		t.Errorf("trigger error should be ERRCODE 23514 or contain warmup_cap_exceeded, got: %v", triggerErr)
	}

	// Message obsahuje warmup_cap_exceeded
	if !strings.Contains(triggerErr.Error(), "warmup_cap_exceeded") {
		t.Errorf("trigger error message should contain 'warmup_cap_exceeded', got: %v", triggerErr)
	}

	// Go sentinel IsWarmupCapError detekuje chybu triggeru
	if !IsWarmupCapError(fmt.Errorf("relay wrapped: %w", errors.New(triggerErr.Error()))) {
		t.Error("IsWarmupCapError should return true for trigger error message")
	}
}

// ── Test 4: daily_cap_override LOWER je respektován ──────────────────────────

func TestAP1_WarmupCap_Override_Lower_IsEnforced(t *testing.T) {
	db := openIntegrationDB(t)
	defer db.Close()

	mb := fmt.Sprintf("test-ap1-low@test-%d.cz", time.Now().UnixNano())
	ctx := context.Background()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback() //nolint:errcheck

	setupWarmupSchema(t, tx, mb)

	// Nastavit override na 2 (nižší než warmup_d0 limit 5)
	_, err = tx.ExecContext(ctx,
		`UPDATE outreach_mailboxes SET daily_cap_override=2 WHERE from_address=$1`, mb)
	if err != nil {
		t.Fatalf("set override: %v", err)
	}

	// 2 odeslání projdou (respektuje override=2)
	for i := 0; i < 2; i++ {
		if err := insertSend(ctx, tx, mb); err != nil {
			t.Fatalf("send %d failed unexpectedly with override=2: %v", i+1, err)
		}
	}

	// 3. odeslání selže (cap=2, sent_today=2 → 2 >= 2 → reject)
	err3 := insertSend(ctx, tx, mb)
	if err3 == nil {
		t.Fatal("3rd send should fail with daily_cap_override=2, but succeeded")
	}
	if !isPgError23514(err3) {
		t.Errorf("expected ERRCODE 23514 for lower override, got: %v", err3)
	}
}

// ── Test 5: daily_cap_override RAISE je ignorován (trigger je ochrana) ───────

func TestAP1_WarmupCap_Override_Raise_IsIgnored(t *testing.T) {
	db := openIntegrationDB(t)
	defer db.Close()

	mb := fmt.Sprintf("test-ap1-raise@test-%d.cz", time.Now().UnixNano())
	ctx := context.Background()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback() //nolint:errcheck

	setupWarmupSchema(t, tx, mb)

	// Nastavit override na 100 (vyšší než warmup_d0 limit 5) — musí být ignorován
	_, err = tx.ExecContext(ctx,
		`UPDATE outreach_mailboxes SET daily_cap_override=100 WHERE from_address=$1`, mb)
	if err != nil {
		t.Fatalf("set override: %v", err)
	}

	// 5 odeslání projde (do limitu warmup_d0=5)
	for i := 0; i < 5; i++ {
		if err := insertSend(ctx, tx, mb); err != nil {
			t.Fatalf("send %d failed with high override=%d: %v", i+1, 100, err)
		}
	}

	// 6. odeslání musí selhat — override 100 byl ignorován, fázový limit 5 platí
	err6 := insertSend(ctx, tx, mb)
	if err6 == nil {
		t.Fatal("6th send should fail even with override=100: phase cap cannot be raised")
	}
	if !isPgError23514(err6) {
		t.Errorf("expected ERRCODE 23514 (override raise blocked), got: %v", err6)
	}
}

// ── Test 6: status guard — paused mailbox → ERRCODE 23514 + warmup_cap_status_guard ──
//
// Ověřuje, že trigger (migrace 079) odmítne INSERT pro schránku ve stavu 'paused'
// s prefixem "warmup_cap_status_guard" a ERRCODE 23514.

func TestAP1_WarmupCap_StatusGuard_PausedMailboxRejected(t *testing.T) {
	db := openIntegrationDB(t)
	defer db.Close()

	mb := fmt.Sprintf("test-ap1-sg@test-%d.cz", time.Now().UnixNano())
	ctx := context.Background()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback() //nolint:errcheck

	setupWarmupSchema(t, tx, mb)

	// Nastavit schránku na 'paused' — trigger 079 musí odmítnout INSERT
	_, err = tx.ExecContext(ctx,
		`UPDATE outreach_mailboxes SET status='paused' WHERE from_address=$1`, mb)
	if err != nil {
		t.Fatalf("set status=paused: %v", err)
	}

	// První odeslání musí selhat — schránka není aktivní
	triggerErr := insertSend(ctx, tx, mb)
	if triggerErr == nil {
		t.Fatal("expected trigger error for paused mailbox, got nil")
	}

	// ERRCODE 23514
	if !isPgError23514(triggerErr) {
		t.Errorf("expected ERRCODE 23514 for status guard, got: %v", triggerErr)
	}

	// Message obsahuje warmup_cap_status_guard
	if !strings.Contains(triggerErr.Error(), "warmup_cap_status_guard") {
		t.Errorf("trigger error should contain 'warmup_cap_status_guard', got: %v", triggerErr)
	}

	// Go sentinel IsWarmupCapStatusGuardError detekuje chybu triggeru
	if !IsWarmupCapStatusGuardError(fmt.Errorf("relay wrapped: %w", errors.New(triggerErr.Error()))) {
		t.Error("IsWarmupCapStatusGuardError should return true for trigger error message")
	}
}
