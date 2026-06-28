// Sprint AP5 — Boot-time mailbox environment boundary check unit tests.
//
// Tests the checkProdMailboxEnvironmentConsistency function logic:
// - production: warn-only if test/dev mailboxes are status='active'
// - dev/test: hard fail if production mailboxes are active in this DB
//
// The function is extracted from server.js for unit testing via eval isolation.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Extract the function body from server.js for isolated unit testing.
// We parse it out rather than importing the full ESM module to avoid
// side effects (DB connection, cron registration, etc.).
const SERVER_SRC = readFileSync(resolve(__dirname, '../../../server.js'), 'utf-8')

// Dynamically extract and evaluate the checkProdMailboxEnvironmentConsistency function
// We wrap it in an async factory that accepts a mock pool.
async function makeCheckFn(mockPool, nodeEnv) {
  // Override NODE_ENV for the test
  const origNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = nodeEnv

  // Extract function body (between the function signature and the closing brace)
  const fnMatch = SERVER_SRC.match(
    /async function checkProdMailboxEnvironmentConsistency\(pool\)\s*\{([\s\S]*?)\n\}/
  )
  if (!fnMatch) throw new Error('checkProdMailboxEnvironmentConsistency not found in server.js')

  const fnBody = fnMatch[1]
  const fn = new Function('pool', 'process', `return (async () => { ${fnBody} })()`)

  try {
    return await fn(mockPool, process)
  } finally {
    process.env.NODE_ENV = origNodeEnv
  }
}

describe('AP5 — checkProdMailboxEnvironmentConsistency', () => {
  let mockPool

  beforeEach(() => {
    mockPool = { query: vi.fn() }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  describe('when NODE_ENV=production', () => {
    it('returns true (no throw) when no non-production mailboxes are active', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ c: 0 }] })
      const result = await makeCheckFn(mockPool, 'production')
      expect(result).toBe(true)
      expect(console.warn).not.toHaveBeenCalled()
    })

    it('returns true but warns when non-production mailboxes are active', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ c: 3 }] })
      const result = await makeCheckFn(mockPool, 'production')
      expect(result).toBe(true)
      expect(console.warn).toHaveBeenCalled()
    })

    it('queries for non-production active mailboxes', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ c: 0 }] })
      await makeCheckFn(mockPool, 'production')
      const [sql] = mockPool.query.mock.calls[0]
      expect(sql).toMatch(/environment != 'production'/i)
      expect(sql).toMatch(/status = 'active'/i)
    })
  })

  describe('when NODE_ENV=development', () => {
    it('returns true when no production mailboxes active', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ c: 0 }] })
      const result = await makeCheckFn(mockPool, 'development')
      expect(result).toBe(true)
    })

    it('throws when production mailboxes are active (hard fail)', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ c: 4 }] })
      await expect(makeCheckFn(mockPool, 'development')).rejects.toThrow(/PRODUCTION_LOCK/)
    })

    it('throw message includes mailbox count and NODE_ENV', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ c: 4 }] })
      await expect(makeCheckFn(mockPool, 'development')).rejects.toThrow(/4 production mailboxes/)
    })

    it('throw message includes dev contamination explanation', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ c: 1 }] })
      await expect(makeCheckFn(mockPool, 'development')).rejects.toThrow(/production credentials/)
    })

    it('queries for production active mailboxes', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ c: 0 }] })
      await makeCheckFn(mockPool, 'development')
      const [sql] = mockPool.query.mock.calls[0]
      expect(sql).toMatch(/environment = 'production'/i)
      expect(sql).toMatch(/status = 'active'/i)
    })
  })

  describe('when NODE_ENV=test', () => {
    it('returns true when no production mailboxes active (test fixture 11583 is env=test)', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ c: 0 }] })
      const result = await makeCheckFn(mockPool, 'test')
      expect(result).toBe(true)
    })

    it('throws when production mailboxes detected in test DB', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ c: 2 }] })
      await expect(makeCheckFn(mockPool, 'test')).rejects.toThrow(/PRODUCTION_LOCK/)
    })
  })
})
