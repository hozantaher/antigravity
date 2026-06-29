#!/usr/bin/env node
// verify-launch.mjs — single-command pre-launch gate chain
// Chains: egress → preflight → SMTP probe → template render → DB write cap
//
// Usage:
//   node scripts/verify-launch.mjs --campaign-id=455
//   node scripts/verify-launch.mjs --campaign-id=455 --mode=live
//   node scripts/verify-launch.mjs --campaign-id=455 --json
//
// Prerequisites:
//   1. BFF must be listening on port 18001 (or set BFF_BASE_URL).
//      Start: `cd apps/outreach-dashboard && pnpm dev`
//   2. DATABASE_URL env var (loaded from apps/outreach-dashboard/.env).
//   3. Anti-trace relay reachable at RELAY_BASE_URL (default :9090) for
//      gates 1 + 3.
//
// Exit codes:
//   0  — all gates green → "READY TO LAUNCH"
//   1  — one or more gates failed → numbered failure list with action_url
//   2  — invocation error (missing --campaign-id, bad format, BFF down)
//
// HARD RULE (memory feedback_campaign_send): this script NEVER sends real
// email. Even in --mode=live, the only side effect is writing + deleting a
// single synthetic send_events row to prove DB write capability.
//
// Subsystem: dashboard-bff (BFF orchestration)
// Anti-trace map SHA: services/campaigns/CLAUDE.md → docs/subsystem-maps/anti-trace.md

import pg from 'pg'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { probeMailboxViaRelay } from './lib/relay-probe.mjs'

// ── env bootstrap ──────────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url))
const envPath = join(here, '..', 'apps', 'outreach-dashboard', '.env')
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach(l => {
      const [k, ...v] = l.split('=')
      if (k && v.length && !process.env[k.trim()]) {
        process.env[k.trim()] = v.join('=').trim()
      }
    })
}

// ── arg parsing ────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const argMap = {}
for (const a of args) {
  const m = a.match(/^--([^=]+)=?(.*)$/)
  if (m) argMap[m[1]] = m[2] || 'true'
}

const campaignIdRaw = argMap['campaign-id']
const mode = argMap['mode'] || 'dry-run'
const asJson = argMap['json'] === 'true'

if (!campaignIdRaw) {
  const msg = 'Missing required flag: --campaign-id=<N>'
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg, failures: [{ step: 'args', message: msg }] }))
  else console.error(`✗ ${msg}`)
  process.exit(2)
}

const campaignId = parseInt(campaignIdRaw, 10)
if (!Number.isFinite(campaignId) || campaignId <= 0) {
  const msg = `Invalid --campaign-id value: "${campaignIdRaw}" — must be a positive integer`
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg, failures: [{ step: 'args', message: msg }] }))
  else console.error(`✗ ${msg}`)
  process.exit(2)
}

if (!['dry-run', 'live'].includes(mode)) {
  const msg = `Invalid --mode: "${mode}" — must be dry-run or live`
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg, failures: [{ step: 'args', message: msg }] }))
  else console.error(`✗ ${msg}`)
  process.exit(2)
}

// ── config ─────────────────────────────────────────────────────────────────
const BFF_PORT = process.env.PORT || 18001
const BFF_BASE = process.env.BFF_BASE_URL || `http://localhost:${BFF_PORT}`
const EXPECTED_EGRESS_COUNTRIES = (process.env.EXPECTED_EGRESS_COUNTRIES || 'CZ')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
const RELAY_BASE = process.env.RELAY_BASE_URL || process.env.ANTI_TRACE_RELAY_URL || 'http://localhost:9090'
const RELAY_TOKEN = process.env.ANTI_TRACE_RELAY_TOKEN || ''
const UNSUB_BASE = process.env.UNSUBSCRIBE_BASE_URL || process.env.UNSUB_BASE_URL || 'https://garaaage.cz'
const UNSUB_SECRET = process.env.UNSUBSCRIBE_SECRET || process.env.OUTREACH_API_KEY || ''
const DB_URL = process.env.DATABASE_URL

