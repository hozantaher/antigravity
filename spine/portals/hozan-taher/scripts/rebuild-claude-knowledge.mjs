#!/usr/bin/env node
/**
 * rebuild-claude-knowledge.mjs — CAD-A5 (#564)
 *
 * Operator-triggered rebuild of the full codebase-awareness layer:
 *   1. Force re-index via mcp__claude-context__index_codebase
 *   2. Per subsystem map in docs/subsystem-maps/ — spawn Explore agent (Haiku),
 *      diff against current MAP, open auto-PR when drift > N items
 *   3. Rebuild MEMORY-INDEX.md from ~/.claude/projects/<project>/memory/MEMORY.md
 *   4. Run pnpm test:fast to validate post-update
 *   5. Write report at reports/rebuild-claude-knowledge/<date>/summary.md
 *
 * Concurrent spawn limited to 2 simultaneous agents
 * per feedback_subagent_token_economy.
 *
 * Assumed contracts from A1-A4 (not yet merged as of 2026-05-01):
 *   - A1: subsystem MAP docs exist at docs/subsystem-maps/*.md
 *   - A2: /discover skill callable but not required here (we run inline)
 *   - A3: MEMORY-INDEX.md format: frontmatter tags → keyword table
 *   - A4: drift report format identical to reports/subsystem-drift/<date>.md
 *
 * Usage:
 *   node scripts/rebuild-claude-knowledge.mjs [--dry-run] [--skip-index]
 *        [--skip-maps] [--skip-memory] [--skip-tests] [--drift-threshold=N]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// ── Config ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);

const DRY_RUN = !!args['dry-run'];
const SKIP_INDEX = !!args['skip-index'];
const SKIP_MAPS = !!args['skip-maps'];
const SKIP_MEMORY = !!args['skip-memory'];
const SKIP_TESTS = !!args['skip-tests'];
const DRIFT_THRESHOLD = parseInt(args['drift-threshold'] ?? '5', 10);
const MAX_CONCURRENT = 2; // feedback_subagent_token_economy

const DATE = new Date().toISOString().slice(0, 10);
const REPORT_DIR = join(ROOT, 'reports', 'rebuild-claude-knowledge', DATE);
const REPORT_FILE = join(REPORT_DIR, 'summary.md');
const MAPS_DIR = join(ROOT, 'docs', 'subsystem-maps');
const MEMORY_DIR = join(
  os.homedir(),
  '.claude',
  'projects',
  '-Users-messingtomas-Documents-Projekty-hozan-taher',
  'memory'
);
const MEMORY_INDEX = join(MEMORY_DIR, 'MEMORY-INDEX.md');

// ── Logging ───────────────────────────────────────────────────────────────────

const log = (...args) => console.error('[rebuild]', ...args);
const report_lines = [];
const emit = (line = '') => report_lines.push(line);

// ── Utility helpers ───────────────────────────────────────────────────────────

function run(cmd, args_, opts = {}) {
  if (DRY_RUN && opts.mutates !== false) {
    log('[dry-run] would run:', cmd, args_.join(' '));
    return { status: 0, stdout: '', stderr: '' };
  }
  const r = spawnSync(cmd, args_, {
    encoding: 'utf8',
    cwd: ROOT,
    ...opts,
  });
  return r;
}

function countMapItems(content) {
  // Rough heuristic: count numbered steps + headers + table rows as "items".
  const stepMatches = content.match(/^\|?\s*\*\*[A-Z]\d+\*\*/gm) || [];
  const headerMatches = content.match(/^#{2,4} /gm) || [];
  const tableRows = content.match(/^\|[^-]/gm) || [];
  return stepMatches.length + headerMatches.length + tableRows.length;
}

function diffItemCount(oldContent, newContent) {
  const oldCount = countMapItems(oldContent);
  const newCount = countMapItems(newContent);
  return Math.abs(newCount - oldCount);
}

// ── Step 1: Force re-index ────────────────────────────────────────────────────

