/**
 * Unit tests for src/lib/mailboxFormHelpers.js.
 *
 * Covers:
 *   1. providerAutoFill — domain mapping for Seznam, post.cz, email.cz;
 *      pass-through (null) for custom domains; null for malformed input.
 *   2. runFullCheck — branching by ids.length:
 *        0   → bulk health-summary
 *        1   → per-mailbox full-check?force=1
 *        2+  → parallel full-checks
 *      Each branch must invoke the right fetch URL and merge into liveScores.
 *
 * No React rendering, no MSW — pure logic with a stubbed fetchFn.
 */
import { describe, it, expect, vi } from 'vitest'
import { providerAutoFill, runFullCheck } from '../../../src/lib/mailboxFormHelpers'

describe('providerAutoFill', () => {
  it('returns Seznam preset for @seznam.cz', () => {
    const got = providerAutoFill('outreach@seznam.cz')
    expect(got).toEqual({
      smtp_host: 'smtp.seznam.cz',
      smtp_port: 465,
      imap_host: 'imap.seznam.cz',
      imap_port: 993,
    })
  })

  it('returns post.cz preset for @post.cz', () => {
    const got = providerAutoFill('hello@post.cz')
    expect(got).toEqual({
      smtp_host: 'smtp.post.cz',
      smtp_port: 465,
      imap_host: 'imap.post.cz',
      imap_port: 993,
    })
  })

  it('returns email.cz preset for @email.cz', () => {
    const got = providerAutoFill('hello@email.cz')
    expect(got?.smtp_host).toBe('smtp.email.cz')
  })

  it('is case-insensitive on the domain', () => {
    const got = providerAutoFill('Outreach@Seznam.CZ')
    expect(got?.smtp_host).toBe('smtp.seznam.cz')
  })

  it('returns null for unknown/custom domain', () => {
    expect(providerAutoFill('me@balkanmotors.cz')).toBeNull()
    expect(providerAutoFill('me@gmail.com')).toBeNull()
  })

  it('returns null for malformed input', () => {
    expect(providerAutoFill('not-an-email')).toBeNull()
    expect(providerAutoFill('')).toBeNull()
    expect(providerAutoFill(null)).toBeNull()
    expect(providerAutoFill(undefined)).toBeNull()
    expect(providerAutoFill(42)).toBeNull()
  })
})

describe('runFullCheck', () => {
  function makeFetchStub(routes) {
    return vi.fn(async (url) => {
      for (const [pattern, body] of Object.entries(routes)) {
        if (url.includes(pattern)) {
          return { ok: true, json: async () => body }
        }
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  it('ids=[] calls /api/mailboxes/health-summary (bulk) and merges results', async () => {
    const fetchFn = makeFetchStub({
      '/api/mailboxes/health-summary': {
        mailboxes: [
          { id: 1, score: 72, ok: true, critical: [] },
          { id: 2, score: 30, ok: false, critical: ['smtp'] },
        ],
      },
    })
    const setLiveScores = vi.fn()
    const merged = await runFullCheck([], { fetchFn, setLiveScores })

    expect(fetchFn).toHaveBeenCalledOnce()
    expect(fetchFn).toHaveBeenCalledWith('/api/mailboxes/health-summary')
    expect(merged).toEqual({
      1: { score: 72, ok: true, critical: [] },
      2: { score: 30, ok: false, critical: ['smtp'] },
    })
    expect(setLiveScores).toHaveBeenCalledOnce()
    // Verify the updater merges (doesn't replace) the previous state.
    const updater = setLiveScores.mock.calls[0][0]
    const result = updater({ existing: { score: 99 } })
    expect(result).toEqual({
      existing: { score: 99 },
      1: { score: 72, ok: true, critical: [] },
      2: { score: 30, ok: false, critical: ['smtp'] },
    })
  })

  it('ids=[1053] calls /api/mailboxes/:id/full-check?force=1', async () => {
    const fetchFn = makeFetchStub({
      '/api/mailboxes/1053/full-check?force=1': { score: 88, ok: true, critical: [] },
    })
    const setLiveScores = vi.fn()
    const merged = await runFullCheck([1053], { fetchFn, setLiveScores })

    expect(fetchFn).toHaveBeenCalledOnce()
    expect(fetchFn).toHaveBeenCalledWith('/api/mailboxes/1053/full-check?force=1')
    expect(merged).toEqual({
      1053: { score: 88, ok: true, critical: [] },
    })
    expect(setLiveScores).toHaveBeenCalledOnce()
  })

  it('ids=[1,2,3] runs parallel full-checks for each id', async () => {
    const fetchFn = vi.fn(async (url) => {
      const m = url.match(/\/api\/mailboxes\/(\d+)\/full-check/)
      if (!m) throw new Error(`unexpected fetch: ${url}`)
      const id = Number(m[1])
      return { ok: true, json: async () => ({ score: id * 10, ok: true, critical: [] }) }
    })
    const setLiveScores = vi.fn()
    const merged = await runFullCheck([1, 2, 3], { fetchFn, setLiveScores })

    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(merged).toEqual({
      1: { score: 10, ok: true, critical: [] },
      2: { score: 20, ok: true, critical: [] },
      3: { score: 30, ok: true, critical: [] },
    })
  })

  it('ids=[1,2] one fail one ok — keeps the ok result, drops the fail', async () => {
    const fetchFn = vi.fn(async (url) => {
      if (url.includes('/1/full-check')) throw new Error('boom')
      return { ok: true, json: async () => ({ score: 50, ok: true, critical: [] }) }
    })
    const setLiveScores = vi.fn()
    const merged = await runFullCheck([1, 2], { fetchFn, setLiveScores })
    expect(merged).toEqual({
      2: { score: 50, ok: true, critical: [] },
    })
  })

  it('works without setLiveScores (returns merged but no side-effect)', async () => {
    const fetchFn = makeFetchStub({
      '/api/mailboxes/health-summary': { mailboxes: [{ id: 9, score: 1, ok: false, critical: [] }] },
    })
    const merged = await runFullCheck([], { fetchFn })
    expect(merged).toEqual({ 9: { score: 1, ok: false, critical: [] } })
  })
})
