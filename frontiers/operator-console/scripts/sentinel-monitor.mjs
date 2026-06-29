#!/usr/bin/env node
// sentinel-monitor.mjs — local 5-min health sentinel for campaign 457.
//
// Usage:
//   node --env-file-if-exists=.env scripts/sentinel-monitor.mjs            # default campaign 457
//   node --env-file-if-exists=.env scripts/sentinel-monitor.mjs 462        # other campaign
//   node scripts/sentinel-monitor.mjs --interval=300 --log                 # custom interval, write log file
//   pnpm sentinel                                                          # shorthand
//
// Companion to Y7 web notification center — this is a CLI watchdog running
// locally on operator's machine. Polls DB + relay every 5 min (default),
// prints color-coded Czech advisories, kills nothing (no auto-pause).
//
// HARD RULES honored:
// - feedback_no_pii_in_commands (T0): DSN from env, mailbox addresses redacted in output
// - feedback_no_speculation (T0): only data-driven alerts (no predictions, no extrapolations)
// - feedback_outreach_dashboard_local_only (T0): runs locally, not on Railway
//
// Exits gracefully on Ctrl+C.
// Safe to import as a module — main loop is gated on isMain.

import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] === __filename;

// ── Thresholds (no magic numbers — exported for tests + operator override) ────
export const THRESHOLDS = {
  bouncePctWarn:           1.5,   // mailbox bounce rate % warning (<2% auto-pause)
  sendStallMinutes:        30,    // no sends during window → warn
  drainPendingWarn:        100,   // relay drain queue depth warn
  consecutiveRedSuggest:   2,     // # consecutive red advisories → suggest pause SQL
  windowStartHourPrague:   6,     // 06:00 Prague — send window opens
  windowEndHourPrague:     23,    // 23:00 Prague — send window closes
};

// ── ANSI color helpers ────────────────────────────────────────────────────────
export const C = {
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  gray:   '\x1b[90m',
  bold:   '\x1b[1m',
  reset:  '\x1b[0m',
};

// ── PII helpers ───────────────────────────────────────────────────────────────

/**
 * Redact a mailbox email: keep first 14 chars of local + last 2 of domain.
 * "hozan.taher.71@post.cz" → "hozan.taher.7X@post.cz"
 * "ab@foo.org" → "ab@foo.org" (too short, return as-is)
 */
export function redactMailbox(email) {
  if (!email || typeof email !== 'string') return '';
  const at = email.indexOf('@');
  if (at < 4) return email; // nothing meaningful to redact
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length <= 2) return email;
  const masked = local.slice(0, -1) + 'X';
  return `${masked}@${domain}`;
}

// ── Pure check evaluators (exported for unit tests) ───────────────────────────

/**
 * Returns true if current Prague hour is inside the configured send window.
 * Pure: takes nowMs override for testability.
 */
export function isInSendWindow(nowMs = Date.now(), thresholds = THRESHOLDS) {
  const hour = parseInt(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Prague',
      hour: '2-digit',
      hour12: false,
    }).format(new Date(nowMs)),
    10,
  );
  return hour >= thresholds.windowStartHourPrague && hour < thresholds.windowEndHourPrague;
}

/**
 * Evaluate all 6 sentinel checks. Pure function — input is poll snapshot,
 * output is a flat list of { level, code, message } advisories.
 *
 * level ∈ 'info' | 'warn' | 'alert' (alert = red).
 */
