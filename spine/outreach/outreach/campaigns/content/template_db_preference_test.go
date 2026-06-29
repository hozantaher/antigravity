package content

// H1 audit ratchet: DB-first template rendering.
//
// These tests lock the DB-preference invariant introduced in Sprint H1.1+H1.2+H1.4:
//   - NewEngineWithDB → email_templates row wins over .tmpl file
//   - sql.ErrNoRows → file fallback (no regression for dev/test)
//   - Both missing → clear error, no panic
//   - NewEngine (nil db) → file-only mode preserved (backward compat)
//   - nil db passed to NewEngineWithDB → treated as file-only (defensive)
//
// Uses go-sqlmock (already in go.mod) — no real DB required.

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── helpers ──────────────────────────────────────────────────────────────────

// newMockDB returns a *sql.DB backed by sqlmock plus the mock controller.
func newMockDB(t *testing.T) (*sql.DB, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db, mock
}

// writeTmpl creates <dir>/<name>.tmpl with the given body content.
func writeTmpl(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name+".tmpl"), []byte(body), 0o644); err != nil {
		t.Fatalf("writeTmpl: %v", err)
	}
}

const dbSubject = "DB-SUBJECT"
const dbBody = "DB-VERSION telo mailu"
const fileBody = "{{/* subject: FILE-SUBJECT */}}\nFILE-VERSION telo mailu"

// ── H1.1 ratchet: DB row wins over file ──────────────────────────────────────

// TestRender_DBPreferenceOverFile is the primary audit ratchet.
// If someone strips the DB-first branch, this test goes red.
func TestRender_DBPreferenceOverFile(t *testing.T) {
	dir := t.TempDir()
	writeTmpl(t, dir, "intro_machinery", fileBody)

	db, mock := newMockDB(t)
	mock.ExpectQuery(`SELECT subject, body,.*email_templates WHERE name=\$1`).
		WithArgs("intro_machinery").
		WillReturnRows(sqlmock.NewRows([]string{"subject", "body", "subject_variants", "body_variants", "body_html"}).
			AddRow(dbSubject, dbBody, "[]", "[]", ""))

	engine := NewEngineWithDB(db, dir, nil)
	rendered, err := engine.Render("intro_machinery", TemplateVars{}, 1, 0)
	if err != nil {
		t.Fatalf("Render error: %v", err)
	}

	if rendered.Subject != dbSubject {
		t.Errorf("subject: want %q, got %q", dbSubject, rendered.Subject)
	}
	if !strings.Contains(rendered.BodyPlain, "DB-VERSION") {
		t.Errorf("body should contain DB-VERSION, got: %q", rendered.BodyPlain)
	}
	if strings.Contains(rendered.BodyPlain, "FILE-VERSION") {
		t.Errorf("body must NOT contain FILE-VERSION when DB row exists")
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations unmet: %v", err)
	}
}

// ── H1.2 ratchet (Sprint AH): DB row absent → clean error (no file fallback) ──
//
// Sprint AH removed the file fallback — DB is now the sole authoritative
// source when an engine is wired with a DB connection. ErrNoRows now returns
// `template %q not found in email_templates` instead of falling through to a
// .tmpl file. The old file-fallback contract is preserved ONLY in NewEngine
// (nil db) callers.

func TestRender_DBMissing_ReturnsCleanError(t *testing.T) {
	dir := t.TempDir()
	// File exists on disk — but must NOT be used when DB is wired (Sprint AH).
	writeTmpl(t, dir, "missing_in_db", fileBody)

	db, mock := newMockDB(t)
	mock.ExpectQuery(`SELECT subject, body,.*email_templates WHERE name=\$1`).
		WithArgs("missing_in_db").
		WillReturnError(sql.ErrNoRows)

	engine := NewEngineWithDB(db, dir, nil)
	_, err := engine.Render("missing_in_db", TemplateVars{}, 1, 0)
	if err == nil {
		t.Fatal("expected error when DB row absent (Sprint AH: no file fallback), got nil")
	}
	if !strings.Contains(err.Error(), "not found in email_templates") {
		t.Errorf("error should say 'not found in email_templates', got: %v", err)
	}
	if !strings.Contains(err.Error(), "missing_in_db") {
		t.Errorf("error should mention template name, got: %v", err)
	}

	if err2 := mock.ExpectationsWereMet(); err2 != nil {
		t.Errorf("sqlmock expectations unmet: %v", err2)
	}
}

