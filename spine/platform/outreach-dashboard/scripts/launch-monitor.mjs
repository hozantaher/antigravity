#!/usr/bin/env node
// launch-monitor.mjs — live launch monitoring dashboard
//
// Usage:
//   DATABASE_URL=... node launch-monitor.mjs <campaign-id>
//   Optional: --interval=30  (poll seconds, default 30)
//   Optional: --silent       (no terminal bell on halt advisory)
//
// Exits gracefully on Ctrl+C.
// Safe to import as a module — main loop is gated on isMain.

import pg from 'pg';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;

// ── isMain guard — exports always available, loop only runs when executed ─────
const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] === __filename;

// ── Halt criteria thresholds (exported for tests) ─────────────────────────────
export const THRESHOLDS = {
  hardBouncePct: 5,              // >5 % hard bounces of total sends
  negativeReplyPct: 20,          // >20 % negative replies
  negativeReplyMinN: 5,          // minimum sample size before checking negPct
  suppressionGrowthPerMin: 10,   // >10 new opt-outs / minute
  relayQueueStuckSec: 600,       // queue oldest age > 10 min
  mailboxLowScore: 60,           // last_score < 60 triggers halt
};

// ── Color helpers ─────────────────────────────────────────────────────────────
export const C = {
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  clear:  '\x1b[2J\x1b[H',
};

// ── Snapshot state (tracks suppression delta between polls) ──────────────────
export let lastSnapshot = { suppressionTotal: 0, snapshotAt: Date.now() };
export function resetLastSnapshot(val = { suppressionTotal: 0, snapshotAt: Date.now() }) {
  lastSnapshot = val;
}

// ── DB error state (exported for unit tests) ──────────────────────────────────
export let consecutiveFailures = 0;
export let lastSuccessAt = Date.now();

/** Reset poll error counters — called on each successful poll. */
export function resetPollError() {
  consecutiveFailures = 0;
  lastSuccessAt = Date.now();
}

/** Record a poll failure — increments counter, preserves lastSuccessAt. */
export function recordPollFailure() {
  consecutiveFailures++;
}

/**
 * Build an error snapshot from a caught poll error.
 * @param {Error} error
 * @returns {{ error: Error, consecutiveFailures: number, lastSuccessAt: number }}
 */
export function buildErrorSnapshot(error) {
  return { error, consecutiveFailures, lastSuccessAt };
}

/**
 * Render the DB-unreachable banner.
 * @param {{ error: Error, consecutiveFailures: number, lastSuccessAt: number }} snap
 * @param {number} intervalSec
 * @param {boolean} silent  — suppress bell
 */
export function renderError(snap, intervalSec = 30, silent = false) {
  const W = 50;
  process.stdout.write(C.clear);
  console.log(`${C.red}${C.bold}╔${'═'.repeat(W)}╗${C.reset}`);
  console.log(`${C.red}${C.bold}║  [!] DB UNREACHABLE${' '.repeat(W - 19)}║${C.reset}`);
  console.log(`${C.red}${C.bold}╚${'═'.repeat(W)}╝${C.reset}`);
  console.log();
  console.log(`Consecutive failures : ${snap.consecutiveFailures}`);
  const agoSec = Math.round((Date.now() - snap.lastSuccessAt) / 1000);
  console.log(`Last successful poll : ${new Date(snap.lastSuccessAt).toLocaleTimeString()} (${agoSec}s ago)`);
  console.log(`Error                : ${snap.error.message}`);
  console.log();
  console.log(`Retrying in ${intervalSec}s... (Ctrl+C to exit)`);
  // Bell on first failure only — alert operator without spam
  if (snap.consecutiveFailures === 1 && !silent) {
    process.stdout.write('\x07');
  }
}

// ── Core business logic (pure, exported for unit tests) ───────────────────────

/**
 * Evaluate halt criteria from a poll result.
 * Returns an array of human-readable halt reasons (empty = all green).
 */