export function evaluateChecks(data, thresholds = THRESHOLDS, nowMs = Date.now()) {
  const advisories = [];
  const inWindow = isInSendWindow(nowMs, thresholds);

  // 1. Send rate (last 60 min) — should be > 0 during window
  if (inWindow && data.sends_60m === 0) {
    advisories.push({
      level: 'alert',
      code: 'send_rate_zero',
      message: `Žádné odeslání za posledních 60 min (probíhá send window).`,
    });
  } else if (inWindow) {
    advisories.push({
      level: 'info',
      code: 'send_rate_ok',
      message: `Odesláno za 60 min: ${data.sends_60m}`,
    });
  } else {
    advisories.push({
      level: 'info',
      code: 'send_window_closed',
      message: `Send window zavřeno (Pražské hodiny mimo ${thresholds.windowStartHourPrague}–${thresholds.windowEndHourPrague}).`,
    });
  }

  // 2. Per-mailbox bounce rate > 1.5 %
  for (const mb of data.mailboxes ?? []) {
    const sent = parseInt(mb.sent_24h ?? 0, 10);
    const bounced = parseInt(mb.bounced_24h ?? 0, 10);
    if (sent < 10) continue; // sample too small
    const pct = (bounced / sent) * 100;
    if (pct > thresholds.bouncePctWarn) {
      advisories.push({
        level: 'warn',
        code: 'bounce_rate_warn',
        message: `Mailbox ${redactMailbox(mb.from_address)} bounce rate ${pct.toFixed(2)} % (${bounced}/${sent}) > ${thresholds.bouncePctWarn} %.`,
      });
    }
  }

  // 3. Mailbox status flipped to auth_locked or bounce_hold
  for (const mb of data.mailboxes ?? []) {
    if (mb.status === 'auth_locked' || mb.status === 'bounce_hold') {
      advisories.push({
        level: 'alert',
        code: 'mailbox_quarantine',
        message: `Mailbox ${redactMailbox(mb.from_address)} status=${mb.status}.`,
      });
    }
  }

  // 4. send_events stalled — minutes since last send during window
  if (inWindow && data.minutes_since_last_send != null
      && data.minutes_since_last_send > thresholds.sendStallMinutes) {
    advisories.push({
      level: 'warn',
      code: 'send_stalled',
      message: `${data.minutes_since_last_send} min od posledního odeslání (limit ${thresholds.sendStallMinutes} min v send window).`,
    });
  }

  // 5. New replies — info-level update (never red)
  if (data.new_replies_60m > 0) {
    advisories.push({
      level: 'info',
      code: 'replies_new',
      message: `Nové odpovědi za 60 min: ${data.new_replies_60m}.`,
    });
  }

  // 6. Anti-trace-relay drain queue — warn if > 100
  if (data.relay?.unreachable) {
    advisories.push({
      level: 'warn',
      code: 'relay_unreachable',
      message: `Relay nedostupné: ${data.relay.error}.`,
    });
  } else if ((data.relay?.queue_depth ?? 0) > thresholds.drainPendingWarn) {
    advisories.push({
      level: 'warn',
      code: 'drain_backlog',
      message: `Relay drain queue ${data.relay.queue_depth} > ${thresholds.drainPendingWarn}.`,
    });
  }

  return advisories;
}

/**
 * Format one advisory as a single console line.
 * Pure — used by render() AND tests.
 */
export function formatAdvisory(adv, isoTimestamp = new Date().toISOString()) {
  const prefix =
    adv.level === 'alert' ? `${C.red}${C.bold}[RED]${C.reset}`
    : adv.level === 'warn' ? `${C.yellow}${C.bold}[YEL]${C.reset}`
    : `${C.green}[GRN]${C.reset}`;
  return `${C.gray}${isoTimestamp}${C.reset} ${prefix} ${adv.message}`;
}

/**
 * Format the suggested kill-switch SQL when red alerts pile up.
 * Returns null if not enough red advisories.
 */
export function maybeKillSwitchHint(consecutiveReds, campaignId, thresholds = THRESHOLDS) {
  if (consecutiveReds < thresholds.consecutiveRedSuggest) return null;
  return [
    '',
    `${C.red}${C.bold}⚠ ${consecutiveReds} RED alerty v řadě — zvaž manuální pauzu:${C.reset}`,
    `${C.red}  psql "$DATABASE_URL" -c "UPDATE campaigns SET status='paused' WHERE id=${campaignId};"${C.reset}`,
    '',
  ].join('\n');
}

// ── Pool / poll only run in main mode ─────────────────────────────────────────

