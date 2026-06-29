#!/usr/bin/env node
// scripts/ops/metrics.mjs
//
// Daily development velocity metrics for messingdev/hozan-taher.
// Zero npm deps. Uses `gh` CLI + node:fs.
//
// Output:
//   docs/metrics/daily.jsonl  — one JSON object per UTC day, sorted by date
//   docs/metrics/README.md    — last 14 days table + 7-day rolling averages
//
// Usage:
//   node scripts/ops/metrics.mjs                       # compute & append today
//   node scripts/ops/metrics.mjs --date 2026-04-29     # backfill specific date
//   node scripts/ops/metrics.mjs --backfill 2026-04-25 # walk since-date through yesterday
//   node scripts/ops/metrics.mjs --no-write            # print to stdout only
//
// Idempotency: if a record for the target date already exists in daily.jsonl,
// it is replaced (not duplicated).
//
// Brutal-asserts strategy:
//   The spec offers two options for counting brutal asserts:
//     (a) regex `\bbrutal asserts\b` over commit messages of merged PRs, OR
//     (b) count `func Test` additions in `gh pr diff`.
//   We pick (a) — commit-message regex — because:
//     * `gh pr diff` returns HTTP 406 for PRs with >300 changed files, which
//       breaks larger refactors silently;
//     * commit messages are author-controlled, language-agnostic (works for
//       Go/JS/Vitest/Playwright tests alike), and cheap to fetch (one
//       `gh pr view` per merged PR);
//     * the field name "brutal asserts" matches the user's own commit prose
//       (Czech dev who self-narrates with that phrase).
//   When the user starts writing `\bbrutal asserts\b` consistently, the
//   number means something. Until then it stays low/zero — that's accurate
//   signal, not a bug.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "messingdev/hozan-taher";

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const METRICS_DIR = resolve(REPO_ROOT, "docs", "metrics");
const JSONL_PATH = resolve(METRICS_DIR, "daily.jsonl");
const README_PATH = resolve(METRICS_DIR, "README.md");

// -----------------------------------------------------------------------------
// Date helpers — all UTC, ISO YYYY-MM-DD
// -----------------------------------------------------------------------------

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

