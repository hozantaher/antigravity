#!/usr/bin/env node
// dedup-replay-validation.mjs — re-evaluate last 30d send_events through dedup-guard.
//
// Simulates the dedup guard's 8-axis logic on historical send_events, reporting
// which ones WOULD HAVE BEEN blocked by the guard. Useful for confidence checks
// before activating new campaigns + post-incident audits.
//
// Reads DATABASE_URL from apps/outreach-dashboard/.env per memory
// feedback_no_pii_in_commands. Output is aggregate counts only — no email
// addresses. Sample includes only send_events.id + reason.
//
// Usage:
//   node scripts/audits/dedup-replay-validation.mjs              # full 30d
//   node scripts/audits/dedup-replay-validation.mjs --json       # machine-readable
//   pnpm dedup:replay                                            # npm shortcut
//
// Pure read-only — no UPDATE / INSERT into send_events or contacts.
// Audit log row written to operator_audit_log at end.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const envPath = join(repoRoot, 'apps', 'outreach-dashboard', '.env')

let envText
try { envText = readFileSync(envPath, 'utf8') } catch (e) {
  console.error(`✗ .env not found at ${envPath}`)
  process.exit(2)
}
const dsnLine = envText.split('\n').find(l => /^(DATABASE_URL|OUTREACH_DATABASE_URL)=/.test(l))
if (!dsnLine) {
  console.error(`✗ DATABASE_URL missing in ${envPath}`)
  process.exit(2)
}
const dsn = dsnLine.split('=', 2)[1].replace(/^"|"$/g, '')

const args = process.argv.slice(2)
const asJson = args.includes('--json')

// Dedup guard thresholds (from dedup_guard.go defaults)
const config = {
  crossCampaignCooldown: 90 * 24 * 3600 * 1000,      // 90 days
  perDomainCooldown: 180 * 24 * 3600 * 1000,          // 180 days
  lifetimeMaxTouches: 3,
  bounceClusterThreshold: 0.30,
  bounceClusterWindow: 30 * 24 * 3600 * 1000,         // 30 days
  regionMaxPerHour: 2,
  regionWindow: 1 * 3600 * 1000,                       // 1 hour
  engagementDecayMinSends: 3,
  engagementDecayWindow: 365 * 24 * 3600 * 1000,      // 365 days
  engagementDecayCooldown: 365 * 24 * 3600 * 1000,    // 365 days
}

const client = new pg.Client({ connectionString: dsn })
await client.connect()