async function pollOnce(pool, campaignId, relayUrl, relayToken) {
  const nowMs = Date.now();

  // (1) Send rate last 60 min (this campaign's sends)
  const { rows: [sendRow] } = await pool.query(
    `SELECT COUNT(*)::int AS sends_60m,
            EXTRACT(EPOCH FROM (NOW() - MAX(sent_at)))/60 AS minutes_since_last_send
       FROM send_events
      WHERE campaign_id = $1
        AND sent_at > NOW() - INTERVAL '60 minutes'`,
    [campaignId],
  );

  // Minutes since last send — query above only finds sends in last 60 min, so
  // when there are none we need a separate lookup over the full table.
  let minutesSinceLastSend = sendRow.minutes_since_last_send != null
    ? Math.round(parseFloat(sendRow.minutes_since_last_send))
    : null;
  if (minutesSinceLastSend == null) {
    const { rows: [latest] } = await pool.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(sent_at)))/60 AS m
         FROM send_events WHERE campaign_id = $1`,
      [campaignId],
    );
    minutesSinceLastSend = latest.m != null ? Math.round(parseFloat(latest.m)) : null;
  }

  // (2,3) Per-mailbox status + bounce rate over 24h
  // Mailboxes are joined by from_address — same convention as system-report.mjs.
  const { rows: mailboxes } = await pool.query(
    `SELECT m.id, m.from_address, m.status,
            COALESCE(s.sent_24h, 0)    AS sent_24h,
            COALESCE(b.bounced_24h, 0) AS bounced_24h
       FROM outreach_mailboxes m
       LEFT JOIN (
         SELECT mailbox_used, COUNT(*) AS sent_24h
           FROM send_events
          WHERE sent_at > NOW() - INTERVAL '24 hours'
            AND campaign_id = $1
          GROUP BY mailbox_used
       ) s ON s.mailbox_used = m.from_address
       LEFT JOIN (
         SELECT mailbox_used, COUNT(*) AS bounced_24h
           FROM send_events
          WHERE sent_at > NOW() - INTERVAL '24 hours'
            AND campaign_id = $1
            AND status IN ('bounced', 'hard_bounce', 'soft_bounce')
          GROUP BY mailbox_used
       ) b ON b.mailbox_used = m.from_address
       WHERE m.status IN ('active', 'auth_locked', 'bounce_hold', 'paused')
       ORDER BY m.id`,
    [campaignId],
  );

  // (5) Inbound replies in last 60 min for this campaign
  const { rows: [replyRow] } = await pool.query(
    `SELECT COUNT(*)::int AS new_replies_60m
       FROM outreach_messages om
       JOIN outreach_threads ot ON ot.id = om.thread_id
      WHERE ot.campaign_id = $1
        AND om.direction = 'inbound'
        AND om.created_at > NOW() - INTERVAL '60 minutes'`,
    [campaignId],
  );

  // (6) Anti-trace-relay drain queue
  let relay = { unreachable: false, queue_depth: 0 };
  if (relayUrl) {
    try {
      const r = await fetch(`${relayUrl}/v1/status`, {
        headers: { Authorization: `Bearer ${relayToken ?? ''}` },
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const d = await r.json();
        relay = { unreachable: false, queue_depth: d.queue_depth ?? 0, raw: d };
      } else {
        relay = { unreachable: true, error: `HTTP ${r.status}` };
      }
    } catch (e) {
      relay = { unreachable: true, error: e.message };
    }
  } else {
    relay = { unreachable: true, error: 'ANTI_TRACE_RELAY_URL / RELAY_URL not set' };
  }

  return {
    nowMs,
    sends_60m: parseInt(sendRow.sends_60m, 10),
    minutes_since_last_send: minutesSinceLastSend,
    mailboxes,
    new_replies_60m: parseInt(replyRow.new_replies_60m, 10),
    relay,
  };
}

// ── Log file writer (best-effort) ─────────────────────────────────────────────

async function appendLog(logPath, plainLine) {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, plainLine + '\n', 'utf8');
  } catch {
    // Logging is best-effort — never crash the sentinel on a disk error.
  }
}

function stripAnsi(s) {
  // Used when writing to log file — strip ANSI escape sequences for cleanliness.
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ── Main loop ─────────────────────────────────────────────────────────────────

if (isMain) {
  const args = process.argv.slice(2);
  const campaignId = parseInt(args.find(a => /^\d+$/.test(a)) ?? '457', 10);
  const intervalSec = parseInt(
    args.find(a => /^--interval=/.test(a))?.split('=')[1] ?? '300',
    10,
  );
  const writeLog = args.includes('--log');

  if (!process.env.DATABASE_URL) {
    console.error(`${C.red}DATABASE_URL not set.${C.reset} Create apps/outreach-dashboard/.env or export it.`);
    process.exit(2);
  }

  const relayUrl = process.env.ANTI_TRACE_RELAY_URL || process.env.RELAY_URL || null;
  const relayToken = process.env.ANTI_TRACE_RELAY_TOKEN || process.env.RELAY_TOKEN || null;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const logPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'logs',
    `sentinel-${new Date().toISOString().slice(0, 10)}.log`,
  );

  let consecutiveReds = 0;

  console.log(`${C.bold}Sentinel monitor${C.reset} — kampaň ${campaignId}, poll každých ${intervalSec}s.`);
  console.log(`Relay: ${relayUrl ?? '(not configured)'}`);
  if (writeLog) console.log(`Log file: ${logPath}`);
  console.log(`${C.gray}Ctrl+C pro ukončení.${C.reset}\n`);

  async function tick() {
    const iso = new Date().toISOString();
    try {
      const data = await pollOnce(pool, campaignId, relayUrl, relayToken);
      const advs = evaluateChecks(data);
      const hasRed = advs.some(a => a.level === 'alert');
      if (hasRed) consecutiveReds += 1;
      else consecutiveReds = 0;

      for (const adv of advs) {
        const line = formatAdvisory(adv, iso);
        console.log(line);
        if (writeLog) await appendLog(logPath, stripAnsi(line));
      }

      const hint = maybeKillSwitchHint(consecutiveReds, campaignId);
      if (hint) {
        console.log(hint);
        if (writeLog) await appendLog(logPath, stripAnsi(hint));
      }

      console.log(`${C.gray}— další kontrola za ${intervalSec}s —${C.reset}\n`);
    } catch (e) {
      const line = `${C.gray}${iso}${C.reset} ${C.red}${C.bold}[ERR]${C.reset} sentinel poll selhal: ${e.message}`;
      console.log(line);
      if (writeLog) await appendLog(logPath, stripAnsi(line));
    }
  }

  await tick();
  const ticker = setInterval(tick, intervalSec * 1000);

  process.on('SIGINT', () => {
    clearInterval(ticker);
    console.log(`\n${C.gray}Sentinel ukončen.${C.reset}`);
    pool.end().then(() => process.exit(0));
  });
}
