import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mountMailboxRepinRoute } from '../../../src/server-routes/mailboxesRepin'

describe('mailboxesRepin', () => {
  let app, mockPool, mockRes, mockReq

  beforeEach(() => {
    // Mock Express app
    app = {
      post: vi.fn(),
    }

    // Mock pool
    mockPool = {
      connect: vi.fn(),
    }

    // Create real handler
    mountMailboxRepinRoute(app, {
      pool: mockPool,
      setRouteTags: vi.fn(),
      capture500: vi.fn(),
      safeError: (e) => e.message,
    })
  })

  it('P2 FIX: rejects invalid operator ID with 403', async () => {
    const handler = app.post.mock.calls[0][1]
    process.env.ALLOWED_OPERATOR_IDS = 'operator,tomas,messing'

    mockReq = {
      params: { id: '1' },
      headers: { 'x-operator-id': 'invalid_actor' },
      body: {
        new_endpoint_label: 'de4',
        reason: 'server degraded',
      },
    }

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await handler(mockReq, mockRes)

    expect(mockRes.status).toHaveBeenCalledWith(403)
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'invalid_operator',
      id: 'invalid_actor',
    })
  })

  it('P2 FIX: allows valid operator ID', async () => {
    const handler = app.post.mock.calls[0][1]
    process.env.ALLOWED_OPERATOR_IDS = 'operator,tomas,messing'

    const mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    }

    mockPool.connect.mockResolvedValue(mockClient)
    mockClient.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1, from_address: 'test@ex', pinned_endpoint_label: 'cz5' }] }) // SELECT mailbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT audit
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE mailbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // COMMIT

    mockReq = {
      params: { id: '1' },
      headers: { 'x-operator-id': 'tomas' },
      body: {
        new_endpoint_label: 'de4',
        reason: 'server degraded',
      },
    }

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await handler(mockReq, mockRes)

    expect(mockRes.status).not.toHaveBeenCalledWith(403)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        mailbox_id: 1,
        actor: 'tomas',
      })
    )
  })

  it('P2 FIX: defaults to "operator" when header missing', async () => {
    const handler = app.post.mock.calls[0][1]
    process.env.ALLOWED_OPERATOR_IDS = 'operator,tomas,messing'

    const mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    }

    mockPool.connect.mockResolvedValue(mockClient)
    mockClient.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1, from_address: 'test@ex', pinned_endpoint_label: 'cz5' }] }) // SELECT
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // COMMIT

    mockReq = {
      params: { id: '1' },
      headers: {}, // no x-operator-id
      body: {
        new_endpoint_label: 'de4',
        reason: 'server degraded',
      },
    }

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await handler(mockReq, mockRes)

    expect(mockRes.status).not.toHaveBeenCalledWith(403)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'operator',
      })
    )
  })
})