async function checkColumnsApplied() {
  const { rows } = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'contacts' AND column_name IN ('email_domain','lifetime_touches','dnt','region','parent_ico','crm_client_id')
  `)
  return rows.length === 6
}

const applied = await checkColumnsApplied()
if (!applied) {
  if (asJson) {
    console.log(JSON.stringify({ error: 'migration_not_applied', migration: '049_dedup_guard' }))
  } else {
    console.log('⚠ Migration 049_dedup_guard not applied yet. Run: bash scripts/migrations/run.sh')
  }
  await client.end()
  process.exit(1)
}

// Fetch all send_events from the last 30 days, ordered by sent_at ASC
// so we can simulate point-in-time evaluation for each.
const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000)
const { rows: sendEvents } = await client.query(`
  SELECT se.id, se.contact_id, se.status, se.sent_at, c.dnt, c.lifetime_touches,
         c.email_domain, c.parent_ico, c.crm_client_id, c.region
  FROM send_events se
  JOIN contacts c ON c.id = se.contact_id
  WHERE se.status = 'sent' AND se.sent_at >= $1
  ORDER BY se.sent_at ASC
`, [thirtyDaysAgo])

// If no events, report cleanly
if (sendEvents.length === 0) {
  const out = {
    total_events_scanned: 0,
    would_have_blocks: {},
    sample_blocked_ids: [],
    message: '0 send_events in last 30 days to replay',
    query_time_ms: 0,
    generated_at: new Date().toISOString(),
  }
  if (asJson) {
    console.log(JSON.stringify(out, null, 2))
  } else {
    console.log('\nDedup-guard replay validation — last 30 days')
    console.log('─'.repeat(60))
    console.log('  Events scanned:               0')
    console.log('  Reason:                       no send_events in window')
  }
  await client.end()
  process.exit(0)
}

// For each event, simulate dedup guard evaluation
const blockedByAxis = {}
const blockedEvents = []
const startTime = Date.now()

for (const event of sendEvents) {
  const simulatedAt = new Date(event.sent_at)
  let blocked = false
  let reason = null

  // 1. CRM active client check (crm_client_id present)
  if (event.crm_client_id !== null && event.crm_client_id !== undefined) {
    blocked = true
    reason = 'crm_active_client'
  }

  // 2. DNT check
  if (!blocked && event.dnt === true) {
    blocked = true
    reason = 'dnt_set'
  }

  // 3. Lifetime touches >= 3
  if (!blocked && event.lifetime_touches >= config.lifetimeMaxTouches) {
    blocked = true
    reason = 'lifetime_exhausted'
  }

  // 4. Cross-campaign cooldown: check prior sends within 90d BEFORE this event
  if (!blocked) {
    const cooldownStart = new Date(simulatedAt.getTime() - config.crossCampaignCooldown)
    const { rows: priorCrossCampaign } = await client.query(`
      SELECT 1 FROM send_events
      WHERE contact_id = $1 AND status = 'sent' AND sent_at > $2 AND sent_at < $3
      LIMIT 1
    `, [event.contact_id, cooldownStart, simulatedAt])
    if (priorCrossCampaign.length > 0) {
      blocked = true
      reason = 'cross_campaign_cooldown'
    }
  }

  // 5. Bounce cluster check (if parent_ico is set)
  if (!blocked && event.parent_ico) {
    const clusterWindowStart = new Date(simulatedAt.getTime() - config.bounceClusterWindow)
    const { rows: bounceStats } = await client.query(`
      SELECT COUNT(*) as total, SUM(CASE WHEN se.status='bounced' THEN 1 ELSE 0 END) as bounced
      FROM send_events se
      JOIN contacts c ON c.id = se.contact_id
      WHERE c.parent_ico = $1 AND se.sent_at > $2 AND se.sent_at < $3
    `, [event.parent_ico, clusterWindowStart, simulatedAt])
    const total = parseInt(bounceStats[0].total || 0)
    const bounced = parseInt(bounceStats[0].bounced || 0)
    if (total >= 5 && bounced > 0) {
      const bounceRate = bounced / total
      if (bounceRate >= config.bounceClusterThreshold) {
        blocked = true
        reason = 'bounce_cluster'
      }
    }
  }

  // 6. Region rate limit: max 2 sends per hour from same region
  if (!blocked && event.region) {
    const regionWindowStart = new Date(simulatedAt.getTime() - config.regionWindow)
    const { rows: regionStats } = await client.query(`
      SELECT COUNT(*) as send_count
      FROM send_events se
      JOIN contacts c ON c.id = se.contact_id
      WHERE c.region = $1 AND se.status = 'sent' AND se.sent_at > $2 AND se.sent_at < $3
    `, [event.region, regionWindowStart, simulatedAt])
    const sendCount = parseInt(regionStats[0].send_count || 0)
    if (sendCount >= config.regionMaxPerHour) {
      blocked = true
      reason = 'region_rate_limit'
    }
  }

  // 7. Engagement decay: >= 3 sends with zero engagement in 365d
  if (!blocked) {
    const engagementWindowStart = new Date(simulatedAt.getTime() - config.engagementDecayWindow)
    const { rows: engagementStats } = await client.query(`
      SELECT COUNT(*) as sent,
             SUM(CASE WHEN (opened_at IS NOT NULL OR clicked_at IS NOT NULL) THEN 1 ELSE 0 END) as engaged
      FROM send_events
      WHERE contact_id = $1 AND status = 'sent' AND sent_at > $2 AND sent_at < $3
    `, [event.contact_id, engagementWindowStart, simulatedAt])
    const sentCount = parseInt(engagementStats[0].sent || 0)
    const engagedCount = parseInt(engagementStats[0].engaged || 0)
    if (sentCount >= config.engagementDecayMinSends && engagedCount === 0) {
      blocked = true
      reason = 'engagement_decay'
    }
  }

  // 8. Per-domain cooldown: other contact at same domain within 180d BEFORE this event
  if (!blocked && event.email_domain) {
    const domainCooldownStart = new Date(simulatedAt.getTime() - config.perDomainCooldown)
    const { rows: priorDomain } = await client.query(`
      SELECT 1 FROM send_events se
      JOIN contacts c ON c.id = se.contact_id
      WHERE c.email_domain = $1 AND se.status = 'sent' AND se.sent_at > $2
        AND se.sent_at < $3 AND se.contact_id <> $4
      LIMIT 1
    `, [event.email_domain, domainCooldownStart, simulatedAt, event.contact_id])
    if (priorDomain.length > 0) {
      blocked = true
      reason = 'per_domain_cooldown'
    }
  }

  if (blocked && reason) {
    if (!blockedByAxis[reason]) {
      blockedByAxis[reason] = 0
    }
    blockedByAxis[reason]++
    blockedEvents.push({ id: event.id, reason })
  }
}

const elapsedMs = Date.now() - startTime

// Sample up to 10 blocked events
const sample = blockedEvents.slice(0, 10)

// Write audit log row (INSERT only, read-only on send_events)
await client.query(`
  INSERT INTO operator_audit_log (action, entity_type, entity_id, details, operator_email, performed_at)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT DO NOTHING
`, [
  'dedup_replay_validation',
  'dedup_guard',
  'batch_' + Date.now(),
  JSON.stringify({
    events_scanned: sendEvents.length,
    would_have_blocks: blockedByAxis,
    sample_count: sample.length,
  }),
  'operator@audit',
  new Date(),
])

await client.end()

// Output
const out = {
  total_events_scanned: sendEvents.length,
  would_have_blocks: blockedByAxis,
  sample_blocked_ids: sample,
  query_time_ms: elapsedMs,
  generated_at: new Date().toISOString(),
}

if (asJson) {
  console.log(JSON.stringify(out, null, 2))
} else {
  console.log('\nDedup-guard replay validation — last 30 days')
  console.log('─'.repeat(60))
  console.log(`  Events scanned:               ${sendEvents.length}`)
  console.log(`  Would have been blocked:      ${Object.values(blockedByAxis).reduce((a, b) => a + b, 0)}`)
  console.log('')
  console.log('  Blocked by axis:')
  for (const [axis, count] of Object.entries(blockedByAxis)) {
    console.log(`    ${axis.padEnd(30)} ${count}`)
  }
  if (sample.length > 0) {
    console.log('')
    console.log('  Sample of would-have-blocked events (first 10):')
    for (const evt of sample) {
      console.log(`    send_events.id=${evt.id}  reason=${evt.reason}`)
    }
  }
  console.log('')
  console.log(`  Query: ${elapsedMs} ms`)
}
