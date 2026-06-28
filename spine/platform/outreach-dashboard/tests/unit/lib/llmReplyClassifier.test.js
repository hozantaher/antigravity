// LLM reply classifier — confidence-weighted semantic classification.
// Tests cover: provider success, fallback paths, validation, prompt shape.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { semanticClassifyReply, VALID_LABELS } from '../../../src/lib/llmReplyClassifier.js'

let originalFetch
beforeEach(() => {
  originalFetch = globalThis.fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.LLM_PROVIDER
  delete process.env.LLM_ENDPOINT
  delete process.env.LLM_MODEL
})

function mockOllama(jsonResponse, opts = {}) {
  globalThis.fetch = vi.fn(async (url, init) => {
    if (opts.networkError) throw new Error('ECONNREFUSED')
    if (opts.timeout) {
      // Simulate hang — the AbortController in classifier will fire
      await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    if (opts.status && opts.status !== 200) {
      return new Response('upstream error', { status: opts.status })
    }
    return new Response(JSON.stringify({
      response: typeof jsonResponse === 'string' ? jsonResponse : JSON.stringify(jsonResponse),
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

describe('semanticClassifyReply — happy paths', () => {
  it('LLM returns positive with high confidence → use LLM result', async () => {
    mockOllama({ label: 'positive', confidence: 0.92, alternatives: [{ label: 'question', confidence: 0.05 }] })
    const r = await semanticClassifyReply('Mám zájem, zavolejte mi', 'Re: stroje')
    expect(r.label).toBe('positive')
    expect(r.confidence).toBe(0.92)
    expect(r.source).toBe('llm')
    expect(r.alternatives).toHaveLength(1)
    expect(r.alternatives[0].label).toBe('question')
    expect(r.provider).toBe('ollama')
  })

  it('LLM returns negative with high confidence', async () => {
    mockOllama({ label: 'negative', confidence: 0.98, alternatives: [] })
    const r = await semanticClassifyReply('Nezájem, prosím odhlásit')
    expect(r.label).toBe('negative')
    expect(r.confidence).toBe(0.98)
    expect(r.source).toBe('llm')
  })

  it('caps alternatives at TOP_N (3)', async () => {
    mockOllama({
      label: 'positive', confidence: 0.7,
      alternatives: [
        { label: 'question', confidence: 0.5 },
        { label: 'unknown', confidence: 0.3 },
        { label: 'auto_reply', confidence: 0.2 },
        { label: 'negative', confidence: 0.1 },  // 4th — should be dropped
      ],
    })
    const r = await semanticClassifyReply('zajímavé, kolik to bude stát?')
    expect(r.alternatives).toHaveLength(3)
  })

  it('filters invalid labels in alternatives', async () => {
    mockOllama({
      label: 'positive', confidence: 0.8,
      alternatives: [
        { label: 'question', confidence: 0.4 },
        { label: 'INVALID_HALLUCINATION', confidence: 0.3 },  // dropped
        { label: 'unknown', confidence: 0.2 },
      ],
    })
    const r = await semanticClassifyReply('test')
    expect(r.alternatives.map(a => a.label)).toEqual(['question', 'unknown'])
  })

  it('logs latencyMs + provider + model for accountability', async () => {
    mockOllama({ label: 'positive', confidence: 0.9, alternatives: [] })
    const r = await semanticClassifyReply('Mám zájem')
    expect(typeof r.latencyMs).toBe('number')
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
    expect(r.provider).toBe('ollama')
    expect(r.model).toBeTruthy()
  })
})

describe('semanticClassifyReply — confidence floor', () => {
  it('LLM low confidence → fallback to regex but keeps LLM hint', async () => {
    mockOllama({ label: 'positive', confidence: 0.3, alternatives: [] })
    const r = await semanticClassifyReply('Mám zájem zavolejte')  // regex catches "zájem" → interested
    expect(r.source).toBe('regex')
    expect(r.fallback_reason).toBe('llm_low_confidence')
    expect(r.llm_label).toBe('positive')
    expect(r.llm_confidence).toBe(0.3)
    // Regex result for "zájem" → 'interested' but our VALID_LABELS uses
    // 'positive' — note there's a vocabulary drift between the two
    // classifiers. This is documented for future alignment.
    expect(['interested', 'positive', 'unknown']).toContain(r.label)
  })

  it('LLM exactly at floor (0.6) → use LLM (>= floor passes)', async () => {
    mockOllama({ label: 'positive', confidence: 0.6, alternatives: [] })
    const r = await semanticClassifyReply('test')
    expect(r.source).toBe('llm')
  })
})

describe('semanticClassifyReply — fallback paths', () => {
  it('LLM_PROVIDER=disabled → regex fallback', async () => {
    process.env.LLM_PROVIDER = 'disabled'
    const r = await semanticClassifyReply('Nezájem')
    expect(r.source).toBe('regex')
    expect(r.fallback_reason).toBe('env_disabled')
    expect(r.label).toBe('negative')  // regex catches "nezájem"
  })

  it('Ollama unreachable → regex fallback', async () => {
    mockOllama(null, { networkError: true })
    const r = await semanticClassifyReply('out of office until June')
    expect(r.source).toBe('regex')
    expect(r.fallback_reason).toMatch(/llm_error/)
    expect(r.label).toBe('ooo')
  })

  it('Ollama 500 → regex fallback', async () => {
    mockOllama(null, { status: 500 })
    const r = await semanticClassifyReply('test')
    expect(r.source).toBe('regex')
  })

  it('LLM returns invalid label → regex fallback', async () => {
    mockOllama({ label: 'INVALID_NEW_CATEGORY', confidence: 0.9, alternatives: [] })
    const r = await semanticClassifyReply('Mám zájem')
    expect(r.source).toBe('regex')
    expect(r.fallback_reason).toBe('llm_invalid_label')
  })

  it('LLM returns malformed JSON → regex fallback', async () => {
    mockOllama('not valid json at all', {})
    const r = await semanticClassifyReply('test')
    expect(r.source).toBe('regex')
    expect(r.fallback_reason).toMatch(/llm_no_parsed|llm_invalid_label|llm_error/)
  })

  it('empty body → unknown without LLM call', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy
    const r = await semanticClassifyReply('')
    expect(r.label).toBe('unknown')
    expect(r.source).toBe('regex')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('semanticClassifyReply — JSON parsing edge cases', () => {
  it('parses JSON wrapped in ```json fences', async () => {
    mockOllama('```json\n{"label":"positive","confidence":0.85,"alternatives":[]}\n```')
    const r = await semanticClassifyReply('test')
    expect(r.source).toBe('llm')
    expect(r.label).toBe('positive')
  })

  it('extracts first {...} block when LLM prepends text', async () => {
    mockOllama('Sure, here is the analysis: {"label":"negative","confidence":0.9,"alternatives":[]}')
    const r = await semanticClassifyReply('test')
    expect(r.source).toBe('llm')
    expect(r.label).toBe('negative')
  })
})

describe('semanticClassifyReply — VALID_LABELS export', () => {
  it('exports authoritative label set', () => {
    expect(VALID_LABELS).toContain('positive')
    expect(VALID_LABELS).toContain('negative')
    expect(VALID_LABELS).toContain('auto_reply')
    expect(VALID_LABELS).toContain('question')
    expect(VALID_LABELS).toContain('unknown')
  })

  // Cíl: src/lib/llmReplyClassifier.js:36-42 SL — pokud StringLiteral
  // mutace shodí jeden ze štítků na '', VALID_LABELS přijde o platnou
  // hodnotu a celá whitelist přestane plnit svoji roli (LLM hallucinations
  // nebudou validovány proti správné množině). Tento explicit length-check
  // killne SL mutaci v jakémkoli z 5 řetězcových literálů.
  it('mutant-kill: VALID_LABELS má přesně 5 unikátních neprázdných hodnot', () => {
    expect(VALID_LABELS).toHaveLength(5)
    expect(new Set(VALID_LABELS).size).toBe(5)
    for (const lbl of VALID_LABELS) {
      expect(typeof lbl).toBe('string')
      expect(lbl.length).toBeGreaterThan(0)
    }
  })
})

// ───────────────────────────────────────────────────────────────────
// Stryker mutant-killer tests (KT-B9 — survivor rescue 2026-04-30)
// ───────────────────────────────────────────────────────────────────
//
// Cílí přesně na surviving mutants identifikované Strykerem v baselinu
// 65.71% pro llmReplyClassifier.js. Každý test má v komentáři, který
// mutant zabíjí + proč by jiný test nestačil.

describe('mutant-killer: semanticClassifyReply guard rails', () => {
  // Cíl: src/lib/llmReplyClassifier.js:87 CE
  //     `if (!body || typeof body !== 'string')` → `if (false) { ... }`
  // Existující test `empty body → unknown without LLM call` posílá ''
  // (falsy string). Když mutace aktivní, '' projde dál → fetch by se
  // zavolal nebo by spadlo. Test ověřuje fetchSpy not called → killne
  // CE 87. Pro úplnost ale musíme ověřit, že non-string vstupy taky
  // bezpečně vrací unknown (jinak `typeof body !== 'string'` část se
  // neotestuje).
  it('M-LLM-1: non-string body (number) → unknown bez fetch volání', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy
    const r = await semanticClassifyReply(42)
    expect(r.label).toBe('unknown')
    expect(r.source).toBe('regex')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('M-LLM-2: null body → unknown bez fetch volání', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy
    const r = await semanticClassifyReply(null)
    expect(r.label).toBe('unknown')
    expect(r.source).toBe('regex')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('M-LLM-3: empty body → confidence === 0 (chrání mutaci `confidence: 0` na řádku 88)', async () => {
    const r = await semanticClassifyReply('')
    expect(r.confidence).toBe(0)
    expect(r.alternatives).toEqual([])
  })
})

describe('mutant-killer: result/result.parsed null guards', () => {
  // Cíl: src/lib/llmReplyClassifier.js:99 CE+LO
  //     `if (!result || !result.parsed)` → `if (!result && !result.parsed)`
  //     LO mutace `||` → `&&`: pokud result je truthy a parsed je null,
  //     pak `!truthy && !null` = false && true = false → if neproběhne →
  //     destructuring `result.parsed` na řádku 102 → TypeError „Cannot
  //     destructure null". Existující testy posílají buď validní parsed,
  //     nebo úplně chybný JSON (kde safeParseJSON vrací null → result.parsed
  //     je null → mutace by spadla). Takže `LLM returns malformed JSON`
  //     by měl killnut LO 99 — ALE: "malformed JSON" stále vrací result
  //     objekt, takže `!result` je false. Pak `!result.parsed` je true →
  //     orig: false || true = true → fallback. Mutant: false && true =
  //     false → destructure null.parsed → TypeError → catch → fallback.
  //     Stejný výsledek navenek (regex fallback)! Equivalent na finálním
  //     `source: 'regex'`. Klíč: musíme ověřit, že fallback_reason je
  //     'llm_no_parsed' (orig path) ne 'llm_error' (catch path).
  it('M-LLM-4: malformed JSON → fallback_reason je llm_no_parsed nebo llm_invalid_label, NE llm_error', async () => {
    mockOllama('totally not json {[}]', {})
    const r = await semanticClassifyReply('test body')
    expect(r.source).toBe('regex')
    // Pokud LO mutace v 99 aktivní, padá do catch → 'llm_error: ...'.
    // Originál: parsed=null → llm_no_parsed.
    expect(r.fallback_reason).not.toMatch(/llm_error/)
  })
})

describe('mutant-killer: confidence type validation', () => {
  // Cíl: src/lib/llmReplyClassifier.js:103 CE
  //     `if (!VALID_LABELS.includes(label) || typeof confidence !== 'number')`
  //     → `if (!VALID_LABELS.includes(label) || false)`
  //     Mutant pak akceptuje string confidence („0.9") jako platnou →
  //     vrátí source: 'llm' s confidence === string. Existující testy
  //     vždy posílají numeric confidence.
  it('M-LLM-5: LLM vrací valid label ale string confidence → fallback (llm_invalid_label)', async () => {
    mockOllama({ label: 'positive', confidence: '0.9', alternatives: [] })
    const r = await semanticClassifyReply('Mám zájem')
    expect(r.source).toBe('regex')
    expect(r.fallback_reason).toBe('llm_invalid_label')
  })

  it('M-LLM-6: LLM vrací valid label ale boolean confidence → fallback', async () => {
    mockOllama({ label: 'positive', confidence: true, alternatives: [] })
    const r = await semanticClassifyReply('test')
    expect(r.source).toBe('regex')
    expect(r.fallback_reason).toBe('llm_invalid_label')
  })

  // Cíl: src/lib/llmReplyClassifier.js:118 CE
  //     `.filter(a => VALID_LABELS.includes(a?.label) && typeof a?.confidence === 'number')`
  //     → `&& true`
  //     Mutant pak nechá projít i alternativy bez numeric confidence,
  //     např. {label: 'question', confidence: 'high'}. Existující test
  //     `filters invalid labels in alternatives` filtruje invalid LABEL
  //     ne invalid CONFIDENCE typ — proto mutace přežila.
  it('M-LLM-7: alternativa s string confidence je odfiltrována (CE 118)', async () => {
    mockOllama({
      label: 'positive',
      confidence: 0.9,
      alternatives: [
        { label: 'question', confidence: 0.5 },
        { label: 'unknown', confidence: 'high' }, // string confidence — DROP
      ],
    })
    const r = await semanticClassifyReply('test')
    expect(r.source).toBe('llm')
    expect(r.alternatives).toHaveLength(1)
    expect(r.alternatives[0].label).toBe('question')
  })

  it('M-LLM-8: alternativa s missing confidence je odfiltrována', async () => {
    mockOllama({
      label: 'positive',
      confidence: 0.9,
      alternatives: [
        { label: 'question' }, // confidence chybí
        { label: 'unknown', confidence: 0.2 },
      ],
    })
    const r = await semanticClassifyReply('test')
    expect(r.source).toBe('llm')
    expect(r.alternatives).toHaveLength(1)
    expect(r.alternatives[0].label).toBe('unknown')
  })
})

describe('mutant-killer: provider routing + endpoint defaults', () => {
  // Cíl: src/lib/llmReplyClassifier.js:143 CE
  //     `if (provider === 'ollama') return classifyViaOllama(...)`
  //     → `if (true) return classifyViaOllama(...)`
  //     Mutant by routoval i unsupported providery do Ollama (místo
  //     hození 'unsupported provider' → catch → fallback). Existující
  //     testy nikdy neposílají neznámý provider.
  it('M-LLM-9: unsupported provider → fallback s reason "llm_error"', async () => {
    // Žádný fetch mock — kdyby mutace propadla do classifyViaOllama,
    // hodilo by skutečné fetch hovor (ECONNREFUSED na localhost:11434).
    // V originále se hodí synchronně z classifyViaLLM → catch.
    globalThis.fetch = vi.fn(() => {
      throw new Error('should-not-be-called')
    })
    const r = await semanticClassifyReply('test', '', { provider: 'anthropic-not-yet' })
    expect(r.source).toBe('regex')
    expect(r.fallback_reason).toMatch(/llm_error/)
    expect(r.fallback_reason).toMatch(/unsupported provider/)
  })

  // Cíl: src/lib/llmReplyClassifier.js:149 CE+LO+SL
  //     `const endpoint = opts.endpoint || process.env.LLM_ENDPOINT || 'http://localhost:11434'`
  //     SL '' → ''. Mutant: endpoint = '' když nikdo nedefinuje. Pak
  //     fetch se zavolá s URL `/api/generate` (relativní) → v node fetch
  //     hodí. V originále má default 'http://localhost:11434'.
  //     Existující testy mockují fetch naivně bez kontroly URL.
  it('M-LLM-10: default endpoint je http://localhost:11434 (testuje URL pased to fetch)', async () => {
    let calledUrl = null
    globalThis.fetch = vi.fn(async (url) => {
      calledUrl = url
      return new Response(
        JSON.stringify({ response: JSON.stringify({ label: 'positive', confidence: 0.9, alternatives: [] }) }),
        { status: 200 },
      )
    })
    delete process.env.LLM_ENDPOINT
    await semanticClassifyReply('test')
    expect(calledUrl).toBe('http://localhost:11434/api/generate')
  })

  // Cíl: src/lib/llmReplyClassifier.js:158 SL
  //     fetch URL has '/api/generate'. Mutace by změnila na '' nebo
  //     "Stryker was here!" → fetch volání by jelo na špatný path.
  //     Existující testy nemají URL assertion.
  it('M-LLM-11: fetch URL končí na /api/generate (chrání SL 158)', async () => {
    let calledUrl = null
    globalThis.fetch = vi.fn(async (url) => {
      calledUrl = url
      return new Response(
        JSON.stringify({ response: JSON.stringify({ label: 'positive', confidence: 0.9, alternatives: [] }) }),
        { status: 200 },
      )
    })
    process.env.LLM_ENDPOINT = 'http://example.test'
    await semanticClassifyReply('test')
    expect(calledUrl).toBe('http://example.test/api/generate')
  })

  // Cíl: src/lib/llmReplyClassifier.js:159-165 SL + BL
  //     method: 'POST', headers content-type, stream: false, format: 'json'
  //     Mutace by je shodila na '' nebo invertovala stream → pak by
  //     Ollama ne-stream odpověděla 200 ale data.response by bylo nesmysl.
  //     Existující testy nezkoumají init body.
  it('M-LLM-12: fetch init má method=POST, stream=false, format=json (chrání SL 159, BL 164, SL 165)', async () => {
    let capturedInit = null
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedInit = init
      return new Response(
        JSON.stringify({ response: JSON.stringify({ label: 'positive', confidence: 0.9, alternatives: [] }) }),
        { status: 200 },
      )
    })
    await semanticClassifyReply('test')
    expect(capturedInit).not.toBeNull()
    expect(capturedInit.method).toBe('POST')
    expect(capturedInit.headers['Content-Type']).toBe('application/json')
    const parsedBody = JSON.parse(capturedInit.body)
    expect(parsedBody.stream).toBe(false)
    expect(parsedBody.format).toBe('json')
  })
})

describe('mutant-killer: latencyMs + safeParseJSON', () => {
  // Cíl: src/lib/llmReplyClassifier.js:181 AO
  //     `latencyMs: Date.now() - start` → `Date.now() + start`
  //     Mutant: latencyMs by byl součet dvou velkých čísel
  //     (~3.5 × 10^12 ms) ne malé delta. Existující test ověřuje
  //     `>= 0` ale ne reasonable horní hranici.
  it('M-LLM-13: latencyMs je rozumně malé (zabíjí AO 181: + místo -)', async () => {
    mockOllama({ label: 'positive', confidence: 0.9, alternatives: [] })
    const r = await semanticClassifyReply('test')
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
    // Test trvá < 1 hodina; součet dvou Date.now() ~ 2 × 10^12, pravdivý
    // delta ~ jednotky ms → bezpečná horní hranice 60s.
    expect(r.latencyMs).toBeLessThan(60_000)
  })

  // Cíl: src/lib/llmReplyClassifier.js:189 CE
  //     `if (!s) return null` → `if (false) return null`
  //     safeParseJSON je interní; testujeme přes empty Ollama response.
  //     Mutant nezachytí early-return na empty string → propadne na
  //     `cleaned.replace(...)` → '' → `JSON.parse('')` → throw → catch →
  //     match by byl null → return null. Stejný výsledek navenek.
  //     Equivalent mutant na úrovni semanticClassifyReply. Vynecháno.

  // Cíl: src/lib/llmReplyClassifier.js:201 CE
  //     `if (match) { try {...} catch { return null } }` → `if (true)`
  //     Pokud match je null (žádné {...}), mutant přejde do try, JSON.parse
  //     na null → throw → catch → return null. Originál: hned return null
  //     (v posledním řádku funkce). Stejný výstup, ale v originále se
  //     nevolá JSON.parse na null. Verifikujeme odlišnost přes vstup, kde
  //     není curly brace AT ALL.
  it('M-LLM-14: response bez curly brace → fallback (chrání CE 201 nepřímo)', async () => {
    mockOllama('absolutely no json whatsoever just plain text')
    const r = await semanticClassifyReply('test')
    expect(r.source).toBe('regex')
  })

  // Cíl: src/lib/llmReplyClassifier.js:170 CE
  //     `if (!res.ok) { throw ... }` → `if (false) {}`
  //     Mutant: 500 response by neházel, pokračoval na res.json() → spadl
  //     by tam, ale s jinou error message. Existující test ověřuje
  //     source: 'regex' na 500 → killne CE 170 protože jiný path má
  //     jiný fallback_reason. Doplníme assertion.
  it('M-LLM-15: 500 response → fallback_reason obsahuje "ollama 500"', async () => {
    mockOllama(null, { status: 500 })
    const r = await semanticClassifyReply('test')
    expect(r.source).toBe('regex')
    expect(r.fallback_reason).toMatch(/ollama 500/)
  })
})
