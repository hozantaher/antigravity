// HXX12 — Self-explaining heal audit (discipline test).
//
// Walks every heal-action call site in the codebase (BFF Express in
// `server.js`, BFF helper modules in `src/lib/automation.js`, plus the
// fixture surface in `src/test/heal-fixtures.js`) and verifies that the
// reason / message strings include the FIVE required signals so that
// renderHealExplanation can later produce a complete operator-readable
// summary in `/observability/heal-quality`:
//
//   1. actionVerb         — table-driven, ACTION_VERBS in heal-explanations.js
//   2. entityRef          — entity_type + entity_id present in the call
//   3. reason+threshold   — human-readable cause incl. the threshold breached
//   4. nextStep           — what the system will do next
//   5. probable-cause     — hypothesis about WHY the breach happened (optional)
//
// Per memory `feedback_extreme_testing.md` (≥10 cases) we exceed by a wide
// margin: 9 BFF call sites + 12 render fixtures + 50 smoke rows + 5+
// edge-case asserts → ≥20 cases total.
//
// Ratchet pattern mirrors HX10 (slog_op_audit_test.go in features/outreach/campaigns
// /sender). The baseline is the count of pre-existing violations at the
// time of writing. New code must NOT raise the count; refactors that
// improve heal-log quality lower it.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  renderHealExplanation,
  parseHealLog,
  validateExplanation,
} from '../../src/lib/heal-explanations.js'

const ROOT = join(import.meta.dirname, '..', '..')
const SERVER_JS = join(ROOT, 'server.js')
// Sprint E1 (v2 unification) extracted logHealing call sites from server.js into
// src/crons/ modules (_runMailboxHealthCycleCron → runMailboxHealthCycleCron.js,
// _runCampaignWatchdogCron → runCampaignWatchdogCron.js). The scan must cover
// both server.js AND the cron modules to maintain the ≥8 call-site discipline.
const CRON_DIR = join(ROOT, 'src', 'crons')

// ── Per-signal ratchet baselines ─────────────────────────────────────
// Initial pass over server.js — these are the violation counts captured
// the day this audit was written (HXX12, 2026-04-26). Lower as call
// sites are improved. Each new logHealing(...) without a signal raises
// the count → test fails. Ratchet directionality is one-way (only
// downward edits are safe).
const BASELINE = {
  actionVerb: 6,    // 6 legacy actions (cap_reduced, bounce_pause, low_performance,
                    //                   uid_validity_change, ooo_detected, dynamic INSERT)
                    //                   that are NOT yet in ACTION_VERBS
  entityRef:  0,    // every call passes (entity_type, entity_id) — keep at 0
  reason:     0,    // every call passes a non-empty reason     — keep at 0
  nextStep:   5,    // current count: most call sites bundle next-step into `reason`
  cause:      11,   // current count: probable_cause is optional and absent on most call sites
}

// Action verb table — duplicated here only to verify the source-of-truth
// mapping. Heal-explanations.js owns the canonical list.
const KNOWN_ACTIONS = new Set([
  'auto_pause', 'auto_resume', 'engine_restart', 'cron_recovery',
  'proxy_rotate', 'breaker_reset', 'suppression_added',
  'manual_review_required', 'health_recheck', 'cache_evict',
  'warmup_advance', 'warmup_pause',
  // Legacy actions referenced by server.js that are NOT in the verb table
  // — counted but the audit reports them as `actionVerb` violations so
  // the operator can decide whether to add them to ACTION_VERBS or
  // collapse them onto an existing verb. They contribute to the ratchet.
])

// ── Static call-site extraction ──────────────────────────────────────
// We use a deliberately conservative regex over the BFF source. The
// alternatives are: (a) parse the JS AST (heavy dependency), (b) string
// match on the function name. For ratchet purposes (b) is sufficient:
// every false negative just means we missed a violation, never that we
// reported a phantom one. False positives would be worse and the regex
// is anchored on the literal `logHealing(` token.

