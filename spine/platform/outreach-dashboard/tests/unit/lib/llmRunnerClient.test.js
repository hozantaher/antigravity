/**
 * AV-F4 — llmRunnerClient unit tests.
 *
 * Validates fail-open semantics + JSON-instruct parsing for the Ollama
 * wrapper client. Covers:
 *   - LLM_RUNNER_URL unset → ok=false, no fetch issued
 *   - non-2xx response → ok=false with status
 *   - non-JSON body → ok=false
 *   - timeout/abort → ok=false reason='timeout'
 *   - success → typed shape returned
 *   - parseClassifyJson — raw / fenced / bad / missing all handled
 *   - callLlmRunnerClassify — happy path + bad LLM output fallback
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

const ORIG_FETCH = global.fetch
const ORIG_ENV = { ...process.env }

async function freshImport() {
  // Reset modules between tests so LLM_RUNNER_TIMEOUT_MS env reads fresh
  vi.resetModules()
  return await import('../../../src/lib/llmRunnerClient.js')
}

beforeEach(() => {
  process.env.LLM_RUNNER_URL = 'http://llm-runner.test'
  delete process.env.LLM_API_KEY
  delete process.env.LLM_RUNNER_TIMEOUT_MS
})

afterEach(() => {
  global.fetch = ORIG_FETCH
  process.env = { ...ORIG_ENV }
})

describe('callLlmRunnerGenerate — fail-open', () => {
  it('returns ok=false when LLM_RUNNER_URL is unset (no fetch)', async () => {
    delete process.env.LLM_RUNNER_URL
    const mod = await freshImport()
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy
    const r = await mod.callLlmRunnerGenerate({ prompt: 'x' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not configured/i)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns ok=false with status when llm-runner returns 500', async () => {
    const mod = await freshImport()
    global.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    const r = await mod.callLlmRunnerGenerate({ prompt: 'x' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('500')
  })

  it('returns ok=false when body is not JSON', async () => {
    const mod = await freshImport()
    global.fetch = vi.fn().mockResolvedValue(new Response('not-json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const r = await mod.callLlmRunnerGenerate({ prompt: 'x' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/non-JSON/i)
  })

  it('returns ok=false reason=timeout when fetch aborts', async () => {
    process.env.LLM_RUNNER_TIMEOUT_MS = '20'
    const mod = await freshImport()
    global.fetch = vi.fn((url, opts) => new Promise((_resolve, reject) => {
      // listen for the abort signal so we mimic real fetch behavior
      opts?.signal?.addEventListener?.('abort', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    }))
    const r = await mod.callLlmRunnerGenerate({ prompt: 'x' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('timeout')
  })

  it('returns typed success shape on 2xx + JSON body', async () => {
    const mod = await freshImport()
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      draft: 'hello',
      tokens_used: 42,
      model: 'llama3.2:3b',
      confidence: 0.8,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const r = await mod.callLlmRunnerGenerate({ prompt: 'x' })
    expect(r.ok).toBe(true)
    expect(r.draft).toBe('hello')
    expect(r.tokens_used).toBe(42)
    expect(r.model).toBe('llama3.2:3b')
    expect(r.confidence).toBe(0.8)
  })

  it('attaches X-LLM-Api-Key header when LLM_API_KEY is set', async () => {
    process.env.LLM_API_KEY = 'sekret'
    const mod = await freshImport()
    let captured = null
    global.fetch = vi.fn((url, opts) => {
      captured = opts
      return Promise.resolve(new Response(JSON.stringify({ draft: '' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    })
    await mod.callLlmRunnerGenerate({ prompt: 'x' })
    expect(captured?.headers?.['X-LLM-Api-Key']).toBe('sekret')
  })
})

describe('parseClassifyJson', () => {
  it('parses a raw JSON object', async () => {
    const { parseClassifyJson } = await freshImport()
    const r = parseClassifyJson('{"classification":"positive","confidence":0.9,"rationale":"r"}')
    expect(r).toEqual({ classification: 'positive', confidence: 0.9, rationale: 'r' })
  })

  it('parses a JSON object wrapped in ```json fences', async () => {
    const { parseClassifyJson } = await freshImport()
    const draft = '```json\n{"classification":"negative","confidence":0.7,"rationale":"x"}\n```'
    const r = parseClassifyJson(draft)
    expect(r?.classification).toBe('negative')
  })

  it('returns null when no object found', async () => {
    const { parseClassifyJson } = await freshImport()
    expect(parseClassifyJson('no json here')).toBeNull()
    expect(parseClassifyJson('')).toBeNull()
    expect(parseClassifyJson(null)).toBeNull()
  })

  it('normalizes invalid classifications to null', async () => {
    const { parseClassifyJson } = await freshImport()
    const r = parseClassifyJson('{"classification":"banana","confidence":0.9,"rationale":""}')
    expect(r?.classification).toBeNull()
  })

  it('clamps confidence into [0, 1]', async () => {
    const { parseClassifyJson } = await freshImport()
    expect(parseClassifyJson('{"classification":"positive","confidence":1.5,"rationale":""}')?.confidence).toBe(1)
    expect(parseClassifyJson('{"classification":"positive","confidence":-0.5,"rationale":""}')?.confidence).toBe(0)
  })

  it('treats "null" string and "unknown" as null classification', async () => {
    const { parseClassifyJson } = await freshImport()
    expect(parseClassifyJson('{"classification":"null","confidence":0.5,"rationale":""}')?.classification).toBeNull()
    expect(parseClassifyJson('{"classification":"unknown","confidence":0.5,"rationale":""}')?.classification).toBeNull()
  })
})

describe('callLlmRunnerClassify', () => {
  it('returns parsed verdict on happy path', async () => {
    const mod = await freshImport()
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      draft: '{"classification":"positive","confidence":0.91,"rationale":"prodává bagr"}',
      model: 'llama3.2:3b',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const r = await mod.callLlmRunnerClassify({ prompt: 'hello' })
    expect(r.ok).toBe(true)
    expect(r.classification).toBe('positive')
    expect(r.confidence).toBe(0.91)
    expect(r.rationale).toBe('prodává bagr')
  })

  it('returns ok=false when draft has no JSON', async () => {
    const mod = await freshImport()
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      draft: 'I think it is positive maybe',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const r = await mod.callLlmRunnerClassify({ prompt: 'hello' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/JSON/i)
  })

  it('rejects missing prompt', async () => {
    const mod = await freshImport()
    const r = await mod.callLlmRunnerClassify({})
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/prompt required/i)
  })
})
