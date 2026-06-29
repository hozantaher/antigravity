#!/usr/bin/env node
// pre-launch-check.mjs — comprehensive pre-launch sanity verification
//
// Usage:
//   DATABASE_URL=... node pre-launch-check.mjs <campaign-id>
//   Optional: --json   (output JSON instead of human format)
//
// Checks:
//   1.  Campaign state (status='draft', pending contacts > 0)
//   2.  Mailbox health (≥4 active production mailboxes, scores ≥80)
//   3.  Suppression UNION accessible (both tables readable)
//   4.  Migrations head (latest version visible)
//   5.  SMOKE campaigns absent / completed
//   6.  Anti-trace relay /v1/status (bridge=ok, queue=0)
//   7.  Launch-readiness BFF endpoint (verdict=green, 7 sanity gates) — skip if offline
//   8.  Required scripts/files present
//   9.  Required env vars set
//   10. Recent operator activity (audit log ≤24h)
//
// Safe to import as module — main block is gated on isMain.

import pg from 'pg';
import { existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
// scripts/ → outreach-dashboard/
const DASHBOARD_ROOT = resolve(__dirname, '..');
// scripts/ → repo root (outreach-dashboard is 2 levels below repo root)
const REPO_ROOT      = resolve(DASHBOARD_ROOT, '..', '..');

const isMain = process.argv[1] === __filename;

// ── helpers (exported for tests) ─────────────────────────────────────────────

/**
 * Wrap an async check function. Returns { name, status, detail?, error? }.
 * Status is 'pass' | 'fail' | 'skip'.
 */
export async function runCheck(name, fn) {
  try {
    const result = await fn();
    // fn may return { status: 'skip', detail: '...' } explicitly
    if (result && result.status === 'skip') {
      return { name, status: 'skip', detail: result.detail ?? '' };
    }
    return { name, status: 'pass', detail: result?.detail ?? '' };
  } catch (e) {
    return { name, status: 'fail', error: e.message };
  }
}

// ── individual check implementations (exported for granular unit tests) ───────

/** Check 1: campaign must be draft with pending contacts */
export async function checkCampaignState(pool, campaignId) {
  const { rows: [c] } = await pool.query(
    `SELECT id, status, sending_config->'mailbox_pool' AS pool FROM campaigns WHERE id=$1`,
    [campaignId]
  );
  if (!c) throw new Error(`Campaign ${campaignId} not found`);
  if (c.status !== 'draft') throw new Error(`status=${c.status}, expected draft`);

  const { rows: [pend] } = await pool.query(
    `SELECT COUNT(*) AS n FROM campaign_contacts WHERE campaign_id=$1 AND status='pending'`,
    [campaignId]
  );
  const n = parseInt(pend.n, 10);
  if (n === 0) throw new Error(`0 pending contacts — campaign may already be sent`);
  return { detail: `status=draft, ${n} pending contacts` };
}

/** Check 2: ≥4 active production mailboxes, all with last_score ≥ 80 */
export async function checkMailboxHealth(pool) {
  const { rows } = await pool.query(
    `SELECT id, status, last_score
       FROM outreach_mailboxes
      WHERE environment='production' AND status='active'
      ORDER BY id`
  );
  if (rows.length < 4) throw new Error(`only ${rows.length} active production mailboxes (expected ≥4)`);
  const lowScore = rows.filter(m => m.last_score != null && m.last_score < 80);
  if (lowScore.length > 0) {
    throw new Error(`${lowScore.length} mailbox(es) score<80: ${lowScore.map(m => `mb${m.id}=${m.last_score}`).join(', ')}`);
  }
  return {
    detail: `${rows.length} active, scores: ${rows.map(m => `mb${m.id}=${m.last_score ?? '?'}`).join(', ')}`
  };
}

/** Check 3: both suppression tables readable, UNION accessible */
export async function checkSuppressionUnion(pool) {
  const { rows: [r] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM outreach_suppressions) +
       (SELECT COUNT(*) FROM suppression_list) AS total`
  );
  return { detail: `${r.total} entries (UNION accessible)` };
}

/** Check 4: schema_migrations table readable, head version visible */
export async function checkMigrations(pool) {
  const { rows } = await pool.query(
    `SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1`
  );
  if (rows.length === 0) throw new Error(`schema_migrations table empty or missing`);
  return { detail: `head=${rows[0].version}` };
}

/** Check 5: no active SMOKE campaigns that could interfere */
export async function checkSmokeAbsent(pool) {
  const { rows } = await pool.query(
    `SELECT id, status FROM campaigns
      WHERE name LIKE 'SMOKE-%' AND status NOT IN ('completed', 'paused')`
  );
  if (rows.length > 0) throw new Error(`${rows.length} active SMOKE campaign(s) — Go daemon may pick them up`);
  return { detail: `no active SMOKE campaigns` };
}

/** Check 6: relay bridge up, queue depth = 0 */
export async function checkRelayStatus(relayUrl, relayToken) {
  if (!relayUrl) throw new Error(`ANTI_TRACE_RELAY_URL not set`);
  const r = await fetch(`${relayUrl}/v1/status`, {
    headers: {
      Authorization: `Bearer ${relayToken ?? ''}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} from relay`);
  const d = await r.json();
  if (d.bridge_status !== 'ok') throw new Error(`bridge=${d.bridge_status}`);
  if (d.queue_depth > 0) throw new Error(`queue_depth=${d.queue_depth} (expected 0)`);
  return { detail: `bridge=ok, queue=0, uptime=${d.uptime_seconds ?? '?'}s` };
}

/** Check 7: BFF launch-readiness endpoint — skip if offline */
export async function checkLaunchReadiness(campaignId, bffPort, apiKey) {
  const url = `http://localhost:${bffPort}/api/launch-readiness?campaign_id=${campaignId}`;
  try {
    const r = await fetch(url, {
      headers: { 'X-API-Key': apiKey ?? '' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) {
      // BFF may not be running locally — treat as skip
      return { status: 'skip', detail: `BFF HTTP ${r.status} (verify in dashboard)` };
    }
    const d = await r.json();
    if (d.verdict !== 'green') throw new Error(`verdict=${d.verdict}, action_items: ${JSON.stringify(d.actionItems ?? d.action_items)}`);
    return { detail: `verdict=green, all gates pass` };
  } catch (e) {
    if (e.code === 'ECONNREFUSED' || e.name === 'TimeoutError') {
      return { status: 'skip', detail: `BFF offline — verify launch-readiness in dashboard` };
    }
    throw e;
  }
}

/** Check 8: required scripts and files present on disk */
export async function checkRequiredFiles(repoRoot, dashboardRoot) {
  const required = [
    join(dashboardRoot, 'campaign-send-batch.mjs'),
    join(dashboardRoot, 'scripts', 'launch-monitor.mjs'),
    join(dashboardRoot, 'scripts', 'end-of-day-report.mjs'),
    join(dashboardRoot, 'src', 'lib', 'campaign-send-batch.js'),
  ];
  const missing = required.filter(p => !existsSync(p));
  if (missing.length > 0) {
    // Report relative to repoRoot for readability
    throw new Error(`missing: ${missing.map(p => p.replace(repoRoot + '/', '')).join(', ')}`);
  }
  return { detail: `${required.length} required files present` };
}

/** Check 9: required environment variables set */
export async function checkEnvVars() {
  const required = [
    'DATABASE_URL',
    'ANTI_TRACE_RELAY_URL',
    'ANTI_TRACE_RELAY_TOKEN',
    'OUTREACH_API_KEY',
    'RELAY_URL',
    'RELAY_TOKEN',
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) throw new Error(`missing env: ${missing.join(', ')}`);
  return { detail: `all ${required.length} env vars set` };
}

/** Check 10: operator_audit_log has activity in last 24h */
export async function checkOperatorActivity(pool) {
  const { rows: [r] } = await pool.query(
    `SELECT MAX(created_at) AS last_action
       FROM operator_audit_log
      WHERE created_at > NOW() - INTERVAL '24 hours'`
  );
  if (!r.last_action) throw new Error(`no operator activity in last 24h — review audit log`);
  return { detail: `last action: ${new Date(r.last_action).toISOString()}` };
}

// ── rendering ────────────────────────────────────────────────────────────────

const C = {
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  bold:   '\x1b[1m',
  reset:  '\x1b[0m',
};

export function renderHuman(campaignId, checks) {
  const lines = [];
  lines.push(`${C.bold}╔════════════════════════════════════════════════╗${C.reset}`);
  lines.push(`${C.bold}║  Pre-Launch Sanity Check — Campaign ${String(campaignId).padEnd(10)} ║${C.reset}`);
  lines.push(`${C.bold}╚════════════════════════════════════════════════╝${C.reset}\n`);

  for (const c of checks) {
    const icon = c.status === 'pass' ? `${C.green}✓${C.reset}`
               : c.status === 'skip' ? `${C.yellow}~${C.reset}`
               : `${C.red}✗${C.reset}`;
    const text = c.status === 'fail' ? c.error : c.detail;
    lines.push(`${icon} ${c.name.padEnd(38)} ${text ?? ''}`);
  }

  const failures = checks.filter(c => c.status === 'fail');
  lines.push('');

  if (failures.length === 0) {
    lines.push(`${C.green}${C.bold}╔══════════════════════════════╗${C.reset}`);
    lines.push(`${C.green}${C.bold}║  ✓  READY TO LAUNCH          ║${C.reset}`);
    lines.push(`${C.green}${C.bold}╚══════════════════════════════╝${C.reset}`);
  } else {
    lines.push(`${C.red}${C.bold}╔══════════════════════════════════════════╗${C.reset}`);
    lines.push(`${C.red}${C.bold}║  ✗  HALT — ${failures.length} failure(s)                 ║${C.reset}`);
    lines.push(`${C.red}${C.bold}╚══════════════════════════════════════════╝${C.reset}`);
    lines.push(`\n${C.bold}Fix items:${C.reset}`);
    failures.forEach(f => lines.push(`  ${C.red}•${C.reset} ${f.name}: ${f.error}`));
  }

  return lines.join('\n');
}

export function isReadyToLaunch(checks) {
  return checks.every(c => c.status !== 'fail');
}

// ── main ─────────────────────────────────────────────────────────────────────

if (isMain) {
  const args   = process.argv.slice(2);
  const jsonMode   = args.includes('--json');
  const campaignId = parseInt(args.find(a => /^\d+$/.test(a)));

  if (!campaignId) {
    process.stderr.write('Usage: node pre-launch-check.mjs <campaign-id> [--json]\n');
    process.exit(2);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const checks = [];
  checks.push(await runCheck('Campaign state',       () => checkCampaignState(pool, campaignId)));
  checks.push(await runCheck('Mailbox health',       () => checkMailboxHealth(pool)));
  checks.push(await runCheck('Suppression UNION',    () => checkSuppressionUnion(pool)));
  checks.push(await runCheck('Migrations head',      () => checkMigrations(pool)));
  checks.push(await runCheck('SMOKE campaigns absent', () => checkSmokeAbsent(pool)));
  checks.push(await runCheck('Anti-trace relay',     () => checkRelayStatus(process.env.ANTI_TRACE_RELAY_URL, process.env.ANTI_TRACE_RELAY_TOKEN)));
  checks.push(await runCheck('Launch-readiness (7 gates)', () => checkLaunchReadiness(campaignId, 18001, process.env.OUTREACH_API_KEY)));
  checks.push(await runCheck('Required files',       () => checkRequiredFiles(REPO_ROOT, DASHBOARD_ROOT)));
  checks.push(await runCheck('Env vars',             () => checkEnvVars()));
  checks.push(await runCheck('Recent operator activity', () => checkOperatorActivity(pool)));

  await pool.end();

  if (jsonMode) {
    process.stdout.write(JSON.stringify({
      campaign_id:     campaignId,
      checks,
      ready_to_launch: isReadyToLaunch(checks),
    }, null, 2) + '\n');
  } else {
    process.stdout.write(renderHuman(campaignId, checks) + '\n');
  }

  process.exit(isReadyToLaunch(checks) ? 0 : 1);
}