// TestRender_ErrorWhenBothMissing verifies the "not found in email_templates" error
// path when neither DB row nor file exists (Sprint AH: single consistent error).
func TestRender_ErrorWhenBothMissing(t *testing.T) {
	dir := t.TempDir()
	// No .tmpl file created. No DB row.

	db, mock := newMockDB(t)
	mock.ExpectQuery(`SELECT subject, body,.*email_templates WHERE name=\$1`).
		WithArgs("ghost_template").
		WillReturnError(sql.ErrNoRows)

	engine := NewEngineWithDB(db, dir, nil)
	_, err := engine.Render("ghost_template", TemplateVars{}, 1, 0)
	if err == nil {
		t.Fatal("expected error for missing template, got nil")
	}
	if !strings.Contains(err.Error(), "not found in email_templates") {
		t.Errorf("unexpected error message: %v", err)
	}

	if err2 := mock.ExpectationsWereMet(); err2 != nil {
		t.Errorf("sqlmock expectations unmet: %v", err2)
	}
}

// ── H1.4 backward-compat: NewEngine (file-only) still works ─────────────────

func TestRender_FileOnlyEngine_StillWorks(t *testing.T) {
	dir := t.TempDir()
	writeTmpl(t, dir, "intro_machinery", fileBody)

	engine := NewEngine(dir, nil) // no DB
	rendered, err := engine.Render("intro_machinery", TemplateVars{}, 1, 0)
	if err != nil {
		t.Fatalf("Render error: %v", err)
	}
	if !strings.Contains(rendered.BodyPlain, "FILE-VERSION") {
		t.Errorf("file-only engine must use file, got: %q", rendered.BodyPlain)
	}
}

// TestEngine_NewEngineWithDB_NilDBFallsBackToFile verifies the defensive nil guard.
func TestEngine_NewEngineWithDB_NilDBFallsBackToFile(t *testing.T) {
	dir := t.TempDir()
	writeTmpl(t, dir, "intro_machinery", fileBody)

	engine := NewEngineWithDB(nil, dir, nil) // nil db → file-only
	rendered, err := engine.Render("intro_machinery", TemplateVars{}, 1, 0)
	if err != nil {
		t.Fatalf("Render with nil db: %v", err)
	}
	if !strings.Contains(rendered.BodyPlain, "FILE-VERSION") {
		t.Errorf("nil-db engine must fall back to file, got: %q", rendered.BodyPlain)
	}
}

// ── DB error handling ─────────────────────────────────────────────────────────

// TestRender_DBErrorPropagated verifies that a non-ErrNoRows DB error is
// surfaced to the caller (not silently swallowed or treated as file fallback).
func TestRender_DBErrorPropagated(t *testing.T) {
	dir := t.TempDir()
	writeTmpl(t, dir, "intro_machinery", fileBody) // file exists — must NOT be used

	dbErr := errors.New("connection refused")
	db, mock := newMockDB(t)
	mock.ExpectQuery(`SELECT subject, body,.*email_templates WHERE name=\$1`).
		WithArgs("intro_machinery").
		WillReturnError(dbErr)

	engine := NewEngineWithDB(db, dir, nil)
	_, err := engine.Render("intro_machinery", TemplateVars{}, 1, 0)
	if err == nil {
		t.Fatal("expected error on DB failure, got nil")
	}
	if !strings.Contains(err.Error(), "template DB lookup") {
		t.Errorf("error should mention DB lookup, got: %v", err)
	}

	if err2 := mock.ExpectationsWereMet(); err2 != nil {
		t.Errorf("sqlmock expectations unmet: %v", err2)
	}
}

// ── DB body with var substitution works end-to-end ───────────────────────────

func TestRender_DBBody_VarSubstitutionApplied(t *testing.T) {
	dir := t.TempDir()
	// No file needed — DB row should be the only source.

	db, mock := newMockDB(t)
	mock.ExpectQuery(`SELECT subject, body,.*email_templates WHERE name=\$1`).
		WithArgs("intro_machinery").
		WillReturnRows(sqlmock.NewRows([]string{"subject", "body", "subject_variants", "body_variants", "body_html"}).
			AddRow("Poptávka od {{firma}}", "Dobrý den {{jmeno}}, rádi bychom spolupracovali.", "[]", "[]", ""))

	engine := NewEngineWithDB(db, dir, nil)
	vars := TemplateVars{Firma: "TestCorp s.r.o.", Jmeno: "Jan"}
	rendered, err := engine.Render("intro_machinery", vars, 1, 0)
	if err != nil {
		t.Fatalf("Render error: %v", err)
	}

	if !strings.Contains(rendered.Subject, "TestCorp s.r.o.") {
		t.Errorf("subject var substitution failed: %q", rendered.Subject)
	}
	if !strings.Contains(rendered.BodyPlain, "Jan") {
		t.Errorf("body var substitution failed: %q", rendered.BodyPlain)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations unmet: %v", err)
	}
}

// ── DB body with empty subject uses default ───────────────────────────────────

