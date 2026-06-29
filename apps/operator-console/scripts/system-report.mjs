#!/usr/bin/env node
// System health/pipeline/bottleneck report.
// Usage: node scripts/system-report.mjs [--json]
// Reads DATABASE_URL from env or .env.

import pg from 'pg'
import { readFileSync } from 'fs'

try {
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .forEach(l => { const [k, ...v] = l.split('='); if (k && v.length && !process.env[k.trim()]) process.env[k.trim()] = v.join('=').trim() })
} catch {}

const asJson = process.argv.includes('--json')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

const PROTECTION_LAYERS = [
  'anti_trace', 'proxy_pool', 'header_gate', 'warmup', 'bounce_guard',
  'circuit_breaker', 'send_rate', 'spf_dmarc', 'canary', 'watchdog',
  'db_pool', 'sender_engine',
]
const PROTECTION_LEVELS = [2, 3]

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
}
const color = (c, s) => asJson ? s : `${C[c]}${s}${C.reset}`
const hdr = (s) => asJson ? '' : `\n${C.bold}${C.cyan}${s}${C.reset}\n${'─'.repeat(Math.min(s.length, 80))}`

function ageSec(ts) {
  if (!ts) return null
  return Math.round((Date.now() - new Date(ts).getTime()) / 1000)
}
function ageLabel(sec) {
  if (sec == null) return 'never'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  if (sec < 86400) return `${Math.round(sec / 3600)}h`
  return `${Math.round(sec / 86400)}d`
}
function statusIcon(s) {
  if (s === 'ok') return color('green', '✓')
  if (s === 'skip') return color('green', '◦')
  if (s === 'warn') return color('yellow', '△')
  if (s === 'err') return color('red', '✗')
  return color('gray', '?')
}

async function probeMatrix() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (layer, level)
      layer, level, status, detail, checked_at
    FROM protection_probes
    ORDER BY layer, level, checked_at DESC
  `)
  const map = new Map()
  for (const r of rows) map.set(`${r.layer}|${r.level}`, r)
  const cells = []
  for (const layer of PROTECTION_LAYERS) {
    for (const level of PROTECTION_LEVELS) {
      const r = map.get(`${layer}|${level}`)
      cells.push({
        layer, level,
        status: r?.status || 'unknown',
        detail: r?.detail || '',
        checked_at: r?.checked_at || null,
        age_sec: ageSec(r?.checked_at),
      })
    }
  }
  return cells
}

async function openAlerts() {
  const { rows } = await pool.query(`
    SELECT id, layer, level, severity, status, consecutive_failures, last_status, detail, fired_at, acked_at
    FROM protection_alerts
    WHERE status IN ('open', 'acked')
    ORDER BY severity DESC, fired_at ASC
  `)
  return rows
}

async function recentResolvedAlerts() {
  const { rows } = await pool.query(`
    SELECT layer, level, severity, consecutive_failures, last_status, detail, fired_at, resolved_at
    FROM protection_alerts
    WHERE status = 'resolved' AND resolved_at >= now() - interval '24 hours'
    ORDER BY fired_at DESC
  `)
  return rows
}

async function mailboxHealth() {
  const { rows } = await pool.query(`
    SELECT
      m.id, m.from_address, m.status, m.consecutive_bounces, m.auth_fail_count,
      m.circuit_opened_at, m.last_send_at, m.total_sent, m.total_bounced,
      m.last_score_at,
      c.score, c.ok, c.checked_at AS cache_checked_at, c.critical, c.warnings,
      w.warmup_day, w.is_paused AS warmup_paused, w.pause_reason AS warmup_pause_reason
    FROM outreach_mailboxes m
    LEFT JOIN mailbox_check_cache c ON c.mailbox_id = m.id
    LEFT JOIN mailbox_warmup w ON w.mailbox_address = m.from_address
    ORDER BY m.id
  `)
  return rows.map(r => ({
    ...r,
    cache_age_sec: ageSec(r.cache_checked_at),
    score_age_sec: ageSec(r.last_score_at),
  }))
}

async function proxyPool() {
  // BFF default is 18001 (server.js); older 3001 caused fetch failed when
  // running pnpm report standalone. PORT env var still wins for Railway prod.
  const port = process.env.PORT || 18001
  const key = process.env.OUTREACH_API_KEY || ''
  try {
    const res = await fetch(`http://localhost:${port}/api/proxy-pool?full=1`, {
      headers: key ? { 'x-api-key': key } : {},
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return { error: `${res.status}`, working: [], total: 0 }
    const data = await res.json()
    return {
      total: data.total ?? 0,
      working_count: Array.isArray(data.working) ? data.working.length : 0,
      refreshed_at: data.refreshed_at || data.cached_at || null,
      working: data.working || [],
    }
  } catch (e) {
    return { error: e.message, working: [], total: 0 }
  }
}

