// icp_sectors.test.js — BFF contract tests for /api/icp-sectors (Sprint AJ).
//
// Tests (12):
//  1.  GET /api/icp-sectors returns 200 with array
//  2.  GET /api/icp-sectors?kind=target passes kind param to query
//  3.  GET /api/icp-sectors?kind=anti_target passes anti_target param
//  4.  GET /api/icp-sectors?kind=invalid does not filter
//  5.  POST /api/icp-sectors creates new sector → 201
//  6.  POST /api/icp-sectors rejects missing code → 400
//  7.  POST /api/icp-sectors rejects invalid kind → 400
//  8.  POST /api/icp-sectors duplicate code+kind → 409
//  9.  PATCH /api/icp-sectors/:id updates fields + writes audit log
// 10.  PATCH /api/icp-sectors/:id returns 404 for unknown id
// 11.  DELETE /api/icp-sectors/:id soft-deletes (active=false) + audit log
// 12.  DELETE /api/icp-sectors/:id returns 404 for unknown id

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── minimal fake Express app ─────────────────────────────────────────────────

function fakeApp() {
  const routes = []
  const app = {
    get(path, ...handlers) { routes.push({ method: 'GET', path, handlers }) },
    post(path, ...handlers) { routes.push({ method: 'POST', path, handlers }) },
    patch(path, ...handlers) { routes.push({ method: 'PATCH', path, handlers }) },
    delete(path, ...handlers) { routes.push({ method: 'DELETE', path, handlers }) },
    _routes: routes,
  }
  return app
}

// Get the single (async) handler for a route.
function getHandler(app, method, path) {
  const route = app._routes.find(r => r.method === method && r.path === path)
  if (!route) throw new Error(`Route not found: ${method} ${path}`)
  // Routes have one async handler (after any middleware).
  return route.handlers[route.handlers.length - 1]
}

function fakeRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this },
    json(body) { this._body = body; return this },
  }
  return res
}

// ─── mock data ────────────────────────────────────────────────────────────────

const SAMPLE_ROW = {
  id: 1, code: 'machinery', name: 'Strojírenství', kind: 'target',
  nace_prefixes: ['28', '3312'], weight: 10, active: true,
  created_at: '2026-05-07T00:00:00Z', updated_at: '2026-05-07T00:00:00Z', updated_by: 'test',
}

function makePool(overrides = {}) {
  const defaults = {
    query: vi.fn().mockResolvedValue({ rows: [SAMPLE_ROW] }),
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [SAMPLE_ROW] }),
      release: vi.fn(),
    }),
  }
  return { ...defaults, ...overrides }
}

const capture500 = vi.fn()
const safeError = e => e?.message || 'err'

// ─── test suite ───────────────────────────────────────────────────────────────

