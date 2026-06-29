package content

// AD1 hardening tests — errors.Is(err, sql.ErrNoRows) in template.go.
//
// Locks the fix from Sprint AD1: template.go must use errors.Is to compare
// against sql.ErrNoRows so wrapped errors (e.g. from future retry middleware
// or instrumentation layers) are handled correctly.

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── AD1-1: errors.Is detects unwrapped sql.ErrNoRows ─────────────────────────

func TestAD1_ErrorsIs_DetectsUnwrapped(t *testing.T) {
	err := sql.ErrNoRows
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("errors.Is should detect unwrapped sql.ErrNoRows")
	}
}

// ── AD1-2: errors.Is detects wrapped sql.ErrNoRows ───────────────────────────

func TestAD1_ErrorsIs_DetectsWrapped(t *testing.T) {
	err := fmt.Errorf("db lookup failed: %w", sql.ErrNoRows)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("errors.Is should detect sql.ErrNoRows wrapped with %%w")
	}
}

// ── AD1-3: errors.Is does NOT match a different error ────────────────────────

func TestAD1_ErrorsIs_DoesNotMatchOtherError(t *testing.T) {
	err := errors.New("some other error")
	if errors.Is(err, sql.ErrNoRows) {
		t.Fatal("errors.Is must not match unrelated errors against sql.ErrNoRows")
	}
}

// ── AD1-4: errors.Is detects doubly-wrapped sql.ErrNoRows ────────────────────

func TestAD1_ErrorsIs_DetectsDoubleWrapped(t *testing.T) {
	inner := fmt.Errorf("inner: %w", sql.ErrNoRows)
	outer := fmt.Errorf("outer: %w", inner)
	if !errors.Is(outer, sql.ErrNoRows) {
		t.Fatal("errors.Is should detect sql.ErrNoRows through double wrapping")
	}
}

// ── AD1-5: template engine returns clean error on sql.ErrNoRows (Sprint AH) ───
// (integration — exercises the actual template.go switch-case path)
//
// Sprint AH: file fallback removed. ErrNoRows now returns a clean error:
//   template %q not found in email_templates

func TestAD1_TemplateEngine_FallsBackOnErrNoRows(t *testing.T) {
	dir := t.TempDir()
	const tmplName = "ad1_fallback"
	// File exists but must NOT be used when DB is wired (Sprint AH).
	body := "{{/* subject: Fallback */}}\nHello"
	if err := os.WriteFile(filepath.Join(dir, tmplName+".tmpl"), []byte(body), 0o600); err != nil {
		t.Fatalf("write tmpl: %v", err)
	}

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	mock.ExpectQuery(`SELECT subject, body,.*email_templates`).
		WillReturnError(sql.ErrNoRows)

	eng := NewEngineWithDB(db, dir, nil)
	_, renderErr := eng.Render(tmplName, TemplateVars{}, 1, 0)
	// Sprint AH: ErrNoRows → clean error, NOT file fallback.
	if renderErr == nil {
		t.Fatal("ErrNoRows should return error (Sprint AH: no file fallback), got nil")
	}
	if !strings.Contains(renderErr.Error(), "not found in email_templates") {
		t.Errorf("expected 'not found in email_templates', got: %v", renderErr)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations unmet: %v", err)
	}
}

// ── AD1-6: template engine returns clean error on WRAPPED sql.ErrNoRows (Sprint AH)

func TestAD1_TemplateEngine_FallsBackOnWrappedErrNoRows(t *testing.T) {
	dir := t.TempDir()
	const tmplName = "ad1_wrapped_norows"
	if err := os.WriteFile(filepath.Join(dir, tmplName+".tmpl"),
		[]byte("{{/* subject: Wrapped */}}\nbody"), 0o600); err != nil {
		t.Fatalf("write tmpl: %v", err)
	}

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	wrappedErr := fmt.Errorf("scan: %w", sql.ErrNoRows)
	mock.ExpectQuery(`SELECT subject, body,.*email_templates`).
		WillReturnError(wrappedErr)

	eng := NewEngineWithDB(db, dir, nil)
	_, renderErr := eng.Render(tmplName, TemplateVars{}, 1, 0)
	// Sprint AH: wrapped ErrNoRows also returns clean error (no file fallback).
	if renderErr == nil {
		t.Fatal("wrapped ErrNoRows should return error (Sprint AH: no file fallback), got nil")
	}
	if !strings.Contains(renderErr.Error(), "not found in email_templates") {
		t.Errorf("expected 'not found in email_templates', got: %v", renderErr)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations unmet: %v", err)
	}
}

// ── AD1-7: real DB error propagates (not silenced as ErrNoRows) ───────────────

func TestAD1_TemplateEngine_PropagatesRealDBError(t *testing.T) {
	dir := t.TempDir()
	const tmplName = "ad1_db_error"

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	mock.ExpectQuery(`SELECT subject, body,.*email_templates`).
		WillReturnError(errors.New("connection reset by peer"))

	eng := NewEngineWithDB(db, dir, nil)
	_, renderErr := eng.Render(tmplName, TemplateVars{}, 1, 0)
	if renderErr == nil {
		t.Fatal("real DB error must propagate, not be swallowed as ErrNoRows")
	}
	if !strings.Contains(renderErr.Error(), "connection reset") {
		t.Errorf("expected original error text in wrapped error, got: %v", renderErr)
	}
}

// ── AD1-8: audit ratchet — no `err == sql.ErrNoRows` in non-test .go files ───
// Local ratchet scoped to the content package — gives a faster red signal
// than the cross-services audit in services/common/audit/sentinel_compare_audit_test.go.

func TestAD1_AuditRatchet_NoDirectSentinelCompare_ContentPackage(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}

	entries, err := os.ReadDir(wd)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}

	var violations []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Join(wd, e.Name()))
		if readErr != nil {
			continue
		}
		for i, line := range strings.Split(string(raw), "\n") {
			if strings.Contains(line, "err == sql.ErrNoRows") || strings.Contains(line, "err != sql.ErrNoRows") {
				violations = append(violations, fmt.Sprintf("%s:%d → %s", e.Name(), i+1, strings.TrimSpace(line)))
			}
		}
	}
	if len(violations) > 0 {
		t.Errorf("AD1: direct sql.ErrNoRows comparison found (use errors.Is):\n  %s",
			strings.Join(violations, "\n  "))
	}
}
