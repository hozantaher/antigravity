// store.resilient.test.js — quality-sweep "gaps" dimension (2026-05-30)
//
// loadAll loads six bootstrap endpoints in parallel. A single failing
// endpoint must NOT blank the whole dashboard (partial-load resilience),
// but the failure must no longer be swallowed silently — it now logs +
// reports a Sentry breadcrumb. These tests pin both halves of that
// contract.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import useStore from '../../../src/store'

const INITIAL_STATE = {
  mailboxes: [], campaigns: [], templates: [], segments: [],
  companies: [], totalCompanies: 0, replyStats: null, loading: false,
}

// Route fetch responses by URL path so we can fail one endpoint while the
// rest succeed.
function routedFetch(failPaths = []) {
  return vi.fn((url) => {
    const path = String(url).replace(/^\/api/, '')
    if (failPaths.some(p => path.startsWith(p))) {
      return Promise.resolve({ ok: false, status: 500, statusText: 'Internal Server Error', json: () => Promise.resolve({}) })
    }
    const body =
      path.startsWith('/companies/stats') ? { total: 7 } :
      path.startsWith('/replies/stats') ? { positive: 1 } :
      path.startsWith('/mailboxes') ? [{ id: 1 }] :
      path.startsWith('/campaigns') ? [{ id: 2 }] :
      path.startsWith('/templates') ? [{ id: 3 }] :
      path.startsWith('/segments') ? [{ id: 4 }] : []
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  })
}

describe('store loadAll — partial-load resilience + observability', () => {
  beforeEach(() => {
    useStore.setState(INITIAL_STATE)  // merge (keeps action methods)
    vi.restoreAllMocks()
  })
  afterEach(() => vi.restoreAllMocks())

  it('all endpoints succeed → state fully populated', async () => {
    vi.stubGlobal('fetch', routedFetch([]))
    await useStore.getState().loadAll()
    const s = useStore.getState()
    expect(s.mailboxes).toHaveLength(1)
    expect(s.campaigns).toHaveLength(1)
    expect(s.totalCompanies).toBe(7)
    expect(s.loading).toBe(false)
  })

  it('one failing endpoint falls back without blanking the rest', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', routedFetch(['/mailboxes']))
    await useStore.getState().loadAll()
    const s = useStore.getState()
    expect(s.mailboxes).toEqual([])        // failed → safe fallback
    expect(s.campaigns).toHaveLength(1)    // unaffected
    expect(s.totalCompanies).toBe(7)
    expect(s.loading).toBe(false)
  })

  it('a swallowed failure is logged (no longer silent)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', routedFetch(['/campaigns']))
    await useStore.getState().loadAll()
    expect(errSpy).toHaveBeenCalled()
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('campaigns'))).toBe(true)
  })
})
