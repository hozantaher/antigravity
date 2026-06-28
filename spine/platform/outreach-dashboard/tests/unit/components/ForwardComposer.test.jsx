import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import ForwardComposer from '../../../src/app/components/odpovedi/ForwardComposer.jsx'

const reply = {
  id: 391,
  from_email: 'lead@firma.cz',
  subject: 'Dotaz na bagr',
  body_text: 'Mám zájem o ten bagr, kolik stojí?',
  attachments_meta: [{ filename: 'foto.jpg', size_bytes: 1234, content_type: 'image/jpeg' }],
}

describe('ForwardComposer', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, outbox_id: 5001, recipient_domain: 'bagry.cz' }) }))
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('renders nothing when closed', () => {
    render(<ForwardComposer reply={reply} open={false} onClose={() => {}} />)
    expect(screen.queryByTestId('app-forward-email-dialog')).toBeNull()
  })

  it('renders the dialog, the quoted original, and the include-attachments toggle', () => {
    render(<ForwardComposer reply={reply} open onClose={() => {}} />)
    expect(screen.getByTestId('app-forward-email-dialog')).toBeInTheDocument()
    expect(screen.getByText('Přeposlat e-mail')).toBeInTheDocument()
    expect(screen.getByTestId('app-forward-email-quote')).toHaveTextContent('Mám zájem o ten bagr')
    expect(screen.getByTestId('app-forward-email-include')).toHaveTextContent('Připojit původní přílohy (1)')
  })

  it('blocks send on an invalid email and surfaces the error', async () => {
    const user = userEvent.setup()
    render(<ForwardComposer reply={reply} open onClose={() => {}} />)
    await user.type(screen.getByTestId('app-forward-email-to'), 'notanemail')
    expect(screen.getByTestId('app-forward-email-err')).toBeInTheDocument()
    expect(screen.getByTestId('app-forward-email-send')).toBeDisabled()
  })

  it('sends through POST /forward with the recipient after a two-step confirm', async () => {
    const onSent = vi.fn()
    const user = userEvent.setup()
    render(<ForwardComposer reply={reply} open onClose={() => {}} onSent={onSent} />)

    await user.type(screen.getByTestId('app-forward-email-to'), 'dealer@bagry.cz')
    await user.click(screen.getByTestId('app-forward-email-send'))     // → confirm step
    await user.click(screen.getByTestId('app-forward-email-confirm'))  // → actual send

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('/api/replies/391/forward')
    expect(opts.method).toBe('POST')
    expect(opts.body.get('to')).toBe('dealer@bagry.cz')
    expect(opts.body.get('include_original')).toBe('true')
    expect(onSent).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId('app-forward-email-done')).toBeInTheDocument()
  })

  it('hides the attachment toggle when the reply has no attachments', () => {
    render(<ForwardComposer reply={{ ...reply, attachments_meta: [] }} open onClose={() => {}} />)
    expect(screen.queryByTestId('app-forward-email-include')).toBeNull()
  })
})
