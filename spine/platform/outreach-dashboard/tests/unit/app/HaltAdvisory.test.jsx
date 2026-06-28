/**
 * HaltAdvisory — bounce-rate safety pill (#1004 [S1.3]).
 *   1. Renders the status label + rate once the advisory loads.
 *   2. Maps status → label (ok / warn_pause / hard_stop).
 *   3. Renders nothing on fetch failure (card stays usable).
 */

import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HaltAdvisory from '../../../src/app/pages/HaltAdvisory'

afterEach(() => { vi.restoreAllMocks() })

const advisory = (over = {}) => ({
  status: 'ok', bounce_rate_pct: 1.45, thresholds: { bounce_pause_pct: 5 }, recommendation: 'ok', ...over,
})

it('renders the status label + rate when the advisory loads', async () => {
  vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => advisory() })
  render(<HaltAdvisory campaignId={457} />)
  await waitFor(() => expect(screen.getByTestId('app-halt-status')).toHaveTextContent('Bezpečné'))
  expect(screen.getByTestId('app-halt-advisory')).toHaveTextContent('bounce 1.45%')
})

it('maps hard_stop → "Zastavit!"', async () => {
  vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => advisory({ status: 'hard_stop', bounce_rate_pct: 12 }) })
  render(<HaltAdvisory campaignId={1} />)
  await waitFor(() => expect(screen.getByTestId('app-halt-status')).toHaveTextContent('Zastavit!'))
})

it('omits the rate span instead of rendering "bounce undefined%" (#1586 R2)', async () => {
  vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => advisory({ bounce_rate_pct: null, thresholds: undefined }) })
  render(<HaltAdvisory campaignId={1} />)
  await waitFor(() => expect(screen.getByTestId('app-halt-status')).toBeInTheDocument())
  expect(screen.getByTestId('app-halt-advisory')).not.toHaveTextContent('undefined')
  expect(screen.getByTestId('app-halt-advisory')).not.toHaveTextContent('bounce')
})

it('renders nothing on fetch failure', async () => {
  vi.spyOn(global, 'fetch').mockRejectedValue(new Error('boom'))
  const { container } = render(<HaltAdvisory campaignId={1} />)
  await new Promise((r) => setTimeout(r, 20))
  expect(container.firstChild).toBeNull()
})
