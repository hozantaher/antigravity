// Layer 7 audit (2026-05-18 hardening) — generic trigger-function column safety
//
// Generalizes the notify_reply_inserted ratchet (tests/audit/notify_reply_trigger_safe.test.js)
// to ALL trigger functions in the public schema. The root-cause bug it
// guards against:
//
//   A PL/pgSQL trigger function references `NEW.<column>` directly. The
//   function is then attached to MULTIPLE tables that don't share that
//   column. Inserts on the table without the column raise ERRCODE 42703
//   ("column does not exist"). Symptom: silent ingestion failure (the
//   error surfaces inside the trigger, callers see only the wrapped
//   exception).
//
//   Real incident (PR #1435, fixed 2026-05-18): notify_reply_inserted
//   used NEW.from_email directly. The trigger was attached to both
//   reply_inbox (has from_email) and unmatched_inbound (has from_address).
//   Every INSERT into unmatched_inbound raised 42703. 5 days of silent
//   replies lost; 26 customer replies stuck in INBOX.
//
// This audit:
//   1. Pulls every trigger function from pg_proc (prorettype = trigger).
//   2. For each function, finds every table that has a trigger calling it
//      (via information_schema.triggers.action_statement).
//   3. Scans the function body for direct `NEW.<column>` / `OLD.<column>`
//      references.
//   4. Asserts that every referenced column exists on every table that
//      fires the trigger.
//
// Skip-if-no-DSN — keeps CI without a DB green. When DSN is set the test
// is deterministic and diff-able.

import { describe, it, expect } from 'vitest'
import pg from 'pg'

const DSN = process.env.DATABASE_URL || process.env.DSN || ''

// PL/pgSQL identifiers are case-insensitive but pg_get_functiondef preserves
// source case. We normalize column names to lowercase for comparison since
// information_schema reports them lowercase by default.
//
// Some NEW.* references are NOT column lookups — they're record-typed
// pseudo-fields ("NEW.*" splat in RAISE NOTICE format, etc.) or assignments
// inside RECORD vars. We extract the conservative form `NEW.<identifier>`
// and rely on the column-set check to flag genuine drift.
const NEW_OLD_COLUMN_RE = /\b(NEW|OLD)\.([a-zA-Z_][a-zA-Z0-9_]*)/g

// Known plpgsql reserved sub-identifiers on row records that aren't columns.
// `tableoid` / `ctid` etc. are system columns; we don't audit them.
const PG_SYSTEM_COLUMNS = new Set(['tableoid', 'ctid', 'xmin', 'xmax', 'cmin', 'cmax', 'oid'])

