/**
 * SavePhoneButton — operator-confirmed phone save (#1581 M2.2).
 *   1. Renders nothing without a contactId (orphan replies).
 *   2. PATCHes the contact and shows a confirmation on success.
 *   3. Shows a retry affordance on failure.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import SavePhoneButton from '../../../src/app/pages/SavePhoneButton'

afterEach(() => { vi.restoreAllMocks() })

describe('SavePhoneButton', () => {
  it('renders nothing without a contactId', () => {
    const { container } = render(<SavePhoneButton tel="+420602207393" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing without a tel', () => {
    const { container } = render(<SavePhoneButton contactId={7} />)
    expect(container.firstChild).toBeNull()
  })

  it('PATCHes the contact and confirms on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    render(<SavePhoneButton contactId={316836} tel="+420602207393" />)
    fireEvent.click(screen.getByTestId('app-savephone'))
    await waitFor(() => expect(screen.getByTestId('app-savephone-done')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith('/api/contacts/316836', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ phone: '+420602207393' }),
    }))
  })

  it('shows a retry affordance on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    render(<SavePhoneButton contactId={7} tel="+420602207393" />)
    fireEvent.click(screen.getByTestId('app-savephone'))
    await waitFor(() => expect(screen.getByTestId('app-savephone')).toHaveTextContent(/znovu/))
  })
})
