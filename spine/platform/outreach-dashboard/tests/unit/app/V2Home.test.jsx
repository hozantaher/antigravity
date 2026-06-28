/**
 * Home — the Přehled hot-lead escalation. The Odpovědi card must escalate as
 * the oldest unhandled "zájem" reply ages (prod 2026-06-01: oldest ~18 days):
 *   - > HOT_NAG_DAYS (2)  → a gentle aging note
 *   - >= HOT_STALE_DAYS (7) → the card goes "urgent" + the note reads "stydne"
 *   - no hot leads        → no note, no escalation
 * and it deep-links into the triage lane (?mode=hot), not the generic inbox.
 *
 * useResource is mocked per-URL so we drive the stats payload directly.
 */

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/hooks/useResource', () => ({ useResource: vi.fn() }))
import { useResource } from '../../../src/hooks/useResource'
import Home from '../../../src/app/pages/Home'

const daysAgoIso = (d) => new Date(Date.now() - d * 86_400_000).toISOString()

function mockStats(stats) {
  useResource.mockImplementation((url) => {
    if (typeof url === 'string' && url.includes('/api/replies/stats')) {
      return { status: 'ok', data: stats, error: null, refresh: vi.fn() }
    }
    // vehicles + campaigns — benign empty.
    return { status: 'ok', data: { rows: [], total: 0 }, error: null, refresh: vi.fn() }
  })
}

function renderHome() {
  return render(<MemoryRouter><Home /></MemoryRouter>)
}

afterEach(() => { vi.clearAllMocks() })

describe('Home hot-lead escalation', () => {
  it('escalates the card + shows "stydne" when the oldest hot lead is stale (>=7d)', () => {
    mockStats({ nezpracovane: 71, hot_unhandled: 45, dotazy: 6, oldest_hot_unhandled_at: daysAgoIso(18) })
    const { container } = renderHome()
    expect(container.querySelector('.app-home-card--urgent')).toBeTruthy()
    expect(screen.getByTestId('app-home-oldest-hot')).toHaveTextContent(/stydne/)
    // deep-links into the triage lane
    expect(screen.getByTestId('app-home-card-Odpovědi').getAttribute('href')).toContain('mode=hot')
    // chip reflects the waiting backlog, not total positive
    expect(screen.getByText(/45 zájem čeká/)).toBeTruthy()
  })

  it('nags but does not escalate when a hot lead has waited a few days (>2, <7)', () => {
    mockStats({ nezpracovane: 10, hot_unhandled: 3, dotazy: 1, oldest_hot_unhandled_at: daysAgoIso(4) })
    const { container } = renderHome()
    expect(container.querySelector('.app-home-card--urgent')).toBeNull()
    expect(screen.getByTestId('app-home-oldest-hot')).toHaveTextContent(/čeká 4 dny/)
  })

  it('shows no aging note + no escalation when there are no waiting hot leads', () => {
    mockStats({ nezpracovane: 5, hot_unhandled: 0, dotazy: 0, oldest_hot_unhandled_at: null })
    const { container } = renderHome()
    expect(container.querySelector('.app-home-card--urgent')).toBeNull()
    expect(screen.queryByTestId('app-home-oldest-hot')).toBeNull()
  })
})
