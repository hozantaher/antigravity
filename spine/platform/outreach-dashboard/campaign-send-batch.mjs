// Send a batch of enrolled campaign contacts via anti-trace-relay.
// Renders template per-contact (matches services/campaigns/content/template.go),
// submits via /v1/submit, marks campaign_contacts.status='in_sequence'.
//
// Usage:
//   RELAY_TOKEN=... node campaign-send-batch.mjs <campaign-id> <count>
//
// R1 / S3.3 — Password sourced per-row from outreach_mailboxes.password.
//   SMTP_PASSWORD env var is now OPTIONAL — used as fallback only when a
//   mailbox row has NULL or empty password (backward compat for legacy edge cases).
//
// e.g. campaign-send-batch.mjs 455 1   → send to first 1 pending contact
//
// H2.1 — Race safety: contact selection uses SELECT FOR UPDATE SKIP LOCKED
//         inside a transaction + immediate mark to 'queued' to prevent
//         two parallel runs from picking the same contacts.
//
// H2.2 — Idempotency: before /v1/submit, query operator_audit_log for a
//         recent 'campaign_contact_send' entry for the same cc_id.
//         If found, skip re-send and catch up status to 'in_sequence'.
//         Handles crash-after-submit-but-before-status-update safely.

import pg from 'pg';
import { buildUnsubToken } from './src/lib/unsubToken.js';
// R1/S3.3 — per-mailbox password resolver (shared lib)
export { resolveMailboxPassword } from './src/lib/mailboxPassword.js';
import { resolveMailboxPassword } from './src/lib/mailboxPassword.js';
// Exactly-once send-claim (migration 171) — shared atomic gate with the Go daemon.
import { acquireClaim, confirmClaim, releaseClaim, CLAIM_PROCEED, CLAIM_ALREADY_SENT } from './src/lib/sendClaim.js';
// Canonical suppression UNION filter (mirrors the Go runner's suppressionFilterFor).
import { notInUnionWhere } from './src/lib/suppressionUnionSql.js';

const { Pool } = pg;
const campaignId = parseInt(process.argv[2] || '0', 10);
const count = parseInt(process.argv[3] || '1', 10);
if (!campaignId || !count) {
  console.error('Usage: node campaign-send-batch.mjs <campaign-id> <count>');
  process.exit(2);
}

const RELAY_URL = process.env.RELAY_URL || 'https://anti-trace-relay-production-a706.up.railway.app';
const RELAY_TOKEN = process.env.RELAY_TOKEN;
// R1/S3.3 — SMTP_PASSWORD is now OPTIONAL env fallback.
// Primary source: outreach_mailboxes.password per DB row.
const SMTP_PASSWORD_FALLBACK = process.env.SMTP_PASSWORD || null;
const UNSUB_SECRET = process.env.UNSUBSCRIBE_SECRET || process.env.OUTREACH_API_KEY ||
  'd755731507bb7b68f85b54d4ebcf280ed864e2f6d650270be383331aba342e06';
const UNSUB_BASE = process.env.UNSUB_BASE_URL || 'https://outreach-dashboard-production-e4ce.up.railway.app';
const SIGNATURE = process.env.SENDER_SIGNATURE || 'Goran Nowak';

if (!RELAY_TOKEN) {
  console.error('RELAY_TOKEN required');
  process.exit(2);
}


const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://outreach:outreach_053ff0c20c74809c@junction.proxy.rlwy.net:54755/outreach?sslmode=disable'
});

function buildUnsubURL(cid, contactId, email) {
  const token = buildUnsubToken(cid, contactId, email, UNSUB_SECRET);
  return `${UNSUB_BASE}/unsubscribe?c=${cid}&id=${contactId}&t=${token}`;
}

function substituteVars(text, vars) {
  const m = {
    '{{firma}}': vars.firma || '',
    '{{jmeno}}': vars.jmeno || '',
    '{{prijmeni}}': vars.prijmeni || '',
    '{{region}}': vars.region || '',
    '{{ico}}': vars.ico || '',
    '{{podpis}}': vars.podpis || '',
    '{{unsuburl}}': vars.unsuburl || '',
    '{{.Firma}}': vars.firma || '', '{{.Jmeno}}': vars.jmeno || '',
    '{{.Prijmeni}}': vars.prijmeni || '', '{{.Region}}': vars.region || '',
    '{{.ICO}}': vars.ico || '', '{{.Podpis}}': vars.podpis || '',
    '{{.UnsubURL}}': vars.unsuburl || '',
  };
  let out = text;
  for (const [k, v] of Object.entries(m)) out = out.split(k).join(v);
  return out;
}