// CAD-M2 / issue #557 — fetch egress debug from BFF read-through cache
// over relay /v1/egress-debug. Reports actual outbound IP + transport
// mode + Mullvad peer endpoint, so config drift (e.g. egress in CN
// instead of CZ) surfaces in pre-launch report.
async function egressDebug() {
  const port = process.env.PORT || 18001
  try {
    const res = await fetch(`http://localhost:${port}/api/anti-trace/egress`, {
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return { error: `${res.status}`, ok: false }
    return await res.json()
  } catch (e) {
    return { error: e.message, ok: false }
  }
}

async function sendStats() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE sent_at >= now() - interval '24 hours') AS sent_24h,
      COUNT(*) FILTER (WHERE sent_at >= now() - interval '1 hour')  AS sent_1h,
      COUNT(*) FILTER (WHERE sent_at >= now() - interval '5 minutes') AS sent_5m
    FROM send_events
  `).catch(() => ({ rows: [{}] }))
  return rows[0]
}

async function bounceStats() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS bounced_24h,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND classification = 'hard') AS hard_24h,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND classification = 'soft') AS soft_24h
    FROM bounce_events
  `).catch(() => ({ rows: [{}] }))
  return rows[0]
}

async function authFails() {
  const { rows } = await pool.query(`
    SELECT mailbox_id, COUNT(*) AS fails_24h, MAX(created_at) AS last_at
    FROM auth_events
    WHERE created_at >= now() - interval '24 hours' AND success = false
    GROUP BY mailbox_id
    ORDER BY fails_24h DESC
  `).catch(() => ({ rows: [] }))
  return rows
}

async function traceCoverage() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(se.id)                         AS total_sent,
      COUNT(pt.message_id)                 AS traced,
      CASE WHEN COUNT(se.id) = 0 THEN NULL
           ELSE ROUND(COUNT(pt.message_id) * 100.0 / COUNT(se.id), 1)
      END                                  AS coverage_pct
    FROM send_events se
    LEFT JOIN protection_trace pt ON pt.message_id = se.message_id
    WHERE se.sent_at >= now() - interval '24 hours'
  `).catch(() => ({ rows: [{}] }))
  return rows[0]
}

async function campaigns() {
  const { rows } = await pool.query(`
    SELECT id, name, status, updated_at, sending_config FROM campaigns ORDER BY id DESC LIMIT 20
  `).catch(() => ({ rows: [] }))
  return rows
}

async function circuitBreakers() {
  const { rows } = await pool.query(`
    SELECT id, from_address, circuit_opened_at
    FROM outreach_mailboxes
    WHERE circuit_opened_at IS NOT NULL
    ORDER BY circuit_opened_at DESC
  `)
  return rows
}

// ── New report sections ──────────────────────────────────────────────────

async function activeCampaignDetail() {
  // Show ANY currently-running campaigns + their send + reply pulse.
  const { rows: camps } = await pool.query(`
    SELECT c.id, c.name, c.status,
           (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id) AS enrolled,
           c.created_at, c.started_at
    FROM campaigns c
    WHERE c.status IN ('running', 'active', 'draft', 'paused')
    ORDER BY c.id DESC
    LIMIT 5
  `).catch(() => ({ rows: [] }))

  // Per-campaign breakdown: send_events status counts + reply count
  const detailed = []
  for (const c of camps) {
    const { rows: stats } = await pool.query(`
      SELECT status, COUNT(*)::int AS n
      FROM send_events WHERE campaign_id = $1 GROUP BY status
    `, [c.id]).catch(() => ({ rows: [] }))
    const { rows: replies } = await pool.query(`
      SELECT classification, COUNT(*)::int AS n
      FROM reply_inbox WHERE campaign_id = $1 GROUP BY classification
    `, [c.id]).catch(() => ({ rows: [] }))
    detailed.push({ ...c, sends: stats, replies })
  }
  return detailed
}

async function s5EncryptionStatus() {
  // Phase 1: column exists? Phase 2: rows populated?
  const { rows: cols } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'outreach_mailboxes'
      AND column_name IN ('password', 'password_encrypted')
  `).catch(() => ({ rows: [] }))
  const hasEncrypted = cols.some(r => r.column_name === 'password_encrypted')
  const hasPlaintext = cols.some(r => r.column_name === 'password')

  let stats = { plaintext_count: 0, encrypted_count: 0, both_count: 0 }
  if (hasEncrypted) {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE password IS NOT NULL AND password <> '')::int AS plaintext_count,
        COUNT(*) FILTER (WHERE password_encrypted IS NOT NULL)::int AS encrypted_count,
        COUNT(*) FILTER (WHERE password IS NOT NULL AND password <> '' AND password_encrypted IS NOT NULL)::int AS both_count
      FROM outreach_mailboxes
    `).catch(() => ({ rows: [{}] }))
    stats = rows[0] || stats
  } else if (hasPlaintext) {
    const { rows } = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE password IS NOT NULL AND password <> '')::int AS plaintext_count
      FROM outreach_mailboxes
    `).catch(() => ({ rows: [{}] }))
    stats = { ...stats, plaintext_count: rows[0]?.plaintext_count || 0 }
  }

  // Determine phase
  let phase = 0
  if (!hasEncrypted) phase = 0  // pre-migration
  else if (stats.encrypted_count === 0) phase = 1  // column added, no data
  else if (hasPlaintext && stats.plaintext_count > 0 && stats.encrypted_count > 0) phase = 2  // both populated
  else if (!hasPlaintext) phase = 4  // plaintext dropped
  else phase = 3  // encrypted populated, Go reads switched (assumption)

  return { phase, hasEncrypted, hasPlaintext, ...stats }
}

