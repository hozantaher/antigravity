/**
 * llmReplyClassifier.js — LLM-based semantic reply classification.
 *
 * Replaces brittle regex keyword matching with relative-scoring semantic
 * classification. Returns confidence-weighted top-N alternatives instead
 * of single binary label.
 *
 * Architecture:
 *   - Provider abstraction (Ollama default, configurable via LLM_PROVIDER env)
 *   - Strict label whitelist (LLM hallucinations validated against fixed set)
 *   - Falls back to regex classifier on LLM unavailable / timeout
 *   - Confidence threshold (default 0.6) below which we trust regex more
 *   - Audit-friendly: returns full provider response for ops debugging
 *
 * Provider contract:
 *   classify(prompt: string, opts?: { timeout?: number }) → Promise<{
 *     raw: string                                 // raw LLM output
 *     parsed: { label: string, confidence: number, alternatives: [...] }
 *     provider: 'ollama' | 'openai' | 'anthropic'
 *     model: string
 *     latencyMs: number
 *   }>
 *
 * AI Act considerations:
 *   - Art. 50 transparency: each classification is a categorization decision
 *     on personal data (reply body), NOT automated decision-making per Art. 22
 *     (no consequence on data subject's legal position)
 *   - Provider model + version logged for accountability (Art. 30 ROPA)
 *   - Fallback to deterministic regex preserves explainability when LLM fails
 */

import { classifyReplyBody } from './replyClassifier.js'

// Authoritative label set. LLM output validated against this — anything
// else is treated as 'unknown' and the alternative scores are surfaced.
export const VALID_LABELS = [
  'positive',    // explicit interest, asks for more info, wants to sell
  'negative',    // not interested, opt-out, hostile
  'auto_reply',  // OOO, vacation, autoresponder
  'question',    // asks something, neutral but engaged
  'unknown',     // unclassifiable / no clear signal
]

const LLM_TIMEOUT_MS = 5000
const CONFIDENCE_FLOOR = 0.6
const TOP_N_ALTERNATIVES = 3

const PROMPT_TEMPLATE = (subject, body) => `Klasifikuj následující emailovou odpověď podle kontextu B2B outreach kampaně.

Možné kategorie (vyber JEDNU primary + až 2 alternativy s confidence):
- positive: explicitní zájem, žádost o další info, chce prodat
- negative: nemá zájem, opt-out, nechce kontakt
- auto_reply: out-of-office, dovolená, automatická odpověď
- question: ptá se na něco, neutrální ale engaged
- unknown: nelze zařadit / nejasné

Vrať POUZE JSON v tomto formátu (žádný komentář, žádný markdown):
{"label":"<primary>","confidence":0.0-1.0,"alternatives":[{"label":"<other>","confidence":0.0-1.0}]}

Email subject: ${subject || '(none)'}
Email body:
${body}
`

/**
 * semanticClassifyReply — top-level entry. Tries LLM, falls back to regex.
 *
 * @param {string} body
 * @param {string} [subject='']
 * @param {object} [opts]
 * @param {string} [opts.provider]  'ollama' | 'disabled' (default from env)
 * @param {string} [opts.endpoint]  override provider URL
 * @param {string} [opts.model]
 * @param {number} [opts.timeout]
 * @returns {Promise<{
 *   label: string,
 *   confidence: number,
 *   alternatives: Array<{label: string, confidence: number}>,
 *   source: 'llm'|'regex',
 *   provider?: string,
 *   model?: string,
 *   latencyMs?: number,
 *   raw?: string
 * }>}
 */
export async function semanticClassifyReply(body, subject = '', opts = {}) {
  if (!body || typeof body !== 'string') {
    return { label: 'unknown', confidence: 0, alternatives: [], source: 'regex' }
  }

  const provider = opts.provider || process.env.LLM_PROVIDER || 'ollama'

  if (provider === 'disabled') {
    return regexFallback(body, 'env_disabled')
  }

  try {
    const result = await classifyViaLLM(body, subject, { ...opts, provider })
    if (!result || !result.parsed) {
      return regexFallback(body, 'llm_no_parsed')
    }
    const { label, confidence, alternatives } = result.parsed
    if (!VALID_LABELS.includes(label) || typeof confidence !== 'number') {
      return regexFallback(body, 'llm_invalid_label')
    }
    if (confidence < CONFIDENCE_FLOOR) {
      // Low LLM confidence — defer to regex which is at least
      // deterministic. Audit both decisions for the operator.
      const reg = regexFallback(body, 'llm_low_confidence')
      reg.llm_label = label
      reg.llm_confidence = confidence
      return reg
    }
    return {
      label,
      confidence,
      alternatives: (alternatives || [])
        .filter(a => VALID_LABELS.includes(a?.label) && typeof a?.confidence === 'number')
        .slice(0, TOP_N_ALTERNATIVES),
      source: 'llm',
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      raw: result.raw,
    }
  } catch (e) {
    return regexFallback(body, `llm_error: ${e.message}`)
  }
}

function regexFallback(body, reason) {
  return {
    label: classifyReplyBody(body),
    confidence: 1.0,           // regex is deterministic; report as "certain"
    alternatives: [],
    source: 'regex',
    fallback_reason: reason,
  }
}

async function classifyViaLLM(body, subject, opts) {
  const provider = opts.provider
  if (provider === 'ollama') return classifyViaOllama(body, subject, opts)
  // Future providers: openai, anthropic. Throw so fallback engages.
  throw new Error(`unsupported provider: ${provider}`)
}

async function classifyViaOllama(body, subject, opts) {
  const endpoint = opts.endpoint || process.env.LLM_ENDPOINT || 'http://localhost:11434'
  const model = opts.model || process.env.LLM_MODEL || 'llama3.2:1b'
  const timeout = opts.timeout || LLM_TIMEOUT_MS
  const prompt = PROMPT_TEMPLATE(subject, body)

  const start = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.0, num_predict: 200 },
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const data = await res.json()
    const raw = String(data.response || '').trim()
    const parsed = safeParseJSON(raw)
    return {
      raw,
      parsed,
      provider: 'ollama',
      model,
      latencyMs: Date.now() - start,
    }
  } finally {
    clearTimeout(timer)
  }
}

function safeParseJSON(s) {
  if (!s) return null
  // Ollama with format=json should return clean JSON, but some models
  // wrap in ```json fences or prepend text. Strip common wrappers.
  const cleaned = s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    // Last-ditch: extract first {...} block
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (match) {
      try { return JSON.parse(match[0]) } catch { return null }
    }
    return null
  }
}