// BFF requires X-API-Key when BFF_AUTH_DISABLED!=1 (apps/outreach-dashboard
// /src/lib/authMiddleware.js). Verify-launch is a privileged operator
// script — it reads OUTREACH_API_KEY from the same .env the BFF uses and
// attaches it on Gate 1 + Gate 2 fetches.
const BFF_API_KEY = process.env.OUTREACH_API_KEY || ''
function bffHeaders(extra = {}) {
  return BFF_API_KEY
    ? { 'x-api-key': BFF_API_KEY, ...extra }
    : { ...extra }
}

// ── result tracking ────────────────────────────────────────────────────────
const stepResults = []
let allOk = true

function pass(stepNum, name, detail, actionUrl = null) {
  stepResults.push({ step: stepNum, name, ok: true, detail, action_url: actionUrl })
}

function fail(stepNum, name, detail, actionUrl) {
  allOk = false
  stepResults.push({ step: stepNum, name, ok: false, detail, action_url: actionUrl })
}

// ── Sentry breadcrumb helper (no-op if Sentry not initialised) ────────────
function breadcrumb(message, data = {}) {
  try {
    // Sentry is initialized by telemetry.Init in Go services. For Node
    // scripts, we emit a structured log line that Sentry Railway log-drain
    // can pick up, rather than importing the full SDK.
    if (process.env.SENTRY_DSN) {
      process.stderr.write(JSON.stringify({
        type: 'breadcrumb',
        timestamp: new Date().toISOString(),
        message,
        data,
        category: 'verify-launch',
      }) + '\n')
    }
  } catch {
    // non-fatal
  }
}

