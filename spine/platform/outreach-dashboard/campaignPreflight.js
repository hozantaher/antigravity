// Pre-flight gate for campaign unpause. Catches the "odpálím to a uvidíme"
// trap — where a paused campaign had its mailboxes silently drift into a
// non-ready state (proxy missing, stale full-check, empty suppression, etc.)
// and the user flips Unpause without realising nothing will send.
//
// Checks run in parallel (Promise.all) so a single slow query doesn't stall
// the whole gate. Each check returns {name, ok, reason?}. Gate is OK only
// when every check is OK.

import { SUPPRESSION_COUNT_UNION_SQL } from './src/lib/suppressionUnionSql.js'

const MIN_DAILY_CAPACITY = 100
const FULL_CHECK_FRESHNESS_HOURS = 6

export async function computeCampaignPreflight(pool, campaignId) {
  const { rows: [camp] } = await pool.query(
    `SELECT id, name, status, sequence_config FROM campaigns WHERE id=$1`,
    [campaignId]
  )
  if (!camp) return null

  const [mbRows, freshRows, supRow, tplCheck, enrollRow] = await Promise.all([
    pool.query(
      `SELECT id, from_address, proxy_url, daily_cap_override
       FROM outreach_mailboxes WHERE status='active' AND environment='production'`
    ).then(r => r.rows),
    pool.query(
      `SELECT m.id FROM outreach_mailboxes m
       JOIN LATERAL (
         SELECT ok, checked_at FROM mailbox_check_history
         WHERE mailbox_id=m.id ORDER BY checked_at DESC LIMIT 1
       ) h ON true
       WHERE m.status='active'
         AND m.environment='production'
         AND h.ok = true
         AND h.checked_at > now() - ($1 || ' hours')::interval`,
      [String(FULL_CHECK_FRESHNESS_HOURS)]
    ).then(r => r.rows),
    // Two suppression tables exist in the system:
    //   - outreach_suppressions — Go-side (reply classifier, bounce cascade)
    //   - suppression_list      — JS/BFF (manual ops UI add, server.js bounce)
    // The Go runner UNIONs both at send time (services/campaigns/campaign/runner.go,
    // suppressionFilterFor). Preflight must mirror that semantic, otherwise a
    // populated outreach_suppressions could pass while suppression_list is
    // empty (or vice versa) and the operator would think suppression is wired
    // up when only half is. Canonical SQL fragment lives in
    // src/lib/suppressionUnionSql.js (mirrors common/sqlsuppression on Go side).
    pool.query(SUPPRESSION_COUNT_UNION_SQL).then(r => r.rows[0] || { n: 0 }),
    checkTemplates(pool, camp.sequence_config),
    // MVP-2: silent-zero-send guard. POST /api/campaigns may succeed (Go
    // creates the campaign row) while category_paths matches zero companies
    // → campaign_contacts stays empty → "Start" sends nothing → operator
    // thinks campaign launched. Block preflight unless enrollment populated.
    pool.query(
      `SELECT COUNT(*)::int AS n FROM campaign_contacts WHERE campaign_id=$1`,
      [campaignId],
    ).then(r => r.rows[0] || { n: 0 }).catch(() => ({ n: 0 })),
  ])

  const checks = []

  // proxy_assignments: skip when anti-trace-relay is configured (relay handles routing)
  // Only enforce per-mailbox proxy_url when relay is absent.
  const relayConfigured = Boolean(process.env.ANTI_TRACE_URL || process.env.ANTI_TRACE_RELAY_URL)
  const withProxy = mbRows.filter(m => m.proxy_url)
  checks.push({
    name: 'proxy_assignments',
    ok: relayConfigured || (mbRows.length > 0 && withProxy.length === mbRows.length),
    reason: relayConfigured
      ? null // relay handles proxying globally
      : mbRows.length === 0
        ? 'žádné aktivní mailboxy'
        : withProxy.length < mbRows.length
          ? `${mbRows.length - withProxy.length} mailboxů bez proxy_url`
          : null,
  })

  // full_check_fresh: every active mailbox has a successful check within 6h
  const staleMbs = mbRows.length - freshRows.length
  checks.push({
    name: 'full_check_fresh',
    ok: mbRows.length > 0 && staleMbs === 0,
    reason: mbRows.length === 0
      ? 'žádné aktivní mailboxy'
      : staleMbs > 0
        ? `${staleMbs} mailboxů bez fresh full-check (≤${FULL_CHECK_FRESHNESS_HOURS}h)`
        : null,
  })

  // suppression_populated: union of both suppression tables non-empty.
  // Mirrors the runner's send-time UNION filter so preflight cannot pass
  // while the table the runner actually consults is empty.
  const supCount = Number(supRow?.n) || 0
  checks.push({
    name: 'suppression_populated',
    ok: supCount > 0,
    reason: supCount === 0 ? 'suppression listy prázdné (outreach_suppressions ∪ suppression_list) — riziko sendů na interní domény' : null,
  })

  // daily_capacity: total daily_cap_override across enabled mailboxes ≥ MIN
  const totalCap = mbRows.reduce((s, m) => s + (Number(m.daily_cap_override) || 0), 0)
  checks.push({
    name: 'daily_capacity',
    ok: totalCap >= MIN_DAILY_CAPACITY,
    reason: totalCap < MIN_DAILY_CAPACITY
      ? `denní kapacita ${totalCap} pod minimum ${MIN_DAILY_CAPACITY}`
      : null,
  })

  // templates_valid: every template referenced in sequence_config exists + non-empty
  checks.push(tplCheck)

  // MVP-2: enrollment_populated. Reject campaigns where category_paths
  // matched zero companies (Go enrollment ran but produced an empty
  // campaign_contacts table). UI Start button must consume preflight.ok
  // so this gate prevents the silent zero-send class of bug.
  const enrollCount = Number(enrollRow?.n) || 0
  checks.push({
    name: 'enrollment_populated',
    ok: enrollCount > 0,
    reason: enrollCount === 0
      ? 'campaign_contacts prázdné — žádný adresát po enrollmentu (zkontroluj category_paths/segment + Go service log)'
      : null,
    enrolled_count: enrollCount,
  })

  const ok = checks.every(c => c.ok)
  return {
    campaign_id: camp.id,
    campaign_name: camp.name,
    campaign_status: camp.status,
    ok,
    checks,
    enrolled_count: enrollCount,
  }
}