async function dsrActivity() {
  const { rows } = await pool.query(`
    SELECT
      action,
      COUNT(*)::int AS count_24h,
      MAX(created_at) AS last_at
    FROM operator_audit_log
    WHERE action IN ('dsr_access', 'dsr_erase', 'dsr_object', 'dsr_rectify', 'unsubscribe_link')
      AND created_at > now() - interval '24 hours'
    GROUP BY action
    ORDER BY count_24h DESC
  `).catch(() => ({ rows: [] }))
  return rows
}

async function healingLogSummary() {
  const { rows } = await pool.query(`
    SELECT
      action,
      COUNT(*)::int AS count_24h,
      MAX(created_at) AS last_at
    FROM healing_log
    WHERE created_at > now() - interval '24 hours'
    GROUP BY action
    ORDER BY count_24h DESC
    LIMIT 10
  `).catch(() => ({ rows: [] }))
  return rows
}

async function suppressionHealth() {
  const { rows } = await pool.query(`
    SELECT
      'outreach_suppressions' AS source,
      COUNT(*)::int AS rows
    FROM outreach_suppressions WHERE email IS NOT NULL
    UNION ALL
    SELECT 'suppression_list', COUNT(*)::int FROM suppression_list WHERE email IS NOT NULL
  `).catch(() => ({ rows: [] }))
  return rows
}

function printActiveCampaigns(camps) {
  console.log(hdr('Active campaigns (last 5 in non-terminal status)'))
  if (!camps.length) {
    console.log(color('gray', '  (none)'))
    return
  }
  for (const c of camps) {
    const sentTotal = c.sends?.find(s => s.status === 'sent')?.n || 0
    const bouncedTotal = c.sends?.find(s => s.status === 'bounced')?.n || 0
    const replyTotal = (c.replies || []).reduce((s, r) => s + r.n, 0)
    console.log(
      `  #${String(c.id).padEnd(5)} ${c.name.slice(0, 40).padEnd(42)} ` +
      color(c.status === 'running' ? 'green' : 'gray', c.status.padEnd(8)) + ' ' +
      `enrolled=${c.enrolled} sent=${sentTotal} bounced=${bouncedTotal} replies=${replyTotal}`
    )
    if (replyTotal > 0) {
      const breakdown = (c.replies || []).map(r => `${r.classification}:${r.n}`).join(' ')
      console.log(`           replies: ${color('cyan', breakdown)}`)
    }
  }
}

function printS5EncryptionStatus(s) {
  console.log(hdr('S5 mailbox encryption phase status'))
  const phaseLabel = {
    0: color('gray', 'pre-migration (no password_encrypted column)'),
    1: color('yellow', 'phase 1 — column added, NO rows populated yet'),
    2: color('yellow', 'phase 2 — both columns populated; Go still reads plaintext'),
    3: color('green', 'phase 3 — Go reads encrypted (operator-coordinated)'),
    4: color('green', 'phase 4 — plaintext dropped, encrypted is sole source'),
  }[s.phase] || 'unknown'
  console.log(`  Phase: ${phaseLabel}`)
  console.log(`  password column exists: ${s.hasPlaintext ? 'yes' : 'no'}`)
  console.log(`  password_encrypted column exists: ${s.hasEncrypted ? 'yes' : 'no'}`)
  console.log(`  rows with plaintext: ${s.plaintext_count}`)
  console.log(`  rows with encrypted: ${s.encrypted_count}`)
  if (s.both_count > 0) console.log(`  rows with BOTH (transitional): ${s.both_count}`)
}

function printDsrActivity(rows) {
  console.log(hdr('GDPR DSR activity (last 24h)'))
  if (!rows.length) {
    console.log(color('gray', '  (none — no opt-outs, no access requests, no erasures)'))
    return
  }
  for (const r of rows) {
    console.log(`  ${r.action.padEnd(20)} count=${r.count_24h}  last: ${ageLabel(ageSec(r.last_at))} ago`)
  }
}

