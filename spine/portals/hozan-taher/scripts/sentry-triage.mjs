#!/usr/bin/env node
// Pull open Sentry issues across configured projects and upsert matching GH issues.
//
// Idempotent: looks up existing GH issue by Sentry event ID embedded in issue body.
//   - If exists: comment with new occurrence count
//   - If new and count >= MIN_COUNT: create new GH issue
//
// Env:
//   SENTRY_AUTH_TOKEN     required (Sentry → Settings → Auth Tokens, scope project:read)
//   SENTRY_ORG            required (e.g. "hozan-taher")
//   SENTRY_PROJECTS       comma-separated project slugs (default: relay,privacy-gateway,mailboxes,campaigns)
//   MIN_COUNT_24H         threshold to create issue (default: 100)
//   GH_TOKEN              required for gh CLI
//
// Usage:
//   SENTRY_AUTH_TOKEN=... SENTRY_ORG=hozan-taher node scripts/sentry-triage.mjs
//   node scripts/sentry-triage.mjs --dry-run

import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);

const isDryRun = !!args['dry-run'];

const SENTRY_TOKEN = process.env.SENTRY_AUTH_TOKEN;
const SENTRY_ORG = process.env.SENTRY_ORG;
const PROJECTS = (process.env.SENTRY_PROJECTS || 'relay,privacy-gateway,mailboxes,campaigns')
  .split(',')
  .map((p) => p.trim());
const MIN_COUNT = parseInt(process.env.MIN_COUNT_24H || '100', 10);

if (!SENTRY_TOKEN || !SENTRY_ORG) {
  console.error('SENTRY_AUTH_TOKEN and SENTRY_ORG required');
  process.exit(2);
}

// ── Sentry API ───────────────────────────────────────────────────
async function sentryFetch(path) {
  const url = `https://sentry.io/api/0${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SENTRY_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Sentry ${path}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function loadOpenIssues(project) {
  // statsPeriod=24h restricts count to last day
  return sentryFetch(`/projects/${SENTRY_ORG}/${project}/issues/?statsPeriod=24h&query=is:unresolved`);
}

// ── GitHub upsert ────────────────────────────────────────────────
function gh(cmdArgs) {
  return execFileSync('gh', cmdArgs, { encoding: 'utf8' });
}

function findExistingIssue(sentryEventId) {
  const list = JSON.parse(gh(['issue', 'list', '--state=all', '--limit=200',
    '--label=from/sentry', '--search', sentryEventId,
    '--json=number,title,body']));
  return list.find((i) => (i.body || '').includes(sentryEventId));
}

function inferArea(culprit) {
  const lower = (culprit || '').toLowerCase();
  if (lower.includes('mailbox')) return 'mailboxes';
  if (lower.includes('relay')) return 'relay';
  if (lower.includes('campaign')) return 'campaigns';
  if (lower.includes('contact')) return 'contacts';
  if (lower.includes('inbox')) return 'inbox';
  if (lower.includes('orchestrator')) return 'orchestrator';
  if (lower.includes('privacy')) return 'privacy-gateway';
  if (lower.includes('common')) return 'common';
  return 'common';
}

function upsertGhIssue(sentryIssue, project) {
  const eventId = sentryIssue.id;
  const count24h = parseInt(sentryIssue.count || '0', 10);
  const release = sentryIssue.lastSeen || '(unknown)';
  const culprit = sentryIssue.culprit || '';
  const title = sentryIssue.title || `${sentryIssue.type}: ${sentryIssue.metadata?.value || ''}`;

  const existing = findExistingIssue(eventId);

  if (existing) {
    const note = `Re-occurred at ${new Date().toISOString()}, current 24h count = ${count24h}.`;
    if (isDryRun) {
      console.log(`[DRY-UPDATE] #${existing.number} ${eventId} count=${count24h}`);
      return;
    }
    gh(['issue', 'comment', String(existing.number), '--body', note]);
    console.log(`[UPDATE] #${existing.number} count=${count24h}`);
    return;
  }

  if (count24h < MIN_COUNT) {
    if (isDryRun) console.log(`[DRY-SKIP] ${eventId} count=${count24h} < ${MIN_COUNT}`);
    return;
  }

  const area = inferArea(culprit);
  const ghTitle = `[sentry] ${title.slice(0, 120)}`;
  const body = [
    `## Symptom`,
    `Sentry recorded ${count24h} occurrences in last 24h.`,
    `Culprit: \`${culprit}\``,
    ``,
    `## Repro`,
    `Sentry event: https://sentry.io/organizations/${SENTRY_ORG}/issues/${eventId}/`,
    ``,
    `## Acceptance`,
    `- [ ] Sentry 24h count drops to 0 after deploy`,
    `- [ ] Regression test added`,
    ``,
    `## Context`,
    `**Sentry event ID**: \`${eventId}\``,
    `**Project**: \`${project}\``,
    `**Last seen release**: \`${release}\``,
  ].join('\n');

  if (isDryRun) {
    console.log(`[DRY-CREATE] ${ghTitle} (count=${count24h})`);
    return;
  }

  const cmdArgs = ['issue', 'create', '--title', ghTitle, '--body', body,
    '--label', 'from/sentry',
    '--label', 'kind/bug',
    '--label', `area/${area}`,
    '--label', count24h > 1000 ? 'priority/p0' : 'priority/p1',
    '--label', 'status/triaged'];
  try {
    const url = gh(cmdArgs).trim();
    console.log(`[CREATE] ${eventId} → ${url}`);
  } catch (err) {
    console.error(`[ERR] ${eventId}: ${err.message.split('\n')[0]}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  for (const project of PROJECTS) {
    console.log(`\n== ${project} ==`);
    try {
      const issues = await loadOpenIssues(project);
      console.log(`  ${issues.length} open Sentry issue(s)`);
      for (const issue of issues) {
        upsertGhIssue(issue, project);
      }
    } catch (err) {
      console.error(`  FAIL: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
