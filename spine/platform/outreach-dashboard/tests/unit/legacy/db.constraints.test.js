// DB constraint coverage — every probe attempts a violating INSERT and
// asserts the expected SQLSTATE comes back. Each probe runs inside a
// transaction that is always ROLLBACK'd, so prod data is untouched.
//
// Catches: a migration accidentally drops NOT NULL/UNIQUE/CHECK/FK,
// or a future ALTER weakens a constraint.
//
// SQLSTATE reference:
//   23502 not_null_violation
//   23503 foreign_key_violation
//   23505 unique_violation
//   23514 check_violation
//   22P02 invalid_text_representation (enum-like check)

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { server as mswServer } from '../../../src/test/setup.js'
import pg from 'pg'
import { readFileSync } from 'fs'

beforeAll(() => mswServer.close())
afterAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }))

let DSN = process.env.DATABASE_URL
if (!DSN) {
  try {
    const env = readFileSync(`${process.cwd()}/.env`, 'utf8')
    DSN = env.split('\n').find(l => l.startsWith('DATABASE_URL='))?.slice(13).trim()
  } catch {}
}

const pool = DSN ? new pg.Pool({ connectionString: DSN, max: 2 }) : null

afterAll(async () => { if (pool) await pool.end() })

async function expectSqlstate(sql, code, params = []) {
  if (!pool) return  // no DSN in this env — skip silently
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    let err
    try { await c.query(sql, params) } catch (e) { err = e }
    expect(err, `expected SQLSTATE ${code} for: ${sql.slice(0, 60)}`).toBeDefined()
    expect(err.code, `got ${err.code} (${err.message.slice(0, 80)}); want ${code}`).toBe(code)
  } finally {
    try { await c.query('ROLLBACK') } catch {}
    c.release()
  }
}

describe.skipIf(!DSN)('DB constraint coverage — violations produce expected SQLSTATE', () => {
  describe('companies', () => {
    it('name NOT NULL', async () => {
      await expectSqlstate(`INSERT INTO companies (firmy_cz_id, name) VALUES (-99991, NULL)`, '23502')
    })
    it('firmy_cz_id NOT NULL', async () => {
      await expectSqlstate(`INSERT INTO companies (name) VALUES ('probe')`, '23502')
    })
    it('firmy_cz_id UNIQUE — duplicate rejected', async () => {
      await expectSqlstate(
        `INSERT INTO companies (firmy_cz_id, name) SELECT firmy_cz_id, 'dup_probe' FROM companies LIMIT 1`,
        '23505'
      )
    })
  })

  describe('contacts', () => {
    const MB = `(SELECT category_path FROM contacts LIMIT 1)`
    it('email NOT NULL', async () => {
      await expectSqlstate(
        `INSERT INTO contacts (email, email_hash, status, category_path) VALUES (NULL, 'h', 'valid', 'x')`,
        '23502'
      )
    })
    it('email_hash UNIQUE — duplicate hash rejected', async () => {
      await expectSqlstate(
        `INSERT INTO contacts (email, email_hash, status, category_path) SELECT 'probe@x', email_hash, 'valid', 'x' FROM contacts WHERE email_hash IS NOT NULL LIMIT 1`,
        '23505'
      )
    })
    it('status CHECK — invalid value rejected', async () => {
      await expectSqlstate(
        `INSERT INTO contacts (email, email_hash, status, category_path) VALUES ('p@x', 'zzz_probe_hash', 'NOT_A_VALID_STATUS', 'x')`,
        '23514'
      )
    })
  })

  describe('outreach_mailboxes', () => {
    it('status CHECK — invalid value', async () => {
      await expectSqlstate(
        `INSERT INTO outreach_mailboxes (from_address, display_name, smtp_host, smtp_port, tz, locale, status)
         VALUES ('a@b.c', 'probe', 'h', 25, 'UTC', 'cs', 'NOT_VALID')`,
        '23514'
      )
    })
    it('daily_cap_override CHECK — negative rejected', async () => {
      await expectSqlstate(
        `INSERT INTO outreach_mailboxes (from_address, display_name, smtp_host, smtp_port, tz, locale, status, daily_cap_override)
         VALUES ('a@b.c', 'probe', 'h', 25, 'UTC', 'cs', 'active', -1)`,
        '23514'
      )
    })
    it('smtp_port CHECK — port out of range', async () => {
      await expectSqlstate(
        `INSERT INTO outreach_mailboxes (from_address, display_name, smtp_host, smtp_port, tz, locale, status)
         VALUES ('a@b.c', 'probe', 'h', 999999, 'UTC', 'cs', 'active')`,
        '23514'
      )
    })
    it('display_name NOT NULL', async () => {
      await expectSqlstate(
        `INSERT INTO outreach_mailboxes (from_address, smtp_host, smtp_port, tz, locale, status)
         VALUES ('a@b.c', 'h', 25, 'UTC', 'cs', 'active')`,
        '23502'
      )
    })
  })
})
