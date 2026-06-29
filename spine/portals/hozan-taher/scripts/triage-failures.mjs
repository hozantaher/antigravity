#!/usr/bin/env node
// Parse CI test failure artifacts (junit XML, vitest JSON, go test JSON output)
// and upsert one GH issue per unique failing test.
//
// Dedup key: SHA1(test_name + file_path), encoded in issue title `[test-fail] <hash> <name>`.
//
// Inputs:
//   --artifacts=<dir>   directory containing junit/, vitest/, gotest/ subfolders
//   --ci-url=<url>      CI run URL to embed in issue body
//   --dry-run           print what would happen
//
// Outputs: GH issues with labels [from/test-fail, kind/bug|kind/flake, area/<inferred>]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);

const artifactsDir = args.artifacts;
const ciUrl = args['ci-url'] || '(unknown)';
const isDryRun = !!args['dry-run'];

if (!artifactsDir) {
  console.error('--artifacts=<dir> required');
  process.exit(2);
}

// ── Parsers ──────────────────────────────────────────────────────
function parseJunitXml(content) {
  // Minimal junit parser: testcase failures
  const failures = [];
  const re = /<testcase[^>]*name="([^"]+)"[^>]*classname="([^"]*)"[^>]*>[\s\S]*?<failure[^>]*>([\s\S]*?)<\/failure>/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    failures.push({
      name: m[1],
      file: m[2],
      message: m[3].replace(/<!\[CDATA\[|\]\]>/g, '').slice(0, 500),
    });
  }
  return failures;
}

function parseVitestJson(content) {
  try {
    const data = JSON.parse(content);
    const failures = [];
    for (const file of data.testResults || []) {
      for (const result of file.assertionResults || []) {
        if (result.status === 'failed') {
          failures.push({
            name: result.fullName || result.title,
            file: file.name || file.testFilePath,
            message: (result.failureMessages || []).join('\n').slice(0, 500),
          });
        }
      }
    }
    return failures;
  } catch {
    return [];
  }
}

function parseGoTestJson(content) {
  // Each line is a JSON event from `go test -json`
  const failures = [];
  const seenFails = new Set();
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.Action === 'fail' && event.Test) {
      const key = `${event.Package}::${event.Test}`;
      if (seenFails.has(key)) continue;
      seenFails.add(key);
      failures.push({
        name: event.Test,
        file: event.Package,
        message: '(see CI log for details)',
      });
    }
  }
  return failures;
}

// ── Dispatch ─────────────────────────────────────────────────────
function loadAllFailures(dir) {
  const out = [];
  function walk(d) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      const content = readFileSync(full, 'utf8');
      const ext = extname(entry).toLowerCase();
      if (ext === '.xml' || basename(entry).includes('junit')) {
        out.push(...parseJunitXml(content));
      } else if (ext === '.json' && entry.includes('vitest')) {
        out.push(...parseVitestJson(content));
      } else if (ext === '.json' && (entry.includes('go-test') || entry.includes('gotest'))) {
        out.push(...parseGoTestJson(content));
      } else if (ext === '.txt' && entry.includes('go-test')) {
        out.push(...parseGoTestJson(content));
      }
    }
  }
  walk(dir);
  return out;
}

// ── Area inference ───────────────────────────────────────────────
function inferArea(filePath) {
  const p = filePath.toLowerCase();
  if (p.includes('mobile-de') || p.includes('scrapers/')) return 'scrapers';
  if (p.includes('mailboxes/')) return 'mailboxes';
  if (p.includes('relay/')) return 'relay';
  if (p.includes('privacy-gateway')) return 'privacy-gateway';
  if (p.includes('contacts/')) return 'contacts';
  if (p.includes('campaigns/')) return 'campaigns';
  if (p.includes('inbox/')) return 'inbox';
  if (p.includes('orchestrator')) return 'orchestrator';
  if (p.includes('common/')) return 'common';
  if (p.includes('outreach-dashboard')) return 'dashboard';
  if (p.includes('mcp/')) return 'mcp';
  if (p.includes('worker/')) return 'worker';
  if (p.includes('extension')) return 'extension';
  return 'test-infra';
}

// ── Upsert ───────────────────────────────────────────────────────
function dedupKey(failure) {
  return createHash('sha1')
    .update(`${failure.file}::${failure.name}`)
    .digest('hex')
    .slice(0, 8);
}

function findExistingIssue(key) {
  const json = execFileSync('gh', ['issue', 'list', '--state=open', '--limit=200',
    '--label=from/test-fail', '--json=number,title'], { encoding: 'utf8' });
  const issues = JSON.parse(json);
  return issues.find((i) => i.title.includes(`[${key}]`));
}

function countRecentFailures(_key) {
  // Stub: real impl would query historic CI runs. For now: return 1.
  return 1;
}

function upsertIssue(failure) {
  const key = dedupKey(failure);
  const existing = findExistingIssue(key);
  const area = inferArea(failure.file || '');
  const failCount = countRecentFailures(key);
  const kindLabel = failCount >= 3 ? 'kind/flake' : 'kind/bug';

  if (existing) {
    const note = `Re-occurred at ${new Date().toISOString()}\nCI: ${ciUrl}`;
    if (isDryRun) {
      console.log(`[DRY-UPDATE] #${existing.number} (${key}) ${failure.name}`);
      return;
    }
    execFileSync('gh', ['issue', 'comment', String(existing.number), '--body', note]);
    console.log(`[UPDATE] #${existing.number} ${failure.name}`);
    return;
  }

  const title = `[test-fail][${key}] ${failure.name}`.slice(0, 200);
  const body = [
    `## Symptom`,
    `Test \`${failure.name}\` failed in \`${failure.file}\`.`,
    ``,
    `## Repro`,
    `\`\`\`shell`,
    `# Reproduce locally:`,
    failure.file?.endsWith('.go')
      ? `cd $(dirname ${failure.file}) && go test -run ${failure.name} -count=20 -race ./...`
      : `cd ${failure.file?.split('/').slice(0, 2).join('/') || '.'} && pnpm test -- ${failure.name}`,
    `\`\`\``,
    ``,
    `## Acceptance`,
    `- [ ] Test prochází 20× v řadě (potvrzeno fix nebo flake)`,
    `- [ ] Root cause v PR description`,
    ``,
    `## Context`,
    ``,
    `**Failure message:**`,
    '```',
    failure.message || '(none)',
    '```',
    ``,
    `**CI run**: ${ciUrl}`,
    `**Dedup key**: \`${key}\``,
  ].join('\n');

  if (isDryRun) {
    console.log(`[DRY-CREATE] ${title}`);
    return;
  }

  const cmdArgs = ['issue', 'create', '--title', title, '--body', body,
    '--label', 'from/test-fail',
    '--label', kindLabel,
    '--label', `area/${area}`,
    '--label', 'status/triaged',
    '--label', 'priority/p2'];
  try {
    const url = execFileSync('gh', cmdArgs, { encoding: 'utf8' }).trim();
    console.log(`[CREATE] ${key} → ${url}`);
  } catch (err) {
    console.error(`[ERR] ${key}: ${err.message.split('\n')[0]}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────
const failures = loadAllFailures(artifactsDir);
console.log(`Found ${failures.length} failure(s) in artifacts`);

const seen = new Set();
const unique = failures.filter((f) => {
  const k = dedupKey(f);
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
console.log(`${unique.length} unique after dedup`);

for (const f of unique) {
  upsertIssue(f);
}
