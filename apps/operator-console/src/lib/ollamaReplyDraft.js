// ollamaReplyDraft.js — RELATIVE (LLM) reply-draft assist for inbound triage.
//
// "Systém je relativní, ne absolutní": instead of canned templates, ask the
// local Ollama to read the customer's reply and draft a short, on-point Czech
// answer that moves the výkup (machinery buy-back) deal forward. The draft is
// a SUGGESTION the operator reads/edits/copies — it is NEVER auto-sent and
// nothing is written to the DB (guardrail: LLM never auto-applies; no campaign
// send). Self-hosted Ollama only (feedback_no_external_services), talks to the
// public Railway Ollama (OLLAMA_URL) directly — llm-runner has no public host.

const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_DRAFT_TIMEOUT_MS || 45000)
const DEFAULT_MODEL = process.env.OLLAMA_EXTRACT_MODEL || 'llama3.2:3b'
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '10m'
const OLLAMA_NUM_PREDICT = Number(process.env.OLLAMA_DRAFT_NUM_PREDICT || 320)

export const DRAFT_VERSION = 'ollama_v1'

function ollamaUrl() {
  const u = process.env.OLLAMA_URL
  return u ? u.replace(/\/$/, '') : null
}

const PROMPT_HEAD =
  'Jsi český asistent firmy Garaaage, která VYKUPUJE techniku a vozidla (bagry, ' +
  'nakladače, dodávky, osobní auta). Zákazník odpověděl na naši poptávku výkupu.\n' +
  'Napiš návrh odpovědi v ČEŠTINĚ podle těchto pravidel:\n' +
  '- spisovná, gramaticky správná čeština; ŽÁDNÁ anglická slova\n' +
  '- maximálně 4 věty, věcně a stručně; neopakuj slova ani fráze\n' +
  '- vykání (Vy/Vás), pokud zákazník netyká\n' +
  '- navaž na jeho zprávu a posuň obchod dál: doptej se na rok, stav, nájezd ' +
  'nebo cenu, případně navrhni prohlídku či odvoz\n' +
  '- NEVYMÝŠLEJ fakta (cenu, model, termín); když je neznáš, zeptej se\n' +
  '- nepodepisuj se, nepiš předmět, vrať jen tělo odpovědi jako prostý text\n' +
  'ZPRÁVA ZÁKAZNÍKA:\n'

/**
 * Draft a reply via Ollama. Returns { draft, model } or null when Ollama is
 * unavailable / errors / empty input (caller surfaces a graceful message).
 * Never throws.
 *
 * @param {string} body customer reply body
 * @param {string} [subject]
 * @returns {Promise<{ draft: string, model: string } | null>}
 */
export async function draftReply(body, subject) {
  const base = ollamaUrl()
  if (!base || !body || !body.trim()) return null

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), OLLAMA_TIMEOUT_MS)
  try {
    const prompt = PROMPT_HEAD
      + (subject ? `Předmět: ${subject}\n` : '')
      + body.slice(0, 4000)
    const r = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        prompt,
        stream: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: { temperature: 0.3, num_predict: OLLAMA_NUM_PREDICT },
      }),
    })
    if (!r.ok) return null
    const data = await r.json()
    const draft = String(data.response || '').trim()
    if (!draft) return null
    return { draft, model: DEFAULT_MODEL }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