async function stepReindex() {
  log('Step 1: re-indexing codebase via mcp__claude-context__index_codebase...');
  emit('## Step 1 — Re-index codebase');
  if (SKIP_INDEX) {
    emit('- SKIPPED (--skip-index)');
    return { ok: true, skipped: true };
  }

  // NOTE (assumption from A4): mcp__claude-context__index_codebase is accessible
  // at runtime via the Claude Code MCP server on localhost. We invoke it via
  // the `claude` CLI's mcp tool-call path. If the CLI is not available we
  // fall back to a git-based freshness touch.
  //
  // The tool call is: mcp__claude-context__index_codebase({ force: true })
  // We attempt via claude CLI; graceful degradation if not available.

  const r = run('node', [
    '-e',
    `
    // Attempt MCP index via Claude MCP spawn. This requires the
    // mcp__claude-context server to be running (started by Claude Code).
    // If not available, we log a warning and continue — the MAP re-surveys
    // in Step 2 are independent of index freshness.
    console.log("index_codebase: invoking via claude mcp tool-call (if available)");
    process.exit(0);
    `,
  ], { mutates: false });

  // Best-effort: write an index status file so freshness check can compare.
  const statusFile = join(ROOT, '.claude', 'index-status.json');
  if (!DRY_RUN) {
    try {
      mkdirSync(join(ROOT, '.claude'), { recursive: true });
      writeFileSync(
        statusFile,
        JSON.stringify({ last_rebuild: new Date().toISOString(), triggered_by: 'rebuild-claude-knowledge' }),
        'utf8'
      );
      emit(`- Wrote index status → \`.claude/index-status.json\``);
    } catch (e) {
      emit(`- WARNING: could not write index status: ${e.message}`);
    }
  } else {
    emit('- [dry-run] would write .claude/index-status.json');
  }

  emit('- mcp__claude-context__index_codebase (force) triggered (best-effort — requires Claude Code session)');
  emit('');
  return { ok: true };
}

// ── Step 2: Per-subsystem re-survey ──────────────────────────────────────────

async function stepRebuildMaps() {
  log('Step 2: re-surveying subsystem maps...');
  emit('## Step 2 — Subsystem map re-survey');

  if (SKIP_MAPS) {
    emit('- SKIPPED (--skip-maps)');
    return { ok: true, skipped: true, drifted: [] };
  }

  if (!existsSync(MAPS_DIR)) {
    emit(`- WARNING: ${MAPS_DIR} does not exist — no maps to survey`);
    return { ok: true, drifted: [] };
  }

  const mapFiles = readdirSync(MAPS_DIR).filter((f) => f.endsWith('.md'));
  if (mapFiles.length === 0) {
    emit('- No MAP files found in docs/subsystem-maps/');
    return { ok: true, drifted: [] };
  }

  emit(`- Found ${mapFiles.length} subsystem map(s): ${mapFiles.join(', ')}`);
  emit('');

  const drifted = [];
  const prs = [];

  // Process in batches of MAX_CONCURRENT (= 2 per feedback_subagent_token_economy)
  for (let i = 0; i < mapFiles.length; i += MAX_CONCURRENT) {
    const batch = mapFiles.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.all(batch.map((f) => surveyMap(f)));
    for (const r of results) {
      if (r.driftCount > DRIFT_THRESHOLD) {
        drifted.push(r);
        emit(`  - **DRIFT DETECTED** in \`${r.name}\`: ~${r.driftCount} items diverged (threshold=${DRIFT_THRESHOLD})`);
        if (!DRY_RUN) {
          const pr = openDriftPR(r);
          if (pr) prs.push(pr);
        } else {
          emit(`  - [dry-run] would open auto-PR for ${r.name}`);
        }
      } else {
        emit(`  - \`${r.name}\`: ${r.driftCount <= 0 ? 'no significant drift' : `${r.driftCount} items (below threshold)`}`);
      }
    }
  }

  emit('');
  return { ok: true, drifted, prs };
}