describe('Layer 7 audit: trigger functions column-safety (all functions, all tables)', () => {
  if (!DSN) {
    it.skip('skipped: no DATABASE_URL/DSN env var set', () => {})
    return
  }

  it('every NEW.<column> / OLD.<column> ref exists on every table that fires the trigger', async () => {
    const pool = new pg.Pool({ connectionString: DSN, max: 1 })
    try {
      // 1. Every public-schema trigger function.
      const { rows: functions } = await pool.query(`
        SELECT p.proname AS name, pg_get_functiondef(p.oid) AS body
        FROM pg_proc p
        WHERE p.prorettype = 'trigger'::regtype::oid
          AND p.pronamespace = 'public'::regnamespace
        ORDER BY p.proname
      `)

      // 2. Every trigger that calls each function (function -> [tables]).
      const { rows: triggerRows } = await pool.query(`
        SELECT event_object_table AS table_name, action_statement
        FROM information_schema.triggers
        WHERE trigger_schema = 'public'
          AND event_object_schema = 'public'
      `)

      // 3. Column set per public table.
      const { rows: columnRows } = await pool.query(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
      `)
      const tableColumns = new Map()
      for (const r of columnRows) {
        const t = r.table_name
        if (!tableColumns.has(t)) tableColumns.set(t, new Set())
        tableColumns.get(t).add(r.column_name.toLowerCase())
      }

      // Build function -> Set<table> map from action_statement
      // (e.g. "EXECUTE FUNCTION notify_reply_inserted()").
      const functionTables = new Map()
      for (const fn of functions) {
        functionTables.set(fn.name, new Set())
      }
      for (const trig of triggerRows) {
        // action_statement looks like "EXECUTE FUNCTION notify_reply_inserted()"
        // or "EXECUTE PROCEDURE foo()". Match the identifier between the keyword
        // and the parens.
        const m = trig.action_statement.match(/EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([a-zA-Z_][a-zA-Z0-9_]*)/i)
        if (!m) continue
        const fnName = m[1]
        if (!functionTables.has(fnName)) continue
        functionTables.get(fnName).add(trig.table_name)
      }

      const failures = []
      for (const fn of functions) {
        const tables = functionTables.get(fn.name)
        if (!tables || tables.size === 0) {
          // Function exists but isn't attached — nothing to check. Could be
          // a soft-deprecated function; skip rather than flag.
          continue
        }

        // Extract distinct column refs from the function body.
        const refs = new Set()
        for (const m of fn.body.matchAll(NEW_OLD_COLUMN_RE)) {
          const col = m[2].toLowerCase()
          if (PG_SYSTEM_COLUMNS.has(col)) continue
          refs.add(col)
        }

        // For each table this function fires on, check all refs exist.
        for (const table of tables) {
          const cols = tableColumns.get(table)
          if (!cols) {
            failures.push({
              function_name: fn.name,
              table,
              missing_column: '(table not found in information_schema)',
            })
            continue
          }
          for (const col of refs) {
            if (!cols.has(col)) {
              failures.push({
                function_name: fn.name,
                table,
                missing_column: col,
              })
            }
          }
        }
      }

      // Render a stable, diff-able failure message.
      const message = failures.length === 0
        ? ''
        : 'Trigger function references columns missing on attached table(s):\n' +
          failures
            .map((f) => `  - ${f.function_name}() on "${f.table}" -> NEW.${f.missing_column} (column missing)`)
            .join('\n') +
          '\n\nFix: rewrite the function to convert NEW via to_jsonb(NEW) and use the ' +
          "`->>'col'` operator, e.g.\n" +
          "  DECLARE rec jsonb; BEGIN rec := to_jsonb(NEW); v := COALESCE(rec ->> 'from_email', rec ->> 'from_address', ''); END;\n" +
          'See migration 117_notify_reply_trigger_jsonb_safe.sql for a worked example.'

      expect(failures, message).toEqual([])
    } finally {
      await pool.end()
    }
  })

  it('produces a documentation snapshot of all trigger functions and their tables', async () => {
    // This test always passes — it only emits a stable inventory for docs.
    // Stable so a `diff` against the snapshot shows when triggers are added,
    // dropped, or re-attached.
    const pool = new pg.Pool({ connectionString: DSN, max: 1 })
    try {
      const { rows: triggerRows } = await pool.query(`
        SELECT
          t.trigger_name,
          t.event_object_table AS table_name,
          t.event_manipulation,
          t.action_timing,
          t.action_statement
        FROM information_schema.triggers t
        WHERE t.trigger_schema = 'public'
          AND t.event_object_schema = 'public'
        ORDER BY t.event_object_table, t.trigger_name, t.event_manipulation
      `)

      // Group by function name for the inventory.
      const inventory = new Map()
      for (const r of triggerRows) {
        const m = r.action_statement.match(/EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([a-zA-Z_][a-zA-Z0-9_]*)/i)
        const fnName = m ? m[1] : '(unknown)'
        if (!inventory.has(fnName)) inventory.set(fnName, [])
        inventory.get(fnName).push({
          table: r.table_name,
          timing: r.action_timing,
          event: r.event_manipulation,
          trigger: r.trigger_name,
        })
      }

      // Snapshot is deterministic (sorted) — enables stable docs diffs.
      const sortedFunctions = Array.from(inventory.keys()).sort()
      expect(sortedFunctions.length).toBeGreaterThan(0)
      // Smoke check: every entry has a table.
      for (const fn of sortedFunctions) {
        for (const e of inventory.get(fn)) {
          expect(e.table, `function ${fn} trigger ${e.trigger} must reference a table`).toBeTruthy()
        }
      }
    } finally {
      await pool.end()
    }
  })
})
