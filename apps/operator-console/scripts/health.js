#!/usr/bin/env node
/**
 * Schránky Health Score Pipeline
 * Runs unit tests + live API checks → outputs 0-100 score.
 * Usage: node scripts/health.js [--json]
 *        pnpm health
 */

import { execSync } from 'child_process'
import { readFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir   = dirname(fileURLToPath(import.meta.url))
const ROOT    = join(__dir, '..')
const BASE    = 'http://localhost:3001'
const RELAY   = 'http://localhost:8090'
const JSON_OUT = process.argv.includes('--json')

// ── ANSI colours ──────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', gray: '\x1b[90m', blue: '\x1b[34m',
  magenta: '\x1b[35m',
}
const c   = (col, t) => JSON_OUT ? t : `${C[col]}${t}${C.reset}`
const b   = t => c('bold', t)
const dim = t => c('gray', t)

// ── HTTP helpers ──────────────────────────────────────────────────
async function api(path, opts = {}) {
  try {
    const r = await fetch(BASE + path, { ...opts, signal: AbortSignal.timeout(8000) })
    const body = await r.json().catch(() => null)
    return { ok: r.ok, status: r.status, body }
  } catch (e) {
    return { ok: false, status: 0, body: null, err: e.message }
  }
}

async function apiPost(path, data = {}) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

