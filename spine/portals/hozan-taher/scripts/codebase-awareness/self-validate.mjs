#!/usr/bin/env node
/**
 * self-validate.mjs — CAD-A5 (#564)
 *
 * Self-validation loop: picks a subsystem MAP, generates a "blind quiz" prompt,
 * optionally compares an AI-generated summary against the MAP, and logs
 * knowledge gaps for re-discovery.
 *
 * Designed to run:
 *   - Weekly via .github/workflows/codebase-awareness-selfvalidate.yml
 *   - On demand: node scripts/codebase-awareness/self-validate.mjs --subsystem random
 *
 * Usage:
 *   node scripts/codebase-awareness/self-validate.mjs
 *        [--subsystem=<name|random>]
 *        [--dry-run]
 *        [--gap-threshold=N]
 *        [--output=<file>]
 *        [--quiz-only]         # just print the quiz, do not compare
 *
 * Assumed contracts (A1-A3 not yet merged as of 2026-05-01):
 *   - A1: MAP files exist at docs/subsystem-maps/*.md
 *   - A3: MEMORY-INDEX.md provides tier tags; used to decide which memories to
 *         pre-load before a quiz session
 *
 * Exit codes:
 *   0 — no gap (or quiz-only mode)
 *   1 — gap detected (divergence > threshold)
 *   2 — misconfiguration / missing files
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname as pathDirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createHash } from 'node:crypto';

const __dirname = pathDirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);

const DRY_RUN = !!args['dry-run'];
const QUIZ_ONLY = !!args['quiz-only'];
const SUBSYSTEM_ARG = args['subsystem'] || 'random';
const GAP_THRESHOLD = parseInt(args['gap-threshold'] ?? '3', 10);
const OUTPUT_FILE = args['output'] || null;

const DATE = new Date().toISOString().slice(0, 10);
const MAPS_DIR = join(ROOT, 'docs', 'subsystem-maps');
const GAP_LOG = join(ROOT, 'reports', 'codebase-awareness', 'knowledge-gaps.jsonl');

const log = (...a) => console.error('[self-validate]', ...a);

// ── Subsystem selection ───────────────────────────────────────────────────────

function selectSubsystem() {
  if (!existsSync(MAPS_DIR)) {
    log('ERROR: docs/subsystem-maps/ does not exist');
    process.exit(2);
  }

  const mapFiles = readdirSync(MAPS_DIR).filter((f) => f.endsWith('.md'));
  if (mapFiles.length === 0) {
    log('ERROR: no MAP files in docs/subsystem-maps/');
    process.exit(2);
  }

  if (SUBSYSTEM_ARG === 'random') {
    // Deterministic seed for reproducible "random" in weekly cron:
    // use ISO week number so the same subsystem is chosen all week.
    const seed = getISOWeek(new Date());
    const idx = seed % mapFiles.length;
    const chosen = mapFiles[idx];
    log(`Selected subsystem (week-seed ${seed}): ${chosen}`);
    return { filename: chosen, subsystem: chosen.replace(/\.md$/, '') };
  }

  // Explicit name — accept with or without .md
  const name = SUBSYSTEM_ARG.replace(/\.md$/, '') + '.md';
  if (!mapFiles.includes(name)) {
    log(`ERROR: no MAP file for subsystem "${SUBSYSTEM_ARG}". Available: ${mapFiles.join(', ')}`);
    process.exit(2);
  }
  return { filename: name, subsystem: SUBSYSTEM_ARG.replace(/\.md$/, '') };
}

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// ── MAP loading + quiz prompt generation ─────────────────────────────────────

function loadMap(filename) {
  const mapPath = join(MAPS_DIR, filename);
  try {
    return readFileSync(mapPath, 'utf8');
  } catch (e) {
    log(`ERROR: could not read MAP file ${mapPath}: ${e.message}`);
    process.exit(2);
  }
}

function extractMapSignature(content) {
  /**
   * Extract structured "signature" from a MAP doc:
   * - Pipeline step IDs (e.g. E1, P1, R1..R18, G0..G12, T1..T8, D1..D8, O1..O5)
   * - Section headings (## ...)
   * - Bypass path names
   * - Forbidden patterns
   *
   * Used as the ground-truth for comparison.
   */
  const sig = {
    stepIds: [],
    sections: [],
    bypassPaths: [],
    forbiddenPatterns: [],
    itemCount: 0,
  };

  // Step IDs: **E1**, **P1**, etc.
  const stepIdMatches = content.match(/\*\*([A-Z]\d+)\*\*/g) || [];
  sig.stepIds = [...new Set(stepIdMatches.map((m) => m.replace(/\*\*/g, '')))];

  // Section headings
  const sectionMatches = content.match(/^#{2,4} .+/gm) || [];
  sig.sections = sectionMatches.map((h) => h.replace(/^#{2,4} /, '').trim());

  // Bypass paths (lines after "Bypass" heading or with "bypass" keyword)
  const bypassSection = content.match(/## Bypass[\s\S]*?(?=^##|\z)/m);
  if (bypassSection) {
    const lines = bypassSection[0].split('\n').filter((l) => l.startsWith('-'));
    sig.bypassPaths = lines.map((l) => l.replace(/^-\s*/, '').trim()).slice(0, 10);
  }

  // Forbidden patterns
  const forbiddenSection = content.match(/## Forbidden[\s\S]*?(?=^##|\z)/m);
  if (forbiddenSection) {
    const lines = forbiddenSection[0].split('\n').filter((l) => l.startsWith('-'));
    sig.forbiddenPatterns = lines.map((l) => l.replace(/^-\s*/, '').trim()).slice(0, 10);
  }

  sig.itemCount = sig.stepIds.length + sig.sections.length;
  return sig;
}

function buildQuizPrompt(subsystem, mapContent, sig) {
  /**
   * The "blind quiz" prompt: describes the subsystem and asks an AI to summarize
   * it from memory. The actual MAP content is NOT included — this tests recall.
   *
   * When run in a Claude Code session, the operator pastes this prompt to Claude
   * and then runs compareAnswer() on the response.
   */
  return `\
---
CAD SELF-VALIDATION QUIZ — ${DATE}
Subsystem: ${subsystem}
---

WITHOUT reading docs/subsystem-maps/${subsystem}.md, answer the following from memory:

1. List the major layers/phases of the ${subsystem} pipeline (e.g. Layer 0, Layer 1…).
2. List all numbered pipeline steps you can recall (e.g. E1, P1, R1…). Be exhaustive.
3. Name any known bypass paths and state whether they are permitted or banned.
4. Name any forbidden imports or construction patterns.
5. What is the "Mandatory read" trigger (i.e. what must happen before touching this subsystem)?
6. Name the files that own the critical path for this subsystem.

---
EXPECTED sections in the MAP (for scoring):
${sig.sections.map((s) => `  - ${s}`).join('\n')}

EXPECTED step IDs (${sig.stepIds.length} total):
  ${sig.stepIds.join(', ')}

SCORING HINT (for compare mode):
  - Each missing step ID = 1 gap
  - Each missing section = 1 gap
  - Each uncited bypass path = 1 gap
  - Gap threshold for re-discovery = ${GAP_THRESHOLD}
---`;
}

// ── Comparison logic ──────────────────────────────────────────────────────────

function compareAnswer(answer, sig) {
  /**
   * Compare a freetext AI answer against the MAP signature.
   * Returns { gapCount, missingSteps, missingSections }.
   */
  const upperAnswer = answer.toUpperCase();

  const missingSteps = sig.stepIds.filter((id) => !upperAnswer.includes(id));
  const missingSections = sig.sections.filter((sec) => !upperAnswer.toLowerCase().includes(sec.toLowerCase().slice(0, 20)));
  const missingBypasses = sig.bypassPaths.filter((bp) => !upperAnswer.toLowerCase().includes(bp.toLowerCase().slice(0, 15)));

  const gapCount = missingSteps.length + missingSections.length + missingBypasses.length;
  return { gapCount, missingSteps, missingSections, missingBypasses };
}

// ── Gap logging ───────────────────────────────────────────────────────────────

function logKnowledgeGap(subsystem, gapResult) {
  const entry = {
    date: DATE,
    subsystem,
    gapCount: gapResult.gapCount,
    missingSteps: gapResult.missingSteps,
    missingSections: gapResult.missingSections,
    missingBypasses: gapResult.missingBypasses,
    action: 'schedule-rediscovery',
  };

  if (DRY_RUN) {
    log('[dry-run] would append gap log:', JSON.stringify(entry));
    return;
  }

  mkdirSync(parentDir(GAP_LOG), { recursive: true });
  appendFileSync(GAP_LOG, JSON.stringify(entry) + '\n', 'utf8');
  log(`Gap logged → ${GAP_LOG}`);
}

function parentDir(p) {
  return join(p, '..');
}

// ── Output ────────────────────────────────────────────────────────────────────

function writeOutput(content) {
  if (OUTPUT_FILE) {
    if (!DRY_RUN) {
      mkdirSync(join(OUTPUT_FILE, '..'), { recursive: true });
      writeFileSync(OUTPUT_FILE, content, 'utf8');
    }
    log(`Output written → ${OUTPUT_FILE}`);
  } else {
    process.stdout.write(content + '\n');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log(`=== self-validate ${DRY_RUN ? '(DRY RUN)' : ''} ===`);

  const { filename, subsystem } = selectSubsystem();
  const mapContent = loadMap(filename);
  const sig = extractMapSignature(mapContent);

  log(`Subsystem: ${subsystem}`);
  log(`Map signature: ${sig.stepIds.length} step IDs, ${sig.sections.length} sections`);
  log(`Gap threshold: ${GAP_THRESHOLD}`);

  const quiz = buildQuizPrompt(subsystem, mapContent, sig);

  if (QUIZ_ONLY) {
    writeOutput(quiz);
    log('Quiz-only mode. Paste the above into a Claude Code session to run self-validation.');
    process.exit(0);
  }

  // In automated mode (GitHub Actions), we can optionally receive an answer
  // via stdin. If stdin is TTY, just output the quiz and exit 0.
  if (process.stdin.isTTY) {
    writeOutput(quiz);
    log('No stdin answer provided. Re-run with --quiz-only to just generate the prompt,');
    log('or pipe an answer: echo "<answer>" | node self-validate.mjs --subsystem=<name>');
    process.exit(0);
  }

  // Read answer from stdin
  let answer = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    answer += chunk;
  }

  if (!answer.trim()) {
    writeOutput(quiz);
    process.exit(0);
  }

  log('Comparing answer against MAP...');
  const gapResult = compareAnswer(answer, sig);

  const resultLines = [
    `# Self-validation result — ${DATE}`,
    '',
    `**Subsystem:** ${subsystem}`,
    `**Gap count:** ${gapResult.gapCount} / threshold ${GAP_THRESHOLD}`,
    `**Status:** ${gapResult.gapCount > GAP_THRESHOLD ? 'GAP DETECTED — re-discovery scheduled' : 'PASS'}`,
    '',
  ];

  if (gapResult.missingSteps.length > 0) {
    resultLines.push(`**Missing steps (${gapResult.missingSteps.length}):** ${gapResult.missingSteps.join(', ')}`);
  }
  if (gapResult.missingSections.length > 0) {
    resultLines.push(`**Missing sections (${gapResult.missingSections.length}):** ${gapResult.missingSections.join('; ')}`);
  }
  if (gapResult.missingBypasses.length > 0) {
    resultLines.push(`**Missing bypasses (${gapResult.missingBypasses.length}):** ${gapResult.missingBypasses.join('; ')}`);
  }

  writeOutput(resultLines.join('\n'));

  if (gapResult.gapCount > GAP_THRESHOLD) {
    logKnowledgeGap(subsystem, gapResult);
    log(`KNOWLEDGE GAP DETECTED (${gapResult.gapCount} > ${GAP_THRESHOLD}). Re-discovery recommended.`);
    log(`Run: pnpm rebuild-claude-knowledge --drift-threshold=0 (or /discover ${subsystem} in Claude Code)`);
    process.exit(1);
  }

  log(`No significant gap (${gapResult.gapCount} <= ${GAP_THRESHOLD}). Validation passed.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[self-validate] fatal error:', e);
  process.exit(2);
});
