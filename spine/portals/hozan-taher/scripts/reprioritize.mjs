#!/usr/bin/env node
// Algoritmický re-prioritizer for GitHub Issues backlog.
//
// Reads open issues + signals (Sentry counts, CI failure history, recent commits),
// computes priority score per issue, updates priority/p* labels.
//
// Pure deterministic scoring — no LLM. Audit comment explains every change.
//
// Usage:
//   node scripts/reprioritize.mjs --dry-run
//   node scripts/reprioritize.mjs           (live, updates labels + comments)
//   node scripts/reprioritize.mjs --no-audit (skip comment writes)

import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const skipAudit = args.includes('--no-audit');

// ── Scoring rules (tuneable) ─────────────────────────────────────
const RULES = [
  { id: 'sentry-very-frequent', score: 50, when: (ctx) => ctx.sentryCount24h > 1000 },
  { id: 'sentry-frequent',      score: 30, when: (ctx) => ctx.sentryCount24h > 100 },
  { id: 'flake',                score: 20, when: (ctx) => ctx.labels.has('kind/flake') },
  { id: 'blocking-ci',          score: 15, when: (ctx) => ctx.labels.has('blocking-ci') },
  { id: 'health-check',         score: 10, when: (ctx) => ctx.labels.has('from/health-check') },
  { id: 'user-recent-area',     score: -10, when: (ctx) => ctx.userTouchedAreaRecently },
  { id: 'manual-p0-pin',        score: 100, when: (ctx) => ctx.labels.has('priority/manual-override') },
  { id: 'stale',                score: -5, when: (ctx) => ctx.ageDays > 30 && !ctx.labels.has('status/in-bot') },
];

// ── Score → label mapping ────────────────────────────────────────
// `floor` raises the minimum priority for issues with certain provenance —
// e.g. backfilled initiative tasks default to P2 even without active signal,
// because they represent a planned commitment, not a stale ticket.
function scoreToPriority(score, ctx) {
  let priority;
  if (score >= 40)      priority = 'priority/p0';
  else if (score >= 20) priority = 'priority/p1';
  else if (score >= 5)  priority = 'priority/p2';
  else                  priority = 'priority/p3';

  const floor = ctx.labels.has('from/initiative') ? 'priority/p2' : null;
  if (floor && PRIORITY_RANK[priority] > PRIORITY_RANK[floor]) {
    priority = floor;
  }
  return priority;
}

const PRIORITY_RANK = {
  'priority/p0': 0,
  'priority/p1': 1,
  'priority/p2': 2,
  'priority/p3': 3,
};

// ── Helpers ──────────────────────────────────────────────────────
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function loadOpenIssues() {
  const json = gh(['issue', 'list', '--state=open', '--limit=500',
    '--json=number,title,labels,createdAt,body,assignees']);
  return JSON.parse(json);
}

function recentUserCommits(sinceHours = 24) {
  try {
    const out = execFileSync('git', ['log', '--all', `--since=${sinceHours} hours ago`,
      '--name-only', '--format='], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function inferAreaFromLabels(labels) {
  const area = labels.find((l) => l.name?.startsWith('area/'));
  return area ? area.name.replace('area/', '') : null;
}

function userTouchedArea(area, recentFiles) {
  if (!area) return false;
  const areaPath = area === 'dashboard' ? 'apps/outreach-dashboard'
    : area === 'extension' ? 'apps/extension'
    : `services/${area}`;
  return recentFiles.some((f) => f.includes(areaPath));
}

function getSentryCount(_issue) {
  // Stub: real impl will pull from Sentry API via SENTRY_AUTH_TOKEN.
  // For now: parse "Event count (24h)" from issue body if present (Sentry template).
  const body = _issue.body || '';
  const m = body.match(/Event count \(24h\)[^0-9]*([0-9]+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function ageDays(createdAt) {
  return Math.floor((Date.now() - new Date(createdAt)) / (1000 * 60 * 60 * 24));
}

// ── Main ─────────────────────────────────────────────────────────
function buildContext(issue, recentFiles) {
  const labels = new Set((issue.labels || []).map((l) => l.name));
  const area = inferAreaFromLabels(issue.labels || []);
  return {
    labels,
    sentryCount24h: getSentryCount(issue),
    userTouchedAreaRecently: userTouchedArea(area, recentFiles),
    ageDays: ageDays(issue.createdAt),
  };
}

function score(ctx) {
  const applied = [];
  let total = 0;
  for (const rule of RULES) {
    if (rule.when(ctx)) {
      total += rule.score;
      applied.push(`${rule.id} (+${rule.score})`);
    }
  }
  return { total, applied };
}

function currentPriority(labels) {
  const found = [...labels].find((l) => l.startsWith('priority/'));
  return found || null;
}

async function reprioritize() {
  console.log('Loading open issues...');
  const issues = loadOpenIssues();
  console.log(`  ${issues.length} open issues`);

  console.log('Loading recent commits...');
  const recentFiles = recentUserCommits(24);
  console.log(`  ${recentFiles.length} files touched in last 24h`);

  let changed = 0, unchanged = 0;
  for (const issue of issues) {
    const ctx = buildContext(issue, recentFiles);
    const { total, applied } = score(ctx);
    const newPriority = scoreToPriority(total, ctx);
    const currPriority = currentPriority(ctx.labels);

    if (currPriority === newPriority) {
      unchanged++;
      continue;
    }

    changed++;
    console.log(`#${issue.number} ${currPriority || '(none)'} → ${newPriority} (score=${total})`);
    console.log(`  rules: ${applied.join(', ') || '(none)'}`);

    if (isDryRun) continue;

    if (currPriority) {
      gh(['issue', 'edit', String(issue.number), '--remove-label', currPriority]);
    }
    gh(['issue', 'edit', String(issue.number), '--add-label', newPriority]);

    if (!skipAudit) {
      const note = [
        `**Bot reprioritized**: \`${currPriority || '(none)'}\` → \`${newPriority}\` (score=${total})`,
        ``,
        `Rules applied:`,
        ...applied.map((r) => `- ${r}`),
        ``,
        `Reprioritizer run at ${new Date().toISOString()}.`,
      ].join('\n');
      gh(['issue', 'comment', String(issue.number), '--body', note]);
    }
  }

  console.log(`\n== Summary == changed=${changed} unchanged=${unchanged} dryRun=${isDryRun}`);
}

reprioritize().catch((err) => {
  console.error(err);
  process.exit(1);
});
