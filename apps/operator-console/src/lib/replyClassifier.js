/**
 * replyClassifier.js — body-only reply classifier.
 *
 * Mirrors common/humanize ClassifyReply Go logic (S19).
 * Returns one of: 'ooo' | 'negative' | 'interested' | 'question' | 'unknown'
 *
 * Priority order: ooo > negative > interested > question > unknown
 */

// Regex classifier kept as FALLBACK only. Primary classifier is LLM
// (semanticClassifyReply in lib/llmReplyClassifier.js) — relative scoring
// with confidence + alternatives instead of binary keyword match.
// This regex path fires when Ollama unavailable or env-disabled.
const OOO_RE = /out of office|nepřítomen|dovolen[aáé]|abwesend|away|vacation|mimo kancelář/i
// Negation must tolerate intervening words so "Nemáme o to zájem" / "Ztratili
// jsme zájem" are caught here (negative) instead of leaking to INTERESTED_RE on
// the bare `zájem` token and returning 'interested' for a clear decline.
const NEGATIVE_RE = /nezájem|ne(?:máme|mám)\b[^.\n]{0,15}\bzájem|ztratili[^.\n]{0,12}zájem|nechci|odhlásit|unsubscribe|opt.?out|\bstop\b|remove me|please remove|nerelevantní|\bspam\b|nevhodné|přestaňte|not interested|no thank/i
const INTERESTED_RE = /zájem|zajímá|pošlete|rád bych|domluvme|schůzka|interested|tell me more|send more/i

/**
 * Klasifikuje text těla odpovědi do kategorií.
 *
 * @param {string|null|undefined} body
 * @returns {'ooo' | 'negative' | 'interested' | 'question' | 'unknown'}
 */
export function classifyReplyBody(body) {
  if (!body || typeof body !== 'string') return 'unknown'

  // OOO first — highest priority (avoids misclassifying OOO as negative/interested).
  // OOO markers live in the human reply, so check the visible portion.
  const visible = stripQuotedReply(body)
  if (OOO_RE.test(visible)) return 'ooo'

  // Negative / unsubscribe signals — visible reply only (not the quoted pitch)
  if (NEGATIVE_RE.test(visible)) return 'negative'

  // Positive interest signals — visible reply only
  if (INTERESTED_RE.test(visible)) return 'interested'

  // Short question (contains '?' and under 200 chars)
  if (/\?/.test(visible) && visible.length < 200) return 'question'

  return 'unknown'
}

// ═════════════════════════════════════════════════════════════════════════
// AV-F2 (2026-05-19) — extended classifier
// ═════════════════════════════════════════════════════════════════════════
//
// Phase A of the AI roadmap: deterministic regex/keyword classifier with
// confidence scoring + structured reasoning, designed to auto-classify
// ≥ 90% of replies at high confidence so the operator only reviews edge
// cases. Phase B (LLM fallback) will sit on top of this same surface.
//
// Output schema differs from `classifyReplyBody` (above):
//   - structured `{ classification, confidence, reasoning }` object
//   - labels match reply_inbox.classification domain
//     (positive | negative | question | auto_reply | bounce | unsubscribe | null)
//   - takes subject + fromAddress in addition to body (bounce detection
//     needs the headers, OOO + unsub may live in either subject or body).
//
// Data context (47 real customer replies + 122 bounces, 2026-05-18 audit):
//   - 64% of replies say "máme/prodáme/nabízíme/na prodej"
//   - ~4% say  "nemáme/neprodáváme/nezájem"
//   - ~6% name a brand (Hitachi/Komatsu/CAT/Liebherr/Volvo/JCB/…)
//   - ~71% of unmatched_inbound rows are bounces (DSN signatures)
//
// Memory rules:
//   feedback_no_magic_thresholds T0 — every threshold a named constant.
//   feedback_no_speculation       — regex patterns + confidence values
//     come from the audit, not gut feel.
//   feedback_extreme_testing      — see tests/unit/lib/replyClassifier.test.js