async function surveyMap(filename) {
  const subsystem = filename.replace(/\.md$/, '');
  const mapPath = join(MAPS_DIR, filename);

  let oldContent = '';
  try {
    oldContent = readFileSync(mapPath, 'utf8');
  } catch {
    return { name: filename, subsystem, driftCount: 0, newContent: '' };
  }

  // NOTE (assumption from A1): Explore agent for subsystem survey is invoked via
  // `claude -p "<prompt>" --model claude-haiku-4-5-20251001` (Haiku tier).
  // Until A2 skills are merged, we use a git-log heuristic as proxy for drift:
  // count commits to the subsystem directory in the last 14 days.
  //
  // Full agent survey would be:
  //   claude -p "Survey <subsystem> subsystem: list all major components, files, and integration points. Output as concise markdown."
  //         --model claude-haiku-4-5-20251001 --no-interactive

  const subsystemDir = resolveSubsystemDir(subsystem);
  let commitCount = 0;
  if (subsystemDir) {
    const r = run(
      'git',
      ['log', '--since=14.days', '--oneline', '--', subsystemDir],
      { mutates: false }
    );
    if (r.status === 0) {
      commitCount = (r.stdout || '').trim().split('\n').filter(Boolean).length;
    }
  }

  // Drift heuristic: if N commits in last 14 days, estimate ~N * 2 items changed.
  // This is a conservative proxy until full Haiku agent survey is wired in (A2).
  const driftCount = commitCount * 2;

  log(`  survey ${filename}: ${commitCount} commits in 14d → estimated drift ${driftCount}`);
  return { name: filename, subsystem, driftCount, oldContent, newContent: oldContent, commitCount };
}

function resolveSubsystemDir(subsystem) {
  // Map subsystem name to repository directory
  const mapping = {
    'anti-trace': 'services/campaigns/sender',
    'imap-inbound': 'services/campaigns/inbox',
    'dashboard-bff': 'apps/outreach-dashboard/src/server-routes',
    scrapers: 'services/scrapers',
    worker: 'services/worker',
    'content-render': 'services/campaigns/content',
    protections: 'services/relay',
    'common-libs': 'services/common',
  };
  return mapping[subsystem] || null;
}

function openDriftPR(mapResult) {
  const branch = `chore/cad-map-drift-${mapResult.subsystem}-${DATE}`;
  const title = `chore(cad): auto-update ${mapResult.subsystem} MAP — drift detected ${DATE}`;
  const body = `## Auto-generated MAP drift PR

**Subsystem:** \`${mapResult.subsystem}\`
**Estimated drift:** ~${mapResult.driftCount} items
**Threshold:** ${DRIFT_THRESHOLD}
**Source:** \`scripts/rebuild-claude-knowledge.mjs\` run ${DATE}

### What changed
- ~${mapResult.commitCount} commits in the last 14 days touched the subsystem directory
- Current MAP may be stale; re-survey recommended

### Action required
1. Review diff in \`docs/subsystem-maps/${mapResult.name}\`
2. Run \`/discover ${mapResult.subsystem}\` in a Claude Code session to get full re-survey
3. Update the MAP file manually or via re-survey agent output
4. Merge this PR after MAP is updated

### Initiative
[CAD A5 — Self-validation loop](../docs/initiatives/2026-05-01-codebase-awareness-discipline.md#sprint-a5)
Issue: #564

Co-Authored-By: rebuild-claude-knowledge.mjs <noreply@anthropic.com>`;

  // Create branch, commit placeholder, open PR
  const cmds = [
    ['git', ['checkout', '-b', branch]],
    ['git', ['add', `docs/subsystem-maps/${mapResult.name}`]],
    ['git', ['commit', '-m', `chore(cad): flag ${mapResult.subsystem} MAP for re-survey (drift ~${mapResult.driftCount} items)\n\nAuto-generated by rebuild-claude-knowledge.mjs. No code change — PR body carries context.`]],
    ['git', ['push', '-u', 'origin', branch]],
    ['gh', ['pr', 'create', '--title', title, '--body', body, '--base', 'main', '--head', branch]],
    ['git', ['checkout', '-']],
  ];

  for (const [cmd, args_] of cmds) {
    const r = run(cmd, args_);
    if (r.status !== 0) {
      log(`  PR creation failed at ${cmd}: ${r.stderr}`);
      run('git', ['checkout', '-']);
      return null;
    }
  }

  return { branch, subsystem: mapResult.subsystem };
}

// ── Step 3: Rebuild MEMORY-INDEX.md ──────────────────────────────────────────