function addDaysUtc(dateStr, n) {
  const ms = Date.parse(`${dateStr}T00:00:00Z`) + n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function daysBetweenInclusive(from, toInclusive) {
  const out = [];
  let d = from;
  while (d <= toInclusive) {
    out.push(d);
    d = addDaysUtc(d, 1);
  }
  return out;
}

// -----------------------------------------------------------------------------
// gh CLI wrapper
// -----------------------------------------------------------------------------

function gh(args) {
  const out = execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out;
}

function ghJson(args) {
  const raw = gh(args);
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  return JSON.parse(trimmed);
}

// -----------------------------------------------------------------------------
// Metrics — per-day
// -----------------------------------------------------------------------------

function fetchPrsMerged(dateStr) {
  const next = addDaysUtc(dateStr, 1);
  return ghJson([
    "pr", "list",
    "--repo", REPO,
    "--state", "merged",
    "--search", `merged:>=${dateStr} merged:<${next}`,
    "--limit", "200",
    "--json", "number,mergedAt,title",
  ]);
}

function fetchPrsOpenedOnDay(dateStr) {
  const next = addDaysUtc(dateStr, 1);
  return ghJson([
    "pr", "list",
    "--repo", REPO,
    "--state", "all",
    "--search", `created:>=${dateStr} created:<${next}`,
    "--limit", "200",
    "--json", "number,createdAt",
  ]);
}

function fetchOpenPrsSnapshot() {
  return ghJson([
    "pr", "list",
    "--repo", REPO,
    "--state", "open",
    "--limit", "300",
    "--json", "number,baseRefName,headRefName",
  ]);
}

function fetchIssuesOpenedOnDay(dateStr) {
  const next = addDaysUtc(dateStr, 1);
  return ghJson([
    "issue", "list",
    "--repo", REPO,
    "--state", "all",
    "--search", `created:>=${dateStr} created:<${next}`,
    "--limit", "200",
    "--json", "number,createdAt",
  ]);
}

function fetchIssuesClosedOnDay(dateStr) {
  const next = addDaysUtc(dateStr, 1);
  return ghJson([
    "issue", "list",
    "--repo", REPO,
    "--state", "closed",
    "--search", `closed:>=${dateStr} closed:<${next}`,
    "--limit", "200",
    "--json", "number,closedAt",
  ]);
}

function fetchPrCommitMessages(prNumber) {
  // Returns a single concatenated string of all commit headlines + bodies.
  const data = ghJson([
    "pr", "view", String(prNumber),
    "--repo", REPO,
    "--json", "commits",
  ]);
  const commits = data?.commits ?? [];
  return commits
    .map((c) => `${c.messageHeadline ?? ""}\n${c.messageBody ?? ""}`)
    .join("\n");
}

function countBrutalAssertsInText(text) {
  const matches = text.match(/\bbrutal\s+asserts\b/gi);
  return matches ? matches.length : 0;
}

// -----------------------------------------------------------------------------
// Stack-depth: longest chain in the open-PR forest, traversing baseRefName.
// -----------------------------------------------------------------------------

function maxStackDepth(openPrs) {
  if (openPrs.length === 0) return 0;
  // Build edge: headRefName -> baseRefName.
  const headToBase = new Map();
  const heads = new Set();
  for (const pr of openPrs) {
    headToBase.set(pr.headRefName, pr.baseRefName);
    heads.add(pr.headRefName);
  }
  // For each open-PR head, count how many hops until we land on a branch
  // that isn't itself an open-PR head (typically `main`). Memoize.
  const memo = new Map();
  function depth(branch, seen) {
    if (memo.has(branch)) return memo.get(branch);
    if (!heads.has(branch)) return 0; // base of the chain
    if (seen.has(branch)) return 0;   // cycle guard
    seen.add(branch);
    const base = headToBase.get(branch);
    const d = 1 + depth(base, seen);
    memo.set(branch, d);
    return d;
  }
  let max = 0;
  for (const head of heads) {
    const d = depth(head, new Set());
    if (d > max) max = d;
  }
  return max;
}

// -----------------------------------------------------------------------------
// Compute one day's record
// -----------------------------------------------------------------------------

async function computeDailyRecord(dateStr, opts = {}) {
  const merged = fetchPrsMerged(dateStr);
  const opened = fetchPrsOpenedOnDay(dateStr);
  const issuesOpened = fetchIssuesOpenedOnDay(dateStr);
  const issuesClosed = fetchIssuesClosedOnDay(dateStr);

  // Brutal asserts: sum across merged PRs of regex hits in commit messages.
  let brutal = 0;
  for (const pr of merged) {
    try {
      const text = fetchPrCommitMessages(pr.number);
      brutal += countBrutalAssertsInText(text);
    } catch (err) {
      console.error(`[metrics] PR #${pr.number} commit fetch failed: ${err.message}`);
    }
  }

  // prs_open_eod and stack_depth_max are "now" snapshots; for backfill they
  // approximate end-of-day-on-the-target-date with current state. The user
  // accepted this trade-off (script is cron-friendly, runs daily).
  let prsOpenEod = null;
  let stackDepthMax = null;
  if (opts.snapshotOpenPrs !== false) {
    const openPrs = fetchOpenPrsSnapshot();
    prsOpenEod = openPrs.length;
    stackDepthMax = maxStackDepth(openPrs);
  }

  return {
    date: dateStr,
    prs_merged: merged.length,
    prs_opened: opened.length,
    prs_open_eod: prsOpenEod,
    issues_opened: issuesOpened.length,
    issues_closed: issuesClosed.length,
    brutal_asserts: brutal,
    stack_depth_max: stackDepthMax,
    test_files_changed: null, // reserved; expensive to compute via gh pr diff
  };
}

// -----------------------------------------------------------------------------
// JSONL persistence
// -----------------------------------------------------------------------------

function readJsonl() {
  if (!existsSync(JSONL_PATH)) return [];
  const raw = readFileSync(JSONL_PATH, "utf8");
  if (raw.trim() === "") return [];
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`daily.jsonl line ${i + 1} is not valid JSON: ${err.message}`);
      }
    });
}

function writeJsonl(records) {
  const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const body = sorted.map((r) => JSON.stringify(r)).join("\n") + "\n";
  if (!existsSync(METRICS_DIR)) mkdirSync(METRICS_DIR, { recursive: true });
  writeFileSync(JSONL_PATH, body, "utf8");
}

function upsertRecord(records, record) {
  const idx = records.findIndex((r) => r.date === record.date);
  if (idx >= 0) {
    const next = [...records];
    next[idx] = record;
    return next;
  }
  return [...records, record];
}

// -----------------------------------------------------------------------------
// README rendering
// -----------------------------------------------------------------------------

function fmt(n) {
  if (n === null || n === undefined) return "—";
  return String(n);
}