function printHealingLogSummary(rows) {
  console.log(hdr('Healing log activity (last 24h)'))
  if (!rows.length) {
    console.log(color('gray', '  (none)'))
    return
  }
  for (const r of rows) {
    console.log(`  ${r.action.padEnd(28)} count=${r.count_24h}  last: ${ageLabel(ageSec(r.last_at))} ago`)
  }
}

function printSuppressionHealth(rows) {
  console.log(hdr('Suppression compliance (UNION both tables)'))
  let total = 0
  for (const r of rows) {
    console.log(`  ${r.source.padEnd(22)} ${r.rows} rows`)
    total += r.rows
  }
  if (total === 0) {
    console.log(color('yellow', '  ⚠  Both tables empty — preflight gate would block campaign launch'))
  }
}

function printMatrix(cells) {
  console.log(hdr('Ochrany — 12 × 2 probe matrix (L2 alive, L3 correct)'))
  const layers = [...new Set(cells.map(c => c.layer))]
  console.log(
    'layer'.padEnd(18) +
    ' L2'.padEnd(22) +
    ' L3'.padEnd(22) +
    ' status'
  )
  for (const layer of layers) {
    const l2 = cells.find(c => c.layer === layer && c.level === 2)
    const l3 = cells.find(c => c.layer === layer && c.level === 3)
    const both = [l2, l3].every(c => c.status === 'ok' || c.status === 'skip')
    const fmt = (c) => `${statusIcon(c.status)} ${(c.status + '').padEnd(5)} ${color('gray', ageLabel(c.age_sec).padStart(4))}`
    console.log(
      layer.padEnd(18) +
      ' ' + fmt(l2).padEnd(31) +
      ' ' + fmt(l3).padEnd(31) +
      ' ' + (both ? color('green', 'ok') : color('red', 'DEGRADED'))
    )
  }
  const total = cells.length
  const green = cells.filter(c => c.status === 'ok' || c.status === 'skip').length
  console.log(`\nCells: ${color(green === total ? 'green' : 'red', `${green}/${total} green`)}`)
}

function printAlerts(open, resolved) {
  console.log(hdr('Aktivní alerty (open/acked)'))
  if (!open.length) {
    console.log(color('green', '  žádné aktivní alerty'))
  } else {
    for (const a of open) {
      console.log(
        `  ${color(a.severity === 'critical' ? 'red' : 'yellow', a.severity.toUpperCase().padEnd(8))} ` +
        `${a.layer} L${a.level}  ` +
        `${color('gray', a.detail || a.last_status)}  ` +
        `${color('gray', `fired ${ageLabel(ageSec(a.fired_at))} ago`)}`
      )
    }
  }
  if (resolved.length) {
    console.log(color('gray', `\n  ${resolved.length} alertů vyřešeno za posledních 24h`))
  }
}

function printMailboxes(mbs) {
  console.log(hdr('Mailboxes — health, warmup, pipeline'))
  console.log(
    'id'.padEnd(4) +
    ' email'.padEnd(30) +
    ' stat'.padEnd(6) +
    ' score'.padEnd(7) +
    ' day'.padEnd(5) +
    ' last_chk'.padEnd(10) +
    ' issues'
  )
  for (const m of mbs) {
    const scoreColor = m.score >= 90 ? 'green' : m.score >= 70 ? 'yellow' : 'red'
    const crit = Array.isArray(m.critical) ? m.critical : []
    const warn = Array.isArray(m.warnings) ? m.warnings : []
    const issues = [
      ...crit.map(s => color('red', `✗${s}`)),
      ...warn.map(s => color('yellow', `△${s}`)),
    ].join(' ')
    console.log(
      String(m.id).padEnd(4) +
      ' ' + String(m.from_address).padEnd(29) +
      ' ' + color(m.status === 'active' ? 'green' : 'yellow', String(m.status).padEnd(6)) +
      ' ' + color(scoreColor, String(m.score ?? '-').padEnd(6)) +
      ' ' + String(m.warmup_day ?? '-').padEnd(4) +
      ' ' + color('gray', (ageLabel(m.cache_age_sec) || '-').padEnd(9)) +
      ' ' + (issues || color('green', 'OK'))
    )
  }
}

function printProxyPool(data) {
  console.log(hdr('Proxy pool'))
  if (data.error) { console.log(color('red', `  BFF error: ${data.error}`)); return }
  const working = data.working_count ?? 0
  const total = data.total ?? 0
  const age = data.refreshed_at ? ageLabel(ageSec(data.refreshed_at)) : '?'
  console.log(`  ${color(working > 0 ? 'green' : 'red', `${working} working`)} / ${total} total  ${color('gray', `refreshed ${age} ago`)}`)
  for (const p of (data.working || []).slice(0, 8)) {
    console.log(
      `  ${color('green', '✓')} ${String(p.addr || p.address || '?').padEnd(28)} ` +
      `${color('gray', `${p.country || '??'} src=${p.source || '?'}`.padEnd(18))} ` +
      `${color('gray', `lat=${p.last_latency_ms ?? p.probe_ms ?? '?'}ms`)}`
    )
  }
}

