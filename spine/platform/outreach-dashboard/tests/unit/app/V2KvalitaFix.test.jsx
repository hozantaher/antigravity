/**
 * Kvalita FixButton — the úkolovník's one-click deterministic fix. The
 * reply_mime_subject task exposes a "Opravit" button that POSTs the fix endpoint
 * and refreshes on success. useResource mocked so we render the board directly.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/hooks/useResource', () => ({ useResource: vi.fn() }))
import { useResource } from '../../../src/hooks/useResource'
import Kvalita from '../../../src/app/pages/Kvalita'

const refresh = vi.fn().mockResolvedValue()

function mockBoard(checks) {
  useResource.mockImplementation((url) => {
    if (typeof url === 'string' && url.includes('/api/data-quality')) {
      return { status: 'ok', data: { checks, errors: 0, warnings: 0, checked_at: new Date().toISOString() }, refresh }
    }
    return { status: 'ok', data: {}, refresh: vi.fn() } // stats
  })
}

afterEach(() => { vi.restoreAllMocks(); refresh.mockClear() })

describe('Kvalita one-click fix', () => {
  it('shows a fix button on the reply_mime_subject task and POSTs + refreshes', async () => {
    mockBoard([{ key: 'reply_mime_subject', label: 'MIME', hint: 'h', severity: 'warn', count: 22 }])
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ ok: true, fixed: 22 }) })
    render(<MemoryRouter><Kvalita /></MemoryRouter>)
    fireEvent.click(screen.getByTestId('app-dq-fix'))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(fetchSpy).toHaveBeenCalledWith('/api/data-quality/fix/reply-mime-subject', { method: 'POST' })
  })

  it('surfaces a retry label when the fix fails', async () => {
    mockBoard([{ key: 'reply_mime_subject', label: 'MIME', hint: 'h', severity: 'warn', count: 22 }])
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false })
    render(<MemoryRouter><Kvalita /></MemoryRouter>)
    fireEvent.click(screen.getByTestId('app-dq-fix'))
    await waitFor(() => expect(screen.getByTestId('app-dq-fix')).toHaveTextContent(/Zkus znovu/))
  })

  it('no fix button on a task without a registered fix', () => {
    mockBoard([{ key: 'crm_no_ico', label: 'CRM', hint: 'h', severity: 'info', count: 87 }])
    render(<MemoryRouter><Kvalita /></MemoryRouter>)
    expect(screen.queryByTestId('app-dq-fix')).toBeNull()
  })
})
