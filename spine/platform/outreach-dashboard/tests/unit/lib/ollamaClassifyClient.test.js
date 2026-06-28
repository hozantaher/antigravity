import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { callLlmRunnerClassify } from '../../../src/lib/ollamaClassifyClient.js'

const OLLAMA = 'https://ollama-test.example'
const gen = (obj) => vi.fn(async () => ({ ok: true, json: async () => ({ response: JSON.stringify(obj) }) }))

describe('ollamaClassifyClient.callLlmRunnerClassify', () => {
  beforeEach(() => { process.env.OLLAMA_URL = OLLAMA })
  afterEach(() => { delete process.env.OLLAMA_URL; vi.restoreAllMocks() })

  it('returns ok:false when OLLAMA_URL is unset', async () => {
    delete process.env.OLLAMA_URL
    expect((await callLlmRunnerClassify({ prompt: 'x' })).ok).toBe(false)
  })

  it('maps a valid classification verdict', async () => {
    vi.stubGlobal('fetch', gen({ classification: 'positive', confidence: 0.95, rationale: 'Nabízí bagr.' }))
    const r = await callLlmRunnerClassify({ prompt: 'p' })
    expect(r).toMatchObject({ ok: true, classification: 'positive', confidence: 0.95, rationale: 'Nabízí bagr.' })
  })

  it('sends keep_alive + num_predict so the Railway model stays warm', async () => {
    const spy = gen({ classification: 'positive', confidence: 0.9 })
    vi.stubGlobal('fetch', spy)
    await callLlmRunnerClassify({ prompt: 'p' })
    const body = JSON.parse(spy.mock.calls[0][1].body)
    expect(body.keep_alive).toBe('10m')                 // model resident between calls
    expect(body.options.num_predict).toBe(200)          // bounded JSON output
  })

  it('rejects unknown labels → null classification', async () => {
    vi.stubGlobal('fetch', gen({ classification: 'banana', confidence: 0.9 }))
    expect((await callLlmRunnerClassify({ prompt: 'p' })).classification).toBeNull()
  })

  it('clamps out-of-range confidence', async () => {
    vi.stubGlobal('fetch', gen({ classification: 'negative', confidence: 5 }))
    expect((await callLlmRunnerClassify({ prompt: 'p' })).confidence).toBe(1)
  })

  it('ok:false on unparseable JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ response: 'not json' }) })))
    expect((await callLlmRunnerClassify({ prompt: 'p' })).ok).toBe(false)
  })

  it('ok:false on non-ok HTTP / throw (→ regex fallback, never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502 })))
    expect((await callLlmRunnerClassify({ prompt: 'p' })).ok).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net') }))
    expect((await callLlmRunnerClassify({ prompt: 'p' })).ok).toBe(false)
  })
})
