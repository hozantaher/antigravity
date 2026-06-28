// End-of-day report for outreach campaign launch monitoring.
//
// Usage:
//   DATABASE_URL=... node end-of-day-report.mjs <campaign-id> [--json]
//
// e.g. end-of-day-report.mjs 462
// e.g. end-of-day-report.mjs 462 --json > report-2026-05-07.json
//
// Memory feedback_no_pii_in_commands: all email addresses are redacted in stdout.

import pg from 'pg';
const { Pool } = pg;

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const campaignId = args.find(a => /^\d+$/.test(a));

if (!campaignId) {
  console.error('Usage: node end-of-day-report.mjs <campaign-id> [--json]');
  process.exit(2);
}

if (!process.env.DATABASE_URL) {
  console.error('Error: DATABASE_URL environment variable is required');
  process.exit(2);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Redact email per memory feedback_no_pii_in_commands
function redact(email) {
  if (!email) return '';
  const atIdx = email.indexOf('@');
  if (atIdx < 0) return email.slice(0, 3) + '…';
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  const domainParts = domain.split('.');
  const shortDomain = domainParts.length >= 2
    ? domainParts.slice(-2).join('.')
    : domain;
  return `${local.slice(0, 3)}…@${shortDomain}`;
}

// 1. Campaign basic info
// daily cap lives inside sending_config JSONB as dailyCapPerMailbox
const { rows: campRows } = await pool.query(
  `SELECT id, name, status, started_at, completed_at,
          (sending_config->>'dailyCapPerMailbox')::int AS daily_cap_per_mailbox
   FROM campaigns WHERE id=$1`,
  [campaignId]
);
const camp = campRows[0];
if (!camp) {
  console.error(`Campaign ${campaignId} not found`);
  await pool.end();
  process.exit(1);
}

// 2. campaign_contacts breakdown
const { rows: ccBreakdown } = await pool.query(
  `SELECT status, COUNT(*) AS count
   FROM campaign_contacts WHERE campaign_id=$1 GROUP BY status ORDER BY count DESC`,
  [campaignId]
);

// Total enrolled
const totalContacts = ccBreakdown.reduce((s, r) => s + parseInt(r.count, 10), 0);
const sentRow = ccBreakdown.find(r => r.status === 'sent') || { count: 0 };
const deliveryRate = totalContacts > 0
  ? ((parseInt(sentRow.count, 10) / totalContacts) * 100).toFixed(1)
  : null;

// 3. Send activity per mailbox (from operator_audit_log)
const { rows: mailboxStats } = await pool.query(
  `SELECT details->>'mailbox_id' AS mailbox_id, COUNT(*) AS sends
   FROM operator_audit_log
   WHERE action='campaign_contact_send'
     AND details->>'campaign_id' = $1
   GROUP BY mailbox_id ORDER BY sends DESC`,
  [String(campaignId)]
);

// 4. Bounce events (last 24h), filtered to contacts enrolled in this campaign
// bounce_events uses processed_at (not bounced_at) and bounce_type + bounce_code
const { rows: bounces } = await pool.query(
  `SELECT bounce_type, bounce_code, COUNT(*) AS count
   FROM bounce_events
   WHERE processed_at > NOW() - INTERVAL '24 hours'
     AND contact_id IN (
       SELECT contact_id FROM campaign_contacts WHERE campaign_id=$1
     )
   GROUP BY 1, 2 ORDER BY count DESC`,
  [campaignId]
);

// 5. Reply distribution (inbound messages from threads belonging to this campaign)
// outreach_messages uses reply_type (not classification) and direction='inbound'
const { rows: replies } = await pool.query(
  `SELECT
     CASE
       WHEN reply_type = 'negative' THEN 'negative'
       WHEN reply_type = 'positive' THEN 'positive'
       WHEN reply_type = 'auto_reply' THEN 'auto_reply'
       WHEN reply_type IS NULL OR reply_type = '' THEN 'unclassified'
       ELSE reply_type
     END AS cat,
     COUNT(*) AS count
   FROM outreach_messages
   WHERE direction = 'inbound'
     AND created_at > NOW() - INTERVAL '24 hours'
     AND thread_id IN (
       SELECT id FROM outreach_threads WHERE campaign_id=$1
     )
   GROUP BY 1 ORDER BY count DESC`,
  [campaignId]
);

// 6. Suppression growth
const { rows: suprRows } = await pool.query(
  `SELECT
     COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS new_24h,
     COUNT(*) AS total
   FROM outreach_suppressions`
);
const supr = suprRows[0];

// 7. Mailbox health
// outreach_mailboxes: circuit state via circuit_opened_at (no circuit_status column)
// bounce metrics: consecutive_bounces + total_bounced (no 'bounces' column)
const { rows: mailboxes } = await pool.query(
  `SELECT id, smtp_username, status,
          last_score, last_score_at,
          circuit_opened_at,
          consecutive_bounces, total_bounced,
          total_sent
   FROM outreach_mailboxes
   WHERE status IN ('active', 'paused')
   ORDER BY id`
);

// 8. Top issues — errors from operator_audit_log last 24h (failed sends etc.)
const { rows: topErrors } = await pool.query(
  `SELECT action, details->>'error' AS error, COUNT(*) AS count
   FROM operator_audit_log
   WHERE created_at > NOW() - INTERVAL '24 hours'
     AND details->>'error' IS NOT NULL
   GROUP BY 1, 2 ORDER BY count DESC LIMIT 10`
);

// ── Output ────────────────────────────────────────────────────────────────────
if (jsonMode) {
  console.log(JSON.stringify({
    campaign: {
      id: camp.id,
      name: camp.name,
      status: camp.status,
      started_at: camp.started_at,
      daily_cap_per_mailbox: camp.daily_cap_per_mailbox,
    },
    contacts_breakdown: ccBreakdown,
    delivery_rate_pct: deliveryRate,
    sends_per_mailbox: mailboxStats,
    bounces_24h: bounces,
    replies_24h: replies,
    suppression: {
      new_24h: supr.new_24h,
      total: supr.total,
    },
    mailbox_health: mailboxes.map(m => ({
      id: m.id,
      smtp_username: redact(m.smtp_username),
      status: m.status,
      last_score: m.last_score,
      last_score_at: m.last_score_at,
      circuit_opened_at: m.circuit_opened_at,
      consecutive_bounces: m.consecutive_bounces,
      total_bounced: m.total_bounced,
      total_sent: m.total_sent,
    })),
    top_errors_24h: topErrors,
    generated_at: new Date().toISOString(),
  }, null, 2));
} else {
  const LINE = '─'.repeat(48);
  console.log(`╔${'═'.repeat(46)}╗`);
  console.log(`║  END-OF-DAY REPORT — Campaign ${String(campaignId).padEnd(14)} ║`);
  console.log(`╚${'═'.repeat(46)}╝`);
  console.log();
  console.log(`Campaign : ${camp.name}`);
  console.log(`Status   : ${camp.status}${camp.started_at ? `, started ${camp.started_at}` : ''}`);
  if (camp.daily_cap_per_mailbox) {
    console.log(`Daily cap: ${camp.daily_cap_per_mailbox} per mailbox`);
  }
  console.log();

  console.log(`── Contacts (total: ${totalContacts}) ──`);
  ccBreakdown.forEach(b => console.log(`  ${b.status.padEnd(16)} ${b.count}`));
  if (deliveryRate !== null) {
    console.log(`  delivery rate    ${deliveryRate}%`);
  }
  console.log();

  console.log(`── Sends per mailbox (audit log) ──`);
  if (mailboxStats.length === 0) {
    console.log(`  none recorded`);
  } else {
    mailboxStats.forEach(s => {
      const mbLabel = `mb${s.mailbox_id}`;
      console.log(`  ${mbLabel.padEnd(10)} ${s.sends} sends`);
    });
  }
  console.log();

  console.log(`── Bounces (last 24h) ──`);
  if (bounces.length === 0) {
    console.log(`  none`);
  } else {
    bounces.forEach(b => {
      const key = b.bounce_code ? `${b.bounce_type}/${b.bounce_code}` : b.bounce_type;
      console.log(`  ${key.padEnd(20)} ${b.count}`);
    });
  }
  console.log();

  console.log(`── Replies (last 24h) ──`);
  if (replies.length === 0) {
    console.log(`  none`);
  } else {
    replies.forEach(r => console.log(`  ${r.cat.padEnd(16)} ${r.count}`));
  }
  console.log();

  console.log(`── Suppression list ──`);
  console.log(`  new last 24h  ${supr.new_24h}`);
  console.log(`  total         ${supr.total}`);
  console.log();

  console.log(`── Mailbox health ──`);
  mailboxes.forEach(m => {
    const score = m.last_score != null ? m.last_score : '?';
    const circuit = m.circuit_opened_at ? `OPEN (since ${m.circuit_opened_at})` : 'closed';
    const addr = redact(m.smtp_username);
    console.log(
      `  mb${String(m.id).padEnd(5)} (${addr.padEnd(20)}) ` +
      `status=${m.status.padEnd(8)} score=${String(score).padEnd(4)} ` +
      `circuit=${circuit} ` +
      `bounces=${m.consecutive_bounces}/${m.total_bounced} sent=${m.total_sent}`
    );
  });
  console.log();

  if (topErrors.length > 0) {
    console.log(`── Top issues (last 24h) ──`);
    topErrors.forEach(e => {
      const errSnippet = (e.error || '').slice(0, 60);
      console.log(`  [${e.count}x] ${e.action}: ${errSnippet}`);
    });
    console.log();
  }

  console.log(`${LINE}`);
  console.log(`generated ${new Date().toISOString()}`);
}

await pool.end();
process.exit(0);