/** Bump when ANY regex below changes — invalidates idempotency keys. */
// regex_v2 (2026-05-31): classify the VISIBLE reply only (strip quoted
// original mail) + price/offer signal + short-decline coverage. Fixes the
// false-positive class found by eyeballing 12 "positive vehicle-mention"
// rows: 5/12 were declines ("Nemám", "Momentálně ne", "aktuálně ne",
// "Nekontaktujte mě") that the v1 regex tagged positive because it matched
// the SELLING keywords ("máte na prodej?") inside OUR OWN quoted outbound.
export const CLASSIFIER_VERSION = 'regex_v2'

// Quoted-reply stripping moved to the shared lib/quoteStrip.js (2026-06) so
// vehicleExtractor can reuse the exact same logic — a brand in our quoted
// outbound was creating phantom vehicles. Re-exported here for back-compat
// with existing importers of stripQuotedReply from this module.
export { stripQuotedReply } from './quoteStrip.js'
import { stripQuotedReply } from './quoteStrip.js'

/** Confidence ≥ this auto-applies the verdict to reply_inbox.classification. */
export const AUTO_APPLY_THRESHOLD = 0.75

/** Confidence ≥ this surfaces the banner in the operator UI. */
export const BANNER_VISIBLE_THRESHOLD = 0.5

// Per-rule base confidence scores (audited data drives these values).
const CONFIDENCE_BOUNCE = 0.99
const CONFIDENCE_UNSUBSCRIBE = 0.95
const CONFIDENCE_AUTO_REPLY = 0.9
const CONFIDENCE_NEGATIVE = 0.85
const CONFIDENCE_POSITIVE_BASE = 0.8
const CONFIDENCE_POSITIVE_BRAND_BONUS = 0.1
const CONFIDENCE_POSITIVE_MACHINE_BONUS = 0.05
const CONFIDENCE_POSITIVE_CAP = 0.95
const CONFIDENCE_QUESTION = 0.65
const CONFIDENCE_FALLBACK = 0.3

/** Body length below which a trailing "?" is enough to be a "question". */
const QUESTION_SHORT_BODY_CHARS = 200

// 1. BOUNCE — DSN headers, postmaster sender, content patterns.
const BOUNCE_FROM_RX = /(postmaster|mailer-daemon|mail-daemon|noreply|no-reply)/i
const BOUNCE_SUBJECT_RX =
  /(delivery status notification|undeliverable|undelivered|failure notice|returned mail|mail delivery (system|failed)|nedoručitelná|nedoručeno)/i
const BOUNCE_BODY_RX =
  /(<[^>]+>.{0,40}not found|550 |551 |552 |553 |554 |permanent failure|recipient address rejected|user unknown|address not found|mailbox unavailable)/i

// 2. UNSUBSCRIBE
const UNSUB_RX =
  /\b(unsubscribe|odhlasit|odhlas[ií]t|odhlaste|chci se odhl[áa]sit|stop sending|prosim p[řr]esta[ňn]te|do not (email|contact)|nepište mi|nepis(at|te) mi|nekontaktujte( m[ěe])?|ned[ěe]lejte to)\b/i

// 3. AUTO-REPLY — vacation responders
const AUTO_REPLY_SUBJECT_RX =
  /(out of office|out-of-office|mimo kancel[áa][řr]|automaticka odpov[ěe][ďd]|automatick[áa] odpov[ěe][ďd]|vacation|auto[- ]?reply|abwesenheit|nejsem v kancel[áa][řr]i)/i
const AUTO_REPLY_BODY_RX =
  /\b(jsem mimo|away from|return on|vrac[íi]m se|on vacation|na dovolen[ée]|out of office until|currently out of)\b/i

