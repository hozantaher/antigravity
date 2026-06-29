#!/usr/bin/env node
// Backfill GH issues from initiative TODO checkboxes.
//
// Reads docs/initiatives/*.md, extracts unchecked items "- [ ] **Sx.y** ...",
// creates one GH issue per item with derived labels.
//
// Idempotent: skips items whose Sx.y key already appears in any open issue title.
//
// Usage:
//   node scripts/setup/backfill-tasks.mjs --dry-run
//   node scripts/setup/backfill-tasks.mjs --initiative=2026-04-27-test-suite-recovery
//   node scripts/setup/backfill-tasks.mjs --all

import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = '/Users/messingtomas/Documents/Projekty/hozan-taher';
const INITIATIVES_DIR = join(ROOT, 'docs/initiatives');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isAll = args.includes('--all');
const initiativeArg = args.find((a) => a.startsWith('--initiative='))?.split('=')[1];

const TASK_RE = /^-\s*\[\s\]\s*\*\*([SA]\d+\.\d+)\*\*\s*(.+?)$/;
const SPRINT_RE = /^###\s*Sprint\s*([SA]\d+)\s*—\s*(.+?)\s*\(/;

const AREA_KEYWORDS = {
  scrapers: 'scrapers', 'mobile-de': 'scrapers',
  mailboxes: 'mailboxes', watchdog: 'mailboxes',
  relay: 'relay', tor: 'relay', onion: 'relay', 'round-robin': 'relay',
  'privacy-gateway': 'privacy-gateway',
  contacts: 'contacts',
  campaigns: 'campaigns',
  inbox: 'inbox',
  orchestrator: 'orchestrator',
  common: 'common',
  dashboard: 'dashboard', 'outreach-dashboard': 'dashboard', vitest: 'dashboard',
  playwright: 'dashboard', stryker: 'dashboard',
  mcp: 'mcp',
  worker: 'worker',
  extension: 'extension',
  bff: 'bff',
  test: 'test-infra', testing: 'test-infra', coverage: 'test-infra',
  ci: 'test-infra', workflow: 'test-infra', runner: 'test-infra',
};

const KIND_KEYWORDS = {
  flake: 'flake',
  bug: 'bug', fix: 'bug',
  smaz: 'refactor', remove: 'refactor', delete: 'refactor', 'přejmenovat': 'refactor',
  doc: 'docs', 'dokumentovat': 'docs', adr: 'docs', readme: 'docs', playbook: 'docs',
  test: 'test',
  config: 'infra', workflow: 'infra', script: 'infra', skript: 'infra',
  dep: 'dep', verze: 'dep', align: 'dep',
};

function inferLabels(text) {
  const lower = text.toLowerCase();
  const labels = ['from/initiative', 'priority/p2', 'status/triaged'];

  let area = null;
  for (const [keyword, label] of Object.entries(AREA_KEYWORDS)) {
    if (lower.includes(keyword)) { area = label; break; }
  }
  labels.push(`area/${area || 'test-infra'}`);

  let kind = null;
  for (const [keyword, label] of Object.entries(KIND_KEYWORDS)) {
    if (lower.includes(keyword)) { kind = label; break; }
  }
  labels.push(`kind/${kind || 'infra'}`);

  // Conservative default: needs-design unless obviously safe (delete, rename, doc)
  const isSafe = /smaz|delete|remove|přejmenov|rename|doc|adr|playbook|readme|comment/i.test(text);
  labels.push(isSafe ? 'automation/ok' : 'automation/needs-design');

  return labels;
}

function parseInitiative(content, initiativeName) {
  const lines = content.split('\n');
  const tasks = [];
  let currentSprint = '';
  let currentSprintTitle = '';

  for (const line of lines) {
    const sprintMatch = line.match(SPRINT_RE);
    if (sprintMatch) {
      currentSprint = sprintMatch[1];
      currentSprintTitle = sprintMatch[2];
      continue;
    }
    const taskMatch = line.match(TASK_RE);
    if (taskMatch && currentSprint) {
      const [, key, body] = taskMatch;
      tasks.push({
        key,
        body: body.trim(),
        sprint: currentSprint,
        sprintTitle: currentSprintTitle,
        initiative: initiativeName,
      });
    }
  }
  return tasks;
}

function getExistingIssueKeys() {
  const json = execFileSync('gh', ['issue', 'list', '--state=open', '--limit=500', '--json=number,title,labels'], { encoding: 'utf8' });
  const issues = JSON.parse(json);
  const keys = new Set();
  for (const issue of issues) {
    const m = issue.title.match(/\[([SA]\d+\.\d+)\]/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

function createIssue({ key, body, sprint, sprintTitle, initiative }, dryRun) {
  const title = `[${key}] ${body.slice(0, 80)}`;
  const labels = inferLabels(body);

  const issueBody = [
    `## Symptom`,
    body,
    ``,
    `## Repro`,
    `Backfilled from initiative: \`docs/initiatives/${initiative}.md\``,
    `Sprint: ${sprint} — ${sprintTitle}`,
    ``,
    `## Acceptance`,
    `- [ ] Implementation matches initiative spec`,
    `- [ ] Tests pass (where applicable)`,
    `- [ ] Initiative checkbox marked complete`,
    ``,
    `## Context`,
    `Auto-backfilled by \`scripts/setup/backfill-tasks.mjs\`. Adjust labels manually if inferred wrong.`,
  ].join('\n');

  if (dryRun) {
    console.log(`[DRY] ${title}`);
    console.log(`      labels: ${labels.join(', ')}`);
    return;
  }

  const args = ['issue', 'create', '--title', title, '--body', issueBody];
  for (const label of labels) {
    args.push('--label', label);
  }
  try {
    const url = execFileSync('gh', args, { encoding: 'utf8' }).trim();
    console.log(`[OK]  ${key} → ${url}`);
  } catch (err) {
    console.error(`[ERR] ${key}: ${err.message.split('\n')[0]}`);
  }
}

async function main() {
  let files;
  if (initiativeArg) {
    files = [`${initiativeArg}.md`];
  } else if (isAll) {
    const all = await readdir(INITIATIVES_DIR);
    files = all.filter((f) => f.startsWith('2026-04-27-')); // only today's two for now
  } else {
    console.error('Usage: --initiative=<slug> or --all (default: today\'s initiatives)');
    process.exit(2);
  }

  const existingKeys = getExistingIssueKeys();
  console.log(`Existing issue keys (skipping): ${existingKeys.size}`);

  let total = 0, skipped = 0, created = 0;
  for (const file of files) {
    const path = join(INITIATIVES_DIR, file);
    const content = await readFile(path, 'utf8');
    const initiativeName = basename(file, '.md');
    const tasks = parseInitiative(content, initiativeName);
    console.log(`\n== ${initiativeName} (${tasks.length} tasks) ==`);
    for (const task of tasks) {
      total++;
      if (existingKeys.has(task.key)) {
        console.log(`[SKIP] ${task.key} (already exists)`);
        skipped++;
        continue;
      }
      createIssue(task, isDryRun);
      created++;
    }
  }

  console.log(`\n== Summary == total=${total} skipped=${skipped} created=${created} dryRun=${isDryRun}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