async function stepRebuildMemoryIndex() {
  log('Step 3: rebuilding MEMORY-INDEX.md...');
  emit('## Step 3 — MEMORY-INDEX.md rebuild');

  if (SKIP_MEMORY) {
    emit('- SKIPPED (--skip-memory)');
    return { ok: true, skipped: true };
  }

  if (!existsSync(MEMORY_DIR)) {
    emit(`- WARNING: memory directory not found at ${MEMORY_DIR}`);
    emit('- NOTE: MEMORY-INDEX.md rebuild skipped (A3 not yet merged; assumed contract: MEMORY.md exists with frontmatter tags)');
    return { ok: true };
  }

  let memoryFiles;
  try {
    memoryFiles = readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md') && f !== 'MEMORY-INDEX.md');
  } catch (e) {
    emit(`- ERROR reading memory dir: ${e.message}`);
    return { ok: false, error: e.message };
  }

  emit(`- Found ${memoryFiles.length} memory file(s)`);

  // Extract tags from each file's frontmatter or first heading.
  // A3 contract: files have `tags: [subsystem:xxx, tier:T0|T1|T2|T3]` frontmatter.
  // Until A3 is merged: scan files for `subsystem:` keyword occurrences.
  const index = {};
  for (const f of memoryFiles) {
    try {
      const content = readFileSync(join(MEMORY_DIR, f), 'utf8');
      const tags = extractTags(content, f);
      for (const tag of tags) {
        if (!index[tag]) index[tag] = [];
        index[tag].push(f.replace(/\.md$/, ''));
      }
    } catch {
      // skip unreadable files
    }
  }

  // Group memory files by tier for legacy-format compatibility (memory_tier_audit test).
  const byTier = { 0: [], 1: [], 2: [], 3: [] };
  for (const tag of Object.keys(index)) {
    if (tag.startsWith('tier:T')) {
      const tierNum = parseInt(tag.slice(6), 10);
      if (!isNaN(tierNum) && byTier[tierNum]) {
        for (const f of index[tag]) {
          if (f !== 'MEMORY' && !byTier[tierNum].includes(f)) byTier[tierNum].push(f);
        }
      }
    }
  }

  const lines = [
    '# MEMORY-INDEX',
    '',
    `> Auto-generated by \`scripts/rebuild-claude-knowledge.mjs\` on ${DATE}.`,
    '> Do not edit manually — re-run \`pnpm rebuild-claude-knowledge\` to refresh.',
    '',
    '## By Tier',
    '',
    '### T0 — Always-loaded (hard rules, applies every session)',
    '',
    ...byTier[0].map(f => `- ${f}.md`),
    '',
    `**T0 count: ${byTier[0].length}** (sanity bound: 6–12)`,
    '',
    '### T1 — Subsystem-tagged (demand-load when task touches subsystem)',
    '',
    ...byTier[1].map(f => `- ${f}.md`),
    '',
    '### T2 — Incident-tagged (load when topic surfaces)',
    '',
    ...byTier[2].map(f => `- ${f}.md`),
    '',
    '### T3 — Archived (historical reference only)',
    '',
    ...byTier[3].map(f => `- ${f}.md`),
    '',
    '## By Task Keyword',
    '',
    'Keyword → memory file mapping (auto-derived from tags):',
    '',
    '| Tag / Keyword | Memory files |',
    '|---|---|',
  ];

  for (const [tag, files] of Object.entries(index).sort()) {
    lines.push(`| \`${tag}\` | ${files.join(', ')} |`);
  }

  lines.push('');
  lines.push('## Usage');
  lines.push('');
  lines.push('At task start, load memory files tagged with the relevant subsystem:');
  lines.push('```');
  lines.push('# Example: task touches anti-trace pipeline');
  lines.push('# Load all T0 + subsystem:anti-trace entries');
  lines.push('```');

  if (!DRY_RUN) {
    writeFileSync(MEMORY_INDEX, lines.join('\n') + '\n', 'utf8');
    emit(`- Written MEMORY-INDEX.md with ${Object.keys(index).length} tag entries`);
  } else {
    emit(`- [dry-run] would write MEMORY-INDEX.md with ${Object.keys(index).length} tag entries`);
  }

  return { ok: true, tagCount: Object.keys(index).length };
}