// 4. NEGATION — must run BEFORE selling, because "nemáme bagr" contains "máme".
// 2026-05-31: added high-precision decline phrases that leaked to 'positive'
// (negation didn't fire → a SELLING/brand keyword elsewhere matched). Observed:
// "nehodláme prodávat", "nezabývám se", "nechci", "neprodávám" (singular),
// "vyřaďte mě", "není zájem", "bohužel ne".
const NEGATIVE_RX =
  /\b(nem[áa]me|neprod[áa]v[áa](me|m)|nez[áa]jem|nen[íi] z[áa]jem|nepot[řr]ebuj[ei](me|i)?|nic na prodej|nem[áa]m(e)? na prodej|nic neprod[áa]v[áa](me|m)|nejsme prodejce|nem[áa]m z[áa]jem|nem[áa]me nic|nem[áa]me k dispozici|d[ěe]kuji nez[áa]jem|nehodl[áa]me|nezab[ýy]v[áa]m|nechci|vy[řr]a[ďd]te|bohužel ne)\b/i

// 4a. SHORT DECLINE — curt brush-offs that carry no "zájem"/"na prodej" token
// so NEGATIVE_RX misses them, yet are unambiguous declines to "máte něco na
// prodej?". Observed leaking to 'positive' (the selling keyword came from the
// quoted original): "Nemám žádná auta", "Momentálně ne", "aktuálně ne",
// "teď ne", "zatím ne", and a bare "Nemám". Matched against the VISIBLE
// (de-quoted) reply only, so a later signature/quote can't reintroduce noise.
const SHORT_DECLINE_RX =
  /\b(moment[áa]ln[ěe]\s+ne|aktu[áa]ln[ěe]\s+ne|te[ďd]\s+ne|zat[íi]m\s+ne|nem[áa]m\s+(nic|žádn|auta|techniku|stroj|vozidl|na\s+prodej)|j[áa]\s+nic\s+nem[áa]m)\b/i
// A visible reply that OPENS with "Nemám" (answering "máte něco na prodej?")
// is a decline even when a signature follows: "Nemám", "Nemám žádná auta",
// "Nemám\nJan Novák\nOdesláno z iPhonu". Leading-anchored so it can't fire on
// "Nemám problém poslat fotky" buried mid-reply.
const LEADING_NEMAM_RX = /^\s*nem[áa]m\b/i

// 4b. LEADING DECLINE — a reply that opens with a curt "Ne." / "NE!" is a
// decline, even if a brand/selling keyword appears later (signature, quoted
// original mail). Period/exclamation only — "Ne," may continue ("Ne, ale…").
const LEADING_DECLINE_RX = /^\s*ne\s*[.!]/i

// 5. SELLING INTENT
const SELLING_RX =
  /\b(m[áa]me|prod[áa]v[áa]me|prod[áa]me|nab[íi]z[íi]me|na prodej|prodej(k[ya]?|ko|en[íi])|m[áa]me k dispozici|inzer[áa]t|inzer(uj[ei]me|ov[áa]no)|k prodeji|nab[íi]dka)\b/i
const BRAND_RX =
  /\b(hitachi|komatsu|caterpillar|cat|liebherr|volvo|jcb|case|new[\s-]*holland|deutz|man\s|tatra|iveco|scania|claas|kubota|bobcat|atlas|fendt|kobelco|takeuchi|yanmar)\b/i
const MACHINE_TYPE_RX =
  /\b(bagr|nakl[áa]dač|jeř[áa]b|valn[íi]k|n[áa]kl[áa][dt][áa]k|sklopka|fek[áa]ln[íi]|p[áa]sov[ée]|kolov[ée]|smykov[ée]|gradr|grader|dozer|excavator|loader|truck)\b/i
// 5b. PRICE / OFFER — a genuine seller answering "máte něco na prodej?" often
// just quotes a price with no selling verb: "Cena bez DPH 980.000,-", "cena
// 195000,- korun". After quote-stripping these would fall to fallback(null)
// and a real hot lead would vanish from the pipeline. A price/amount token in
// the VISIBLE reply is itself a positive offer signal. Matches "980.000,-",
// "195000,- korun", "1 250 000 Kč", or the word "cena" next to digits.
const PRICE_RX =
  /(\bcena\b[^.\n]{0,30}\d|\d[\d .]{2,}\s*(,-|k[čc]\b|korun|tis[íi]c))/i

