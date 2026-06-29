#!/usr/bin/env node
// Campaign dry-run — render templates for each enrolled contact and log
// what WOULD be sent. NEVER touches the relay/SMTP. NO real email goes out.
//
// Pure simulation: replicates services/campaigns/content/template.go
// substituteVars + buildUnsubURL. Output is for ops review BEFORE flipping
// campaign to status='running'.
//
// Usage:
//   DATABASE_URL=... node scripts/campaign-dry-run.mjs <campaign-id>
//   UNSUBSCRIBE_SECRET=... node scripts/campaign-dry-run.mjs 455

import pg from 'pg';
import { buildUnsubToken } from '../apps/outreach-dashboard/src/lib/unsubToken.js';

const { Pool } = pg;
const id = parseInt(process.argv[2] || '0', 10);
if (!id) {
  console.error('Usage: node scripts/campaign-dry-run.mjs <campaign-id>');
  process.exit(2);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://outreach:outreach_053ff0c20c74809c@junction.proxy.rlwy.net:54755/outreach?sslmode=disable'
});

const UNSUB_SECRET = process.env.UNSUBSCRIBE_SECRET || process.env.OUTREACH_API_KEY ||
  'd755731507bb7b68f85b54d4ebcf280ed864e2f6d650270be383331aba342e06';
const UNSUB_BASE = process.env.UNSUB_BASE_URL || 'https://outreach-dashboard-production-e4ce.up.railway.app';

function buildUnsubURL(campaignId, contactId, email) {
  const token = buildUnsubToken(campaignId, contactId, email, UNSUB_SECRET);
  return `${UNSUB_BASE}/unsubscribe?c=${campaignId}&id=${contactId}&t=${token}`;
}

function substituteVars(text, vars) {
  // Resolve Go-template conditionals first (mirror services/campaigns/content/template.go resolveConditionals)
  // Pattern: {{if .Field}}...{{end}} → "..." if vars[field] truthy, else ""
  text = text.replace(/\{\{if \.(\w+)\}\}([^]*?)\{\{end\}\}/g, (_, field, body) => {
    const key = field.toLowerCase();
    return vars[key] ? body : '';
  });
  const m = {
    '{{firma}}': vars.firma || '',
    '{{jmeno}}': vars.jmeno || '',
    '{{prijmeni}}': vars.prijmeni || '',
    '{{region}}': vars.region || '',
    '{{ico}}': vars.ico || '',
    '{{podpis}}': vars.podpis || '',
    '{{unsuburl}}': vars.unsuburl || '',
    '{{.Firma}}': vars.firma || '',
    '{{.Jmeno}}': vars.jmeno || '',
    '{{.Prijmeni}}': vars.prijmeni || '',
    '{{.Region}}': vars.region || '',
    '{{.ICO}}': vars.ico || '',
    '{{.Podpis}}': vars.podpis || '',
    '{{.UnsubURL}}': vars.unsuburl || '',
  };
  let out = text;
  for (const [k, v] of Object.entries(m)) out = out.split(k).join(v);
  return out;
}

const { rows: [camp] } = await pool.query(
  `SELECT id, name, status, sequence_config, sending_config FROM campaigns WHERE id=$1`,
  [id]
);
if (!camp) { console.error(`Campaign ${id} not found`); process.exit(1); }

const sequence = camp.sequence_config || [];
const step0 = sequence[0];
if (!step0) { console.error(`Campaign ${id} has empty sequence_config`); process.exit(1); }

const { rows: [tpl] } = await pool.query(
  `SELECT id, name, subject, body FROM email_templates WHERE name=$1`,
  [step0.template]
);
if (!tpl) { console.error(`Template "${step0.template}" not found in DB`); process.exit(1); }

const { rows: contacts } = await pool.query(
  `SELECT cc.contact_id, cc.status, c.email, c.first_name, c.last_name, c.company_name, c.region, c.ico, c.industry
   FROM campaign_contacts cc JOIN contacts c ON c.id=cc.contact_id
   WHERE cc.campaign_id=$1 ORDER BY cc.contact_id LIMIT 100`,
  [id]
);

const sender_signature = 'Tým Garaaage';

console.log(`\n═══════════════════════════════════════════════════════════════`);
console.log(`DRY-RUN — campaign #${id} "${camp.name}"`);
console.log(`Status: ${camp.status}`);
console.log(`Step 0 template: "${step0.template}" (DB id ${tpl.id})`);
console.log(`Enrolled: ${contacts.length} contacts`);
console.log(`Sending: daily_cap=${camp.sending_config?.daily_cap} mailbox_pool=${JSON.stringify(camp.sending_config?.mailbox_pool)}`);
console.log(`═══════════════════════════════════════════════════════════════\n`);

let okCount = 0;
let issueCount = 0;
const issues = [];

for (const c of contacts) {
  const vars = {
    firma:    c.company_name || '',
    jmeno:    c.first_name || '',
    prijmeni: c.last_name || '',
    region:   c.region || '',
    ico:      c.ico || '',
    podpis:   sender_signature,
    unsuburl: buildUnsubURL(id, c.contact_id, c.email),
  };
  const subject = substituteVars(tpl.subject, vars);
  const body    = substituteVars(tpl.body, vars);

  const issuesPerContact = [];
  if (subject.includes('{{')) issuesPerContact.push('subject has unresolved placeholder');
  if (body.includes('{{')) issuesPerContact.push('body has unresolved placeholder');
  if (!body.includes('/unsubscribe?')) issuesPerContact.push('missing unsubscribe link');
  if (!c.email || !/@/.test(c.email)) issuesPerContact.push('invalid recipient email');

  if (issuesPerContact.length === 0) okCount++;
  else { issueCount++; issues.push({ contact_id: c.contact_id, email: c.email, issues: issuesPerContact }); }
}

// Show first 3 rendered
console.log(`\n─── First 3 rendered samples ───`);
for (let i = 0; i < Math.min(3, contacts.length); i++) {
  const c = contacts[i];
  const vars = {
    firma: c.company_name || '', jmeno: c.first_name || '', prijmeni: c.last_name || '',
    region: c.region || '', ico: c.ico || '', podpis: sender_signature,
    unsuburl: buildUnsubURL(id, c.contact_id, c.email),
  };
  const subject = substituteVars(tpl.subject, vars);
  const body = substituteVars(tpl.body, vars);
  console.log(`\n─── To: ${c.email} (${c.company_name}, ${c.region}) ─────`);
  console.log(`Subject: ${subject}`);
  console.log(`Body:`);
  console.log(body.split('\n').map(l => '  ' + l).join('\n'));
}

console.log(`\n═══════════════════════════════════════════════════════════════`);
console.log(`SUMMARY: ${okCount}/${contacts.length} clean, ${issueCount} with issues`);
if (issues.length) {
  for (const i of issues) console.log(`  ✗ #${i.contact_id} ${i.email}: ${i.issues.join(', ')}`);
}
console.log(`═══════════════════════════════════════════════════════════════\n`);

console.log(`Audit log entry that WOULD be written:`);
console.log(JSON.stringify({
  action: 'campaign_tick_dry_run',
  campaign_id: id,
  recipient_count: contacts.length,
  ok_count: okCount,
  issue_count: issueCount,
  template: step0.template,
  ts: new Date().toISOString(),
}, null, 2));

await pool.end();
process.exit(issueCount > 0 ? 1 : 0);
