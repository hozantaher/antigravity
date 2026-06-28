// I2 — heal-state-guard tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  buildMailboxStateGraph,
  guardMailboxTransition,
  logTransition,
  guardedTransition,
  InvariantViolation,
} from '../../../src/lib/heal-state-guard.js'

const ORIGINAL_THROW = process.env.INVARIANT_THROW

beforeEach(() => {
  // Force throw for testability
  process.env.INVARIANT_THROW = '1'
})

afterEach(() => {
  if (ORIGINAL_THROW === undefined) delete process.env.INVARIANT_THROW
  else process.env.INVARIANT_THROW = ORIGINAL_THROW
  vi.restoreAllMocks()
})

describe('I2 — heal-state-guard', () => {
  describe('buildMailboxStateGraph', () => {
    it('returns 5-state graph (active, paused, warming, retired, needs_human)', () => {
      const sg = buildMailboxStateGraph()
      expect(sg.states).toEqual(expect.arrayContaining(['active', 'paused', 'warming', 'retired', 'needs_human']))
    })

    it('retired + needs_human are absorbing', () => {
      const sg = buildMailboxStateGraph()
      expect(sg.canTransition('retired', 'active')).toBe(false)
      expect(sg.canTransition('needs_human', 'active')).toBe(false)
    })

    it('active → paused allowed', () => {
      const sg = buildMailboxStateGraph()
      expect(sg.canTransition('active', 'paused')).toBe(true)
    })

    it('active → needs_human BLOCKED (must go through paused)', () => {
      const sg = buildMailboxStateGraph()
      expect(sg.canTransition('active', 'needs_human')).toBe(false)
    })
  })

  describe('guardMailboxTransition', () => {
    it('valid: active → paused returns true', () => {
      expect(guardMailboxTransition('active', 'paused', { mailboxId: 1 })).toBe(true)
    })

    it('valid: paused → needs_human returns true', () => {
      expect(guardMailboxTransition('paused', 'needs_human', { mailboxId: 2 })).toBe(true)
    })

    it('invalid: active → needs_human throws InvariantViolation (with throw flag)', () => {
      expect(() => guardMailboxTransition('active', 'needs_human', { mailboxId: 3 }))
        .toThrow(InvariantViolation)
    })

    it('invalid: retired → active throws (absorbing)', () => {
      expect(() => guardMailboxTransition('retired', 'active', { mailboxId: 4 }))
        .toThrow(/Invalid mailbox transition/i)
    })

    it('non-string from/to throws', () => {
      expect(() => guardMailboxTransition(null, 'active', { mailboxId: 5 })).toThrow()
      expect(() => guardMailboxTransition('active', undefined, { mailboxId: 6 })).toThrow()
    })

    it('error message includes from + to', () => {
      try {
        guardMailboxTransition('active', 'needs_human', { mailboxId: 7 })
      } catch (e) {
        expect(e.message).toMatch(/active.*needs_human/i)
      }
    })
  })

  describe('logTransition', () => {
    it('no-op when pool is null', async () => {
      await expect(logTransition(null, { mailboxId: 1, from: 'active', to: 'paused', valid: true })).resolves.toBeUndefined()
    })

    it('queries pool with INSERT INTO healing_log on success', async () => {
      const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
      await logTransition(pool, { mailboxId: 1, from: 'active', to: 'paused', reason: 'test', valid: true })
      expect(pool.query).toHaveBeenCalledOnce()
      const sql = pool.query.mock.calls[0][0]
      expect(sql).toMatch(/INSERT INTO healing_log/)
    })

    it('queries with invalid_transition action when valid=false', async () => {
      const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
      await logTransition(pool, { mailboxId: 2, from: 'active', to: 'needs_human', valid: false })
      const params = pool.query.mock.calls[0][1]
      expect(params[1]).toMatch(/invalid_transition/i)
    })

    it('swallows pool errors (best-effort)', async () => {
      const pool = { query: vi.fn().mockRejectedValue(new Error('DB down')) }
      // Should not throw
      await expect(logTransition(pool, { mailboxId: 3, from: 'a', to: 'b', valid: true }))
        .resolves.toBeUndefined()
    })
  })

  describe('guardedTransition (composed)', () => {
    it('valid transition → ok=true, logs success', async () => {
      const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
      // Disable throw for this composed test
      process.env.INVARIANT_THROW = ''
      const r = await guardedTransition(pool, {
        mailboxId: 1, from: 'active', to: 'paused', trigger: 'breaker_tripped',
      })
      expect(r.ok).toBe(true)
      expect(pool.query).toHaveBeenCalledOnce()
    })

    it('invalid transition → ok=false, error captured, log written', async () => {
      const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
      const r = await guardedTransition(pool, {
        mailboxId: 1, from: 'active', to: 'needs_human', trigger: 'bypass',
      })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/Invalid mailbox transition/i)
      expect(pool.query).toHaveBeenCalledOnce()
    })
  })
})