async function pickWorkingProxy(senderEmail, smtpPassword) {
  const r = await fetch(`${RELAY_URL}/v1/proxy-pool`, {
    headers: { Authorization: `Bearer ${RELAY_TOKEN}` },
  });
  const pool = await r.json();
  const candidates = (pool.working || [])
    .sort((a, b) => (a.latency_ms || 9999) - (b.latency_ms || 9999))
    .slice(0, 30)
    .map(p => p.addr);
  const probes = candidates.map(async proxy => {
    try {
      const res = await fetch(`${RELAY_URL}/v1/auth-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RELAY_TOKEN}` },
        body: JSON.stringify({
          smtp_host: 'smtp.seznam.cz', smtp_port: 465,
          smtp_username: senderEmail, password: smtpPassword, proxy_addr: proxy,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const d = await res.json();
      return d.ok ? proxy : null;
    } catch { return null; }
  });
  const ok = (await Promise.all(probes)).filter(Boolean);
  return ok[0] || null;
}

const { rows: [camp] } = await pool.query(
  `SELECT id, name, sequence_config, sending_config FROM campaigns WHERE id=$1`,
  [campaignId]
);
if (!camp) { console.error(`Campaign ${campaignId} not found`); process.exit(1); }

const step0 = (camp.sequence_config || [])[0];
if (!step0) { console.error('empty sequence_config'); process.exit(1); }

const { rows: [tpl] } = await pool.query(
  `SELECT id, name, subject, body FROM email_templates WHERE name=$1`, [step0.template]
);
if (!tpl) { console.error(`Template "${step0.template}" not found`); process.exit(1); }

// Pick mailbox pool (round-robin if multiple)
const mbPool = (camp.sending_config?.mailbox_pool) || [1, 3, 631];
// R1/S3.3 — include password column; resolved per-row in resolveMailboxPassword()
const { rows: mailboxes } = await pool.query(
  `SELECT id, from_address, smtp_host, smtp_port, password FROM outreach_mailboxes
   WHERE id = ANY($1::int[]) AND status='active' AND environment='production' ORDER BY id`,
  [mbPool]
);
if (!mailboxes.length) { console.error('no active mailboxes'); process.exit(1); }
console.log(`Using mailboxes: ${mailboxes.map(m => m.from_address).join(', ')}`);

// Validate passwords: each mailbox must have row.password OR env fallback.
for (const mb of mailboxes) {
  try {
    resolveMailboxPassword(mb, SMTP_PASSWORD_FALLBACK);
  } catch (e) {
    console.error(`Mailbox ${mb.id}: ${e.message} — set password via UI/DB`);
    process.exit(2);
  }
}

// Pre-pick a working proxy per mailbox (try in parallel)
const mbProxy = {};
for (const mb of mailboxes) {
  const smtpPassword = resolveMailboxPassword(mb, SMTP_PASSWORD_FALLBACK);
  process.stderr.write(`  probing proxy for ${mb.from_address}…`);
  const px = await pickWorkingProxy(mb.from_address, smtpPassword);
  if (!px) { console.log(` ✗ NO AUTH-OK PROXY (skipping mailbox)`); continue; }
  mbProxy[mb.id] = px;
  console.log(` → ${px}`);
}
const usableMailboxes = mailboxes.filter(m => mbProxy[m.id]);
if (!usableMailboxes.length) { console.error('no mailboxes have working proxy'); process.exit(1); }
console.log(`Usable: ${usableMailboxes.length}/${mailboxes.length}`);

// H2.1 — Select + lock pending contacts atomically.
// FOR UPDATE OF cc SKIP LOCKED: other concurrent script runs skip already-
// locked rows, preventing double-pick on parallel invocations.
// Immediate UPDATE to 'queued' ensures the lock survives even if this
// process holds the transaction open briefly before COMMIT.
let contacts;
{
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Send-gate parity with the canonical Go runner (services/campaigns/campaign/
    // runner.go ~220-237 + gate.go EmailStatusAllowed):
    //   - c.status NOT IN (...) — the full "do not contact" vocabulary (migration
    //     033 status_enum_check) so a contact that flipped to unsubscribed/bounced/
    //     suppressed after enrollment is excluded at send time, not just enroll time.
    //   - COALESCE(co.email_status,'')='valid' — only verified-deliverable emails
    //     (EmailStatusAllowed). LEFT JOIN → no company row = '' = blocked.
    //   - suppression UNION filter — both outreach_suppressions ∪ suppression_list.
    const result = await client.query(
      `SELECT cc.id AS cc_id, cc.contact_id, cc.status,
              c.email, c.first_name, c.last_name, c.company_name, c.region, c.ico
       FROM campaign_contacts cc
       JOIN contacts c ON c.id=cc.contact_id
       LEFT JOIN companies co ON co.ico = c.ico
       WHERE cc.campaign_id=$1 AND cc.status='pending'
         AND c.status NOT IN (
             'bounced', 'blacklisted', 'invalid',
             'unsubscribed', 'opted_out',
             'human_handoff', 'paused_human',
             'completed_no_reply', 'retention_expired',
             'suppressed'
         )
         AND COALESCE(co.email_status, '') = 'valid'
         AND ${notInUnionWhere('c.email')}
       ORDER BY cc.contact_id LIMIT $2
       FOR UPDATE OF cc SKIP LOCKED`,
      [campaignId, count]
    );
    if (result.rows.length > 0) {
      await client.query(
        `UPDATE campaign_contacts SET status='queued', updated_at=NOW()
         WHERE id = ANY($1::int[])`,
        [result.rows.map(r => r.cc_id)]
      );
    }
    await client.query('COMMIT');
    contacts = result.rows;
  } catch (e) {
    await client.query('ROLLBACK');
    await pool.end();
    throw e;
  } finally {
    client.release();
  }
}
console.log(`\nPicked ${contacts.length} pending contact(s) to send (locked as queued).`);

if (contacts.length === 0) { console.log('Nothing to send.'); await pool.end(); process.exit(0); }

// Send each
let sent = 0; let failed = 0;
for (let i = 0; i < contacts.length; i++) {
  const c = contacts[i];
  const mb = usableMailboxes[i % usableMailboxes.length];
  const proxy = mbProxy[mb.id];

  const vars = {
    firma:    c.company_name || '', jmeno: c.first_name || '',
    prijmeni: c.last_name || '',    region: c.region || '',
    ico:      c.ico || '',          podpis: SIGNATURE,
    unsuburl: buildUnsubURL(campaignId, c.contact_id, c.email),
  };
  const subject = substituteVars(tpl.subject, vars);
  const body = substituteVars(tpl.body, vars);

  console.log(`\n[${i + 1}/${contacts.length}] ${mb.from_address} → ${c.email} (${c.company_name})`);

  // Exactly-once send-claim (migration 171 send_claims) — the shared atomic
  // gate the Go daemon also acquires. Supersedes the prior operator_audit_log
  // idempotency read: durable, atomic (UNIQUE constraint), and visible to BOTH
  // send paths, so the dual-path race can no longer double-send. step=0 — the
  // operator script sends only the first sequence step.
  const claim = await acquireClaim(pool, campaignId, c.contact_id, 0);
  if (claim !== CLAIM_PROCEED) {
    if (claim === CLAIM_ALREADY_SENT) {
      console.log(`  ⚠ already sent (claim), catching up status`);
      await pool.query(
        `UPDATE campaign_contacts SET status='in_sequence', current_step=0, next_send_at=NOW(), updated_at=NOW()
         WHERE id=$1 AND status != 'in_sequence'`,
        [c.cc_id]
      ).catch(e => console.warn(`  status catch-up err: ${e.message}`));
      sent++;
    } else {
      // in-flight elsewhere: the Go daemon or a parallel run holds the claim.
      // Release our 'queued' reservation back to 'pending' so the holder owns it.
      console.log(`  ⏭ in-flight elsewhere (claim), skipping`);
      await pool.query(
        `UPDATE campaign_contacts SET status='pending', updated_at=NOW() WHERE id=$1 AND status='queued'`,
        [c.cc_id]
      ).catch(e => console.warn(`  revert err: ${e.message}`));
    }
    continue;
  }

  try {
    const res = await fetch(`${RELAY_URL}/v1/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RELAY_TOKEN}` },
      body: JSON.stringify({
        recipient: c.email, subject, body,
        from_address: mb.from_address,
        smtp_host: mb.smtp_host, smtp_port: mb.smtp_port,
        smtp_username: mb.from_address,
        // R1/S3.3 — per-row password, env fallback
        smtp_password: resolveMailboxPassword(mb, SMTP_PASSWORD_FALLBACK),
      }),
    });
    const data = await res.json();
    if (data.envelope_id) {
      console.log(`  ✓ sealed: ${data.envelope_id}`);
      // Confirm the send-claim (claiming -> sent) so any future attempt for this
      // (campaign,contact,step) short-circuits. Idempotent (CAS on 'claiming').
      await confirmClaim(pool, campaignId, c.contact_id, 0, data.envelope_id)
        .catch(e => console.warn(`  claim confirm err: ${e.message}`));
      // send_events row — parity with the Go orchestrator's post-send INSERT
      // (services/orchestrator/cmd/outreach/main.go). Fires the BEFORE-INSERT
      // warmup-cap trigger (trg_enforce_warmup_cap keys on mailbox_used =
      // outreach_mailboxes.from_address) and feeds per-mailbox daily-cap counting
      // + reply threading (runner reads message_id from send_events). step=0.
      // Best-effort (Go logs + continues): a warmup_cap_exceeded rejection here
      // is logged, not fatal — the message already left via the relay.
      await pool.query(
        `INSERT INTO send_events (campaign_id, contact_id, step, mailbox_used, message_id, subject, status, sent_at)
         VALUES ($1, $2, 0, $3, $4, $5, 'sent', NOW())
         ON CONFLICT (campaign_id, contact_id, step) WHERE status = 'sent' DO NOTHING`,
        [campaignId, c.contact_id, mb.from_address, data.envelope_id, subject]
      ).catch(e => console.warn(`  send_events err: ${e.message}`));
      // Audit log first — so idempotency check works on crash before status UPDATE
      await pool.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('campaign_contact_send', 'campaign-send-batch', 'campaign_contact', $1::text,
                 jsonb_build_object('campaign_id', $2::int, 'contact_id', $3::bigint,
                                    'mailbox_id', $4::int, 'envelope_id', $5::text,
                                    'proxy', $6::text, 'subject', $7::text))`,
        [c.cc_id, campaignId, c.contact_id, mb.id, data.envelope_id, proxy, subject]
      ).catch(e => console.warn(`  audit log err: ${e.message}`));
      // Mark in_sequence + step 0
      await pool.query(
        `UPDATE campaign_contacts SET status='in_sequence', current_step=0, next_send_at=NOW(), updated_at=NOW()
         WHERE id=$1`, [c.cc_id]
      );
      sent++;
    } else {
      console.log(`  ✗ submit failed: ${JSON.stringify(data)}`);
      // Release the send-claim (claiming -> failed) so the next run can re-claim.
      await releaseClaim(pool, campaignId, c.contact_id, 0)
        .catch(e => console.warn(`  claim release err: ${e.message}`));
      // Revert to pending so next run can retry
      await pool.query(
        `UPDATE campaign_contacts SET status='pending', updated_at=NOW() WHERE id=$1 AND status='queued'`,
        [c.cc_id]
      ).catch(e => console.warn(`  revert err: ${e.message}`));
      failed++;
    }
  } catch (e) {
    console.log(`  ✗ exception: ${e.message}`);
    // Release the send-claim (claiming -> failed) so the next run can re-claim.
    await releaseClaim(pool, campaignId, c.contact_id, 0)
      .catch(err => console.warn(`  claim release err: ${err.message}`));
    // Revert to pending so next run can retry
    await pool.query(
      `UPDATE campaign_contacts SET status='pending', updated_at=NOW() WHERE id=$1 AND status='queued'`,
      [c.cc_id]
    ).catch(err => console.warn(`  revert err: ${err.message}`));
    failed++;
  }
}

console.log(`\n═══════════════════════════════════════════════`);
console.log(`SUMMARY: sent=${sent} failed=${failed} of ${contacts.length}`);
console.log(`═══════════════════════════════════════════════`);

await pool.end();
process.exit(failed > 0 ? 1 : 0);