// 6. QUESTION — explicit phrasing.
const QUESTION_PHRASE_RX =
  /\b(kde|kolik|co byste|specifikujte|jak[áy]?|m[ůu]žete (mi|n[áa]m) (sd[ěe]lit|specifikovat|popsat|prosím)|m[ůu]žete poslat|m[áa]te k dispozici|m[ůu]žete uv[ée]st)\b/i

function _avf2Normalize(v) {
  if (v === null || v === undefined) return ''
  return String(v).replace(/ /g, ' ').trim()
}

function _avf2Reasoning(matched, breakdown) {
  return {
    matched_patterns: matched.filter(Boolean),
    score_breakdown: breakdown,
    classifier_version: CLASSIFIER_VERSION,
  }
}

/**
 * AV-F2 classifier — returns a structured verdict for one reply.
 *
 * Priority order (early-exit): bounce → unsubscribe → auto_reply → negative
 * → positive → question → fallback(null).
 *
 * @param {string|null|undefined} bodyRaw
 * @param {string|null|undefined} subjectRaw
 * @param {string|null|undefined} fromAddressRaw
 * @returns {{
 *   classification: 'positive'|'negative'|'question'|'auto_reply'|'bounce'|'unsubscribe'|null,
 *   confidence: number,
 *   reasoning: {
 *     matched_patterns: string[],
 *     score_breakdown: Record<string, number>,
 *     classifier_version: string,
 *   }
 * }}
 */
export function classifyReply(bodyRaw, subjectRaw, fromAddressRaw) {
  const body = _avf2Normalize(bodyRaw)
  const subject = _avf2Normalize(subjectRaw)
  const fromAddress = _avf2Normalize(fromAddressRaw)
  // The human-typed portion only — negation / selling / question all run
  // against this so OUR quoted outbound ("máte na prodej?") can't be scored
  // as the recipient's intent. Bounce detection stays on the full body (DSN
  // text can look quote-shaped).
  const visible = stripQuotedReply(body)

  // 1. BOUNCE --------------------------------------------------------------
  const bounceFrom = BOUNCE_FROM_RX.exec(fromAddress)
  const bounceSubject = BOUNCE_SUBJECT_RX.exec(subject)
  const bounceBody = BOUNCE_BODY_RX.exec(body)
  if (bounceFrom || bounceSubject || bounceBody) {
    return {
      classification: 'bounce',
      confidence: CONFIDENCE_BOUNCE,
      reasoning: _avf2Reasoning(
        [bounceFrom?.[0], bounceSubject?.[0], bounceBody?.[0]],
        { bounce_indicators: CONFIDENCE_BOUNCE },
      ),
    }
  }

  // 2. UNSUBSCRIBE ---------------------------------------------------------
  const unsubInBody = UNSUB_RX.exec(visible)
  const unsubInSubject = UNSUB_RX.exec(subject)
  if (unsubInBody || unsubInSubject) {
    return {
      classification: 'unsubscribe',
      confidence: CONFIDENCE_UNSUBSCRIBE,
      reasoning: _avf2Reasoning(
        [unsubInBody?.[0], unsubInSubject?.[0]],
        { unsub: CONFIDENCE_UNSUBSCRIBE },
      ),
    }
  }

  // 3. AUTO-REPLY ----------------------------------------------------------
  const autoSubj = AUTO_REPLY_SUBJECT_RX.exec(subject)
  const autoBody = AUTO_REPLY_BODY_RX.exec(visible)
  if (autoSubj || autoBody) {
    return {
      classification: 'auto_reply',
      confidence: CONFIDENCE_AUTO_REPLY,
      reasoning: _avf2Reasoning(
        [autoSubj?.[0], autoBody?.[0]],
        { auto_reply: CONFIDENCE_AUTO_REPLY },
      ),
    }
  }

  // 4. NEGATION FIRST (before selling) ------------------------------------
  const negativeMatch =
    LEADING_DECLINE_RX.exec(visible) ||
    LEADING_NEMAM_RX.exec(visible) ||
    SHORT_DECLINE_RX.exec(visible) ||
    NEGATIVE_RX.exec(visible) ||
    NEGATIVE_RX.exec(subject)
  if (negativeMatch) {
    return {
      classification: 'negative',
      confidence: CONFIDENCE_NEGATIVE,
      reasoning: _avf2Reasoning(
        [negativeMatch[0]],
        { negation: CONFIDENCE_NEGATIVE, selling: 0 },
      ),
    }
  }

  // 5. SELLING INTENT (or a bare price/offer) ------------------------------
  const sellingMatch =
    SELLING_RX.exec(visible) || PRICE_RX.exec(visible) || SELLING_RX.exec(subject)
  if (sellingMatch) {
    const brandMatch = BRAND_RX.exec(visible) || BRAND_RX.exec(subject)
    const machineMatch = MACHINE_TYPE_RX.exec(visible) || MACHINE_TYPE_RX.exec(subject)
    const brandBonus = brandMatch ? CONFIDENCE_POSITIVE_BRAND_BONUS : 0
    const machineBonus = machineMatch ? CONFIDENCE_POSITIVE_MACHINE_BONUS : 0
    const raw = CONFIDENCE_POSITIVE_BASE + brandBonus + machineBonus
    const confidence = Math.min(raw, CONFIDENCE_POSITIVE_CAP)
    return {
      classification: 'positive',
      confidence,
      reasoning: _avf2Reasoning(
        [sellingMatch[0], brandMatch?.[0], machineMatch?.[0]],
        {
          selling: CONFIDENCE_POSITIVE_BASE,
          brand: brandBonus,
          machine: machineBonus,
          negation: 0,
        },
      ),
    }
  }

  // 6. QUESTION ------------------------------------------------------------
  const endsWithQ = /\?\s*$/.test(visible)
  const shortBody = visible.length > 0 && visible.length < QUESTION_SHORT_BODY_CHARS
  const phraseMatch = QUESTION_PHRASE_RX.exec(visible) || QUESTION_PHRASE_RX.exec(subject)
  if ((endsWithQ && shortBody) || phraseMatch) {
    return {
      classification: 'question',
      confidence: CONFIDENCE_QUESTION,
      reasoning: _avf2Reasoning(
        [phraseMatch?.[0], endsWithQ && shortBody ? 'trailing-question-mark' : null],
        { question: CONFIDENCE_QUESTION },
      ),
    }
  }

  // 7. FALLBACK ------------------------------------------------------------
  return {
    classification: null,
    confidence: CONFIDENCE_FALLBACK,
    reasoning: _avf2Reasoning([], { fallback: CONFIDENCE_FALLBACK }),
  }
}

