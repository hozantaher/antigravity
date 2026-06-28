/**
 * ReplyComposer — unit tests.
 *
 * The composer is OUTWARD-FACING + state-mutating (it dispatches real mail via
 * the outbox→relay path), so it gets boundary + error + integration coverage:
 *   1. Renders the recipient line + send disabled while empty.
 *   2. Typing enables send; send is two-step (confirm gate) — never one-click.
 *   3. Confirm POSTs multipart FormData(body) to /api/replies/:id/reply,
 *      then shows the queued state + calls onSent().
 *   4. "Zpět" cancels the confirm without sending.
 *   5. A failed send surfaces the error inline + keeps the text for retry.
 *   6. "Navrhni (Ollama)" pre-fills the textarea from /draft-reply.
 *   7. Reply templates (#1022): chips render from /api/reply-templates and
 *      seed the textarea (fill when empty, append when not).
 *
 * On mount the composer GETs /api/reply-templates for the picker, so the fetch
 * mock is route-aware: the templates URL gets its own response and every other
 * URL falls through to the per-test handler. This keeps the "Nth call" send
 * assertions stable regardless of the mount fetch.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReplyComposer from '../../../src/app/pages/ReplyComposer'

const REPLY = { id: 97, from_email: 'jan.novak@example.cz', from_name: 'Jan Novák' }

const TEMPLATES = [
  { id: 1, slug: 'interest_ack', label: 'Zájem — domluva prohlídky', body: 'Dobrý den, rádi se podíváme.' },
  { id: 2, slug: 'request_photos', label: 'Žádost o fotky', body: 'Pošlete prosím pár fotek.' },
]

/**
 * Install a route-aware global.fetch. The reply-templates GET always resolves
 * to `templates`; any other request is delegated to `rest` (a vi.fn the test
 * configures), so send/draft assertions ignore the mount fetch entirely.
 */
function mockFetch({ templates = TEMPLATES, rest } = {}) {
  const restFn = rest || vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
  const spy = vi.spyOn(global, 'fetch').mockImplementation((url, ...args) => {
    if (typeof url === 'string' && url.includes('/api/reply-templates')) {
      return Promise.resolve({ ok: true, json: async () => ({ templates }) })
    }
    return restFn(url, ...args)
  })
  return { spy, restFn }
}

function setup(props = {}) {
  const onSent = vi.fn()
  render(<ReplyComposer reply={REPLY} onSent={onSent} {...props} />)
  return { onSent }
}

beforeEach(() => { mockFetch() })
afterEach(() => { vi.restoreAllMocks() })

describe('ReplyComposer', () => {
  it('renders the recipient + send is disabled while empty', () => {
    setup()
    expect(screen.getByTestId('app-compose-to')).toHaveTextContent('jan.novak@example.cz')
    expect(screen.getByTestId('app-compose-send')).toBeDisabled()
  })

  it('returns null without a reply id', () => {
    const { container } = render(<ReplyComposer reply={{}} />)
    expect(container.firstChild).toBeNull()
  })

  it('typing enables send and send is a two-step confirm (never one-click)', () => {
    const { restFn } = mockFetch()
    setup()
    fireEvent.change(screen.getByTestId('app-compose-text'), { target: { value: 'Dobrý den, ozvu se.' } })
    const send = screen.getByTestId('app-compose-send')
    expect(send).toBeEnabled()
    fireEvent.click(send)
    // First click only arms the confirm — no send request yet.
    expect(restFn).not.toHaveBeenCalled()
    expect(screen.getByTestId('app-compose-confirm')).toBeVisible()
  })

  it('confirm POSTs multipart body + shows queued + calls onSent', async () => {
    const rest = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ok: true, outbox_id: 42, note: 'queued' }),
    })
    const { restFn } = mockFetch({ rest })
    const { onSent } = setup()
    fireEvent.change(screen.getByTestId('app-compose-text'), { target: { value: 'Děkuji za nabídku.' } })
    fireEvent.click(screen.getByTestId('app-compose-send'))
    fireEvent.click(screen.getByTestId('app-compose-confirm'))
    await waitFor(() => expect(screen.getByTestId('app-compose-done')).toBeVisible())
    expect(onSent).toHaveBeenCalledTimes(1)
    const [url, opts] = restFn.mock.calls[0]
    expect(url).toBe('/api/replies/97/reply')
    expect(opts.method).toBe('POST')
    expect(opts.body).toBeInstanceOf(FormData)
    expect(opts.body.get('body')).toBe('Děkuji za nabídku.')
  })

  it('"Zpět" cancels the confirm without sending', () => {
    const { restFn } = mockFetch()
    setup()
    fireEvent.change(screen.getByTestId('app-compose-text'), { target: { value: 'Test' } })
    fireEvent.click(screen.getByTestId('app-compose-send'))
    fireEvent.click(screen.getByTestId('app-compose-cancel'))
    expect(restFn).not.toHaveBeenCalled()
    expect(screen.getByTestId('app-compose-send')).toBeVisible()
  })

  it('failed send surfaces the error inline + keeps the text for retry', async () => {
    mockFetch({ rest: vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'relay down' }) }) })
    setup()
    fireEvent.change(screen.getByTestId('app-compose-text'), { target: { value: 'Ahoj' } })
    fireEvent.click(screen.getByTestId('app-compose-send'))
    fireEvent.click(screen.getByTestId('app-compose-confirm'))
    await waitFor(() => expect(screen.getByTestId('app-compose-msg')).toHaveTextContent(/selhalo/))
    // Text preserved so the operator can retry.
    expect(screen.getByTestId('app-compose-text')).toHaveValue('Ahoj')
  })

  it('"Navrhni (Ollama)" pre-fills the textarea from /draft-reply', async () => {
    mockFetch({ rest: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ draft: 'Dobrý den, děkujeme za Vaši zprávu…' }) }) })
    setup()
    fireEvent.click(screen.getByTestId('app-compose-draft'))
    await waitFor(() =>
      expect(screen.getByTestId('app-compose-text')).toHaveValue('Dobrý den, děkujeme za Vaši zprávu…'))
  })

  it('renders template chips from /api/reply-templates (#1022)', async () => {
    setup()
    await waitFor(() => expect(screen.getByTestId('app-compose-template-interest_ack')).toBeVisible())
    expect(screen.getByTestId('app-compose-template-request_photos')).toHaveTextContent('Žádost o fotky')
  })

  it('clicking a template fills an empty textarea', async () => {
    setup()
    const chip = await screen.findByTestId('app-compose-template-interest_ack')
    fireEvent.click(chip)
    expect(screen.getByTestId('app-compose-text')).toHaveValue('Dobrý den, rádi se podíváme.')
  })

  it('clicking a template appends below existing draft (never destroys it)', async () => {
    setup()
    fireEvent.change(screen.getByTestId('app-compose-text'), { target: { value: 'Můj text.' } })
    const chip = await screen.findByTestId('app-compose-template-request_photos')
    fireEvent.click(chip)
    expect(screen.getByTestId('app-compose-text')).toHaveValue('Můj text.\n\nPošlete prosím pár fotek.')
  })
})