function printCampaigns(rows) {
  console.log(hdr('Campaigns'))
  if (!rows.length) { console.log(color('gray', '  žádné kampaně')); return }
  const counts = rows.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {})
  const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')
  console.log(`  ${summary}`)
  for (const r of rows.slice(0, 8)) {
    const st = ['running', 'sending'].includes(r.status) ? color('green', r.status) : color('gray', r.status)
    console.log(`  #${r.id}  ${String(r.name).padEnd(40)}  ${st}`)
  }
}

function printPipeline(sends, bounces, trace) {
  console.log(hdr('Pipeline — send / bounce / trace coverage'))
  console.log(`  sends:   ${sends.sent_5m ?? 0} / 5m   ${sends.sent_1h ?? 0} / 1h   ${sends.sent_24h ?? 0} / 24h`)
  const hardN = Number(bounces.hard_24h ?? 0)
  const softN = Number(bounces.soft_24h ?? 0)
  console.log(`  bounces: ${color(hardN ? 'red' : 'green', `hard=${hardN}`)}  ${color(softN ? 'yellow' : 'green', `soft=${softN}`)} / 24h`)
  const cov = trace.coverage_pct
  const covColor = cov == null ? 'gray' : cov >= 99 ? 'green' : cov >= 95 ? 'yellow' : 'red'
  console.log(`  trace:   ${color(covColor, `${cov ?? '-'}%`)}  (${trace.traced ?? 0}/${trace.total_sent ?? 0} messages / 24h)`)
}

function printAuthFails(rows) {
  console.log(hdr('Auth fails (24h)'))
  if (!rows.length) { console.log(color('green', '  žádné')); return }
  for (const r of rows) {
    console.log(`  mb=${r.mailbox_id}  fails=${color('red', r.fails_24h)}  last ${ageLabel(ageSec(r.last_at))} ago`)
  }
}

// CAD-M2 / issue #557 — egress sanity (transport mode + actual egress IP +
// Mullvad peer endpoint). Surfaces config drift before launch (e.g. relay
// configured for CZ Mullvad but routing through CN exit).
function printEgressSanity(egress) {
  console.log(hdr('Egress sanity (anti-trace egress IP + transport)'))
  if (!egress || egress.error) {
    console.log(`  ${color('red', '✗ unable to fetch')} ${color('gray', egress?.error || egress?.reason || 'unknown')}`)
    return
  }
  if (!egress.ok && egress.reason) {
    console.log(`  ${color('yellow', '△ degraded')} ${color('gray', egress.reason)}`)
    return
  }
  const mode = egress.transport_mode || '(unset)'
  const ip = egress.current_egress_ip || '(probe failed)'
  const peer = egress.mullvad_peer_endpoint || '(no Mullvad peer parsed)'
  const wp = egress.wireproxy_active ? 'active' : 'inactive'
  console.log(`  transport_mode:        ${color(mode === 'socks5' ? 'green' : 'red', mode)}`)
  console.log(`  wireproxy:             ${color(egress.wireproxy_active ? 'green' : 'red', wp)}`)
  console.log(`  current_egress_ip:     ${ip}`)
  console.log(`  mullvad_peer_endpoint: ${peer}`)
  if (egress.probe_error) {
    console.log(`  ${color('yellow', '△ probe error:')} ${color('gray', egress.probe_error)}`)
  }
  if (Array.isArray(egress.notes) && egress.notes.length) {
    for (const n of egress.notes) {
      console.log(`  ${color('yellow', '△')} ${color('gray', n)}`)
    }
  }
}

function printCircuits(rows) {
  console.log(hdr('Circuit breakers (open)'))
  if (!rows.length) { console.log(color('green', '  žádný otevřený circuit')); return }
  for (const r of rows) {
    console.log(`  mb=${r.id}  ${r.from_address}  open ${ageLabel(ageSec(r.circuit_opened_at))}`)
  }
}

export const STALE_THRESHOLD_SEC = { 2: 600, 3: 2400 }

