/**
 * llmReplyClassifierPrompt.js — AV-F4 (2026-05-19)
 * ─────────────────────────────────────────────────────────────────────────
 * JSON-instruct prompt template for the second-stage (LLM) reply
 * classifier. The vocabulary matches the AV-F2 regex classifier so the
 * two stages produce compatible verdicts.
 *
 * Categories (must stay in sync with `replyClassifier.js`):
 *   positive | negative | question | auto_reply | bounce | unsubscribe | null
 *
 * Memory rules:
 *   feedback_no_magic_thresholds T0 — body truncation length is a named
 *     constant exported from this module.
 *   feedback_no_speculation       — examples below come from real replies
 *     in the 2026-05-18 audit corpus (dzobamek@seznam.cz + chupik@chupik.cz
 *     real cases from PROD reply_inbox).
 */

/** Body characters to keep when feeding the LLM. 1500 chars covers ~95 %
 *  of real B2B replies without blowing the 4 k context window of small
 *  Ollama models. */
export const LLM_BODY_TRUNC_CHARS = 1500

/**
 * Build the JSON-instruct prompt fed to llm-runner `/v1/generate`.
 *
 * @param {{ body?: string|null, subject?: string|null, fromAddress?: string|null }} arg
 * @returns {string}
 */
export function buildClassifyPrompt({ body, subject, fromAddress } = {}) {
  const safeBody = String(body || '').slice(0, LLM_BODY_TRUNC_CHARS)
  const safeSubject = String(subject || '').slice(0, 200) || '(no subject)'
  const safeFrom = String(fromAddress || '').slice(0, 200) || '(unknown)'

  return `Jsi klasifikátor B2B obchodních e-mailů v češtině. Dostaneš tělo příchozí odpovědi a vrátíš JSON s klasifikací.

Kategorie:
- positive: odesílatel signalizuje prodejní zájem (máme bagr na prodej, mám stroj, ...)
- negative: odesílatel odmítá / nemá nic na prodej (nemáme, nezájem, neprodáváme)
- question: dotaz, žádost o upřesnění (co potřebujete, specifikujte, jak ...?)
- auto_reply: out-of-office / automatická odpověď (jsem mimo, vrátím se ...)
- bounce: DSN / mailer-daemon / undeliverable
- unsubscribe: odhlášení (unsubscribe, odhlásit)
- null: nelze rozhodnout

Vrať POUZE JSON object, žádný markdown, žádný komentář.

Schema:
{ "classification": "<one of above or null>", "confidence": 0.0-1.0, "rationale": "<1 věta česky>" }

Příklady:

INPUT:
Subject: Re: Poptávka
From: dzobamek@seznam.cz
Body: MAME NA PRODEJ BAGR 24 TUN PASAK LIBHER 922

OUTPUT:
{"classification":"positive","confidence":0.95,"rationale":"Nabízí bagr Liebherr 922 na prodej."}

INPUT:
Subject: Re: Poptávka
From: chupik@chupik.cz
Body: Vláďa nás opustil 16tého ledna 2024.

OUTPUT:
{"classification":"negative","confidence":0.85,"rationale":"Majitel zemřel, prodej nepravděpodobný."}

---

Klasifikuj:

Subject: ${safeSubject}
From: ${safeFrom}
Body: ${safeBody}

OUTPUT:`
}
