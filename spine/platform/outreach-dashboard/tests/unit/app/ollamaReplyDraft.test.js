/**
 * ollamaReplyDraft — RELATIVE (Ollama) reply-draft assist.
 * Spustit: cd features/platform/outreach-dashboard && pnpm test tests/unit/ollamaReplyDraft
 *
 * Pins the contract: graceful null on every failure path (so the endpoint
 * surfaces a calm message, never throws) + a bounded, JSON-free generate
 * request. The draft is operator-confirm only — these tests guard that the lib
 * never invents content and degrades cleanly when Ollama is down.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const OLLAMA_URL = 'http://ollama.test'

async function freshImport() {
  vi.resetModules()
  return import('../../../src/lib/ollamaReplyDraft.js')
}

beforeEach(() => { process.env.OLLAMA_URL = OLLAMA_URL })
afterEach(() => { vi.restoreAllMocks(); delete process.env.OLLAMA_URL })

function mockOllama(responseText) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ response: responseText }) })))
}

describe('draftReply', () => {
  it('returns null (→ graceful UI message) when OLLAMA_URL is unset', async () => {
    delete process.env.OLLAMA_URL
    const { draftReply } = await freshImport()
    expect(await draftReply('Máte zájem o můj bagr?')).toBeNull()
  })

  it('returns null for empty body without calling the network', async () => {
    const { draftReply } = await freshImport()
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    expect(await draftReply('   ')).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it('sends a bounded generate request (model, keep_alive, num_predict, temp)', async () => {
    mockOllama('Dobrý den, …')
    const { draftReply } = await freshImport()
    await draftReply('Prodám bagr', 'Re: Poptávka')
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe(`${OLLAMA_URL}/api/generate`)
    const body = JSON.parse(opts.body)
    expect(body.model).toBeTruthy()
    expect(body.stream).toBe(false)
    expect(body.keep_alive).toBeTruthy()
    expect(body.options.num_predict).toBeGreaterThan(0)
    expect(body.options.temperature).toBeGreaterThanOrEqual(0)
    expect(body.prompt).toContain('Prodám bagr')   // customer text included
    expect(body.prompt).toContain('Re: Poptávka')  // subject included
  })

  it('returns { draft, model } on success (trimmed)', async () => {
    mockOllama('  Dobrý den, děkuji za zprávu.  ')
    const { draftReply, DRAFT_VERSION } = await freshImport()
    const r = await draftReply('text')
    expect(r.draft).toBe('Dobrý den, děkuji za zprávu.'.replace('zprávu', 'zprávu')) // trimmed
    expect(r.model).toBeTruthy()
    expect(DRAFT_VERSION).toBe('ollama_v1')
  })

  it('returns null when the model returns an empty completion', async () => {
    mockOllama('   ')
    const { draftReply } = await freshImport()
    expect(await draftReply('text')).toBeNull()
  })

  it('returns null on HTTP error (→ graceful fallback, never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    const { draftReply } = await freshImport()
    expect(await draftReply('text')).toBeNull()
  })

  it('returns null on network throw (never propagates)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    const { draftReply } = await freshImport()
    expect(await draftReply('text')).toBeNull()
  })
})