// Issue #486: weekend / after-hours suppression for `no_sends_despite_running`.
// When EVERY running campaign's sending_config window is closed at `now`,
// the absence of sends in last 24h is expected behaviour, not an incident.
export function evaluateSendWindows(runningCampaigns, now = new Date()) {
  if (!runningCampaigns.length) return { allClosed: false, nextOpen: null }
  const evals = runningCampaigns.map(c => {
    const cfg = c.sending_config || {}
    if (!cfg.send_window_start || !cfg.send_window_end) {
      return { isOpen: true, nextOpen: null }
    }
    return windowState(cfg, now)
  })
  if (evals.every(e => e.isOpen)) return { allClosed: false, nextOpen: null }
  if (!evals.every(e => !e.isOpen)) return { allClosed: false, nextOpen: null }
  const nexts = evals.map(e => e.nextOpen).filter(Boolean)
  const nextOpen = nexts.length
    ? new Date(Math.min(...nexts.map(d => d.getTime())))
    : null
  return { allClosed: true, nextOpen }
}

// Pure window evaluator — no DB, no clock side-effects. Treats
// send_window_start/end as wall-clock 'HH:MM' in cfg.timezone.
// `weekdays_only=true` excludes Sat/Sun.
export function windowState(cfg, now) {
  const tz = cfg.timezone || 'Europe/Prague'
  const [sh, sm] = String(cfg.send_window_start).split(':').map(Number)
  const [eh, em] = String(cfg.send_window_end).split(':').map(Number)
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  })
  const parts = fmt.formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {})
  const nowMin = Number(parts.hour) * 60 + Number(parts.minute)
  const weekday = parts.weekday
  const weekend = weekday === 'Sat' || weekday === 'Sun'
  const dayAllowed = !cfg.weekdays_only || !weekend
  const inWindow = nowMin >= startMin && nowMin < endMin
  if (dayAllowed && inWindow) return { isOpen: true, nextOpen: null }

  for (let dayOffset = 0; dayOffset <= 14; dayOffset++) {
    const candidate = new Date(now.getTime() + dayOffset * 86400000)
    const cParts = fmt.formatToParts(candidate).reduce((a, p) => (a[p.type] = p.value, a), {})
    const cWeekday = cParts.weekday
    const cWeekend = cWeekday === 'Sat' || cWeekday === 'Sun'
    const cDayAllowed = !cfg.weekdays_only || !cWeekend
    if (!cDayAllowed) continue
    const cMin = Number(cParts.hour) * 60 + Number(cParts.minute)
    if (dayOffset === 0 && cMin >= startMin) continue
    const minutesUntilOpen = (24 * 60 - cMin) + startMin + (dayOffset > 0 ? (dayOffset - 1) * 24 * 60 : 0)
    return { isOpen: false, nextOpen: new Date(now.getTime() + minutesUntilOpen * 60000) }
  }
  return { isOpen: false, nextOpen: null }
}

