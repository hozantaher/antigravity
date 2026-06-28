/**
 * ActionRail — phone-as-hero reading-pane action (#1586 R1).
 *   1. Mined phone → a big click-to-call tel: link is the primary action.
 *   2. No phone → Reply is the hero action.
 *   3. Reply button calls onReply.
 */

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import ActionRail from '../../../src/app/pages/ActionRail'

describe('ActionRail', () => {
  it('makes the mined phone the hero call-to-action (tel: link)', () => {
    render(<ActionRail reply={{ contact_id: 7, mined: { phones: [{ display: '+420 602 207 393', tel: '+420602207393' }] } }} onReply={() => {}} />)
    const call = screen.getByTestId('app-actionrail-call')
    expect(call).toHaveAttribute('href', 'tel:+420602207393')
    expect(call).toHaveTextContent('+420 602 207 393')
  })

  it('falls back to Reply as the hero when there is no phone', () => {
    render(<ActionRail reply={{ mined: { phones: [] } }} onReply={() => {}} />)
    expect(screen.queryByTestId('app-actionrail-call')).toBeNull()
    expect(screen.getByTestId('app-actionrail-reply')).toBeInTheDocument()
  })

  it('Reply button calls onReply', () => {
    const onReply = vi.fn()
    render(<ActionRail reply={{ mined: { phones: [] } }} onReply={onReply} />)
    fireEvent.click(screen.getByTestId('app-actionrail-reply'))
    expect(onReply).toHaveBeenCalled()
  })

  it('renders without crashing when mined is missing', () => {
    render(<ActionRail reply={{}} onReply={() => {}} />)
    expect(screen.getByTestId('app-actionrail')).toBeInTheDocument()
  })
})
