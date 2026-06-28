/**
 * ClassificationControl — confidence display + manual override (#1020).
 *
 * Surfaces the automatic classifier's confidence and lets the operator correct
 * the label via the existing PATCH /api/replies/:id/classify (which records a
 * classifier_overrides row + audit). Coverage:
 *   1. Renders an AI-confidence badge bucketed from pre_classification.
 *   2. Falls back to "Bez AI skóre" when there's no pre_classification.
 *   3. Renders nothing for unmatched replies (negative id — no classification).
 *   4. Clicking a label PATCHes {classification} + calls onReclassified.
 *   5. The current classification's button is disabled (no-op re-classify).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ClassificationControl from '../../../src/app/pages/ClassificationControl'

afterEach(() => { vi.restoreAllMocks() })

const matched = (over = {}) => ({
  id: 36,
  classification: null,
  pre_classification: { confidence: 0.3, classifier_version: 'regex_v1' },
  ...over,
})

describe('ClassificationControl', () => {
  it('renders an AI-confidence badge from pre_classification', () => {
    render(<ClassificationControl reply={matched()} />)
    expect(screen.getByTestId('app-classify-conf')).toHaveTextContent('AI důvěra 30%')
  })

  it('falls back to "Bez AI skóre" when pre_classification is absent', () => {
    render(<ClassificationControl reply={matched({ pre_classification: null })} />)
    expect(screen.getByTestId('app-classify-conf')).toHaveTextContent('Bez AI skóre')
  })

  it('renders nothing for an unmatched reply (negative id)', () => {
    const { container } = render(<ClassificationControl reply={matched({ id: -12 })} />)
    expect(container.firstChild).toBeNull()
  })

  it('clicking a label PATCHes the override + calls onReclassified', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    const onReclassified = vi.fn()
    render(<ClassificationControl reply={matched()} onReclassified={onReclassified} />)
    fireEvent.click(screen.getByTestId('app-classify-opt-positive'))
    await waitFor(() => expect(onReclassified).toHaveBeenCalledTimes(1))
    const [url, opts] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/replies/36/classify')
    expect(opts.method).toBe('PATCH')
    expect(JSON.parse(opts.body)).toEqual({ classification: 'positive' })
  })

  it('disables the button for the current classification (no redundant re-classify)', () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    render(<ClassificationControl reply={matched({ classification: 'positive' })} />)
    const active = screen.getByTestId('app-classify-opt-positive')
    expect(active).toBeDisabled()
    fireEvent.click(active)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