export function detectBottlenecks(data) {
  const out = []
  for (const c of data.matrix) {
    const threshold = STALE_THRESHOLD_SEC[c.level] ?? 1800
    if (c.status === 'skip') continue
    if (c.status !== 'unknown' && c.age_sec != null && c.age_sec > threshold) {
      out.push({ kind: 'stale_probe', layer: c.layer, level: c.level, age_sec: c.age_sec, severity: 'warn' })
    }
    if (c.status === 'unknown') {
      out.push({ kind: 'missing_probe', layer: c.layer, level: c.level })
    }
    if (c.status === 'err' || c.status === 'warn') {
      out.push({ kind: 'probe_not_green', layer: c.layer, level: c.level, status: c.status, detail: c.detail })
    }
  }
  const activeMbs = data.mailboxes.filter(m => m.status === 'active').length
  const runningCampaignRows = data.campaigns.filter(c => c.status === 'running' || c.status === 'sending')
  const runningCamps = runningCampaignRows.length
  const sent24h = Number(data.sends.sent_24h ?? 0)
  if (activeMbs > 0 && runningCamps > 0 && sent24h === 0) {
    // Issue #486: suppress critical when every running campaign's window
    // is closed; emit info-level outside_send_window so verdict resolves
    // to ANO (waiting for window).
    const win = evaluateSendWindows(runningCampaignRows, data._now ?? new Date())
    if (win.allClosed) {
      out.push({
        kind: 'outside_send_window',
        active_mailboxes: activeMbs,
        running_campaigns: runningCamps,
        next_open_iso: win.nextOpen ? win.nextOpen.toISOString() : null,
        severity: 'info',
      })
    } else {
      out.push({ kind: 'no_sends_despite_running', active_mailboxes: activeMbs, running_campaigns: runningCamps })
    }
  }
  for (const m of data.mailboxes) {
    if (m.status === 'active' && (m.cache_age_sec ?? 999999) > 21600) {
      out.push({ kind: 'stale_mailbox_check', mailbox_id: m.id, age_sec: m.cache_age_sec, severity: 'warn' })
    }
    // Issue #485: last_score_at >24h on active mailboxes is a critical signal —
    // the watchdog/scoring loop is broken and the report would otherwise show
    // false-green. Threshold matches the 4h Go scoring loop × 6 missed runs.
    //
    // CAD-S8 / issue #539: scoring loop moved to Go orchestrator
    // (services/orchestrator/intelligence/mailbox_score_loop.go, 4h cadence).
    // BFF reachability no longer affects scoring freshness — Go runs 24/7 on
    // Railway.  Stale score >24h is always critical regardless of BFF status.
    // bff_unreachable field kept for backward-compat with existing test fixtures
    // (PR #543) but set to false unconditionally.
    if (m.status === 'active' && (m.score_age_sec ?? Infinity) > 86400) {
      out.push({
        kind: 'stale_mailbox_score',
        mailbox_id: m.id,
        email: m.from_address,
        age_hours: Math.floor((m.score_age_sec ?? 0) / 3600),
        severity: 'critical',
        bff_unreachable: false,
      })
    }
    if (m.status === 'paused' && m.auth_fail_count > 0) {
      out.push({ kind: 'paused_auth_fail', mailbox_id: m.id, fails: m.auth_fail_count, severity: 'info' })
    }
    if (Array.isArray(m.critical) && m.critical.length) {
      out.push({ kind: 'mailbox_critical', mailbox_id: m.id, critical: m.critical, severity: m.status === 'active' ? 'critical' : 'info' })
    }
  }
  if (data.openAlerts.length) {
    out.push({ kind: 'open_alerts', count: data.openAlerts.length })
  }
  if (data.proxyPool.length && data.proxyPool.filter(p => p.working).length === 0) {
    out.push({ kind: 'no_working_proxies' })
  }

  // CAD-M2 / issue #557 — egress drift detector. When relay reports an
  // egress IP whose country is NOT in EXPECTED_EGRESS_COUNTRIES (default
  // ["CZ"]), flag as critical pre-launch blocker. probe_error alone is
  // info-level (relay reachable but probe failed; could be temporary).
  if (data.egress && data.egress.ok) {
    const expectedCountries = (process.env.EXPECTED_EGRESS_COUNTRIES || 'CZ')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    if (data.egress.transport_mode === 'direct' || data.egress.transport_mode === 'proxy') {
      out.push({
        kind: 'egress_mode_forbidden',
        mode: data.egress.transport_mode,
        severity: 'critical',
      })
    }
    // If we have an egress_country_iso (BFF/report could set this from a
    // future GeoIP step) and it's not in the allowlist, flag.
    if (data.egress.egress_country_iso && !expectedCountries.includes(data.egress.egress_country_iso.toUpperCase())) {
      out.push({
        kind: 'egress_country_drift',
        actual: data.egress.egress_country_iso,
        expected: expectedCountries.join(','),
        severity: 'critical',
      })
    }
  }
  return out
}

function printBottlenecks(bns) {
  console.log(hdr('Bottlenecks — co brzdí systém'))
  if (!bns.length) { console.log(color('green', '  nic podezřelého')); return }
  for (const b of bns) {
    const line = (() => {
      switch (b.kind) {
        case 'stale_probe': return color('yellow', `△ stale probe`) + ` ${b.layer} L${b.level} (age ${ageLabel(b.age_sec)})`
        case 'missing_probe': return color('red', `✗ missing probe`) + ` ${b.layer} L${b.level}`
        case 'probe_not_green': return color('red', `✗ probe ${b.status}`) + ` ${b.layer} L${b.level}  ${color('gray', b.detail || '')}`
        case 'stale_mailbox_check': return color('yellow', `△ stale mailbox check`) + ` mb=${b.mailbox_id} (age ${ageLabel(b.age_sec)})`
        // CAD-S8: scoring loop is in Go orchestrator; always critical >24h
        case 'stale_mailbox_score':
          return color('red', `✗ stale mailbox score`) + ` mb=${b.mailbox_id} (${b.email}) age=${b.age_hours}h — Go orchestrator score loop not running or relay unreachable`
        case 'paused_auth_fail': return color('yellow', `△ paused + auth fails`) + ` mb=${b.mailbox_id} (${b.fails} fails) — need new credentials`
        case 'mailbox_critical': return color('red', `✗ mailbox critical`) + ` mb=${b.mailbox_id}  ${b.critical.join(',')}`
        case 'open_alerts': return color('red', `✗ open alerts`) + ` count=${b.count}`
        case 'no_working_proxies': return color('red', `✗ no working proxies`)
        case 'no_sends_despite_running': return color('red', `✗ no sends despite running campaign`) + ` (${b.running_campaigns} campaigns, ${b.active_mailboxes} active mailboxes)`
        case 'egress_mode_forbidden': return color('red', `✗ egress mode forbidden`) + ` ${b.mode} (chain.go banned; relay should have failed boot)`
        case 'egress_country_drift': return color('red', `✗ egress country drift`) + ` actual=${b.actual} expected=${b.expected} — Mullvad peer config wrong, fix WIREPROXY_CONFIG on Railway`
        case 'outside_send_window': {
          const next = b.next_open_iso ? new Date(b.next_open_iso) : null
          const inLabel = next ? ageLabel(Math.round((next.getTime() - Date.now()) / 1000)) : '?'
          const nextLabel = next ? next.toISOString().replace(/\.\d+Z$/, 'Z') : 'unknown'
          return color('gray', `ℹ outside send window`) + ` — next open: ${nextLabel} (in ${inLabel})`
        }
        default: return JSON.stringify(b)
      }
    })()
    console.log(`  ${line}`)
  }
}

