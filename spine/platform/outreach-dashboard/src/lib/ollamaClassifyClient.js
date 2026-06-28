// ollamaClassifyClient.js — RELATIVE reply classifier transport (Ollama direct).
//
// Drop-in for llmRunnerClient.callLlmRunnerClassify: same {prompt} in, same
// { ok, classification, confidence, rationale, model, raw } out. The classifier
// prompt (llmReplyClassifierPrompt.js) is already an LLM-agnostic JSON-instruct
// that asks for {"classification","confidence","rationale"}, so we just swap
// the transport: call the public Railway Ollama directly instead of llm-runner
// (which has no public domain reachable from the local dashboard).
//
// Used as the classifier's second stage when OLLAMA_URL is set but
// LLM_RUNNER_URL is not. Self-hosted Ollama only (feedback_no_external_services).

// 30s, not 20s — same CPU-Ollama tail-latency root cause as the vehicle
// extractor (2026-05-31): warm classify calls land ~5–12s but the cold tail
// crossed 20s and silently aborted → regex fallback (0 ollama_v1 rows in prod).
// num_predict=200 keeps this faster than extraction, so 30s is ample headroom.
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_CLASSIFY_TIMEOUT_MS || 30000)
const DEFAULT_MODEL = process.env.OLLAMA_EXTRACT_MODEL || 'llama3.2:3b'
// Keep the model RESIDENT between calls. Without this the Railway Ollama
// unloads llama3.2:3b after each request, so every classify pays a ~3.4s cold
// model-load on top of inference — measured 17-20s/call → most cron calls hit
// the timeout and silently fell back to regex (the LLM stage was effectively
// dead). With keep_alive the load_duration drops to ~0.2s and warm calls land
// at ~4-5s. Named constant — no magic numbers (feedback_no_magic_thresholds).
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '10m'
// Cap generated tokens — the classifier emits a tiny JSON object, so an
// unbounded num_predict only risks a runaway generation eating the timeout.
const OLLAMA_NUM_PREDICT = Number(process.env.OLLAMA_CLASSIFY_NUM_PREDICT || 200)

const VALID = new Set(['positive', 'negative', 'question', 'auto_reply', 'bounce', 'unsubscribe'])

function ollamaUrl() {
  const u = process.env.OLLAMA_URL
  return u ? u.replace(/\/$/, '') : null
}

/**
 * @param {{ prompt: string }} args
 * @returns {Promise<{ ok: true, classification: string|null, confidence: number, rationale: string, model: string|null, raw: string } | { ok: false, reason: string }>}
 */
export async function callLlmRunnerClassify({ prompt }) {
  const base = ollamaUrl()
  if (!base) return { ok: false, reason: 'OLLAMA_URL not configured' }
  if (!prompt) return { ok: false, reason: 'empty prompt' }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), OLLAMA_TIMEOUT_MS)
  try {
    const r = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        prompt,
        stream: false,
        format: 'json',
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: { temperature: 0, num_predict: OLLAMA_NUM_PREDICT },
      }),
    })
    if (!r.ok) return { ok: false, reason: `ollama HTTP ${r.status}` }
    const data = await r.json()
    const raw = data.response || ''
    let parsed
    try { parsed = JSON.parse(raw) } catch { return { ok: false, reason: 'unparseable JSON' } }

    // Normalise: only accept known labels, clamp confidence, keep null otherwise.
    const cls = typeof parsed.classification === 'string' && VALID.has(parsed.classification)
      ? parsed.classification
      : null
    const conf = Number(parsed.confidence)
    return {
      ok: true,
      classification: cls,
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
      model: DEFAULT_MODEL,
      raw,
    }
  } catch (e) {
    return { ok: false, reason: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'unknown') }
  } finally {
    clearTimeout(timer)
  }
}
