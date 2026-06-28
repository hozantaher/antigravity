import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMailboxAlert } from '../../../src/lib/mailboxAlerts.js'

/**
 * In-memory pool fake that mimics the PostgreSQL mailbox_alerts semantics we
 * depend on: SELECT … WHERE resolved_at IS NULL, INSERT … RETURNING id,
 * and UPDATE … SET resolved_at=now() WHERE id=$1.
 */
function makeFakePool() {
  let nextId = 1
  const rows = []

  const pool = {
    rows,
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim()

      // SELECT existing unresolved
      if (q.startsWith('SELECT id FROM mailbox_alerts')) {
        const [mailboxId, type] = params
        const hit = rows
          .filter(r => r.mailbox_id === mailboxId && r.type === type && r.resolved_at === null)
          .sort((a, b) => b.id - a.id)
        return { rows: hit.length ? [{ id: hit[0].id }] : [] }
      }

      // INSERT new alert
      if (q.startsWith('INSERT INTO mailbox_alerts')) {
        const [mailbox_id, type, severity, message] = params
        const row = {
          id: nextId++,
          mailbox_id,
          type,
          severity,
          message,
          created_at: new Date(),
          resolved_at: null,
        }
        rows.push(row)
        return { rows: [{ id: row.id }] }
      }

      // UPDATE resolve
      if (q.startsWith('UPDATE mailbox_alerts SET resolved_at')) {
        const [id] = params
        const r = rows.find(x => x.id === id)
        if (r) r.resolved_at = new Date()
        return { rows: [], rowCount: r ? 1 : 0 }
      }

      throw new Error(`fake pool: unexpected SQL: ${q}`)
    },
  }
  return pool
}

async function resolveAlert(pool, id) {
  await pool.query(`UPDATE mailbox_alerts SET resolved_at=now() WHERE id=$1`, [id])
}

describe('createMailboxAlert', () => {
  let pool
  beforeEach(() => {
    pool = makeFakePool()
  })

  it('inserts a new row when none exists', async () => {
    const res = await createMailboxAlert(pool, 42, 'auth_failure', 'critical', 'twice failed')
    expect(res.created).toBe(true)
    expect(res.id).toBe(1)
    expect(pool.rows).toHaveLength(1)
    expect(pool.rows[0]).toMatchObject({
      mailbox_id: 42,
      type: 'auth_failure',
      severity: 'critical',
      resolved_at: null,
    })
  })

  it('dedups against an existing UNRESOLVED alert of the same (mailbox, type)', async () => {
    await createMailboxAlert(pool, 42, 'auth_failure', 'critical', 'twice failed')
    const res = await createMailboxAlert(pool, 42, 'auth_failure', 'critical', 'still failing')

    expect(res.created).toBe(false)
    expect(res.id).toBe(1)
    expect(pool.rows).toHaveLength(1) // no duplicate row written
  })

  it('RE-FIRES: after resolve, the same (mailbox, type) produces a fresh row', async () => {
    const first = await createMailboxAlert(pool, 42, 'auth_failure', 'critical', 'twice failed')
    expect(first.created).toBe(true)

    // Operator clicks "Vyřešit" in the UI.
    await resolveAlert(pool, first.id)

    // The underlying condition persists — next probe tries to create again.
    const second = await createMailboxAlert(pool, 42, 'auth_failure', 'critical', 'still failing')

    expect(second.created).toBe(true)
    expect(second.id).toBe(2)
    expect(pool.rows).toHaveLength(2)
    expect(pool.rows[0].resolved_at).not.toBeNull() // first one resolved
    expect(pool.rows[1].resolved_at).toBeNull()     // new one open
  })

  it('does NOT dedup across distinct alert types for the same mailbox', async () => {
    const a = await createMailboxAlert(pool, 42, 'auth_failure', 'critical', 'a')
    const b = await createMailboxAlert(pool, 42, 'score_drop', 'warn', 'b')
    expect(a.created).toBe(true)
    expect(b.created).toBe(true)
    expect(pool.rows).toHaveLength(2)
  })

  it('does NOT dedup across different mailboxes of the same type', async () => {
    const a = await createMailboxAlert(pool, 42, 'score_drop', 'warn', 'a')
    const b = await createMailboxAlert(pool, 43, 'score_drop', 'warn', 'b')
    expect(a.created).toBe(true)
    expect(b.created).toBe(true)
    expect(pool.rows).toHaveLength(2)
  })

  it('validates inputs', async () => {
    await expect(createMailboxAlert(null, 1, 't', 'warn', 'm')).rejects.toThrow(/pool/)
    await expect(createMailboxAlert(pool, 0, 't', 'warn', 'm')).rejects.toThrow(/mailboxId/)
    await expect(createMailboxAlert(pool, 1, '', 'warn', 'm')).rejects.toThrow(/type/)
  })

  it('surfaces pool errors', async () => {
    const brokenPool = { query: vi.fn().mockRejectedValue(new Error('db down')) }
    await expect(createMailboxAlert(brokenPool, 1, 'auth_failure', 'warn', 'm')).rejects.toThrow('db down')
  })
})
