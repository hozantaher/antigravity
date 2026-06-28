/**
 * IngestFreshness — top-right "kdy se naposledy vyzvedly data" heartbeat.
 * Pure presentation over /api/ingest-freshness; useResource mocked.
 */
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/hooks/useResource', () => ({ useResource: vi.fn() }))
import { useResource } from '../../../src/hooks/useResource'
import IngestFreshness from '../../../src/app/components/IngestFreshness'

const iso = (minAgo) => new Date(Date.now() - minAgo * 60_000).toISOString()
afterEach(() => vi.clearAllMocks())

describe('IngestFreshness', () => {
  it('shows a live heartbeat when mailboxes polled recently', () => {
    useResource.mockReturnValue({ status: 'ok', data: { last_poll_at: iso(1), last_inbound_at: iso(60), mailboxes_polled_recently: 4 } })
    render(<IngestFreshness />)
    const el = screen.getByTestId('app-ingest-freshness')
    expect(el).toHaveTextContent(/Vyzvednuto/)
    expect(el.className).toContain('app-fresh--live')
  })

  it('marks stale when nothing polled in the last window', () => {
    useResource.mockReturnValue({ status: 'ok', data: { last_poll_at: iso(45), last_inbound_at: iso(200), mailboxes_polled_recently: 0 } })
    render(<IngestFreshness />)
    expect(screen.getByTestId('app-ingest-freshness').className).toContain('app-fresh--stale')
  })

  it('shows a quiet loading hint before first load', () => {
    useResource.mockReturnValue({ status: 'loading', data: null })
    render(<IngestFreshness />)
    expect(screen.getByTestId('app-ingest-freshness')).toHaveTextContent(/vyzvedávám/)
  })

  it('renders nothing on error / no data (never a misleading "now")', () => {
    useResource.mockReturnValue({ status: 'error', data: null, error: 'x' })
    const { container } = render(<IngestFreshness />)
    expect(container.firstChild).toBeNull()
  })
})