describe('icp-sectors BFF contract', () => {
  beforeEach(() => { vi.resetModules() })

  // T-01: GET returns 200 + rows array
  it('T-01: GET /api/icp-sectors returns 200 + rows array', async () => {
    const pool = makePool({ query: vi.fn().mockResolvedValue({ rows: [SAMPLE_ROW] }) })
    const { mountICPSectorsRoutes } = await import('../../../src/server-routes/icpSectors.js')
    const app = fakeApp()
    mountICPSectorsRoutes(app, { pool, capture500, safeError })

    const handler = getHandler(app, 'GET', '/api/icp-sectors')
    const req = { query: {}, params: {}, body: {}, headers: {} }
    const res = fakeRes()
    await handler(req, res, () => {})

    expect(res._status).toBe(200)
    expect(Array.isArray(res._body)).toBe(true)
    expect(res._body[0].code).toBe('machinery')
  })

  // T-02: GET ?kind=target passes kind param to query
  it('T-02: GET ?kind=target passes kind param', async () => {
    const querySpy = vi.fn().mockResolvedValue({ rows: [] })
    const pool = makePool({ query: querySpy })
    const { mountICPSectorsRoutes } = await import('../../../src/server-routes/icpSectors.js')
    const app = fakeApp()
    mountICPSectorsRoutes(app, { pool, capture500, safeError })

    const handler = getHandler(app, 'GET', '/api/icp-sectors')
    await handler({ query: { kind: 'target' }, params: {}, body: {}, headers: {} }, fakeRes(), () => {})

    expect(querySpy).toHaveBeenCalled()
    expect(querySpy.mock.calls[0][1]).toEqual(['target'])
  })

  // T-03: GET ?kind=anti_target filters
  it('T-03: GET ?kind=anti_target passes anti_target param', async () => {
    const querySpy = vi.fn().mockResolvedValue({ rows: [] })
    const pool = makePool({ query: querySpy })
    const { mountICPSectorsRoutes } = await import('../../../src/server-routes/icpSectors.js')
    const app = fakeApp()
    mountICPSectorsRoutes(app, { pool, capture500, safeError })

    const handler = getHandler(app, 'GET', '/api/icp-sectors')
    await handler({ query: { kind: 'anti_target' }, params: {}, body: {}, headers: {} }, fakeRes(), () => {})

    expect(querySpy.mock.calls[0][1]).toEqual(['anti_target'])
  })

  // T-04: GET ?kind=invalid does not filter (empty params array)
  it('T-04: GET ?kind=invalid does not filter', async () => {
    const querySpy = vi.fn().mockResolvedValue({ rows: [] })
    const pool = makePool({ query: querySpy })
    const { mountICPSectorsRoutes } = await import('../../../src/server-routes/icpSectors.js')
    const app = fakeApp()
    mountICPSectorsRoutes(app, { pool, capture500, safeError })

    const handler = getHandler(app, 'GET', '/api/icp-sectors')
    await handler({ query: { kind: 'invalid_kind' }, params: {}, body: {}, headers: {} }, fakeRes(), () => {})

    expect(querySpy.mock.calls[0][1]).toEqual([])
  })

  // T-05: POST creates sector → 201
  it('T-05: POST /api/icp-sectors returns 201 + created row', async () => {
    const createdRow = { ...SAMPLE_ROW, id: 5 }
    const clientMock = {
      query: vi.fn()
        .mockResolvedValueOnce({})                      // BEGIN
        .mockResolvedValueOnce({ rows: [createdRow] })  // INSERT sector
        .mockResolvedValueOnce({})                      // INSERT audit
        .mockResolvedValueOnce({}),                     // COMMIT
      release: vi.fn(),
    }
    const pool = makePool({ connect: vi.fn().mockResolvedValue(clientMock) })
    const { mountICPSectorsRoutes } = await import('../../../src/server-routes/icpSectors.js')
    const app = fakeApp()
    mountICPSectorsRoutes(app, { pool, capture500, safeError })

    const handler = getHandler(app, 'POST', '/api/icp-sectors')
    const req = {
      body: { code: 'machinery', name: 'Strojírenství', kind: 'target', nace_prefixes: ['28'], weight: 10 },
      query: {}, params: {}, headers: {},
    }
    const res = fakeRes()
    await handler(req, res, () => {})

    expect(res._status).toBe(201)
    expect(res._body.id).toBe(5)
  })

  // T-06: POST rejects missing code → 400
  it('T-06: POST without code returns 400', async () => {
    const pool = makePool()
    const { mountICPSectorsRoutes } = await import('../../../src/server-routes/icpSectors.js')
    const app = fakeApp()
    mountICPSectorsRoutes(app, { pool, capture500, safeError })

    const handler = getHandler(app, 'POST', '/api/icp-sectors')
    const req = { body: { name: 'Test', kind: 'target' }, query: {}, params: {}, headers: {} }
    const res = fakeRes()
    await handler(req, res, () => {})

    expect(res._status).toBe(400)
    expect(res._body.error).toMatch(/code/)
  })

  // T-07: POST rejects invalid kind → 400
  it('T-07: POST with invalid kind returns 400', async () => {
    const pool = makePool()
    const { mountICPSectorsRoutes } = await import('../../../src/server-routes/icpSectors.js')
    const app = fakeApp()
    mountICPSectorsRoutes(app, { pool, capture500, safeError })

    const handler = getHandler(app, 'POST', '/api/icp-sectors')
    const req = { body: { code: 'foo', name: 'Foo', kind: 'bad_kind' }, query: {}, params: {}, headers: {} }
    const res = fakeRes()
    await handler(req, res, () => {})

    expect(res._status).toBe(400)
    expect(res._body.error).toMatch(/kind/)
  })

  // T-08: POST duplicate code+kind → 409
  it('T-08: POST duplicate code+kind returns 409', async () => {
    const uniqueErr = Object.assign(new Error('unique violation'), { code: '23505' })
    const clientMock = {
      query: vi.fn()
        .mockResolvedValueOnce({})            // BEGIN
        .mockRejectedValueOnce(uniqueErr)     // INSERT throws unique violation
        .mockResolvedValueOnce({}),           // ROLLBACK
      release: vi.fn(),
    }
    const pool = makePool({ connect: vi.fn().mockResolvedValue(clientMock) })
    const { mountICPSectorsRoutes } = await import('../../../src/server-routes/icpSectors.js')
    const app = fakeApp()
    mountICPSectorsRoutes(app, { pool, capture500, safeError })

    const handler = getHandler(app, 'POST', '/api/icp-sectors')
    const req = {
      body: { code: 'machinery', name: 'Strojírenství', kind: 'target' },
      query: {}, params: {}, headers: {},
    }
    const res = fakeRes()
    await handler(req, res, () => {})

    expect(res._status).toBe(409)
    expect(res._body.error).toMatch(/already exists/)
  })

  // T-09: PATCH updates fields + writes audit log
  it('T-09: PATCH /api/icp-sectors/:id writes audit log', async () => {
    const clientMock = {
      query: vi.fn()
        .mockResolvedValueOnce({})                          // BEGIN
        .mockResolvedValueOnce({ rows: [SAMPLE_ROW] })     // UPDATE
        .mockResolvedValueOnce({})                         // INSERT audit
        .mockResolvedValueOnce({}),                        // COMMIT
      release: vi.fn(),
    }
    const pool = makePool({ connect: vi.fn().mockResolvedValue(clientMock) })
    const { mountICPSectorsRoutes } = await import('../../../src/server-routes/icpSectors.js')
    const app = fakeApp()
    mountICPSectorsRoutes(app, { pool, capture500, safeError })

    const handler = getHandler(app, 'PATCH', '/api/icp-sectors/:id')
    const req = { params: { id: '1' }, body: { weight: 5 }, query: {}, headers: { 'x-actor': 'tester' } }
    const res = fakeRes()
    await handler(req, res, () => {})

    expect(res._status).toBe(200)
    const auditCall = clientMock.query.mock.calls[2]
    expect(auditCall[0]).toMatch(/INSERT INTO operator_audit_log/)
    expect(auditCall[1][0]).toBe('icp_sector_update')
    expect(auditCall[1][1]).toBe('tester')
  })

  // T-10: PATCH returns 404 for unknown id
  it('T-10: PATCH unknown id returns 404', async () => {
    const clientMock = {
      query: vi.fn()
        .mockResolvedValueOnce({})             // BEGIN
        .mockResolvedValueOnce({ rows: [] })   // UPDATE returns no rows
        .mockResolvedValueOnce({}),            // ROLLBACK
      release: vi.fn(),
    }
    const pool = makePool({ connect: vi.fn().mockResolvedValue(clientMock) })
    const { mountICPSectorsRoutes } = await import('../../../src/server-routes/icpSectors.js')
    const app = fakeApp()
    mountICPSectorsRoutes(app, { pool, capture500, safeError })

    const handler = getHandler(app, 'PATCH', '/api/icp-sectors/:id')
    const req = { params: { id: '9999' }, body: { weight: 5 }, query: {}, headers: {} }
    const res = fakeRes()
    await handler(req, res, () => {})

    expect(res._status).toBe(404)
  })

  // T-11: DELETE soft-deletes (active=false) + audit log
  it('T-11: DELETE /api/icp-sectors/:id sets active=false + writes audit log', async () => {
    const deletedRow = { ...SAMPLE_ROW, active: false }
    const clientMock = {
      query: vi.fn()
        .mockResolvedValueOnce({})                          // BEGIN
        .mockResolvedValueOnce({ rows: [deletedRow] })     // UPDATE active=false
        .mockResolvedValueOnce({})                         // INSERT audit
        .mockResolvedValueOnce({}),                        // COMMIT
      release: vi.fn(),
    }
    const pool = makePool({ connect: vi.fn().mockResolvedValue(clientMock) })
    const { mountICPSectorsRoutes } = await import('../../../src/server-routes/icpSectors.js')
    const app = fakeApp()
    mountICPSectorsRoutes(app, { pool, capture500, safeError })

    const handler = getHandler(app, 'DELETE', '/api/icp-sectors/:id')
    const req = { params: { id: '1' }, body: {}, query: {}, headers: {} }
    const res = fakeRes()
    await handler(req, res, () => {})

    expect(res._status).toBe(200)
    expect(res._body.deleted).toBe(true)
    expect(res._body.active).toBe(false)

    const auditCall = clientMock.query.mock.calls[2]
    expect(auditCall[1][0]).toBe('icp_sector_delete')
  })

  // T-12: DELETE returns 404 for unknown id
  it('T-12: DELETE unknown id returns 404', async () => {
    const clientMock = {
      query: vi.fn()
        .mockResolvedValueOnce({})             // BEGIN
        .mockResolvedValueOnce({ rows: [] })   // UPDATE returns no rows
        .mockResolvedValueOnce({}),            // ROLLBACK
      release: vi.fn(),
    }
    const pool = makePool({ connect: vi.fn().mockResolvedValue(clientMock) })
    const { mountICPSectorsRoutes } = await import('../../../src/server-routes/icpSectors.js')
    const app = fakeApp()
    mountICPSectorsRoutes(app, { pool, capture500, safeError })

    const handler = getHandler(app, 'DELETE', '/api/icp-sectors/:id')
    const req = { params: { id: '9999' }, body: {}, query: {}, headers: {} }
    const res = fakeRes()
    await handler(req, res, () => {})

    expect(res._status).toBe(404)
  })
})
