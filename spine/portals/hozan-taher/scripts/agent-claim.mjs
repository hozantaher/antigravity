#!/usr/bin/env node
// Pick the next bot-eligible issue from the GH backlog.
//
// Selection rules (in order):
//   1. Open
//   2. Label `automation/ok`
//   3. NO label `automation/blocked`
//   4. NO assignee (no one else / bot is working on it)
//   5. Highest priority first (p0 > p1 > p2 > p3)
//   6. Oldest first within same priority (FIFO)
//
// Outputs to stdout (for shell parsing):
//   ISSUE_NUMBER=<n>
//   ISSUE_TITLE=<title>
//   ISSUE_AREA=<area>
//
// Or "NO_CLAIMABLE" if nothing matches.
//
// Side effects: assigns issue to bot user (BOT_GH_USER env), adds status/in-bot label.
//
// Usage:
//   node scripts/agent-claim.mjs --bot-user=hozan-bot
//   node scripts/agent-claim.mjs --dry-run

import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);

const isDryRun = !!args['dry-run'];
const botUser = args['bot-user'] || process.env.BOT_GH_USER || '';

const PRIORITY_RANK = { 'priority/p0': 0, 'priority/p1': 1, 'priority/p2': 2, 'priority/p3': 3 };

function gh(cmdArgs) {
  return execFileSync('gh', cmdArgs, { encoding: 'utf8' });
}

function loadCandidates() {
  const json = gh(['issue', 'list', '--state=open', '--limit=200',
    '--label=automation/ok',
    '--json=number,title,labels,assignees,createdAt']);
  return JSON.parse(json);
}

function isClaimable(issue) {
  const labelNames = (issue.labels || []).map((l) => l.name);
  if (labelNames.includes('automation/blocked')) return false;
  if (labelNames.includes('status/in-bot')) return false;
  if ((issue.assignees || []).length > 0) return false;
  return true;
}

function priorityOf(issue) {
  const labels = (issue.labels || []).map((l) => l.name);
  for (const [label, rank] of Object.entries(PRIORITY_RANK)) {
    if (labels.includes(label)) return rank;
  }
  return 99;
}

function areaOf(issue) {
  const area = (issue.labels || []).find((l) => l.name?.startsWith('area/'));
  return area ? area.name.replace('area/', '') : 'test-infra';
}

function main() {
  const all = loadCandidates();
  const claimable = all.filter(isClaimable);

  if (claimable.length === 0) {
    console.log('NO_CLAIMABLE');
    return;
  }

  claimable.sort((a, b) => {
    const pa = priorityOf(a), pb = priorityOf(b);
    if (pa !== pb) return pa - pb;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });

  const target = claimable[0];
  const area = areaOf(target);

  if (!isDryRun) {
    if (botUser) {
      gh(['issue', 'edit', String(target.number), '--add-assignee', botUser]);
    }
    gh(['issue', 'edit', String(target.number), '--add-label', 'status/in-bot']);
  }

  console.log(`ISSUE_NUMBER=${target.number}`);
  console.log(`ISSUE_TITLE=${JSON.stringify(target.title)}`);
  console.log(`ISSUE_AREA=${area}`);
}

main();
