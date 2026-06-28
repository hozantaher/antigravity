/**
 * ChatThread — unit tests, focused on the manual_reply rendering added when
 * the composer landed. The operator's own reply must appear as an outgoing
 * bubble with a delivery-state footer (pending → sent → error) so they know
 * whether it actually went out via the relay worker.
 *
 * useResource is mocked so we drive the message list directly — no network.
 */

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/hooks/useResource', () => ({
  useResource: vi.fn(),
}))
import { useResource } from '../../../src/hooks/useResource'
import ChatThread from '../../../src/app/pages/ChatThread'

function withMessages(messages) {
  useResource.mockReturnValue({ status: 'ok', data: { messages }, error: null, refresh: vi.fn() })
}

afterEach(() => { vi.clearAllMocks() })

describe('ChatThread manual_reply rendering', () => {
  it('renders a pending manual reply as an outgoing bubble with "odesílá se"', () => {
    withMessages([{ id: 'manual-1', type: 'manual_reply', sender: 'Vy', body: 'Díky, ozvu se.', status: 'pending', sent_at: '2026-06-01T10:00:00Z' }])
    render(<ChatThread replyId={97} />)
    expect(screen.getByTestId('app-msg-ours')).toHaveTextContent('Díky, ozvu se.')
    expect(screen.getByTestId('app-msg-status')).toHaveTextContent(/odesílá se/)
  })

  it('shows "✓ odesláno" once the worker dispatched it', () => {
    withMessages([{ id: 'manual-2', type: 'manual_reply', sender: 'Vy', body: 'Hotovo.', status: 'sent', sent_at: '2026-06-01T10:05:00Z' }])
    render(<ChatThread replyId={97} />)
    expect(screen.getByTestId('app-msg-status')).toHaveTextContent(/odesláno/)
  })

  it('shows the failure state on error', () => {
    withMessages([{ id: 'manual-3', type: 'manual_reply', sender: 'Vy', body: 'X', status: 'error', error: 'relay down', sent_at: '2026-06-01T10:06:00Z' }])
    render(<ChatThread replyId={97} />)
    expect(screen.getByTestId('app-msg-status')).toHaveTextContent(/nepodařilo se odeslat/)
  })

  it('keeps inbound replies on the customer (theirs) side without a status', () => {
    withMessages([{ id: 'reply-1', type: 'incoming', sender: 'jan@firma.cz', subject: 'Dotaz', body_text: 'Máte zájem?', received_at: '2026-06-01T09:00:00Z' }])
    render(<ChatThread replyId={97} />)
    expect(screen.getByTestId('app-msg-theirs')).toHaveTextContent('Máte zájem?')
    expect(screen.queryByTestId('app-msg-status')).toBeNull()
  })

  // #1586 R1 — the reading pane was dominated by the quoted-back original
  // ("> Od: … > Datum: 24.0") instead of what the person actually wrote.
  it('strips the quoted-back original, showing only the human reply', () => {
    withMessages([{
      id: 'reply-2', type: 'incoming', sender: 'tomas@centrum.cz',
      body_text: 'Dobrý den, omlouvám se ale máte nejspíše špatnou adresu.\n\n> Od: "Hozan Taher" <h@post.cz>\n> Komu: tomas@centrum.cz\n> Datum: 24.0',
      received_at: '2026-06-01T09:00:00Z',
    }])
    render(<ChatThread replyId={97} />)
    const bubble = screen.getByTestId('app-msg-theirs')
    expect(bubble).toHaveTextContent('Dobrý den, omlouvám se ale máte nejspíše špatnou adresu')
    expect(bubble).not.toHaveTextContent('> Od:')
    expect(bubble).not.toHaveTextContent('Datum: 24.0')
  })
})