async function apiPatch(path, data = {}) {
  return api(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

async function apiDelete(path) {
  return api(path, { method: 'DELETE' })
}

async function relay(path) {
  try {
    const r = await fetch(RELAY + path, { signal: AbortSignal.timeout(4000) })
    return { ok: r.ok, body: await r.json().catch(() => null) }
  } catch {
    return { ok: false, body: null }
  }
}

// ── 1. Unit tests via vitest JSON reporter ─────────────────────────
function runUnitTests() {
  const outFile = join(tmpdir(), `vitest-health-${Date.now()}.json`)
  try {
    execSync(
      `pnpm vitest run --reporter=json --outputFile=${outFile}`,
      { cwd: ROOT, stdio: 'pipe' }
    )
  } catch { /* vitest exits non-zero when tests fail — that's fine */ }

  try {
    const raw = JSON.parse(readFileSync(outFile, 'utf8'))
    try { unlinkSync(outFile) } catch {}
    return {
      passed:  raw.numPassedTests  ?? 0,
      failed:  raw.numFailedTests  ?? 0,
      total:   raw.numTotalTests   ?? 0,
      suites:  raw.numTotalTestSuites ?? 0,
      ok: (raw.numFailedTests ?? 1) === 0,
    }
  } catch {
    return { passed: 0, failed: 0, total: 0, suites: 0, ok: false, err: 'parse failed' }
  }
}

// ── 2. Check registry ─────────────────────────────────────────────
const categories = []

function category(name, weight) {
  const cat = { name, weight, checks: [] }
  categories.push(cat)
  return (label, fn, timeout = 8000) => cat.checks.push({ label, fn, timeout })
}

// ── Category: Infrastructure (15 pts) ─────────────────────────────
const infra = category('Infrastructure', 15)

infra('Server on :3001 responds', async () => {
  const { ok } = await api('/api/mailboxes')
  return { pass: ok, detail: ok ? ':3001 OK' : 'connection refused' }
})

infra('DB connected — mailboxes table accessible', async () => {
  const { ok, body } = await api('/api/mailboxes')
  const pass = ok && Array.isArray(body)
  return { pass, detail: pass ? `${body.length} schránek` : 'not array' }
})

infra('Anti-trace relay on :8090 /healthz', async () => {
  const { ok, body } = await relay('/healthz')
  return { pass: ok && body?.status === 'ok', detail: ok ? 'relay UP' : 'relay DOWN' }
})

// ── Category: Mailboxes CRUD (20 pts) ─────────────────────────────
const crud = category('API: Mailboxes CRUD', 20)

crud('GET /api/mailboxes → array with required fields', async () => {
  const { ok, body } = await api('/api/mailboxes')
  if (!ok || !Array.isArray(body)) return { pass: false, detail: 'not array' }
  if (!body.length) return { pass: true, detail: 'empty (OK)' }
  const required = ['id','email','host','port','status','daily_limit','total_sent','total_bounced']
  const missing  = required.filter(f => !(f in body[0]))
  return { pass: missing.length === 0, detail: missing.length ? `missing: ${missing.join(',')}` : 'all fields present' }
})

crud('POST /api/mailboxes creates & returns id', async () => {
  const email = `health_${Date.now()}@health.internal`
  const { ok, body } = await apiPost('/api/mailboxes', {
    email, display_name: 'Health Check',
    smtp_host: 'smtp.health.internal', smtp_port: 587,
    smtp_username: email, password: 'health-pass', daily_limit: 10,
  })
  if (!ok || !body?.id) return { pass: false, detail: `status=${body?.error ?? 'unknown'}` }
  await apiDelete(`/api/mailboxes/${body.id}`)
  return { pass: true, detail: `id=${body.id} (cleaned up)` }
})

crud('PATCH /api/mailboxes/:id updates display_name', async () => {
  const email = `health_patch_${Date.now()}@health.internal`
  const { body: created } = await apiPost('/api/mailboxes', {
    email, smtp_host: 'smtp.health.internal', smtp_port: 587,
    smtp_username: email, password: 'hp', daily_limit: 10,
  })
  if (!created?.id) return { pass: false, detail: 'create failed' }
  const { ok, body } = await apiPatch(`/api/mailboxes/${created.id}`, { display_name: 'Patched Name' })
  await apiDelete(`/api/mailboxes/${created.id}`)
  const pass = ok && body?.display_name === 'Patched Name'
  return { pass, detail: pass ? 'display_name updated' : `got: ${body?.display_name}` }
})

crud('DELETE /api/mailboxes/:id removes row', async () => {
  const email = `health_del_${Date.now()}@health.internal`
  const { body: created } = await apiPost('/api/mailboxes', {
    email, smtp_host: 'smtp.health.internal', smtp_port: 587,
    smtp_username: email, password: 'hp', daily_limit: 10,
  })
  if (!created?.id) return { pass: false, detail: 'create failed' }
  const { ok, body } = await apiDelete(`/api/mailboxes/${created.id}`)
  return { pass: ok && body?.ok === true, detail: ok ? 'deleted' : `status error` }
})

// ── Category: Detail Endpoints (20 pts) ───────────────────────────
const detail = category('API: Detail Endpoints', 20)

detail('GET /api/mailboxes/:id/stats has numeric fields', async () => {
  const { body: list } = await api('/api/mailboxes')
  if (!list?.length) return { pass: true, detail: 'no mailboxes (skip)' }
  const { ok, body } = await api(`/api/mailboxes/${list[0].id}/stats`)
  const fields = ['total_sent','total_bounced','sent_30d','consecutive_bounces']
  const missing = fields.filter(f => !(f in (body || {})))
  return { pass: ok && missing.length === 0, detail: missing.length ? `missing: ${missing}` : 'all fields OK' }
})

detail('GET /api/mailboxes/:id/pipeline-results → array', async () => {
  const { body: list } = await api('/api/mailboxes')
  if (!list?.length) return { pass: true, detail: 'no mailboxes (skip)' }
  const { ok, body } = await api(`/api/mailboxes/${list[0].id}/pipeline-results`)
  return { pass: ok && Array.isArray(body), detail: ok ? `${body.length} results` : 'failed' }
})

detail('GET /api/mailboxes/:id/send-log → array', async () => {
  const { body: list } = await api('/api/mailboxes')
  if (!list?.length) return { pass: true, detail: 'no mailboxes (skip)' }
  const { ok, body } = await api(`/api/mailboxes/${list[0].id}/send-log`)
  return { pass: ok && Array.isArray(body), detail: ok ? `${body.length} entries` : 'failed' }
})

detail('PATCH /api/mailboxes/:id/warmup accepts paused toggle', async () => {
  const { body: list } = await api('/api/mailboxes')
  if (!list?.length) return { pass: true, detail: 'no mailboxes (skip)' }
  const id = list[0].id
  const r = await api(`/api/mailboxes/${id}/warmup`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: true }),
  })
  return { pass: [200, 404].includes(r.status), detail: `status=${r.status}` }
})

// ── Category: Proxy & Anti-trace (20 pts) ─────────────────────────
const proxy = category('API: Proxy & Anti-trace', 20)

proxy('GET /api/anti-trace/health → { ok: boolean }', async () => {
  const { ok, body } = await api('/api/anti-trace/health')
  const pass = ok && typeof body?.ok === 'boolean'
  return { pass, detail: pass ? `ok=${body.ok}` : 'missing ok field' }
})

proxy('GET /api/anti-trace/health live value matches relay', async () => {
  const { body: ath } = await api('/api/anti-trace/health')
  const { ok: relayOk } = await relay('/healthz')
  if (ath?.url === null) return { pass: true, detail: 'url not configured (skip)' }
  const consistent = (ath?.ok === true) === relayOk
  return { pass: consistent, detail: `api.ok=${ath?.ok}, relay.up=${relayOk}` }
})