function avg(nums) {
  const valid = nums.filter((n) => typeof n === "number");
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function fmtAvg(n) {
  if (n === null) return "—";
  return n.toFixed(1);
}

function renderReadme(records) {
  const sorted = [...records].sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
  const last14 = sorted.slice(0, 14);
  const last7 = sorted.slice(0, 7);
  const latest = sorted[0];

  const tableRows = last14.map((r) =>
    `| ${r.date} | ${fmt(r.prs_merged)} | ${fmt(r.prs_opened)} | ${fmt(r.prs_open_eod)} | ${fmt(r.issues_opened)} | ${fmt(r.issues_closed)} | ${fmt(r.brutal_asserts)} | ${fmt(r.stack_depth_max)} |`,
  );

  const rollPrsMerged = avg(last7.map((r) => r.prs_merged));
  const rollBrutal = avg(last7.map((r) => r.brutal_asserts));

  const lines = [
    "# Daily velocity metrics",
    "",
    "Auto-generated by `scripts/ops/metrics.mjs`. Do not edit by hand.",
    "Source data lives in `daily.jsonl` (one JSON object per UTC day).",
    "",
    "## Current snapshot",
    "",
    latest
      ? `- **Open PRs (EOD ${latest.date}):** ${fmt(latest.prs_open_eod)}`
      : "- **Open PRs (EOD):** —",
    latest
      ? `- **Max stack depth:** ${fmt(latest.stack_depth_max)}`
      : "- **Max stack depth:** —",
    "",
    "## 7-day rolling averages",
    "",
    `- **PRs merged / day:** ${fmtAvg(rollPrsMerged)}`,
    `- **Brutal asserts / day:** ${fmtAvg(rollBrutal)}`,
    "",
    "## Last 14 days",
    "",
    "| Date | PRs merged | PRs opened | Open EOD | Issues opened | Issues closed | Brutal asserts | Stack depth |",
    "|------|-----------:|-----------:|---------:|--------------:|--------------:|---------------:|------------:|",
    ...tableRows,
    "",
    "## Schema",
    "",
    "Each line in `daily.jsonl`:",
    "",
    "```json",
    '{"date":"YYYY-MM-DD","prs_merged":N,"prs_opened":N,"prs_open_eod":N,"issues_opened":N,"issues_closed":N,"brutal_asserts":N,"stack_depth_max":N,"test_files_changed":null}',
    "```",
    "",
    "`prs_open_eod` and `stack_depth_max` are sampled at script run-time, not",
    "actually backfilled per historical day — a backfilled record gets the",
    "current snapshot values. Today's record reflects today's snapshot.",
    "",
    "`test_files_changed` is reserved (always `null`); the cheap computation",
    "via `gh pr diff` fails for PRs with >300 changed files.",
    "",
    "`brutal_asserts` counts case-insensitive `\\bbrutal asserts\\b` matches",
    "across commit messages of PRs merged that day. Only meaningful when the",
    "user actually writes that phrase — by design.",
    "",
  ];
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { date: null, backfill: null, write: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-write") args.write = false;
    else if (a === "--date") args.date = argv[++i];
    else if (a === "--backfill") args.backfill = argv[++i];
    else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`[metrics] unknown arg: ${a}`);
      printHelp();
      process.exit(2);
    }
  }
  if (args.date && !isValidDate(args.date)) {
    console.error(`[metrics] --date must be YYYY-MM-DD, got: ${args.date}`);
    process.exit(2);
  }
  if (args.backfill && !isValidDate(args.backfill)) {
    console.error(`[metrics] --backfill must be YYYY-MM-DD, got: ${args.backfill}`);
    process.exit(2);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/ops/metrics.mjs [options]

Options:
  --date YYYY-MM-DD     Compute & upsert one specific date.
  --backfill YYYY-MM-DD Compute every day from given date through yesterday.
  --no-write            Print result(s) to stdout; do not modify files.
  -h, --help            Show this help.

Default (no args): compute & upsert today (UTC), regenerate README.md.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Determine which dates to process.
  const dates = (() => {
    if (args.backfill) {
      const yesterday = addDaysUtc(todayUtc(), -1);
      if (args.backfill > yesterday) return [];
      return daysBetweenInclusive(args.backfill, yesterday);
    }
    if (args.date) return [args.date];
    return [todayUtc()];
  })();

  if (dates.length === 0) {
    console.error("[metrics] no dates to process");
    return;
  }

  // Compute records.
  const newRecords = [];
  for (const d of dates) {
    process.stderr.write(`[metrics] computing ${d}...\n`);
    const rec = await computeDailyRecord(d);
    newRecords.push(rec);
  }

  if (!args.write) {
    for (const r of newRecords) {
      console.log(JSON.stringify(r));
    }
    return;
  }

  // Persist.
  let records = readJsonl();
  for (const rec of newRecords) {
    records = upsertRecord(records, rec);
  }
  writeJsonl(records);
  writeFileSync(README_PATH, renderReadme(records), "utf8");
  process.stderr.write(
    `[metrics] wrote ${newRecords.length} record(s) to ${JSONL_PATH}\n`,
  );
  process.stderr.write(`[metrics] regenerated ${README_PATH}\n`);
}

main().catch((err) => {
  console.error(`[metrics] FATAL: ${err.stack ?? err.message ?? err}`);
  process.exit(1);
});
