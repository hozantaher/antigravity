/**
 * llmRunnerClient.js — AV-F4 (2026-05-19)
 * ─────────────────────────────────────────────────────────────────────────
 * Self-hosted Ollama wrapper client. Talks ONLY to `services/llm-runner`
 * (Go binary, single endpoint surface — `/v1/generate` + `/v1/classify` +
 * `/v1/parse-photo`). The wrapper enforces ADR-006 §D4 contract: structured
 * JSON only, never streaming.
 *
 * Fail-open semantics — EVERY caller can rely on `{ ok: false, reason }`
 * when llm-runner is not configured / unreachable / 4xx-5xx / parse error /
 * timeout. NEVER throws. Callers fall back to regex/heuristic paths.
 *
 * Extracted from `apps/outreach-dashboard/server.js` (AV-F4 refactor) so
 * the reply classifier + reply draft generator share the same fetch wiring.
 *
 * Memory rules:
 *   feedback_no_external_services      — Ollama (self-hosted) only.
 *   feedback_external_io_backoff  T0   — single attempt + 8s timeout; the
 *     classifier layer above this DOES retry-and-fall-back to regex, so
 *     this layer stays simple + deterministic. No retry-on-5xx here on
 *     purpose (cold-start spike protection is the caller's job).
 *   feedback_no_magic_thresholds  T0   — all timeouts / lengths exported
 *     as named constants.
 */

/**
 * Timeout for one llm-runner request. Reads from env at module-load time —
 * tests override via `LLM_RUNNER_TIMEOUT_MS`. 8 s is the upper bound below
 * which the BFF HTTP response stays under operator SLA of 10 s.
 */
export const LLM_RUNNER_TIMEOUT_MS = Number(process.env.LLM_RUNNER_TIMEOUT_MS || 8000)

/**
 * Default model alias the BFF requests when caller does not specify. Match
 * `DEFAULT_TEXT_MODEL` in `services/llm-runner/cmd/llm-runner/main.go`.
 */
export const DEFAULT_TEXT_MODEL = process.env.LLM_RUNNER_DEFAULT_MODEL || 'llama3.2:3b'

function llmRunnerBaseUrl() {
  return process.env.LLM_RUNNER_URL || null
}

function llmRunnerHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  if (process.env.LLM_API_KEY) {
    headers['X-LLM-Api-Key'] = process.env.LLM_API_KEY
  }
  return headers
}

/**
 * Low-level POST. Internal helper — callers should use the typed wrappers
 * (`callLlmRunnerGenerate`, `callLlmRunnerClassify`) so the response shape
 * stays uniform.
 *
 * @param {string} path  — `/v1/generate` | `/v1/classify`
 * @param {object} payload
 * @returns {Promise<{ ok: true, data: object } | { ok: false, reason: string, status?: number }>}
 */
async function postJson(path, payload) {
  const baseUrl = llmRunnerBaseUrl()
  if (!baseUrl) {
    return { ok: false, reason: 'LLM_RUNNER_URL not configured' }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), LLM_RUNNER_TIMEOUT_MS)
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: llmRunnerHeaders(),
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    if (!r.ok) {
      return { ok: false, reason: `llm-runner status ${r.status}`, status: r.status }
    }
    const data = await r.json().catch(() => null)
    if (!data || typeof data !== 'object') {
      return { ok: false, reason: 'llm-runner returned non-JSON body' }
    }
    return { ok: true, data }
  } catch (e) {
    return { ok: false, reason: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'unknown') }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Generate a free-form completion via `/v1/generate`. Returns the same
 * shape that was previously inlined in server.js so existing consumers
 * (reply-draft pipeline) keep working unchanged.
 *
 * @param {object} payload
 * @returns {Promise<{ ok: true, draft: string, tokens_used: number|null, model: string|null, confidence: number|null } | { ok: false, reason: string }>}
 */