func TestRender_DBBody_EmptySubjectDefaultsToPooptavka(t *testing.T) {
	dir := t.TempDir()

	db, mock := newMockDB(t)
	// DB row has empty subject — extractSubjects should return ["Poptávka"] default.
	mock.ExpectQuery(`SELECT subject, body,.*email_templates WHERE name=\$1`).
		WithArgs("intro_machinery").
		WillReturnRows(sqlmock.NewRows([]string{"subject", "body", "subject_variants", "body_variants", "body_html"}).
			AddRow("", "Tělo mailu bez předmětu", "[]", "[]", ""))

	engine := NewEngineWithDB(db, dir, nil)
	rendered, err := engine.Render("intro_machinery", TemplateVars{}, 1, 0)
	if err != nil {
		t.Fatalf("Render error: %v", err)
	}
	if rendered.Subject != "Poptávka" {
		t.Errorf("empty DB subject should default to Poptávka, got %q", rendered.Subject)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations unmet: %v", err)
	}
}

// ── Path-traversal guard still fires before DB lookup ────────────────────────

func TestRender_DBEngine_PathTraversalRejected(t *testing.T) {
	dir := t.TempDir()
	db, _ := newMockDB(t)
	// No mock expectation — guard must reject before any DB call.

	engine := NewEngineWithDB(db, dir, nil)
	_, err := engine.Render("../etc/passwd", TemplateVars{}, 1, 0)
	if err == nil {
		t.Fatal("expected path-traversal error, got nil")
	}
	if !strings.Contains(err.Error(), "invalid template name") {
		t.Errorf("unexpected error: %v", err)
	}
}

// ── HTML output from DB body is valid ────────────────────────────────────────

// TestRender_DBBody_HTMLOutputNonEmpty: outbound carries HTML alternative
// styled to mirror the historical Garaaage visual look (operator decision
// 2026-05-08 — revision after brief plaintext-only experiment).
func TestRender_DBBody_HTMLOutputNonEmpty(t *testing.T) {
	dir := t.TempDir()

	db, mock := newMockDB(t)
	mock.ExpectQuery(`SELECT subject, body,.*email_templates WHERE name=\$1`).
		WithArgs("intro_machinery").
		WillReturnRows(sqlmock.NewRows([]string{"subject", "body", "subject_variants", "body_variants", "body_html"}).
			AddRow("HTML test", "Párový odstavec\n\nDruhý odstavec", "[]", "[]", ""))

	engine := NewEngineWithDB(db, dir, nil)
	rendered, err := engine.Render("intro_machinery", TemplateVars{}, 1, 0)
	if err != nil {
		t.Fatalf("Render error: %v", err)
	}
	if rendered.BodyHTML == "" {
		t.Error("BodyHTML must be populated")
	}
	// AR3: profile varies per envelope, so the closing/opening tag pair may use
	// <p style=...>, <p class=...>, or <div style=...>. Assert that both
	// paragraphs appear and that there are multiple block elements (structure exists).
	if !strings.Contains(rendered.BodyHTML, "Párový odstavec") || !strings.Contains(rendered.BodyHTML, "Druhý odstavec") {
		t.Errorf("both paragraphs must appear in HTML output, got: %q", rendered.BodyHTML)
	}
	if !strings.Contains(rendered.BodyHTML, "</p>") && !strings.Contains(rendered.BodyHTML, "</div>") {
		t.Errorf("HTML must contain block-level closing tags, got: %q", rendered.BodyHTML)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations unmet: %v", err)
	}
}

// ── SkipHumanize propagates from DB body ─────────────────────────────────────

func TestRender_DBBody_SkipHumanizePropagated(t *testing.T) {
	dir := t.TempDir()

	db, mock := newMockDB(t)
	// Body contains humanize-off marker
	mock.ExpectQuery(`SELECT subject, body,.*email_templates WHERE name=\$1`).
		WithArgs("notice").
		WillReturnRows(sqlmock.NewRows([]string{"subject", "body", "subject_variants", "body_variants", "body_html"}).
			AddRow("Oznámení", "{{/* humanize: off */}}\nTělo bez humanizace", "[]", "[]", ""))

	engine := NewEngineWithDB(db, dir, nil)
	rendered, err := engine.Render("notice", TemplateVars{}, 1, 0)
	if err != nil {
		t.Fatalf("Render error: %v", err)
	}
	if !rendered.SkipHumanize {
		t.Error("SkipHumanize must be true when DB body has {{/* humanize: off */}}")
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations unmet: %v", err)
	}
}

// ── NewEngineWithDB returns non-nil even when templatesDir is empty ───────────

func TestNewEngineWithDB_ConstructorSanity(t *testing.T) {
	db, _ := newMockDB(t)
	engine := NewEngineWithDB(db, "/some/dir", []string{"sig1", "sig2"})
	if engine == nil {
		t.Fatal("NewEngineWithDB returned nil")
	}
}