proxy('GET /api/mailboxes/:id/proxy-live-check → { ok }', async () => {
  const { body: list } = await api('/api/mailboxes')
  if (!list?.length) return { pass: true, detail: 'no mailboxes (skip)' }
  const { ok, body } = await api(`/api/mailboxes/${list[0].id}/proxy-live-check`)
  const pass = ok && 'ok' in (body ?? {})
  return { pass, detail: pass ? `proxy.ok=${body.ok}` : 'missing ok field' }
})

proxy('GET /api/proxy-pool → required fields present', async () => {
  const { ok, body } = await api('/api/proxy-pool')
  const fields = ['total_candidates','probed','working','cached_at']
  const missing = fields.filter(f => !(f in (body ?? {})))
  return { pass: ok && missing.length === 0, detail: missing.length ? `missing: ${missing}` : `${body?.working?.length ?? 0} working` }
}, 60_000)

// ── Category: Mailbox Live Checks (25 pts) ────────────────────────
const liveChecks = category('Mailbox Live Checks', 25)

liveChecks('GET /api/mailboxes/health-summary → valid structure', async () => {
  const { ok, body } = await api('/api/mailboxes/health-summary')
  const pass = ok && typeof body?.total === 'number' && Array.isArray(body?.mailboxes)
  return { pass, detail: pass ? `${body.total} mailboxes checked` : 'invalid structure' }
})

liveChecks('health-summary score fields are 0-100', async () => {
  const { ok, body } = await api('/api/mailboxes/health-summary')
  if (!ok || !body?.mailboxes?.length) return { pass: true, detail: 'no mailboxes (skip)' }
  const valid = body.mailboxes.every(m => typeof m.score === 'number' && m.score >= 0 && m.score <= 100)
  return { pass: valid, detail: valid ? 'all scores valid' : 'invalid score range' }
})

liveChecks('GET /api/mailboxes/:id/smtp-check → valid shape', async () => {
  const { body: list } = await api('/api/mailboxes')
  if (!list?.length) return { pass: true, detail: 'no mailboxes (skip)' }
  const { ok, body } = await api(`/api/mailboxes/${list[0].id}/smtp-check`)
  const pass = ok && typeof body?.ok === 'boolean' && Array.isArray(body?.steps)
  return { pass, detail: pass ? `smtp.ok=${body.ok}` : 'invalid shape' }
}, 30_000)

liveChecks('GET /api/mailboxes/:id/imap-check → valid shape', async () => {
  const { body: list } = await api('/api/mailboxes')
  if (!list?.length) return { pass: true, detail: 'no mailboxes (skip)' }
  const { ok, body } = await api(`/api/mailboxes/${list[0].id}/imap-check`)
  const pass = ok && typeof body?.ok === 'boolean'
  return { pass, detail: pass ? `imap.ok=${body.ok}` : 'invalid shape' }
}, 30_000)

liveChecks('GET /api/mailboxes/:id/full-check score is integer 0-100', async () => {
  const { body: list } = await api('/api/mailboxes')
  if (!list?.length) return { pass: true, detail: 'no mailboxes (skip)' }
  const { ok, body } = await api(`/api/mailboxes/${list[0].id}/full-check`)
  const pass = ok && Number.isInteger(body?.score) && body.score >= 0 && body.score <= 100
  return { pass, detail: pass ? `score=${body.score}` : `invalid: ${body?.score}` }
}, 30_000)

// ── Runner ────────────────────────────────────────────────────────
async function runChecks() {
  const results = []
  for (const cat of categories) {
    cat.results = []
    for (const chk of cat.checks) {
      const t0 = Date.now()
      try {
        const r = await Promise.race([
          chk.fn(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), chk.timeout)),
        ])
        cat.results.push({ label: chk.label, pass: r.pass, detail: r.detail ?? '', ms: Date.now() - t0 })
      } catch (e) {
        cat.results.push({ label: chk.label, pass: false, detail: e.message, ms: Date.now() - t0 })
      }
    }
  }
  return results
}