// ═════════════════════════════════════════════════════════════════════════
// AV-F4 (2026-05-19) — LLM second-stage classifier (Ollama via llm-runner)
// ═════════════════════════════════════════════════════════════════════════
//
// Phase B of the AI roadmap. AV-F2 (regex) achieved 76 % auto-applied; the
// remaining 24 % are low-confidence cases that the LLM can disambiguate.
//
// Flow:
//   1. Run regex via classifyReply() (sync).
//   2. confidence ≥ LLM_TRIGGER_THRESHOLD  → return regex verdict (no LLM call).
//   3. confidence <  LLM_TRIGGER_THRESHOLD → call llm-runner with structured
//      prompt; parse JSON.
//   4. LLM confidence > regex confidence   → LLM wins (classifier_version='ollama_v1').
//   5. LLM confidence ≤ regex confidence   → regex stays (LLM didn't help —
//      log disagreement at info level for future tuning).
//   6. ANY error (timeout, unreachable, parse fail) → regex stays; reasoning
//      records llm_error so the audit log can be mined later.
//
// Memory rules:
//   feedback_no_magic_thresholds      T0 — LLM_TRIGGER_THRESHOLD,
//     LLM_MIN_CONFIDENCE, LLM_BODY_TRUNC_CHARS all named constants.
//   feedback_external_io_backoff      T0 — single attempt + 8 s timeout in
//     callLlmRunnerClassify; LLM never re-attempted within a single classify
//     call (re-attempt happens on the next cron tick if needed).
//   feedback_anti_trace_full_stack    — outbound HTTP only to llm-runner
//     internal Railway endpoint; no direct Ollama or cloud LLM calls.

