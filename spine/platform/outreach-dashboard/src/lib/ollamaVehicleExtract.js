// ollamaVehicleExtract.js — RELATIVE (LLM) vehicle extraction.
//
// "Systém je relativní, ne absolutní": the regex+dictionary extractor
// (machineryDict.js) only matches brands it knows, so it misses real offers
// ("mazda 6" → no model, an unknown brand → nothing). This stage asks a local
// Ollama model to read the free Czech reply text and pull out whatever vehicle
// is being offered — make/model/year/price/condition — without a hardcoded
// catalog. It is the PRIMARY extractor; the regex extractor is the graceful
// fallback when OLLAMA_URL is unset or the call fails/times out.
//
// Self-hosted Ollama only (feedback_no_external_services). Talks to the public
// Railway Ollama (OLLAMA_URL) directly — llm-runner has no public domain, and
// the dashboard runs locally, so it can't reach llm-runner's railway.internal.

// 45s, not 20s. The Railway Ollama runs llama3.2:3b on CPU; a real ~1KB reply
// body takes ~16–22s to extract even warm (measured 2026-05-31: body id=97 was
// 15.8s warm, 20.0s on the cold tail). The old 20s default sat right on that
// tail, so EVERY extraction silently aborted → fell back to regex. Result:
// 0 ollama_v1 rows in production despite Ollama being up and the code wired.
// The whole "relative, not absolute" Ollama path was dead. Env-overridable.
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_EXTRACT_TIMEOUT_MS || 45000)
const DEFAULT_MODEL = process.env.OLLAMA_EXTRACT_MODEL || 'llama3.2:3b'
// Keep the model resident between calls — see ollamaClassifyClient.js: without
// keep_alive the Railway Ollama cold-loads llama3.2:3b on every request
// (~3.4s) and most calls hit the timeout. Shared default with the classifier.
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '10m'
// Cap generation so a runaway response can't eat the whole timeout. A vehicle
// JSON for a typical reply is well under this; mirrors the classifier's bound.
const OLLAMA_NUM_PREDICT = Number(process.env.OLLAMA_EXTRACT_NUM_PREDICT || 512)

export const LLM_EXTRACTOR_VERSION = 'ollama_v1'

function ollamaUrl() {
  const u = process.env.OLLAMA_URL
  return u ? u.replace(/\/$/, '') : null
}

const PROMPT_HEAD =
  'Jsi extraktor vozidel z českých prodejních e-mailů (výkup techniky i osobních aut). ' +
  'Z textu vrať POUZE JSON objekt {"vehicles":[...]}. Každé vozidlo: ' +
  '{"make": značka nebo null, "model": model nebo null, "year": rok int nebo null, ' +
  '"mileage_km": nájezd int nebo null, "price_eur": cena v EUR int nebo null, ' +
  '"body_type": typ (bagr/nakladač/dodávka/osobní/…) nebo null, "note": krátký stav nebo null}. ' +
  'Když text žádné vozidlo nenabízí (odmítnutí, dotaz, nemám nic), vrať {"vehicles":[]}. ' +
  'Nevymýšlej údaje které tam nejsou. TEXT:\n'

/**
 * Extract vehicles via Ollama. Returns the canonical shape used by the regex
 * extractor, or null when Ollama is unavailable / errors (→ caller falls back
 * to regex). Never throws.
 *
 * @param {string} text reply body
 * @returns {Promise<{ vehicles: Array<object>, extractor_version: string } | null>}
 */
export async function extractVehiclesLLM(text) {
  const base = ollamaUrl()
  if (!base || !text || !text.trim()) return null

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), OLLAMA_TIMEOUT_MS)
  try {
    const r = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        prompt: PROMPT_HEAD + text.slice(0, 4000),
        stream: false,
        format: 'json',
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: { temperature: 0, num_predict: OLLAMA_NUM_PREDICT },
      }),
    })
    if (!r.ok) return null
    const data = await r.json()
    const parsed = JSON.parse(data.response || '{}')
    const raw = Array.isArray(parsed) ? parsed : (parsed.vehicles || [])
    const vehicles = raw
      .filter(v => v && (v.make || v.model))
      .map(v => ({
        make: v.make || null,
        model: v.model != null ? String(v.model) : null,
        // 0 means "unknown" (the model emits 0 for missing numerics) — a real
        // vehicle never has year 0, so normalize it to null like mileage/price.
        year: Number(v.year) > 0 ? Number(v.year) : null,
        // Treat 0 as "unknown" — the model returns 0 for missing numerics, and
        // a real offer never has 0 km / 0 EUR, so showing "0" would be noise.
        mileage_km: Number(v.mileage_km) > 0 ? Number(v.mileage_km) : null,
        motohours: null,
        price_offered_eur: Number(v.price_eur) > 0 ? Number(v.price_eur) : null,
        body_type: v.body_type || null,
        note: v.note || null,
        confidence: 0.75,
        matched_text: (text.slice(0, 200)),
        matched_patterns: ['llm'],
      }))
    return { vehicles, extractor_version: LLM_EXTRACTOR_VERSION }
  } catch {
    // timeout / network / parse — graceful fallback to regex.
    return null
  } finally {
    clearTimeout(timer)
  }
}
