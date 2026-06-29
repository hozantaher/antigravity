import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../setup/server'

type Any = Record<string, unknown>
const g = globalThis as Any

// The middleware reads the request host and (when redirecting) emits a 301. The shared server setup
// installs getRequestURL but not these two h3 helpers, so we stub them against the mock event here.
const getRequestHost = vi.fn<(...args: unknown[]) => string | undefined>()
const sendRedirect = vi.fn((_event: unknown, location: string, code: number) => ({ location, code }))

beforeEach(() => {
  getRequestHost.mockReset()
  sendRedirect.mockClear()
  g.getRequestHost = getRequestHost
  g.sendRedirect = sendRedirect
})

const importHandler = async () => (await import('~/server/middleware/canonical-host')).default

describe('canonical-host middleware', () => {
  it('does nothing when host is undefined', async () => {
    getRequestHost.mockReturnValue(undefined)
    const handler = await importHandler()
    const result = handler(makeEvent() as never)
    expect(result).toBeUndefined()
    expect(sendRedirect).not.toHaveBeenCalled()
  })

  it('does nothing when host is not a www host', async () => {
    getRequestHost.mockReturnValue('auction24.cz')
    const handler = await importHandler()
    const result = handler(makeEvent() as never)
    expect(result).toBeUndefined()
    expect(sendRedirect).not.toHaveBeenCalled()
  })

  it('301-redirects a www host to the apex preserving pathname and search', async () => {
    getRequestHost.mockReturnValue('www.auction24.cz')
    const handler = await importHandler()
    handler(makeEvent({ url: 'https://www.auction24.cz/auctions?page=2' }) as never)
    expect(sendRedirect).toHaveBeenCalledWith(expect.anything(), 'https://auction24.cz/auctions?page=2', 301)
  })

  it('redirects a bare www root with empty search', async () => {
    getRequestHost.mockReturnValue('www.auction24.cz')
    const handler = await importHandler()
    handler(makeEvent({ url: 'https://www.auction24.cz/' }) as never)
    expect(sendRedirect).toHaveBeenCalledWith(expect.anything(), 'https://auction24.cz/', 301)
  })
})
