// SHARED-5 — heal-explanations lib.
// Renders Czech natural-language summaries for self-healing actions.
// Used by HXX12 audit + dashboard /observability/heal-quality + ops UI.
//
// Schema (input — same as healing_log row):
//   { action, entity_type, entity_id, entity_label?, reason, threshold?,
//     next_step?, probable_cause?, resolved_at?, created_at? }
//
// Action verb table (Czech, single-source-of-truth so audits + UI agree):

const ACTION_VERBS = {
  auto_pause:              'Pozastaveno',
  auto_resume:             'Obnoveno',
  engine_restart:          'Restart engine',
  cron_recovery:           'Cron obnoven',
  proxy_rotate:            'Proxy přepnuta',
  breaker_reset:            'Breaker resetován',
  suppression_added:       'Doplněno na suppression',
  manual_review_required:  'ESKALACE — vyžaduje ruční ACK',
  health_recheck:          'Spuštěn full-check',
  cache_evict:             'Vyhozena položka cache',
  warmup_advance:          'Warmup posunut',
  warmup_pause:            'Warmup pozastaven',
}

const REQUIRED_FIELDS = ['action', 'entity_type', 'entity_id', 'reason']

function entityRef(entity_type, entity_id) {
  // Conventional shorthand: "mb=3" for mailbox, "cron=fullCheck" for cron.
  const prefix = entity_type === 'mailbox' ? 'mb'
    : entity_type === 'engine'   ? 'engine'
    : entity_type === 'cron'     ? 'cron'
    : entity_type === 'campaign' ? 'camp'
    : entity_type
  return `${prefix}=${entity_id}`
}

export function renderHealExplanation(input, opts = {}) {
  for (const f of REQUIRED_FIELDS) {
    if (input?.[f] === undefined || input?.[f] === null) {
      throw new Error(`renderHealExplanation: required field missing: ${f}`)
    }
  }
  const verb = ACTION_VERBS[input.action]
  if (!verb) {
    throw new Error(`renderHealExplanation: unknown action: ${input.action}`)
  }
  const ref = entityRef(input.entity_type, input.entity_id)
  const parts = []
  // First clause: verb + entity (+ reason in parens).
  parts.push(`${verb} ${ref} (${input.reason})`)
  // Second clause: next step.
  if (input.next_step) parts.push(input.next_step)
  // Third clause: probable cause hypothesis.
  if (input.probable_cause) parts.push(`Pravděpodobná příčina: ${input.probable_cause}`)

  if (opts.multiline) return parts.join('\n')
  // Single-line default for log compatibility.
  return parts.join(' · ')
}

export function parseHealLog(rowOrRows) {
  if (Array.isArray(rowOrRows)) return rowOrRows.map(r => parseHealLog(r))
  const row = rowOrRows
  for (const f of ['entity_type', 'entity_id', 'action', 'reason']) {
    if (row?.[f] === undefined || row?.[f] === null) {
      throw new Error(`parseHealLog: required field missing: ${f}`)
    }
  }
  const created = row.created_at ? new Date(row.created_at).getTime() : null
  const resolved = row.resolved_at ? new Date(row.resolved_at).getTime() : null
  return {
    ...row,
    is_open: !row.resolved_at,
    duration_ms: created && resolved ? resolved - created : null,
  }
}

// Discipline helper: verify a heal-log explanation includes all 5 required
// signals — actionVerb, entityRef, reason, nextStep, cause.
// Used by HXX12 audit test as a per-call-site validator.
export function validateExplanation(text, expected) {
  if (typeof text !== 'string') return { ok: false, missing: ['text-not-string'] }
  const missing = []
  for (const key of ['actionVerb', 'entityRef', 'reason', 'nextStep', 'cause']) {
    const needle = expected?.[key]
    if (!needle) continue
    if (!text.includes(String(needle))) missing.push(key)
  }
  return { ok: missing.length === 0, missing }
}