function verdict(data, bns) {
  const green = data.matrix.filter(c => c.status === 'ok' || c.status === 'skip').length
  const total = data.matrix.length
  const allGreen = green === total
  const noAlerts = data.openAlerts.length === 0
  const isBlocking = (b) => (b.severity === 'critical') || (b.kind === 'probe_not_green' || b.kind === 'missing_probe' || b.kind === 'no_working_proxies' || b.kind === 'open_alerts' || b.kind === 'no_sends_despite_running')
  const blockers = bns.filter(isBlocking)
  const infos    = bns.filter(b => b.severity === 'info')
  console.log(hdr('Verdict'))
  console.log(`  probes:    ${color(allGreen ? 'green' : 'red', `${green}/${total} green`)}`)
  console.log(`  alerts:    ${color(noAlerts ? 'green' : 'red', `${data.openAlerts.length} open`)}`)
  console.log(`  blockers:  ${color(blockers.length ? 'red' : 'green', blockers.length)}`)
  if (infos.length) console.log(`  info:      ${color('yellow', `${infos.length} items (paused mailboxes, retired state)`)}`)
  const rth = allGreen && noAlerts && blockers.length === 0
  // Issue #486: outside-window info renders RTH=ANO (waiting for window).
  const onlyWindowInfo = bns.length > 0 && bns.every(b => b.kind === 'outside_send_window')
  if (rth && onlyWindowInfo) {
    const next = bns[0].next_open_iso ? new Date(bns[0].next_open_iso) : null
    const inLabel = next ? ageLabel(Math.round((next.getTime() - Date.now()) / 1000)) : '?'
    console.log(`\n  RTH:       ${color('green', `✓ ANO (waiting for send window — opens in ${inLabel})`)}`)
  } else {
    console.log(`\n  RTH:       ${color(rth ? 'green' : 'red', rth ? '✓ 100 %' : '✗ NE')}`)
  }
}

async function main() {
  const [matrix, open, resolved, mailboxes, proxies, sends, bounces, fails, trace, circuits, camps, egress] = await Promise.all([
    probeMatrix(),
    openAlerts(),
    recentResolvedAlerts(),
    mailboxHealth(),
    proxyPool(),
    sendStats(),
    bounceStats(),
    authFails(),
    traceCoverage(),
    circuitBreakers(),
    campaigns(),
    egressDebug(),
  ])

  // S6.x extended sections — independent of bottleneck detection
  const [activeCamps, s5Status, dsrRows, healingRows, suppRows] = await Promise.all([
    activeCampaignDetail(),
    s5EncryptionStatus(),
    dsrActivity(),
    healingLogSummary(),
    suppressionHealth(),
  ])

  const data = {
    matrix, openAlerts: open, resolvedAlerts: resolved,
    mailboxes, proxyPool: proxies, sends, bounces, fails, trace, circuits,
    campaigns: camps,
    activeCampaigns: activeCamps,
    s5Encryption: s5Status,
    dsrActivity: dsrRows,
    healingLog: healingRows,
    suppression: suppRows,
    egress,
  }
  const bns = detectBottlenecks(data)

  if (asJson) {
    console.log(JSON.stringify({ ...data, bottlenecks: bns, generated_at: new Date().toISOString() }, null, 2))
    await pool.end()
    return
  }

  const now = new Date().toISOString()
  console.log(`${C.bold}SYSTEM REPORT${C.reset}  ${C.gray}${now}${C.reset}`)
  printMatrix(matrix)
  printAlerts(open, resolved)
  printEgressSanity(egress)
  printMailboxes(mailboxes)
  printProxyPool(proxies)
  printCampaigns(camps)
  printActiveCampaigns(activeCamps)
  printS5EncryptionStatus(s5Status)
  printSuppressionHealth(suppRows)
  printDsrActivity(dsrRows)
  printHealingLogSummary(healingRows)
  printPipeline(sends, bounces, trace)
  printAuthFails(fails)
  printCircuits(circuits)
  printBottlenecks(bns)
  verdict(data, bns)
  await pool.end()
}

main().catch(e => { console.error('REPORT FAILED:', e); process.exit(1) })