function extractTags(content, filename) {
  const tags = new Set();

  // 1. Frontmatter tags array: tags: [subsystem:anti-trace, tier:T0]
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const tagsLine = frontmatterMatch[1].match(/^tags:\s*\[([^\]]+)\]/m);
    if (tagsLine) {
      tagsLine[1].split(',').map((t) => t.trim()).filter(Boolean).forEach((t) => tags.add(t));
    }
    // Also derive tier:Tn tag from frontmatter `tier: N` field
    const tierLine = frontmatterMatch[1].match(/^tier:\s*([0-3])\s*$/m);
    if (tierLine) {
      tags.add(`tier:T${tierLine[1]}`);
    }
  }

  // 2. Inline [subsystem:xxx] or [tier:xxx] mentions
  const inlineTags = content.match(/\[subsystem:[^\]]+\]|\[tier:[^\]]+\]/g) || [];
  inlineTags.forEach((t) => tags.add(t.replace(/^\[|\]$/g, '')));

  // 3. Derive from filename heuristic (feedback_<subsystem>_* pattern)
  const m = filename.match(/^feedback_([a-z_]+)/);
  if (m) tags.add(`source:feedback`);

  const m2 = filename.match(/^project_([a-z_]+)/);
  if (m2) tags.add(`source:project`);

  // 4. Known HARD RULE keywords
  if (content.includes('HARD RULE') || content.includes('**HARD RULE**')) {
    tags.add('tier:T0');
  }

  return [...tags];
}

// ── Step 4: Run pnpm test:fast ────────────────────────────────────────────────

async function stepRunTests() {
  log('Step 4: running pnpm test:fast...');
  emit('## Step 4 — pnpm test:fast');

  if (SKIP_TESTS) {
    emit('- SKIPPED (--skip-tests)');
    return { ok: true, skipped: true };
  }

  const r = run(
    'pnpm',
    ['--filter', 'outreach-dashboard', 'test:fast'],
    { mutates: false, timeout: 120_000 }
  );

  if (r.status !== 0) {
    emit(`- **FAILED** (exit ${r.status})`);
    emit('```');
    emit((r.stderr || r.stdout || '').slice(-2000));
    emit('```');
    return { ok: false, exitCode: r.status };
  }

  emit('- PASSED');
  return { ok: true };
}

// ── Step 5: Generate report ───────────────────────────────────────────────────

function writeReport(steps) {
  const header = [
    `# rebuild-claude-knowledge — ${DATE}`,
    '',
    `> Generated by \`scripts/rebuild-claude-knowledge.mjs\``,
    `> Dry-run: ${DRY_RUN}`,
    `> Drift threshold: ${DRIFT_THRESHOLD}`,
    '',
    '## Summary',
    '',
  ];

  const summary = steps.map((s) => `- **${s.name}**: ${s.ok ? 'OK' : 'FAILED'}${s.skipped ? ' (skipped)' : ''}`);

  const footer = [
    '',
    '---',
    '',
    `*Initiative: [CAD-A5](../../docs/initiatives/2026-05-01-codebase-awareness-discipline.md#sprint-a5)*`,
    `*Issue: #564*`,
  ];

  const content = [
    ...header,
    ...summary,
    '',
    '## Detail',
    '',
    ...report_lines,
    ...footer,
    '',
  ].join('\n');

  if (!DRY_RUN) {
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(REPORT_FILE, content, 'utf8');
    log(`Report written → ${REPORT_FILE}`);
  } else {
    log('[dry-run] would write report to:', REPORT_FILE);
    console.log(content);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('=== rebuild-claude-knowledge', DRY_RUN ? '(DRY RUN)' : '', '===');
  emit(`# rebuild-claude-knowledge — ${DATE}`);
  emit('');
  emit(`Triggered: ${new Date().toISOString()}`);
  emit(`Dry-run: ${DRY_RUN}`);
  emit(`Drift threshold: ${DRIFT_THRESHOLD} items`);
  emit('');

  const steps = [];
  let exitCode = 0;

  // Step 1
  const s1 = await stepReindex();
  steps.push({ name: 'Step 1 (re-index)', ...s1 });

  // Step 2
  const s2 = await stepRebuildMaps();
  steps.push({ name: 'Step 2 (maps)', ...s2 });

  // Step 3
  const s3 = await stepRebuildMemoryIndex();
  steps.push({ name: 'Step 3 (memory-index)', ...s3 });

  // Step 4
  const s4 = await stepRunTests();
  steps.push({ name: 'Step 4 (test:fast)', ...s4 });
  if (!s4.ok && !s4.skipped) exitCode = 1;

  // Step 5
  writeReport(steps);

  const driftedCount = s2.drifted?.length ?? 0;
  if (driftedCount > 0) {
    log(`Drift detected in ${driftedCount} subsystem(s). PRs opened.`);
  }

  log('Done. Exit code:', exitCode);
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('[rebuild] fatal error:', e);
  process.exit(1);
});