export function evaluateHaltCriteria(data, prevSnapshot, nowMs = Date.now()) {
  const halts = [];
  const { totalSent, hardBounces, totalReplies, negativeReplies,
          suppressionTotal, mailboxes, relay } = data;

  // 1. Hard bounce rate
  const hardBouncePct = totalSent > 0 ? (hardBounces / totalSent * 100) : 0;
  if (hardBouncePct > THRESHOLDS.hardBouncePct) {
    halts.push(
      `HARD BOUNCE RATE ${hardBouncePct.toFixed(1)}% > ${THRESHOLDS.hardBouncePct}% threshold`
    );
  }

  // 2. Negative reply rate (only when n >= minN)
  const negPct = totalReplies > 0 ? (negativeReplies / totalReplies * 100) : 0;
  if (totalReplies >= THRESHOLDS.negativeReplyMinN && negPct > THRESHOLDS.negativeReplyPct) {
    halts.push(
      `NEGATIVE REPLY RATE ${negPct.toFixed(0)}% > ${THRESHOLDS.negativeReplyPct}% (n=${totalReplies})`
    );
  }

  // 3. Suppression growth rate
  const suppressionDelta = suppressionTotal - prevSnapshot.suppressionTotal;
  const minutesElapsed = (nowMs - prevSnapshot.snapshotAt) / 60000;
  const growthRate = minutesElapsed > 0 ? suppressionDelta / minutesElapsed : 0;
  if (growthRate > THRESHOLDS.suppressionGrowthPerMin) {
    halts.push(
      `SUPPRESSION GROWTH ${growthRate.toFixed(1)}/min > ${THRESHOLDS.suppressionGrowthPerMin}/min`
    );
  }

  // 4. Mailbox circuit breaker + low score
  for (const mb of (mailboxes ?? [])) {
    if (mb.circuit_opened_at) {
      halts.push(`Mailbox ${mb.id} CIRCUIT TRIPPED at ${mb.circuit_opened_at}`);
    }
    if (mb.last_score != null && mb.last_score < THRESHOLDS.mailboxLowScore) {
      halts.push(`Mailbox ${mb.id} LOW SCORE ${mb.last_score}/100`);
    }
  }

  // 5. Relay reachability + queue stuck
  if (relay?.unreachable) {
    halts.push(`RELAY UNREACHABLE: ${relay.error}`);
  } else if (relay?.oldest_pending_age_seconds > THRESHOLDS.relayQueueStuckSec) {
    halts.push(`RELAY QUEUE STUCK: oldest age ${relay.oldest_pending_age_seconds}s`);
  }

  return halts;
}

/**
 * Redact email addresses in a string, keeping the mailbox ID visible.
 * e.g. "mb3 user@example.com" → "mb3 mb3@…"
 */
export function redactEmail(str, mbId) {
  return str.replace(/\S+@\S+\.\S+/g, `mb${mbId}@…`);
}