/** Bump when prompt OR parsing semantics change — invalidates idempotency keys. */
export const LLM_CLASSIFIER_VERSION = 'ollama_v1'

/** Regex confidence ≥ this skips the LLM call (the regex is good enough). */
export const LLM_TRIGGER_THRESHOLD = 0.75

/** LLM verdict below this confidence is discarded — regex stays. */
export const LLM_MIN_CONFIDENCE = 0.5

/**
 * Async wrapper combining regex (always) + optional LLM second stage.
 *
 * Returns the SAME verdict shape as `classifyReply` PLUS:
 *   - classifier_version on the top-level reasoning (regex_v1 | ollama_v1)
 *   - llm_invoked  (bool) — convenience for the route to know whether the
 *     LLM was actually called
 *   - llm_error (string|undefined) — set when LLM was called and failed
 *   - stages[] — both stage verdicts (regex always, ollama when invoked)
 *
 * The injected `llmClient` dependency must implement
 * `callLlmRunnerClassify({ prompt }) → { ok, classification, confidence, rationale, ... }`.
 * Tests inject a mock; production wires the real `llmRunnerClient.js`.
 *
 * @param {string|null|undefined} bodyRaw
 * @param {string|null|undefined} subjectRaw
 * @param {string|null|undefined} fromAddressRaw
 * @param {{
 *   llmClient?: { callLlmRunnerClassify: (p: {prompt:string}) => Promise<any> },
 *   buildPrompt?: (a: {body:string, subject:string, fromAddress:string}) => string,
 *   logger?: { warn: (...a:any[])=>void, info: (...a:any[])=>void },
 * }} [opts]
 * @returns {Promise<{
 *   classification: 'positive'|'negative'|'question'|'auto_reply'|'bounce'|'unsubscribe'|null,
 *   confidence: number,
 *   reasoning: object,
 *   stages: Array<{ version: string, classification: string|null, confidence: number, rationale?: string, error?: string }>,
 *   llm_invoked: boolean,
 *   llm_error?: string,
 * }>}
 */