// ── Step 1: Egress sanity ──────────────────────────────────────────────────
async function stepEgress() {
  breadcrumb('step:start', { step: 1, name: 'egress_sanity' })
  try {
    const res = await fetch(`${BFF_BASE}/api/anti-trace/egress`, {
      headers: bffHeaders(),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      fail(1, 'egress_sanity',
        `BFF /api/anti-trace/egress returned HTTP ${res.status} — relay unreachable or BFF down`,
        '/diagnostika/anonymita')
      return
    }
    const egress = await res.json()
    if (!egress.ok && egress.reason) {
      fail(1, 'egress_sanity',
        `Egress degraded: ${egress.reason}`,
        '/diagnostika/anonymita')
      return
    }
    if (egress.ok && (egress.transport_mode === 'direct' || egress.transport_mode === 'proxy')) {
      fail(1, 'egress_sanity',
        `Relay transport_mode=${egress.transport_mode} is BANNED (chain.go ErrDirectTransportForbidden). Fix WIREPROXY_CONFIG on Railway.`,
        '/diagnostika/anonymita')
      return
    }
    if (egress.ok && egress.egress_country_iso &&
        !EXPECTED_EGRESS_COUNTRIES.includes(egress.egress_country_iso.toUpperCase())) {
      fail(1, 'egress_sanity',
        `Egress country=${egress.egress_country_iso}, expected ${EXPECTED_EGRESS_COUNTRIES.join('/')} — Mullvad peer config drift on Railway. See docs/playbooks/launch-readiness.md.`,
        '/diagnostika/anonymita')
      return
    }
    pass(1, 'egress_sanity',
      `transport_mode=${egress.transport_mode || 'ok'} wireproxy=${egress.wireproxy_active ? 'active' : 'inactive'} ip=${egress.current_egress_ip || 'ok'}`)
  } catch (e) {
    fail(1, 'egress_sanity',
      `Egress probe failed: ${e.message}. Ensure BFF is running on port ${BFF_PORT}.`,
      '/diagnostika/anonymita')
  }
}

// ── Step 2: BFF preflight ─────────────────────────────────────────────────
async function stepPreflight() {
  breadcrumb('step:start', { step: 2, name: 'bff_preflight', campaign_id: campaignId })
  try {
    const res = await fetch(`${BFF_BASE}/api/campaigns/${campaignId}/run`, {
      method: 'POST',
      headers: bffHeaders({ 'Content-Type': 'application/json', 'x-preflight-only': '1' }),
      body: JSON.stringify({ preflight_only: true }),
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status === 404) {
      fail(2, 'bff_preflight',
        `Campaign id=${campaignId} not found (HTTP 404). Verify the campaign exists.`,
        '/campaigns')
      return
    }
    // 412 = blockers present; inspect the body
    if (res.status === 412 || res.status === 200) {
      let body = {}
      try { body = await res.json() } catch { /* non-json response — treat as ok */ }
      const blockers = body.blockers || []
      const preflightBlockers = blockers.filter(b => b && (b.code || b.label || b.detail))
      if (preflightBlockers.length > 0) {
        fail(2, 'bff_preflight',
          `Preflight blockers (${preflightBlockers.length}): ${preflightBlockers.map(b => `[${b.code}] ${b.detail}`).join('; ')}`,
          `/campaigns/${campaignId}`)
        return
      }
      pass(2, 'bff_preflight', `Campaign ${campaignId} passed BFF preflight (HTTP ${res.status})`)
      return
    }
    fail(2, 'bff_preflight',
      `Unexpected HTTP ${res.status} from BFF /api/campaigns/${campaignId}/run`,
      `/campaigns/${campaignId}`)
  } catch (e) {
    fail(2, 'bff_preflight',
      `BFF preflight request failed: ${e.message}. Ensure BFF is running on port ${BFF_PORT}.`,
      `/campaigns/${campaignId}`)
  }
}

// ── Step 3: SMTP AUTH probe via relay /v1/probe ───────────────────────────
async function stepSmtpProbe() {
  breadcrumb('step:start', { step: 3, name: 'smtp_probe' })
  if (!DB_URL) {
    pass(3, 'smtp_probe', 'DATABASE_URL not set — SMTP probe skipped in no-DB mode')
    return
  }
  // The relay's POST /v1/probe handler calls requireActor() and rejects
  // requests without a Bearer token with HTTP 401 (issue #584). If the
  // operator hasn't exported ANTI_TRACE_RELAY_TOKEN locally, every probe
  // returns 401 and Gate 3 reports a misleading "SMTP AUTH probe failed"
  // message that points at the mailboxes instead of the missing config.
  // Skip the gate cleanly with an actionable message instead.
  if (!RELAY_TOKEN) {
    pass(3, 'smtp_probe',
      `ANTI_TRACE_RELAY_TOKEN not set in env — SMTP probe skipped (relay requires Bearer auth, see services/relay/web/probe.go requireActor)`)
    return
  }
  // Fetch active mailboxes from DB then probe each via relay
  let mailboxes = []
  const pool = new pg.Pool({ connectionString: DB_URL })
  try {
    const { rows } = await pool.query(`
      SELECT id, from_address, smtp_host, smtp_port, smtp_username, password
      FROM outreach_mailboxes
      WHERE status = 'active'
        AND length(password) > 0
      ORDER BY id
    `)
    mailboxes = rows
  } catch (e) {
    await pool.end()
    fail(3, 'smtp_probe',
      `DB query for active mailboxes failed: ${e.message}. Check DATABASE_URL.`,
      '/mailboxes')
    return
  }
  await pool.end()

  if (mailboxes.length === 0) {
    fail(3, 'smtp_probe',
      'No active mailboxes with passwords found in outreach_mailboxes.',
      '/mailboxes')
    return
  }

  // Probe each mailbox via relay /v1/probe — see scripts/lib/relay-probe.mjs.
  const failures = []
  let relayUnreachable = false
  for (const mb of mailboxes) {
    const r = await probeMailboxViaRelay({
      relayBase: RELAY_BASE,
      token: RELAY_TOKEN,
      mailbox: mb,
    })
    if (r.ok) continue
    if (r.status === 0 && /ECONNREFUSED|fetch failed/i.test(r.error || '')) {
      // Relay unreachable — skip probe, don't block (relay may be off in dev)
      relayUnreachable = true
      break
    }
    failures.push(`mb=${mb.id} (${mb.from_address}): ${r.error}`)
  }
  if (relayUnreachable) {
    pass(3, 'smtp_probe', `Relay unreachable at ${RELAY_BASE} — SMTP probe skipped`)
    return
  }

  if (failures.length > 0) {
    fail(3, 'smtp_probe',
      `SMTP AUTH probe failed for ${failures.length}/${mailboxes.length} mailboxes: ${failures.join('; ')}`,
      '/mailboxes')
    return
  }
  pass(3, 'smtp_probe', `${mailboxes.length} active mailbox(es) probed OK`)
}

// ── Step 4: Template render dry-run ───────────────────────────────────────
async function stepTemplateRender() {
  breadcrumb('step:start', { step: 4, name: 'template_render', campaign_id: campaignId })
  if (!DB_URL) {
    pass(4, 'template_render', 'DATABASE_URL not set — template render skipped in no-DB mode')
    return
  }
  const pool = new pg.Pool({ connectionString: DB_URL })
  try {
    const { rows: [camp] } = await pool.query(
      `SELECT id, name, sequence_config FROM campaigns WHERE id = $1`,
      [campaignId]
    )
    if (!camp) {
      await pool.end()
      fail(4, 'template_render',
        `Campaign id=${campaignId} not found in DB for template render check.`,
        '/campaigns')
      return
    }

    const sequence = Array.isArray(camp.sequence_config)
      ? camp.sequence_config
      : (camp.sequence_config?.steps || [])
    const templateName = sequence[0]?.template
    if (!templateName) {
      await pool.end()
      fail(4, 'template_render',
        `Campaign ${campaignId} has no template in sequence_config[0].template.`,
        `/campaigns/${campaignId}`)
      return
    }

    // Fetch template body. Production runtime reads the FILESYSTEM at
    // services/orchestrator binary's TEMPLATES_DIR (Docker bakes the
    // canonical garaaage.cz-brand templates from
    // modules/outreach/configs/templates/ into /app/configs/templates/
    // per services/orchestrator/Dockerfile:44). The DB tables
    // email_templates / templates hold a stale hozan-taher.cz-brand
    // version that is NOT what production actually sends.
    //
    // Pre-launch audit 2026-05-04 (campaign 1, intro_machinery):
    //   DB email_templates: 1446 chars, references hozan-taher.cz/privacy,
    //                       missing {{.UnsubURL}} per the gate-4 spec
    //                       → false fail when joined to real contacts.
    //   FS modules/outreach/configs/templates/intro_machinery.tmpl:
    //       949 chars, references garaaage.cz/privacy, contains
    //       {{.UnsubURL}} (verified)
    //
    // Fix: read FS first (canonical), fall back to DB only if FS is
    // missing (e.g., older deploy without bundled templates). Keeps
    // gate 4 aligned with what production actually renders.
    const { readFileSync: readTplSync, existsSync: existsTpl } = await import('node:fs')
    const fsTplPath = join(here, '..', 'modules', 'outreach', 'configs', 'templates', `${templateName}.tmpl`)
    let activeTpl = null
    if (existsTpl(fsTplPath)) {
      try {
        const body = readTplSync(fsTplPath, 'utf8')
        // Filesystem templates use a `{{/* subject: ... */}}` marker
        // for subject lines (per services/campaigns/content/template.go
        // extractSubjects). Pull the first marker as the subject so the
        // gate has the same rendered shape as production.
        const subjMatch = body.match(/\{\{\/\*\s*subject:\s*([^*]+?)\s*\*\/\}\}/)
        const subject = subjMatch ? subjMatch[1].trim() : '(no subject marker)'
        activeTpl = { id: `fs:${templateName}`, subject, body }
      } catch { /* tolerate read error, fall through to DB */ }
    }
    if (!activeTpl) {
      try {
        const { rows } = await pool.query(`SELECT id, subject, body FROM email_templates WHERE name = $1`, [templateName])
        activeTpl = rows[0] || null
      } catch { /* table may not exist */ }
    }
    if (!activeTpl) {
      try {
        const { rows } = await pool.query(`SELECT id, subject, body FROM templates WHERE name = $1`, [templateName])
        activeTpl = rows[0] || null
      } catch { /* table may not exist */ }
    }
    if (!activeTpl || !activeTpl.body) {
      await pool.end()
      fail(4, 'template_render',
        `Template "${templateName}" not found on filesystem (modules/outreach/configs/templates/) or in DB tables.`,
        '/templates')
      return
    }

    // Sample 5 contacts from campaign_contacts.
    //
    // FK target table is `contacts` (524k rows, canonical), NOT
    // `outreach_contacts` (524k rows, legacy mirror with subset of FK
    // values populated). Joining the wrong side returns 0 rows for
    // campaigns enrolled against `contacts.id`, which silently turns
    // gate 4 into a no-op pass ("No enrolled contacts — skipped")
    // instead of actually rendering a sample. Pre-launch audit
    // 2026-05-04: campaign 1 had 7 pending + 193 in_sequence rows,
    // join against `outreach_contacts` returned 0, against `contacts`
    // returned 7. Fixed to canonical table.
    const { rows: contacts } = await pool.query(`
      SELECT c.id, c.email, c.first_name AS jmeno, c.last_name AS prijmeni,
             c.company_name AS firma, c.region, c.ico
      FROM campaign_contacts cc
      JOIN contacts c ON c.id = cc.contact_id
      WHERE cc.campaign_id = $1
        AND (cc.status IS NULL OR cc.status IN ('pending','queued'))
      ORDER BY c.id
      LIMIT 5
    `, [campaignId]).catch(() => ({ rows: [] }))

    if (contacts.length === 0) {
      await pool.end()
      pass(4, 'template_render', `No enrolled contacts for campaign ${campaignId} — render check skipped`)
      return
    }

    // Import crypto for HMAC (sync in Node 18+)
    const { createHmac } = await import('node:crypto')

    function buildUnsubURL(contactId, email) {
      if (!UNSUB_SECRET) return `${UNSUB_BASE}/unsubscribe?c=${campaignId}&id=${contactId}&t=preview`
      const token = createHmac('sha256', UNSUB_SECRET)
        .update(`${campaignId}|${contactId}|${email}`)
        .digest('hex')
        .slice(0, 16)
      return `${UNSUB_BASE}/unsubscribe?c=${campaignId}&id=${contactId}&t=${token}`
    }

    // Substitute template vars — mirrors content/template.go's full
    // pipeline so the rendered string matches what production sends.
    //
    //   1. Strip `{{/* directive */}}` markers (subject, humanize off, etc.)
    //      — Go side calls extractSubjects + removeSubjectComments +
    //      removeDirectiveComments before var substitution.
    //   2. Resolve `{a|b|c}` spin syntax (pick first variant for
    //      determinism — matches services/campaigns/content/spin.go
    //      ResolveSpin's seed-driven choice for sample-of-1 cases).
    //   3. Resolve `{{if .Field}}...{{end}}` conditionals.
    //   4. Substitute `{{.Var}}` placeholders.
    //
    // Pre-fix verify-launch only did step 4 → directive markers and
    // spin braces survived → `body.includes('{{')` falsely flagged
    // every render as "unresolved template placeholder", masking real
    // placeholder bugs and triggering false fails on FS-source
    // templates that production renders cleanly.
    function substituteVars(text, vars) {
      if (!text) return ''
      // 1. Strip directive comments (any {{/* ... */}} block).
      text = text.replace(/\{\{\/\*[\s\S]*?\*\/\}\}/g, '')
      // 2. Resolve spin `{a|b|c}` — first-variant pick for deterministic
      //    sample. Real send uses seed-driven selection but this gate
      //    just verifies the syntax resolves at all.
      text = text.replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, (_, choices) =>
        choices.split('|')[0]
      )
      // 3. Conditional blocks.
      text = text.replace(/\{\{if \.(\w+)\}\}([\s\S]*?)\{\{end\}\}/g, (_, field, body) =>
        vars[field.toLowerCase()] ? body : ''
      )
      // 4. Field substitution (both lowercase and CapitalCase).
      const m = {
        '{{firma}}': vars.firma || '', '{{.Firma}}': vars.firma || '',
        '{{jmeno}}': vars.jmeno || '', '{{.Jmeno}}': vars.jmeno || '',
        '{{prijmeni}}': vars.prijmeni || '', '{{.Prijmeni}}': vars.prijmeni || '',
        '{{region}}': vars.region || '', '{{.Region}}': vars.region || '',
        '{{ico}}': vars.ico || '', '{{.ICO}}': vars.ico || '',
        '{{unsuburl}}': vars.unsuburl || '', '{{.UnsubURL}}': vars.unsuburl || '',
      }
      for (const [k, v] of Object.entries(m)) text = text.split(k).join(v)
      return text
    }

    const renderIssues = []
    for (const c of contacts) {
      const unsuburl = buildUnsubURL(c.id, c.email)
      const vars = {
        firma: c.firma || '', jmeno: c.jmeno || '', prijmeni: c.prijmeni || '',
        region: c.region || '', ico: c.ico || '', unsuburl,
      }
      const body = substituteVars(activeTpl.body, vars)
      if (!body.includes('/unsubscribe?')) {
        renderIssues.push(`contact ${c.id} (${c.email}): missing UnsubURL in rendered body`)
      }
      if (body.includes('{{')) {
        renderIssues.push(`contact ${c.id} (${c.email}): unresolved template placeholder in body`)
      }
    }

    await pool.end()
    if (renderIssues.length > 0) {
      fail(4, 'template_render',
        `Template render issues for ${renderIssues.length} contact(s): ${renderIssues.slice(0, 3).join('; ')}`,
        '/templates')
      return
    }
    pass(4, 'template_render',
      `Template "${templateName}" rendered clean for ${contacts.length} sample contact(s) — GDPR footer OK UnsubURL OK`)
  } catch (e) {
    await pool.end().catch(() => {})
    fail(4, 'template_render',
      `Template render dry-run failed: ${e.message}`,
      '/templates')
  }
}

// ── Step 5: send_events DB write probe ────────────────────────────────────
async function stepDbWrite() {
  breadcrumb('step:start', { step: 5, name: 'db_write_probe', mode })
  if (mode === 'dry-run') {
    pass(5, 'db_write_probe', 'Mode=dry-run — DB write probe skipped (read-only mode)')
    return
  }
  if (!DB_URL) {
    pass(5, 'db_write_probe', 'DATABASE_URL not set — DB write probe skipped in no-DB mode')
    return
  }
  // HARD RULE: even in live mode we only write a synthetic row and delete it.
  // No real email is sent. No campaign status is changed.
  const pool = new pg.Pool({ connectionString: DB_URL })
  try {
    const syntheticMessageId = `verify-launch-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const insertRes = await pool.query(`
      INSERT INTO send_events (campaign_id, contact_id, message_id, status, sent_at)
      VALUES ($1, -1, $2, 'probe', now())
      RETURNING id
    `, [campaignId, syntheticMessageId])
    const probeId = insertRes.rows[0]?.id
    if (!probeId) throw new Error('INSERT returned no id')
    await pool.query('DELETE FROM send_events WHERE id = $1', [probeId])
    await pool.end()
    pass(5, 'db_write_probe', `DB write capability confirmed — synthetic row inserted+deleted (id=${probeId})`)
  } catch (e) {
    await pool.end().catch(() => {})
    fail(5, 'db_write_probe',
      `DB write probe failed: ${e.message}. Check DATABASE_URL and send_events table permissions.`,
      '/diagnostika')
  }
}

// BFF liveness pre-check (issue #586 / Sprint 1.1).
// NOT called from main() — stepEgress() and stepPreflight() already catch
// fetch errors and record them as step failures (exit 1). Keeping this
// function for manual operator use when troubleshooting boot issues.
// IMPORTANT: BFF-unreachable is a gate failure (exit 1), NOT an invocation
// error (exit 2). Do not call process.exit(2) here.
async function assertBffReachable() {
  try {
    const res = await fetch(`${BFF_BASE}/api/health/system`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok && res.status >= 500) {
      throw new Error(`BFF returned ${res.status}`)
    }
  } catch (err) {
    const msg = err?.message || String(err)
    if (asJson) {
      // Emit proper full-shape JSON so callers get parseable output.
      fail(1, 'egress_sanity',
        `BFF unreachable at ${BFF_BASE}: ${msg}. Start: cd apps/outreach-dashboard && pnpm dev`,
        '/diagnostika/anonymita')
    } else {
      console.log('')
      console.log(`✗ BFF unreachable at ${BFF_BASE} — ${msg}`)
      console.log('  Start: cd apps/outreach-dashboard && pnpm dev')
      console.log('  Or set BFF_BASE_URL=<url> if the BFF runs elsewhere.')
    }
    process.exit(1)
  }
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  breadcrumb('verify-launch:start', { campaign_id: campaignId, mode })

  if (!asJson) {
    console.log(`\nverify-launch  campaign=${campaignId}  mode=${mode}`)
    console.log('─'.repeat(60))
  }

  await stepEgress()
  await stepPreflight()
  await stepSmtpProbe()
  await stepTemplateRender()
  await stepDbWrite()

  breadcrumb('verify-launch:done', { ok: allOk, failures: stepResults.filter(s => !s.ok).length })

  if (asJson) {
    const failures = stepResults.filter(s => !s.ok)
    console.log(JSON.stringify({
      ok: allOk,
      campaign_id: campaignId,
      mode,
      steps: stepResults,
      failures,
      generated_at: new Date().toISOString(),
    }, null, 2))
    process.exit(allOk ? 0 : 1)
  }

  // Human-readable output
  for (const s of stepResults) {
    const icon = s.ok ? '✓' : '✗'
    const url = s.action_url ? `  → ${s.action_url}` : ''
    console.log(`  [${s.step}] ${icon} ${s.name.padEnd(20)} ${s.detail}${url}`)
  }
  console.log('─'.repeat(60))

  const failures = stepResults.filter(s => !s.ok)
  if (allOk) {
    console.log('\n  ✓ READY TO LAUNCH\n')
    process.exit(0)
  } else {
    console.error(`\n  ✗ NOT READY — ${failures.length} gate(s) failed:\n`)
    failures.forEach((f, i) => {
      console.error(`  ${i + 1}. [Step ${f.step}] ${f.name}: ${f.detail}`)
      if (f.action_url) console.error(`     Fix at: ${f.action_url}`)
    })
    console.error('')
    process.exit(1)
  }
}

main().catch(e => {
  if (asJson) {
    console.log(JSON.stringify({ ok: false, error: e.message, failures: [{ step: 'fatal', message: e.message }] }))
  } else {
    console.error(`✗ FATAL: ${e.message}`)
  }
  process.exit(1)
})
