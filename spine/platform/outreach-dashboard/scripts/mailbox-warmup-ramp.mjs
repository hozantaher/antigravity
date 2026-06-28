// mailbox-warmup-ramp.mjs
//
// Sprint L1 / S3.2 — Mailbox warmup ramp utility.
// R1 / S3.3 — Password sourced per-row from outreach_mailboxes.password.
//
// Sends a controlled batch of warmup emails from a given mailbox to a
// trusted "network" of inboxes the operator controls, following the ramp
// schedule: day 1=5, day 2=10, day 3=25, day 4=50, day 5+=target (default 100).
//
// Usage:
//   DATABASE_URL=... RELAY_URL=... RELAY_TOKEN=...
//     node mailbox-warmup-ramp.mjs <mailbox-id>
//     --network "mb1@example.com,mb2@example.com,mb3@example.com"
//     [--day-num N]      # manual day override (skip auto-increment)
//     [--dry-run]        # simulate: print plan, no sends, no DB writes
//
// SMTP_PASSWORD env is now OPTIONAL — used as fallback when row.password is NULL.
//
// Hard rules enforced:
//   - No direct SMTP/IMAP (relay /v1/submit only) — feedback_no_direct_smtp
//   - All email addresses redacted in stdout — feedback_no_pii_in_commands
//   - Audit log entry per send — operator_audit_log action='mailbox_warmup_send'
//   - Passwords sourced from DB row, env fallback only — feedback_mailbox_passwords_via_db

import pg from 'pg';
// R1/S3.3 — per-mailbox password resolver (shared lib)
export { resolveMailboxPassword } from '../src/lib/mailboxPassword.js';
import { resolveMailboxPassword } from '../src/lib/mailboxPassword.js';

const { Pool } = pg;

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const result = { positional: [], 'dry-run': false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      result['dry-run'] = true;
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      result[key] = argv[i + 1] ?? true;
      i++;
    } else {
      result.positional.push(a);
    }
  }
  return result;
}

// ─── PII redaction ───────────────────────────────────────────────────────────

/**
 * Redact email per memory feedback_no_pii_in_commands.
 * "alice@example.com" → "al…@example.com"
 */
export function redact(email) {
  if (!email || typeof email !== 'string') return '';
  const atIdx = email.indexOf('@');
  if (atIdx < 0) return email.slice(0, 2) + '…';
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  const domainParts = domain.split('.');
  const shortDomain =
    domainParts.length >= 2 ? domainParts.slice(-2).join('.') : domain;
  return `${local.slice(0, 2)}…@${shortDomain}`;
}

// ─── Daily cap schedule ───────────────────────────────────────────────────────

/** Ramp schedule (day → send count). Day 5+ falls back to warmup_target_per_day. */
export const RAMP_SCHEDULE = { 1: 5, 2: 10, 3: 25, 4: 50 };

/**
 * Resolve daily cap for the given day number.
 * @param {number} dayNum
 * @param {number} targetPerDay  — from DB column warmup_target_per_day
 */
export function dailyCap(dayNum, targetPerDay) {
  return RAMP_SCHEDULE[dayNum] ?? targetPerDay;
}

// ─── Round-robin recipient selection ─────────────────────────────────────────

/**
 * Pick recipient at index i from network array using round-robin.
 * @param {string[]} network
 * @param {number} i
 */
export function pickRecipient(network, i) {
  if (!network || network.length === 0) throw new Error('network is empty');
  return network[i % network.length];
}

// ─── Environment validation ───────────────────────────────────────────────────

/**
 * Validate required environment variables.
 * Returns null if OK, or an error message string.
 *
 * R1/S3.3 — SMTP_PASSWORD is now OPTIONAL (used as fallback when row.password NULL).
 */
export function validateEnv(env) {
  const required = ['DATABASE_URL', 'RELAY_URL', 'RELAY_TOKEN'];
  const missing = required.filter(k => !env[k]);
  if (missing.length > 0) return `Missing env vars: ${missing.join(', ')}`;
  return null;
}


// ─── Relay submit ─────────────────────────────────────────────────────────────

/**
 * Submit a single warmup email via relay /v1/submit.
 * Returns { envelope_id } on success, throws on failure.
 *
 * Per HARD RULE feedback_no_direct_smtp: relay path only.
 */