export async function classifyReplyWithLLM(bodyRaw, subjectRaw, fromAddressRaw, opts = {}) {
  // 1. Always run regex.
  const regexVerdict = classifyReply(bodyRaw, subjectRaw, fromAddressRaw)
  const stages = [{
    version: CLASSIFIER_VERSION,
    classification: regexVerdict.classification,
    confidence: regexVerdict.confidence,
  }]

  // 2. Regex confident enough → short-circuit.
  if (regexVerdict.confidence >= LLM_TRIGGER_THRESHOLD) {
    return {
      ...regexVerdict,
      reasoning: { ...regexVerdict.reasoning, classifier_version: CLASSIFIER_VERSION },
      stages,
      llm_invoked: false,
    }
  }

  // 3. Resolve dependencies (lazy import to keep this file synchronous-importable).
  const logger = opts.logger || console
  let llmClient = opts.llmClient
  let buildPrompt = opts.buildPrompt
  if (!llmClient) {
    // RELATIVE-first: when llm-runner has no URL (it has no public domain
    // reachable from the local dashboard) but the public Railway Ollama is
    // configured, classify via Ollama directly. The classifier prompt is an
    // LLM-agnostic JSON-instruct, so the Ollama client is a drop-in for
    // callLlmRunnerClassify. Falls back to llm-runner when OLLAMA_URL is unset.
    const preferOllama = !process.env.LLM_RUNNER_URL && process.env.OLLAMA_URL
    const clientModule = preferOllama ? './ollamaClassifyClient.js' : './llmRunnerClient.js'
    try {
      llmClient = await import(clientModule)
    } catch (e) {
      logger.warn?.('classifyReplyWithLLM: llmRunnerClient import failed', { error: e?.message })
      return {
        ...regexVerdict,
        reasoning: {
          ...regexVerdict.reasoning,
          classifier_version: CLASSIFIER_VERSION,
          llm_error: 'client_import_failed',
        },
        stages,
        llm_invoked: false,
        llm_error: 'client_import_failed',
      }
    }
  }
  if (!buildPrompt) {
    try {
      const mod = await import('./llmReplyClassifierPrompt.js')
      buildPrompt = mod.buildClassifyPrompt
    } catch (e) {
      logger.warn?.('classifyReplyWithLLM: prompt module import failed', { error: e?.message })
      return {
        ...regexVerdict,
        reasoning: {
          ...regexVerdict.reasoning,
          classifier_version: CLASSIFIER_VERSION,
          llm_error: 'prompt_import_failed',
        },
        stages,
        llm_invoked: false,
        llm_error: 'prompt_import_failed',
      }
    }
  }

  // 4. Call llm-runner.
  const prompt = buildPrompt({
    body: bodyRaw || '',
    subject: subjectRaw || '',
    fromAddress: fromAddressRaw || '',
  })
  let llmRes
  try {
    llmRes = await llmClient.callLlmRunnerClassify({ prompt })
  } catch (e) {
    llmRes = { ok: false, reason: e?.message || 'unknown' }
  }

  if (!llmRes.ok) {
    logger.warn?.('classifyReplyWithLLM: llm-runner unavailable, falling back to regex', {
      error: llmRes.reason,
    })
    stages.push({
      version: LLM_CLASSIFIER_VERSION,
      classification: null,
      confidence: 0,
      error: llmRes.reason,
    })
    return {
      ...regexVerdict,
      reasoning: {
        ...regexVerdict.reasoning,
        classifier_version: CLASSIFIER_VERSION,
        llm_error: llmRes.reason,
      },
      stages,
      llm_invoked: true,
      llm_error: llmRes.reason,
    }
  }

  // 5. LLM responded. Record stage.
  stages.push({
    version: LLM_CLASSIFIER_VERSION,
    classification: llmRes.classification,
    confidence: llmRes.confidence,
    rationale: llmRes.rationale,
  })

  // 6. Drop LLM verdict if below floor.
  if (llmRes.confidence < LLM_MIN_CONFIDENCE) {
    logger.info?.('classifyReplyWithLLM: llm confidence below floor, keeping regex', {
      regex_confidence: regexVerdict.confidence,
      llm_confidence: llmRes.confidence,
      llm_classification: llmRes.classification,
    })
    return {
      ...regexVerdict,
      reasoning: { ...regexVerdict.reasoning, classifier_version: CLASSIFIER_VERSION },
      stages,
      llm_invoked: true,
    }
  }

  // 7. Pick winner. LLM only wins if strictly higher confidence than regex.
  if (llmRes.confidence > regexVerdict.confidence) {
    return {
      classification: llmRes.classification,
      confidence: llmRes.confidence,
      reasoning: {
        matched_patterns: [],
        score_breakdown: { llm: llmRes.confidence },
        classifier_version: LLM_CLASSIFIER_VERSION,
        rationale: llmRes.rationale,
        regex_fallback: {
          classification: regexVerdict.classification,
          confidence: regexVerdict.confidence,
        },
      },
      stages,
      llm_invoked: true,
    }
  }

  // 8. LLM ≤ regex — note disagreement, regex stays.
  if (llmRes.classification !== regexVerdict.classification) {
    logger.info?.('classifyReplyWithLLM: llm/regex disagreement, regex confidence higher', {
      regex: regexVerdict.classification,
      regex_conf: regexVerdict.confidence,
      llm: llmRes.classification,
      llm_conf: llmRes.confidence,
    })
  }
  return {
    ...regexVerdict,
    reasoning: {
      ...regexVerdict.reasoning,
      classifier_version: CLASSIFIER_VERSION,
      llm_alternative: {
        classification: llmRes.classification,
        confidence: llmRes.confidence,
        rationale: llmRes.rationale,
      },
    },
    stages,
    llm_invoked: true,
  }
}