const HEAL_CALL_RE = /logHealing\(\s*(['"])(\w+)\1\s*,\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*(['"])(\w+)\5\s*,\s*([^)]+?)\)/gs

/**
 * Returns an array of synthetic heal records — one per call site found.
 * Each record carries the literals the source file passed (entity_type,
 * action, reason). entity_id / entity_label are kept as raw expressions
 * because they are typically variables; the audit only needs the action +
 * reason for signal extraction.
 *
 * @param {string} source
 * @returns {Array<{ line: number, entity_type: string, action: string, raw_reason: string }>}
 */
function extractLogHealingCalls(source) {
  const out = []
  let m
  // Reset lastIndex defensively in case the regex object is reused.
  HEAL_CALL_RE.lastIndex = 0
  while ((m = HEAL_CALL_RE.exec(source)) !== null) {
    const offset = m.index
    const line = source.slice(0, offset).split('\n').length
    out.push({
      line,
      entity_type: m[2],
      action: m[6],
      raw_reason: m[7].trim(),
    })
  }
  return out
}

// Direct INSERT INTO healing_log(...) call sites are also heal surfaces.
const INSERT_HEAL_RE = /INSERT INTO healing_log\([^)]*\)\s*VALUES\(([^)]*)\)/g

function extractInsertHealCalls(source) {
  const out = []
  let m
  INSERT_HEAL_RE.lastIndex = 0
  while ((m = INSERT_HEAL_RE.exec(source)) !== null) {
    const offset = m.index
    const line = source.slice(0, offset).split('\n').length
    // VALUES list — grab the action literal if it's inline, else mark as
    // dynamic (parametrized $4 binding — must be inspected manually).
    const inner = m[1]
    const actionMatch = inner.match(/'(\w+)'/g) || []
    const action = actionMatch.length > 1 ? actionMatch[1].replace(/'/g, '') : 'dynamic'
    out.push({ line, entity_type: 'inline', action, raw_reason: inner })
  }
  return out
}

// ── Test 1: discipline audit over BFF call sites ─────────────────────

describe('Heal-explanation audit — BFF call sites', () => {
  // Combine server.js + all extracted BFF cron modules for a complete call-site
  // inventory. Sprint E1 (v2 unification) factored logHealing calls from
  // server.js into src/crons/. Line numbers in violation messages are relative
  // to the concatenated source, which is approximate but sufficient for ratchet
  // purposes (counts are what matters, not precise file:line).
  const cronSources = readdirSync(CRON_DIR)
    .filter(f => f.endsWith('.js'))
    .map(f => readFileSync(join(CRON_DIR, f), 'utf8'))
  const source = [readFileSync(SERVER_JS, 'utf8'), ...cronSources].join('\n')
  const logCalls = extractLogHealingCalls(source)
  const insertCalls = extractInsertHealCalls(source)
  const allCalls = [...logCalls, ...insertCalls]

  it('extracts at least 8 logHealing() call sites across server.js + BFF crons (HX10 set)', () => {
    expect(logCalls.length).toBeGreaterThanOrEqual(8)
  })

  it('extracts at least 1 direct INSERT INTO healing_log call site', () => {
    expect(insertCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('every action literal is in the canonical ACTION_VERBS table OR is a documented legacy action', () => {
    // The five "modern" actions used by logHealing today are documented in
    // the action-verb table directly. Legacy actions (cap_reduced,
    // bounce_pause, low_performance, uid_validity_change, ooo_detected)
    // come from older surfaces; they are tracked here so the count can
    // ratchet down as they migrate.
    const LEGACY = new Set([
      'cap_reduced', 'bounce_pause', 'low_performance',
      'uid_validity_change', 'ooo_detected', 'dynamic',
    ])
    const violations = []
    for (const c of allCalls) {
      if (KNOWN_ACTIONS.has(c.action)) continue
      if (LEGACY.has(c.action)) continue
      violations.push(`server.js:${c.line} unknown action '${c.action}'`)
    }
    expect(violations, `Unknown heal actions:\n${violations.join('\n')}`)
      .toEqual([])
  })

  // Per-signal violation counters with ratchet.
  const counts = {
    actionVerb: 0,
    entityRef:  0,
    reason:     0,
    nextStep:   0,
    cause:      0,
  }
  const detail = {
    actionVerb: [],
    entityRef:  [],
    reason:     [],
    nextStep:   [],
    cause:      [],
  }

  for (const c of allCalls) {
    // actionVerb — canonical action AND mapped in ACTION_VERBS
    if (!KNOWN_ACTIONS.has(c.action)) {
      counts.actionVerb += 1
      detail.actionVerb.push(`server.js:${c.line} action='${c.action}' missing from ACTION_VERBS`)
    }
    // entityRef — extractor only matches calls that include entity_type
    // and entity_id positionally, so this is always present for the JS
    // logHealing() path. INSERT-style call sites use parametrized binding
    // and may or may not include the entity_id literal in the line.
    if (c.entity_type === 'inline') {
      // Only flag when the captured VALUES tuple is missing $-bindings entirely.
      if (!/\$\d+/.test(c.raw_reason)) {
        counts.entityRef += 1
        detail.entityRef.push(`server.js:${c.line} INSERT missing parametrized entity binding`)
      }
    }
    // reason — non-empty literal or template
    const r = c.raw_reason || ''
    if (r === '' || r === 'null' || r === 'undefined') {
      counts.reason += 1
      detail.reason.push(`server.js:${c.line} action='${c.action}' empty reason`)
    }
    // nextStep — heuristic: reason text contains "→" / "auto-" / "po té"
    // / "after" / "next" / "cooldown" / "resume" / "retry" — anything
    // implying a follow-up action. The current call sites mostly do NOT
    // emit a structured next_step; they bundle cause + next-step into the
    // reason text.
    if (!/→|auto[-_ ]|po té|po\s|after|next\s|cooldown|resume|retry|escalation|threshold/i.test(r)) {
      counts.nextStep += 1
      detail.nextStep.push(`server.js:${c.line} action='${c.action}' no next-step hint in reason`)
    }
    // probable-cause hypothesis — heuristic: reason text contains a
    // probable-cause keyword. Optional per HXX12 spec — counted but
    // tolerated if it grew within budget.
    if (!/(příčina|because|caused|due to|likely|pravděpodobn|kvůli|because of|panic|cascade)/i.test(r)) {
      counts.cause += 1
      detail.cause.push(`server.js:${c.line} action='${c.action}' no probable-cause hypothesis`)
    }
  }

  for (const signal of ['actionVerb', 'entityRef', 'reason', 'nextStep', 'cause']) {
    it(`signal '${signal}': ${counts[signal]} violations ≤ baseline ${BASELINE[signal]}`, () => {
      if (counts[signal] > BASELINE[signal]) {
        // Print details so the operator can fix or ratchet.
        // eslint-disable-next-line no-console
        console.log(`HXX12 violations for ${signal}:\n  ${detail[signal].join('\n  ')}`)
      }
      expect(counts[signal], `Signal '${signal}' regressed`)
        .toBeLessThanOrEqual(BASELINE[signal])
    })
  }

  it('reports per-signal counts (informational summary)', () => {
    // Surface the counts for `pnpm vitest --reporter=verbose` so the
    // ratchet can be visually tracked. Does not assert.
    // eslint-disable-next-line no-console
    console.log('HXX12 per-signal counts:', counts, 'baseline:', BASELINE)
    expect(typeof counts.actionVerb).toBe('number')
  })
})

// ── Test 2: 12 fixture-based renderHealExplanation tests ─────────────

const RENDER_FIXTURES = [
  {
    label: 'auto_pause — mailbox SMTP 535 cluster',
    input: {
      action: 'auto_pause',
      entity_type: 'mailbox',
      entity_id: 3,
      entity_label: 'a.mazher@email.cz',
      reason: '3× SMTP 535 v 8 minutách',
      threshold: { failures: 3, window_min: 8 },
      next_step: 'Cooldown 30 min, poté auto_resume',
      probable_cause: 'Rotace přihlašovacích údajů na seznam.cz',
    },
    expected: {
      actionVerb: 'Pozastaveno',
      entityRef: 'mb=3',
      reason: 'SMTP 535',
      nextStep: 'Cooldown 30 min',
      cause: 'Rotace',
    },
  },
  {
    label: 'auto_resume — mailbox cooldown elapsed',
    input: {
      action: 'auto_resume',
      entity_type: 'mailbox',
      entity_id: 3,
      reason: 'Cooldown 30 min vypršel',
      next_step: 'Sledovat dalších 3 odeslání',
      probable_cause: 'Předchozí rate limiting odezněl',
    },
    expected: {
      actionVerb: 'Obnoveno',
      entityRef: 'mb=3',
      reason: 'Cooldown',
      nextStep: 'Sledovat',
      cause: 'rate limiting',
    },
  },
  {
    label: 'engine_restart — sender daemon panic',
    input: {
      action: 'engine_restart',
      entity_type: 'engine',
      entity_id: 'sender_daemon',
      reason: 'panic: anti-trace down (503 cascade)',
      next_step: 'Cold-start engine, breaker half-open po 60s',
      probable_cause: 'Anti-trace relay 503 cascade',
    },
    expected: {
      actionVerb: 'Restart engine',
      entityRef: 'engine=sender_daemon',
      reason: 'anti-trace down',
      nextStep: 'Cold-start',
      cause: 'cascade',
    },
  },
  {
    label: 'cron_recovery — fullCheck previous tick failed',
    input: {
      action: 'cron_recovery',
      entity_type: 'cron',
      entity_id: 'fullCheck',
      reason: 'Předchozí tick selhal s timeoutem 30s',
      next_step: 'Příští tick za 12 minut',
      probable_cause: 'IMAP server pomalu odpovídá',
    },
    expected: {
      actionVerb: 'Cron obnoven',
      entityRef: 'cron=fullCheck',
      reason: 'timeoutem',
      nextStep: 'Příští tick',
      cause: 'pomalu',
    },
  },
  {
    label: 'proxy_rotate — exhausted endpoint',
    input: {
      action: 'proxy_rotate',
      entity_type: 'mailbox',
      entity_id: 7,
      reason: 'Aktuální proxy 5× za sebou selhala (CONNECT timeout)',
      next_step: 'Probe nový endpoint z fresh poolu',
      probable_cause: 'Endpoint zablokován cílovým SMTP serverem',
    },
    expected: {
      actionVerb: 'Proxy přepnuta',
      entityRef: 'mb=7',
      reason: 'CONNECT timeout',
      nextStep: 'Probe',
      cause: 'zablokován',
    },
  },
  {
    label: 'breaker_reset — half-open after cooldown',
    input: {
      action: 'breaker_reset',
      entity_type: 'mailbox',
      entity_id: 12,
      reason: 'Breaker open 30 min vypršel',
      next_step: 'Probe send, při úspěchu plný close',
      probable_cause: 'Tranzientní výpadek odezněl',
    },
    expected: {
      actionVerb: 'Breaker resetován',
      entityRef: 'mb=12',
      reason: 'Breaker open',
      nextStep: 'Probe send',
      cause: 'výpadek',
    },
  },
  {
    label: 'suppression_added — bounce-back',
    input: {
      action: 'suppression_added',
      entity_type: 'campaign',
      entity_id: 42,
      reason: 'Bounce hard 550 5.1.1 — adresa neexistuje',
      next_step: 'Email blacklisted napříč všemi kampaněmi',
      probable_cause: 'Adresa zrušena nebo překlep při exportu',
    },
    expected: {
      actionVerb: 'Doplněno na suppression',
      entityRef: 'camp=42',
      reason: 'Bounce hard 550',
      nextStep: 'blacklisted',
      cause: 'zrušena',
    },
  },
  {
    label: 'manual_review_required — escalation terminal',
    input: {
      action: 'manual_review_required',
      entity_type: 'mailbox',
      entity_id: 3,
      reason: '3 cykly auto_pause/resume v 30 min',
      next_step: 'Operátor musí ručně potvrdit ACK přes /ops',
      probable_cause: 'Mailbox cyklí mezi pauzou a resume — auth nestabilní',
    },
    expected: {
      actionVerb: 'ESKALACE',
      entityRef: 'mb=3',
      reason: 'cykly',
      nextStep: 'Operátor',
      cause: 'cyklí',
    },
  },
  {
    label: 'health_recheck — full-check forced after pause',
    input: {
      action: 'health_recheck',
      entity_type: 'mailbox',
      entity_id: 5,
      reason: 'Auto-pause stáří > 1h, vyžadován re-check',
      next_step: 'Při OK přepnout do active, jinak ponechat paused',
      probable_cause: 'Bezpečnostní revize stavu po cooldownu',
    },
    expected: {
      actionVerb: 'Spuštěn full-check',
      entityRef: 'mb=5',
      reason: 'stáří',
      nextStep: 'OK přepnout',
      cause: 'revize',
    },
  },
  {
    label: 'cache_evict — stale full-check cache',
    input: {
      action: 'cache_evict',
      entity_type: 'mailbox',
      entity_id: 9,
      reason: 'TTL 5 min vypršel, ale operator vyvolal manual recheck',
      next_step: 'Příští SELECT proběhne live',
      probable_cause: 'Operator override — chce čerstvý stav',
    },
    expected: {
      actionVerb: 'Vyhozena položka cache',
      entityRef: 'mb=9',
      reason: 'TTL 5 min',
      nextStep: 'live',
      cause: 'override',
    },
  },
  {
    label: 'warmup_advance — day++ after healthy 24h',
    input: {
      action: 'warmup_advance',
      entity_type: 'mailbox',
      entity_id: 11,
      reason: '24h bez bounce, day 7 → 8',
      next_step: 'Daily cap 50 → 65',
      probable_cause: 'Reputace stoupá podle plánu',
    },
    expected: {
      actionVerb: 'Warmup posunut',
      entityRef: 'mb=11',
      reason: 'bez bounce',
      nextStep: 'Daily cap',
      cause: 'Reputace',
    },
  },
  {
    label: 'warmup_pause — degraded score',
    input: {
      action: 'warmup_pause',
      entity_type: 'mailbox',
      entity_id: 4,
      reason: 'Score klesl o 25 bodů během 6h',
      next_step: 'Pauza warmupu, eskalace operátorovi',
      probable_cause: 'Možný spam-trap zásah, čeká se na investigaci',
    },
    expected: {
      actionVerb: 'Warmup pozastaven',
      entityRef: 'mb=4',
      reason: 'Score klesl',
      nextStep: 'eskalace',
      cause: 'spam-trap',
    },
  },
]

describe('renderHealExplanation — 12 fixture suite (all action types)', () => {
  it('covers every action in ACTION_VERBS', () => {
    const acted = new Set(RENDER_FIXTURES.map(f => f.input.action))
    for (const action of KNOWN_ACTIONS) {
      expect(acted, `Action '${action}' has no fixture`).toContain(action)
    }
  })

  for (const f of RENDER_FIXTURES) {
    it(`renders + validates: ${f.label}`, () => {
      const text = renderHealExplanation(f.input)
      expect(typeof text).toBe('string')
      expect(text.length).toBeGreaterThan(0)
      const v = validateExplanation(text, f.expected)
      expect(v.ok, `validation missing: ${v.missing.join(',')}`).toBe(true)
      expect(v.missing).toEqual([])
      // No English fallbacks / formatting glitches
      expect(text).not.toMatch(/undefined/)
      expect(text).not.toMatch(/\bnull\b/)
      expect(text).not.toMatch(/\[object Object]/)
    })
  }

  it('multi-line render also validates', () => {
    const f = RENDER_FIXTURES[0]
    const text = renderHealExplanation(f.input, { multiline: true })
    expect(text.includes('\n')).toBe(true)
    const v = validateExplanation(text, f.expected)
    expect(v.ok).toBe(true)
  })
})

// ── Test 3: 50-row smoke test through parseHealLog → renderHealExplanation

function buildSmokeRows(n) {
  const actions = Array.from(KNOWN_ACTIONS)
  const entityTypes = ['mailbox', 'engine', 'cron', 'campaign']
  const reasons = [
    '3× SMTP 535 v 8 min',
    'Cooldown 30 min vypršel',
    'Breaker tripped na 5 selhání',
    'IMAP timeout 30s',
    'Bounce hard 550 5.1.1',
    'Score klesl o 20 bodů',
  ]
  const nextSteps = [
    'Cooldown 30 min, poté auto-retry',
    'Probe nový endpoint',
    'Eskalace operátorovi přes /ops',
    'Příští tick za 12 minut',
    null,
  ]
  const causes = [
    'Rotace přihlášení',
    'Anti-trace cascade',
    'Operator override',
    'Reputace stoupá',
    null,
  ]
  const out = []
  for (let i = 0; i < n; i += 1) {
    const action = actions[i % actions.length]
    const entity_type = entityTypes[i % entityTypes.length]
    const entity_id = entity_type === 'engine' ? 'sender_daemon'
      : entity_type === 'cron' ? 'fullCheck'
      : (i % 20) + 1
    // Build created_at first, then derive resolved_at strictly AFTER it
    // so duration_ms is always positive when the row resolved.
    const createdAt = new Date(Date.now() - (i + 1) * 60 * 60_000)
    const resolvedAt = i % 3 === 0
      ? null
      : new Date(createdAt.getTime() + 30 * 60_000)
    out.push({
      id: i + 1,
      entity_type,
      entity_id,
      entity_label: entity_type === 'mailbox' ? `mb${i}@example.cz` : null,
      action,
      reason: reasons[i % reasons.length],
      next_step: nextSteps[i % nextSteps.length],
      probable_cause: causes[i % causes.length],
      resolved_at: resolvedAt ? resolvedAt.toISOString() : null,
      created_at: createdAt.toISOString(),
    })
  }
  return out
}

describe('Heal-explanation smoke — 50 healing_log rows', () => {
  const rows = buildSmokeRows(50)

  it('all 50 rows pass parseHealLog', () => {
    for (const r of rows) {
      const parsed = parseHealLog(r)
      expect(parsed.action).toBe(r.action)
      expect(typeof parsed.is_open).toBe('boolean')
    }
  })

  it('all 50 rows produce non-empty Czech strings via renderHealExplanation', () => {
    for (const r of rows) {
      const text = renderHealExplanation(r)
      expect(typeof text).toBe('string')
      expect(text.length).toBeGreaterThan(0)
    }
  })

  it('no rendered string contains "undefined" or "[object Object]"', () => {
    for (const r of rows) {
      const text = renderHealExplanation(r)
      expect(text).not.toMatch(/undefined/)
      expect(text).not.toMatch(/\[object Object]/)
    }
  })

  it('no rendered string falls back to English ("null" / "NaN" stand-ins)', () => {
    for (const r of rows) {
      const text = renderHealExplanation(r)
      // entity_label may legitimately contain "null" inside "@example.null" in
      // pathological cases — guard with word boundaries.
      expect(text).not.toMatch(/\bNaN\b/)
      expect(text).not.toMatch(/\bnull\b/)
    }
  })

  it('multi-line option is structurally valid for all 50 rows', () => {
    for (const r of rows) {
      const text = renderHealExplanation(r, { multiline: true })
      // Every row that has at least one optional field should split.
      // Rows without next_step OR probable_cause may stay single-line.
      const expectsSplit = Boolean(r.next_step) || Boolean(r.probable_cause)
      if (expectsSplit) expect(text.includes('\n')).toBe(true)
    }
  })

  it('parseHealLog mirrors resolved_at into is_open + duration_ms', () => {
    let openCount = 0
    let resolvedCount = 0
    for (const r of rows) {
      const p = parseHealLog(r)
      if (p.is_open) openCount += 1
      else {
        resolvedCount += 1
        expect(p.duration_ms).toBeGreaterThan(0)
      }
    }
    // Half-and-half-ish; just verify both branches exercised.
    expect(openCount).toBeGreaterThan(0)
    expect(resolvedCount).toBeGreaterThan(0)
  })
})

// ── Test 4: edge-case validation behaviour (≥4 cases) ─────────────────

describe('validateExplanation — edge cases', () => {
  it('missing probable-cause is allowed (cause expected key omitted)', () => {
    const text = 'Pozastaveno mb=3 (3× SMTP 535) · Cooldown 30 min'
    const v = validateExplanation(text, {
      actionVerb: 'Pozastaveno',
      entityRef:  'mb=3',
      reason:     'SMTP 535',
      nextStep:   'Cooldown',
      // cause omitted — must NOT be required
    })
    expect(v.ok).toBe(true)
  })

  it('missing entityRef is reported as missing', () => {
    const text = 'Pozastaveno (3× SMTP 535) · Cooldown 30 min'
    const v = validateExplanation(text, {
      actionVerb: 'Pozastaveno',
      entityRef:  'mb=3',
      reason:     'SMTP 535',
      nextStep:   'Cooldown',
    })
    expect(v.ok).toBe(false)
    expect(v.missing).toContain('entityRef')
  })

  it('non-string text returns ok=false safely', () => {
    expect(validateExplanation(null, { actionVerb: 'X' }).ok).toBe(false)
    expect(validateExplanation(undefined, {}).ok).toBe(false)
    expect(validateExplanation(42, {}).ok).toBe(false)
    expect(validateExplanation({}, {}).ok).toBe(false)
  })

  it('Czech-only output — never contains the literal "undefined" / "null"', () => {
    const t1 = renderHealExplanation({
      action: 'auto_pause',
      entity_type: 'mailbox',
      entity_id: 1,
      reason: 'x',
    })
    expect(t1).not.toMatch(/undefined|\bnull\b/)
  })

  it('multi-line and single-line render the same payload (just different separator)', () => {
    const input = {
      action: 'auto_pause',
      entity_type: 'mailbox',
      entity_id: 1,
      reason: 'r',
      next_step: 's',
      probable_cause: 'c',
    }
    const single = renderHealExplanation(input, { multiline: false })
    const multi  = renderHealExplanation(input, { multiline: true })
    expect(single.split(' · ').length).toBe(multi.split('\n').length)
  })
})