// ── Score calculation ─────────────────────────────────────────────
function calcScore(unitResult) {
  const parts = []

  // Unit tests: 25 pts
  const unitPct = unitResult.total > 0 ? unitResult.passed / unitResult.total : 0
  const unitPts = Math.round(unitPct * 25)
  parts.push({ label: 'Unit Tests', pts: unitPts, max: 25, detail: `${unitResult.passed}/${unitResult.total} passed` })

  // API categories
  for (const cat of categories) {
    const passed = cat.results.filter(r => r.pass).length
    const total  = cat.results.length
    const pct    = total > 0 ? passed / total : 0
    const pts    = Math.round(pct * cat.weight)
    parts.push({ label: cat.name, pts, max: cat.weight, passed, total,
      detail: cat.results.map(r => `${r.pass ? '✓' : '✗'} ${r.label}`).join('\n') })
  }

  const total = parts.reduce((s, p) => s + p.pts, 0)
  const max   = parts.reduce((s, p) => s + p.max, 0)
  return { total, max, parts }
}

// ── Output ────────────────────────────────────────────────────────
function bar(pts, max, width = 30) {
  const filled = Math.round((pts / max) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function scoreColor(pct) {
  if (pct >= 0.9) return 'green'
  if (pct >= 0.7) return 'yellow'
  return 'red'
}

function printReport(score, unitResult, checkResults) {
  const pct = score.total / score.max
  const col = scoreColor(pct)

  console.log()
  console.log(b('┌─────────────────────────────────────────────────────────────┐'))
  console.log(b('│') + `  ${b('SCHRÁNKY HEALTH SCORE')}  ${dim(new Date().toLocaleString('cs-CZ'))}`)
  console.log(b('├─────────────────────────────────────────────────────────────┤'))

  const W_LABEL = 32, W_DETAIL = 18, W_PTS = 8
  const header  = `  ${'Kategorie'.padEnd(W_LABEL)} ${'Detail'.padEnd(W_DETAIL)} ${'Score'.padStart(W_PTS)}`
  console.log(dim(header))
  console.log(dim('  ' + '─'.repeat(W_LABEL + W_DETAIL + W_PTS + 2)))

  for (const p of score.parts) {
    const pPct   = p.pts / p.max
    const pCol   = scoreColor(pPct)
    const icon   = pPct === 1 ? c('green', '✓') : pPct >= 0.5 ? c('yellow', '~') : c('red', '✗')
    const label  = p.label.padEnd(W_LABEL)
    const detail = (p.detail?.split('\n')[0] ?? '').slice(0, W_DETAIL).padEnd(W_DETAIL)
    const pts    = c(pCol, `${p.pts}/${p.max}`.padStart(W_PTS))
    console.log(`  ${icon} ${label} ${dim(detail)} ${pts}`)

    // sub-checks for API categories
    if (p.passed !== undefined) {
      const catObj = categories.find(cat => cat.name === p.label)
      if (catObj) {
        for (const r of catObj.results) {
          const si = r.pass ? c('green', '    ✓') : c('red', '    ✗')
          console.log(`${si} ${dim(r.label.slice(0, 54))} ${dim(`${r.ms}ms`)}`)
        }
      }
    }
  }

  console.log(b('├─────────────────────────────────────────────────────────────┤'))

  const barStr = c(col, bar(score.total, score.max, 32))
  const label  = pct >= 0.9 ? c('green', b('ZDRAVÝ')) : pct >= 0.7 ? c('yellow', b('VAROVÁNÍ')) : c('red', b('KRITICKÝ'))
  console.log(`  ${barStr} ${c(col, b(`${score.total}/${score.max}`))}  ${label}`)
  console.log()

  // Failures summary
  const failures = []
  for (const cat of categories) {
    for (const r of cat.results) {
      if (!r.pass) failures.push({ cat: cat.name, label: r.label, detail: r.detail })
    }
  }
  if (unitResult.failed > 0) {
    failures.unshift({ cat: 'Unit Tests', label: `${unitResult.failed} testů selhalo`, detail: '' })
  }

  if (failures.length) {
    console.log(c('red', b('  Selhání:')))
    for (const f of failures) {
      console.log(c('red', `  ✗ [${f.cat}] ${f.label}`) + (f.detail ? dim(` — ${f.detail}`) : ''))
    }
    console.log()
  }

  console.log(b('└─────────────────────────────────────────────────────────────┘'))
  console.log()
}

// ── Main ──────────────────────────────────────────────────────────
console.log(dim('  Spouštím unit testy…'))
const unitResult = runUnitTests()
console.log(dim(`  Unit testy: ${unitResult.passed}/${unitResult.total} passed`))

console.log(dim('  Spouštím API checks…'))
await runChecks()

const score = calcScore(unitResult)

if (JSON_OUT) {
  console.log(JSON.stringify({ score: score.total, max: score.max, parts: score.parts }, null, 2))
} else {
  printReport(score, unitResult)
}

process.exit(score.total >= 70 ? 0 : 1)