export async function submitWarmupEmail({
  relayUrl,
  relayToken,
  fromAddress,
  smtpHost,
  smtpPort,
  smtpPassword,
  recipient,
  subject,
  body,
}) {
  const resp = await fetch(`${relayUrl}/v1/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${relayToken}`,
    },
    body: JSON.stringify({
      recipient,
      subject,
      body,
      from_address: fromAddress,
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      smtp_username: fromAddress,
      smtp_password: smtpPassword,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.envelope_id) {
    const err = data.error || `HTTP ${resp.status}`;
    throw new Error(`relay submit failed: ${err}`);
  }
  return { envelope_id: data.envelope_id };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Only run main() when invoked directly (not when imported by tests).
if (process.argv[1] && new URL(process.argv[1], 'file://').pathname === new URL(import.meta.url, 'file://').pathname) {
  await main();
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mailboxId = parseInt(args.positional[0], 10);
  const networkRaw = args.network || '';
  const networkEmails = networkRaw
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);
  const dryRun = args['dry-run'] === true;
  const dayOverride = args['day-num'] ? parseInt(args['day-num'], 10) : null;

  if (!mailboxId || networkEmails.length === 0) {
    console.error(
      'Usage: node mailbox-warmup-ramp.mjs <mailbox-id> --network "email1,email2,..." [--day-num N] [--dry-run]'
    );
    process.exit(2);
  }

  const envErr = validateEnv(process.env);
  if (envErr) {
    console.error(`Error: ${envErr}`);
    process.exit(2);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // 1. Fetch mailbox state (R1/S3.3 — include password column)
    const { rows } = await pool.query(
      `SELECT id, from_address, smtp_host, smtp_port, status, password,
              warmup_started_at, warmup_day, warmup_target_per_day, warmup_active
       FROM outreach_mailboxes WHERE id=$1`,
      [mailboxId]
    );
    const mb = rows[0];
    if (!mb) {
      console.error(`Mailbox ${mailboxId} not found.`);
      await pool.end();
      process.exit(1);
    }
    if (mb.status === 'test') {
      console.error(
        `Warmup not allowed for mailbox ${mailboxId} with status='test'. Use a production or dev mailbox.`
      );
      await pool.end();
      process.exit(1);
    }

    // 2. Determine day number
    let dayNum;
    if (dayOverride !== null && !isNaN(dayOverride)) {
      dayNum = dayOverride;
    } else if (!mb.warmup_started_at) {
      // First run ever
      dayNum = 1;
      if (!dryRun) {
        await pool.query(
          `UPDATE outreach_mailboxes
           SET warmup_started_at = NOW(), warmup_active = true, warmup_day = 1
           WHERE id = $1`,
          [mailboxId]
        );
      }
    } else {
      const msSince = Date.now() - new Date(mb.warmup_started_at).getTime();
      dayNum = Math.max(1, Math.floor(msSince / 86_400_000) + 1);
    }

    // 3. Resolve daily cap
    const cap = dailyCap(dayNum, mb.warmup_target_per_day);

    console.log(
      `Mailbox ${mailboxId} (${redact(mb.from_address)}) — warmup day ${dayNum}, daily cap ${cap}, network size ${networkEmails.length}`
    );

    if (dryRun) {
      console.log(
        `DRY RUN — would send ${cap} warmup emails to ${networkEmails.length} recipient(s) via relay.`
      );
      await pool.end();
      return;
    }

    // 4. Send N emails (relay only — no direct SMTP)
    let sent = 0;
    for (let i = 0; i < cap; i++) {
      const recipient = pickRecipient(networkEmails, i);
      const subject = `Warmup #${dayNum}-${i + 1}`;
      const body =
        `This is a warmup email from mailbox ${mailboxId} on day ${dayNum}, message ${i + 1}/${cap}.\n\n` +
        `If you received this, please mark as read (and optionally reply — it helps).\n\n` +
        `-- automated warmup sequence --`;

      try {
        // R1/S3.3 — resolve per-row password, env fallback
        const smtpPassword = resolveMailboxPassword(mb, process.env.SMTP_PASSWORD || null);
        const { envelope_id } = await submitWarmupEmail({
          relayUrl: process.env.RELAY_URL,
          relayToken: process.env.RELAY_TOKEN,
          fromAddress: mb.from_address,
          smtpHost: mb.smtp_host,
          smtpPort: mb.smtp_port,
          smtpPassword,
          recipient,
          subject,
          body,
        });

        sent++;
        console.log(`  ${i + 1}/${cap} → ${redact(recipient)} : ${envelope_id}`);

        // Audit log entry per send
        await pool.query(
          `INSERT INTO operator_audit_log (action, entity_id, details, created_at)
           VALUES ('mailbox_warmup_send', $1::text, $2::jsonb, NOW())`,
          [
            String(mailboxId),
            JSON.stringify({ envelope_id, day: dayNum, index: i + 1, cap }),
          ]
        );
      } catch (err) {
        console.error(`  ${i + 1}/${cap} → FAILED: ${err.message}`);
      }

      // Brief pause to avoid rate-limit bursts
      if (i < cap - 1) {
        await new Promise(r => setTimeout(r, 2_000));
      }
    }

    // 5. Persist warmup_day
    await pool.query(
      `UPDATE outreach_mailboxes SET warmup_day = $1 WHERE id = $2`,
      [dayNum, mailboxId]
    );

    console.log(
      `\nSent ${sent}/${cap} warmup emails. Mailbox ${mailboxId} warmup_day = ${dayNum}.`
    );
  } finally {
    await pool.end();
  }
}