async function checkTemplates(pool, sequenceConfig) {
  const seq = normalizeSequence(sequenceConfig)
  const names = seq.map(s => s.template).filter(Boolean)
  if (!names.length) {
    return { name: 'templates_valid', ok: false, reason: 'sequence_config bez šablon' }
  }
  const { rows } = await pool.query(
    `SELECT name, subject, body FROM email_templates WHERE name = ANY($1::text[])`,
    [names]
  )
  const byName = new Map(rows.map(t => [t.name, t]))
  const missing = names.filter(n => !byName.has(n))
  if (missing.length) {
    return { name: 'templates_valid', ok: false, reason: `chybí šablony: ${missing.join(', ')}` }
  }
  const empty = rows.filter(t => !t.subject || !t.body).map(t => t.name)
  if (empty.length) {
    return { name: 'templates_valid', ok: false, reason: `prázdné šablony: ${empty.join(', ')}` }
  }
  return { name: 'templates_valid', ok: true, reason: null }
}

function normalizeSequence(sequenceConfig) {
  if (!sequenceConfig) return []
  if (Array.isArray(sequenceConfig)) return sequenceConfig
  if (Array.isArray(sequenceConfig.steps)) return sequenceConfig.steps
  return []
}

export const PREFLIGHT_CONSTANTS = {
  MIN_DAILY_CAPACITY,
  FULL_CHECK_FRESHNESS_HOURS,
}
