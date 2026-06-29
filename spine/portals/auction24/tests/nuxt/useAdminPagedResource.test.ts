import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAdminPagedResource, type PagedParams } from '~/features/platform/admin/logic/useAdminPagedResource'

interface Row {
  id: string
}

interface Params extends PagedParams {
  page: number
  pageSize: number
}

// The module-level seq map and useState entries are keyed by `key`, so every test uses a unique
// key to avoid cross-test contamination of the shared counter/state.
let n = 0
const freshKey = () => `res${++n}`

beforeEach(() => vi.clearAllMocks())

describe('useAdminPagedResource', () => {
  it('exposes the expected reactive API with default values', () => {
    const r = useAdminPagedResource<Row, Params>(freshKey(), '/api/admin/rows')
    expect(r.items.value).toBeUndefined()
    expect(r.total.value).toBe(0)
    expect(r.loading.value).toBe(false)
    expect(r.last.value).toBeNull()
    expect(typeof r.fetchPage).toBe('function')
    expect(typeof r.refresh).toBe('function')
  })

  it('fetchPage stores items/total, records params, and clears loading', async () => {
    const f = vi.fn().mockResolvedValue({ items: [{ id: 'a' }], total: 7 })
    vi.stubGlobal('$fetch', f)
    const r = useAdminPagedResource<Row, Params>(freshKey(), '/api/admin/rows')

    await r.fetchPage({ page: 2, pageSize: 10, q: 'x' })

    expect(r.items.value).toEqual([{ id: 'a' }])
    expect(r.total.value).toBe(7)
    expect(r.loading.value).toBe(false)
    expect(r.last.value).toEqual({ page: 2, pageSize: 10, q: 'x' })
    const [path, opts] = f.mock.calls[0]!
    expect(path).toBe('/api/admin/rows')
    expect(opts.query).toEqual({ page: 2, pageSize: 10, q: 'x' })
  })

  it('toggles loading true while in flight (?? 0 on the first call)', async () => {
    let resolve: (v: { items: Row[]; total: number }) => void = () => {}
    const f = vi.fn().mockImplementation(
      () =>
        new Promise<{ items: Row[]; total: number }>(res => {
          resolve = res
        }),
    )
    vi.stubGlobal('$fetch', f)
    const r = useAdminPagedResource<Row, Params>(freshKey(), '/api/admin/rows')

    const p = r.fetchPage({ page: 1, pageSize: 10 })
    expect(r.loading.value).toBe(true)
    resolve({ items: [{ id: 'z' }], total: 1 })
    await p
    expect(r.loading.value).toBe(false)
    expect(r.items.value).toEqual([{ id: 'z' }])
  })

  it('drops a stale response superseded by a newer fetch (seq guard)', async () => {
    let resolveFirst: (v: { items: Row[]; total: number }) => void = () => {}
    const f = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ items: Row[]; total: number }>(res => {
            resolveFirst = res
          }),
      )
      .mockResolvedValueOnce({ items: [{ id: 'new' }], total: 2 })
    vi.stubGlobal('$fetch', f)
    const r = useAdminPagedResource<Row, Params>(freshKey(), '/api/admin/rows')

    const first = r.fetchPage({ page: 1, pageSize: 10 })
    // Second call bumps the seq before the first resolves.
    await r.fetchPage({ page: 2, pageSize: 10 })
    expect(r.items.value).toEqual([{ id: 'new' }])
    expect(r.total.value).toBe(2)

    // First (stale) resolution must not overwrite, and must not flip loading back off
    // since its seq no longer matches.
    resolveFirst({ items: [{ id: 'stale' }], total: 99 })
    await first
    expect(r.items.value).toEqual([{ id: 'new' }])
    expect(r.total.value).toBe(2)
    expect(r.loading.value).toBe(false)
  })

  it('swallows a failed fetch, degrades to an empty list, and clears loading', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = useAdminPagedResource<Row, Params>(freshKey(), '/api/admin/rows')

    // A non-401 fetch error must not bubble out of onBeforeMount: no rethrow, list degrades to
    // empty, loading still clears in finally.
    await r.fetchPage({ page: 1, pageSize: 10 })
    expect(r.loading.value).toBe(false)
    expect(r.items.value).toEqual([])
    expect(r.total.value).toBe(0)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('refresh re-runs the last params once a fetch has happened', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 'a' }], total: 1 })
      .mockResolvedValueOnce({ items: [{ id: 'b' }], total: 1 })
    vi.stubGlobal('$fetch', f)
    const r = useAdminPagedResource<Row, Params>(freshKey(), '/api/admin/rows')

    await r.fetchPage({ page: 3, pageSize: 5, q: 'hi' })
    await r.refresh()

    expect(f).toHaveBeenCalledTimes(2)
    expect(f.mock.calls[1]![1].query).toEqual({ page: 3, pageSize: 5, q: 'hi' })
    expect(r.items.value).toEqual([{ id: 'b' }])
  })

  it('refresh resolves to a no-op when no fetch has run yet', async () => {
    const f = vi.fn()
    vi.stubGlobal('$fetch', f)
    const r = useAdminPagedResource<Row, Params>(freshKey(), '/api/admin/rows')

    await expect(r.refresh()).resolves.toBeUndefined()
    expect(f).not.toHaveBeenCalled()
    expect(r.last.value).toBeNull()
  })

  it('keys distinct resources independently so one fetch does not invalidate another', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 'A' }], total: 1 })
      .mockResolvedValueOnce({ items: [{ id: 'B' }], total: 1 })
    vi.stubGlobal('$fetch', f)
    const a = useAdminPagedResource<Row, Params>(freshKey(), '/api/admin/a')
    const b = useAdminPagedResource<Row, Params>(freshKey(), '/api/admin/b')

    await a.fetchPage({ page: 1, pageSize: 10 })
    await b.fetchPage({ page: 1, pageSize: 10 })

    expect(a.items.value).toEqual([{ id: 'A' }])
    expect(b.items.value).toEqual([{ id: 'B' }])
  })
})