export async function callLlmRunnerGenerate(payload) {
  const res = await postJson('/v1/generate', payload)
  if (!res.ok) return res
  const data = res.data
  return {
    ok: true,
    draft: typeof data.draft === 'string' ? data.draft : '',
    tokens_used: Number.isFinite(data.tokens_used) ? Number(data.tokens_used) : null,
    model: data.model || null,
    confidence: Number.isFinite(data.confidence) ? Number(data.confidence) : null,
  }
}

/**
 * Reply-classifier wrapper. The llm-runner `/v1/classify` endpoint uses
 * a fixed vocabulary `{interested|meeting|later|objection|negative|ooo}`
 * (per ADR-006 §D2) that DOES NOT match the AV-F2 reply-classifier
 * vocabulary `{positive|negative|question|auto_reply|bounce|unsubscribe}`.
 *
 * So AV-F4 chooses path B: post to `/v1/generate` with a structured
 * JSON-instruct prompt and parse `{ classification, confidence, rationale }`
 * out of `data.draft`. Falls back to the same fail-open shape as
 * `callLlmRunnerGenerate`.
 *
 * The prompt is built by the caller (see `llmReplyClassifierPrompt.js`).
 *
 * @param {{ prompt: string, model?: string, max_tokens?: number }} payload
 * @returns {Promise<{ ok: true, classification: string|null, confidence: number, rationale: string, model: string|null, raw: string } | { ok: false, reason: string }>}
 */
export async function callLlmRunnerClassify({ prompt, model, max_tokens }) {
  if (!prompt || typeof prompt !== 'string') {
    return { ok: false, reason: 'prompt required' }
  }
  const res = await callLlmRunnerGenerate({
    model: model || DEFAULT_TEXT_MODEL,
    prompt,
    max_tokens: Number.isFinite(max_tokens) ? max_tokens : 200,
    // Keep response shape JSON-only — Ollama doesn't gate on this but the
    // structured-prompt expects no markdown wrapping; the parser below is
    // permissive enough to handle ```json fences anyway.
    response_format: 'json',
  })
  if (!res.ok) return res

  const parsed = parseClassifyJson(res.draft)
  if (!parsed) {
    return { ok: false, reason: 'llm draft did not contain JSON object', raw: res.draft }
  }
  return {
    ok: true,
    classification: parsed.classification,
    confidence: parsed.confidence,
    rationale: parsed.rationale,
    model: res.model,
    raw: res.draft,
  }
}

/**
 * Lenient parser for the JSON-instruct response. Accepts:
 *   - raw `{ ... }` object on a line
 *   - ` ```json ... ``` ` fenced block
 *   - leading/trailing whitespace + commentary
 *
 * Returns null when no parseable object found. Caller should fall back to
 * regex verdict on null.
 *
 * Exported for unit tests; not part of the public consumer API.
 *
 * @param {string} draft
 * @returns {{ classification: string|null, confidence: number, rationale: string } | null}
 */
export function parseClassifyJson(draft) {
  if (typeof draft !== 'string' || draft.length === 0) return null
  // Strip markdown fence if present.
  let s = draft.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()

  // First {...} block (greedy enough to handle nested braces? Not — rationale
  // is a flat string by schema. Stick with first-balanced match.)
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  const jsonish = s.slice(start, end + 1)
  let obj
  try {
    obj = JSON.parse(jsonish)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null

  const VALID = new Set([
    'positive', 'negative', 'question', 'auto_reply',
    'bounce', 'unsubscribe', null,
  ])
  let cls = obj.classification
  if (cls === undefined) cls = null
  if (typeof cls === 'string') cls = cls.toLowerCase().trim()
  if (cls === '' || cls === 'null' || cls === 'unknown') cls = null
  if (!VALID.has(cls)) cls = null

  let conf = Number(obj.confidence)
  if (!Number.isFinite(conf)) conf = 0
  if (conf < 0) conf = 0
  if (conf > 1) conf = 1

  const rationale = typeof obj.rationale === 'string' ? obj.rationale.slice(0, 500) : ''
  return { classification: cls, confidence: conf, rationale }
}