// ── Main loop (only runs when executed directly, not when imported by tests) ──
if (isMain) {
  // ── CLI args ──────────────────────────────────────────────────────────────
  const args = process.argv.slice(2);
  const campaignId = parseInt(args.find(a => /^\d+$/.test(a)));
  const intervalSec = parseInt(
    args.find(a => /^--interval=/.test(a))?.split('=')[1] ?? '30'
  );
  const silent = args.includes('--silent');

  if (!campaignId || isNaN(campaignId)) {
    console.error('Usage: node launch-monitor.mjs <campaign-id> [--interval=30] [--silent]');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL');
    process.exit(2);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // ── DB polling ──────────────────────────────────────────────────────────────
  async function pollOnce(cid) {
    const nowMs = Date.now();

    // Campaign meta
    const { rows: [camp] } = await pool.query(
      `SELECT id, name, status, started_at FROM campaigns WHERE id=$1`,
      [cid]
    );
    if (!camp) return { missing: true, halts: [`Campaign ${cid} not found`] };

    // Progress per status bucket
    const { rows: progress } = await pool.query(
      `SELECT status, COUNT(*) AS count FROM campaign_contacts
       WHERE campaign_id=$1 GROUP BY 1`,
      [cid]
    );

    // Sends last 1h
    const { rows: [sendRate] } = await pool.query(
      `SELECT COUNT(*) AS count FROM operator_audit_log
       WHERE action='campaign_contact_send'
         AND details->>'campaign_id'=$1
         AND created_at > NOW() - INTERVAL '1 hour'`,
      [String(cid)]
    );

    // Bounce events 24h
    const { rows: bounces } = await pool.query(
      `SELECT bounce_type, COUNT(*) AS count FROM bounce_events
       WHERE contact_id IN (
         SELECT contact_id FROM campaign_contacts WHERE campaign_id=$1
       )
       AND processed_at > NOW() - INTERVAL '24 hours'
       GROUP BY 1`,
      [cid]
    );

    // Reply distribution 24h
    const { rows: replies } = await pool.query(
      `SELECT reply_type, COUNT(*) AS count FROM outreach_messages om
       JOIN outreach_threads ot ON ot.id = om.thread_id
       WHERE ot.campaign_id=$1
         AND om.direction='inbound'
         AND om.created_at > NOW() - INTERVAL '24 hours'
       GROUP BY 1`,
      [cid]
    );

    // Suppression count
    const { rows: [supr] } = await pool.query(
      `SELECT COUNT(*) AS total FROM outreach_suppressions`
    );

    // Mailbox health — production mailboxes used in this campaign
    const { rows: mailboxes } = await pool.query(
      `SELECT DISTINCT om.id, om.last_score, om.circuit_opened_at, om.total_bounced
       FROM outreach_mailboxes om
       JOIN campaign_contacts cc ON cc.mailbox_id = om.id
       WHERE cc.campaign_id=$1 AND om.environment='production'`,
      [cid]
    );

    // Derived aggregates
    const inSeq = parseInt(progress.find(p => p.status === 'in_sequence')?.count ?? 0);
    const sent  = parseInt(progress.find(p => p.status === 'sent')?.count ?? 0);
    const totalSent       = inSeq + sent;
    const hardBounces     = parseInt(bounces.find(b => b.bounce_type === 'hard')?.count ?? 0);
    const negativeReplies = parseInt(replies.find(r => r.reply_type === 'negative')?.count ?? 0);
    const totalReplies    = replies.reduce((s, r) => s + parseInt(r.count), 0);
    const suppressionTotal = parseInt(supr.total);

    // Relay status
    let relay = { unreachable: false };
    try {
      const r = await fetch(`${process.env.RELAY_URL || ''}/v1/status`, {
        headers: { Authorization: `Bearer ${process.env.RELAY_TOKEN || ''}` },
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        relay = { ...(await r.json()), unreachable: false };
      } else {
        relay = { unreachable: true, error: `HTTP ${r.status}` };
      }
    } catch (e) {
      relay = { unreachable: true, error: e.message };
    }

    const halts = evaluateHaltCriteria(
      { totalSent, hardBounces, totalReplies, negativeReplies,
        suppressionTotal, mailboxes, relay },
      lastSnapshot,
      nowMs
    );

    // Advance snapshot
    lastSnapshot = { suppressionTotal, snapshotAt: nowMs };

    return {
      camp, progress, sendRate: sendRate?.count ?? 0,
      bounces, replies, suppressionTotal, mailboxes, relay, halts,
    };
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  function render(snap, cid) {
    process.stdout.write(C.clear);

    if (snap.missing) {
      console.log(`${C.red}Campaign ${cid} not found in DB.${C.reset}`);
      return;
    }

    const { camp, progress, sendRate, bounces, replies,
            suppressionTotal, mailboxes, relay, halts } = snap;

    const W = 50;
    console.log(`${C.bold}╔${'═'.repeat(W)}╗${C.reset}`);
    console.log(`${C.bold}║  Launch Monitor — Campaign ${camp.id}${' '.repeat(W - 22 - String(camp.id).length)}║${C.reset}`);
    console.log(`${C.bold}╚${'═'.repeat(W)}╝${C.reset}`);
    console.log();
    console.log(`Status: ${camp.status}  started: ${camp.started_at ?? 'not yet'}`);
    console.log();

    console.log(`${C.bold}Progress:${C.reset}`);
    progress.forEach(p => console.log(`  ${p.status.padEnd(18)} ${p.count}`));
    console.log(`  ${'sends last 1h'.padEnd(18)} ${sendRate}`);
    console.log();

    console.log(`${C.bold}Bounces (24h):${C.reset}`);
    if (!bounces.length) {
      console.log(`  ${C.green}none${C.reset}`);
    } else {
      bounces.forEach(b => {
        const col = b.bounce_type === 'hard' ? C.red : C.yellow;
        console.log(`  ${col}${b.bounce_type.padEnd(10)} ${b.count}${C.reset}`);
      });
    }
    console.log();

    console.log(`${C.bold}Replies (24h):${C.reset}`);
    if (!replies.length) {
      console.log(`  none`);
    } else {
      replies.forEach(r => {
        const col = r.reply_type === 'negative' ? C.yellow : C.green;
        console.log(`  ${col}${r.reply_type.padEnd(18)} ${r.count}${C.reset}`);
      });
    }
    console.log();

    console.log(`${C.bold}Mailbox health:${C.reset}`);
    if (!mailboxes.length) {
      console.log(`  (no production mailboxes found for this campaign)`);
    } else {
      mailboxes.forEach(mb => {
        const score   = mb.last_score ?? '?';
        const circuit = mb.circuit_opened_at
          ? `${C.red}TRIPPED${C.reset}`
          : `${C.green}closed${C.reset}`;
        // PII: never print smtp_username; use id only
        console.log(`  mb${mb.id}  score=${score}  circuit=${circuit}  bounces=${mb.total_bounced ?? 0}`);
      });
    }
    console.log();

    console.log(`${C.bold}Relay:${C.reset}`);
    if (relay.unreachable) {
      console.log(`  ${C.red}unreachable${C.reset} (${relay.error})`);
    } else {
      const qd  = relay.queue_depth ?? '?';
      const age = relay.oldest_pending_age_seconds ?? '?';
      console.log(`  ${C.green}ok${C.reset}  queue=${qd}  oldest=${age}s`);
    }
    console.log();

    if (halts.length > 0) {
      console.log(`${C.red}${C.bold}╔${'═'.repeat(W)}╗${C.reset}`);
      console.log(`${C.red}${C.bold}║  HALT ADVISORY${' '.repeat(W - 15)}║${C.reset}`);
      halts.forEach(h => console.log(`${C.red}  ⚠ ${h}${C.reset}`));
      console.log(`${C.red}${C.bold}╚${'═'.repeat(W)}╝${C.reset}`);
      if (!silent) process.stdout.write('\x07'); // terminal bell
      console.log();
      console.log(`${C.yellow}Operator action: consider pausing the campaign:${C.reset}`);
      console.log(`${C.yellow}  UPDATE campaigns SET status='paused' WHERE id=${camp.id};${C.reset}`);
    } else {
      console.log(`${C.green}${C.bold}● ALL GREEN${C.reset}`);
    }

    console.log(`\n${C.bold}Updated:${C.reset} ${new Date().toLocaleTimeString()}  |  Next poll in ${intervalSec}s  |  Ctrl+C to exit`);
  }

  // ── Run ─────────────────────────────────────────────────────────────────────
  console.log(`Launch Monitor starting — campaign ${campaignId}, poll every ${intervalSec}s…`);

  // ── Initial poll ─────────────────────────────────────────────────────────────
  try {
    let latestSnap = await pollOnce(campaignId);
    resetPollError();
    render(latestSnap, campaignId);

    const ticker = setInterval(async () => {
      try {
        const prevFailures = consecutiveFailures;
        const snap = await pollOnce(campaignId);
        if (prevFailures > 0 && !silent) {
          // Recovery — one-time notice before normal render
          process.stdout.write(C.clear);
          console.log(`${C.green}${C.bold}✓ DB reconnected after ${prevFailures} failure(s)${C.reset}\n`);
        }
        resetPollError();
        latestSnap = snap;
        render(latestSnap, campaignId);
      } catch (e) {
        recordPollFailure();
        renderError(buildErrorSnapshot(e), intervalSec, silent);
      }
    }, intervalSec * 1000);

    process.on('SIGINT', () => {
      clearInterval(ticker);
      console.log('\n\nExiting. Final snapshot:');
      render(latestSnap, campaignId);
      pool.end().then(() => process.exit(0));
    });
  } catch (e) {
    // Initial poll failed — show error and start polling anyway
    recordPollFailure();
    renderError(buildErrorSnapshot(e), intervalSec, silent);

    const ticker = setInterval(async () => {
      try {
        const prevFailures = consecutiveFailures;
        const snap = await pollOnce(campaignId);
        if (prevFailures > 0 && !silent) {
          process.stdout.write(C.clear);
          console.log(`${C.green}${C.bold}✓ DB reconnected after ${prevFailures} failure(s)${C.reset}\n`);
        }
        resetPollError();
        render(snap, campaignId);
      } catch (e2) {
        recordPollFailure();
        renderError(buildErrorSnapshot(e2), intervalSec, silent);
      }
    }, intervalSec * 1000);

    process.on('SIGINT', () => {
      clearInterval(ticker);
      pool.end().then(() => process.exit(0));
    });
  }

}
