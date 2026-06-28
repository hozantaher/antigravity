/**
 * MinedSignals — mined signals strip (#1578 M1.1, #1586 R1).
 * Phone moved to ActionRail (R1), so MinedSignals now shows price / intent /
 * location only, and renders nothing when none of those are present.
 */

import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import MinedSignals from '../../../src/app/pages/MinedSignals'

describe('MinedSignals', () => {
  it('renders a formatted CZK price', () => {
    render(<MinedSignals mined={{ phones: [], prices: [{ amount: 1250000, currency: 'CZK', raw: '1 250 000 Kč' }] }} />)
    expect(screen.getByTestId('app-mined-price')).toHaveTextContent('Kč')
  })

  it('renders callback / urgency / location flags', () => {
    render(<MinedSignals mined={{ phones: [], prices: [], callback: true, urgent: true, locations: ['Brno'] }} />)
    expect(screen.getByTestId('app-mined-callback')).toBeInTheDocument()
    expect(screen.getByTestId('app-mined-urgent')).toBeInTheDocument()
    expect(screen.getByTestId('app-mined-location')).toHaveTextContent('Brno')
  })

  it('does NOT render the phone (it moved to the ActionRail)', () => {
    render(<MinedSignals mined={{ phones: [{ display: '+420 602 207 393', tel: '+420602207393' }], prices: [] }} />)
    expect(screen.queryByTestId('app-mined-phone')).toBeNull()
  })

  it('renders nothing when only a phone is mined (phone is in the rail)', () => {
    const { container } = render(<MinedSignals mined={{ phones: [{ display: 'x', tel: '+420602207393' }], prices: [] }} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when nothing is mined / undefined', () => {
    const { container: a } = render(<MinedSignals mined={{ phones: [], prices: [] }} />)
    expect(a.firstChild).toBeNull()
    const { container: b } = render(<MinedSignals mined={undefined} />)
    expect(b.firstChild).toBeNull()
  })
})
