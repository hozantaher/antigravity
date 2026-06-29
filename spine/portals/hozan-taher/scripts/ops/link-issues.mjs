#!/usr/bin/env node
/**
 * link-issues.mjs — audit GH issues + PRs in messingdev/hozan-taher for missing
 * cross-references and (optionally) post the missing links.
 *
 * Behavior:
 *   1. Pulls open issues + open PRs (limit 200) via `gh`.
 *   2. Extracts a scope tag from each title:
 *        - Issues: leading `[Tag]` prefix, e.g. `[ML2.2] ...`, `[S1.4] ...`,
 *          `[F5-1] ...`, `[CH-3] ...`, `[W2-A] ...`.
 *        - PRs:    bare inline token (no brackets), since this repo uses
 *          conventional-commit titles like `feat(ml-lab-api): ML2.7 — ...`,
 *          `test(e2e): mail-client S3.6 — ...`, `chore: CH-6 ...`.
 *   3. Builds tag → { issues, prs } map and, for each tag with both sides:
 *        a. Issue side: ensure a comment exists pointing at the PR
 *           ("Tracked by PR #M ...").
 *        b. PR side: ensure body contains `Closes #N` / `Fixes #N` / `Resolves #N`
 *           for the matching issue(s); if not, append a footer.
 *
 * Modes:
 *   --dry-run (default)   print what would change
 *   --apply               actually write
 *   --tag <prefix>        limit to one tag (case-insensitive exact match)
 *
 * No npm deps. Uses `gh` CLI via child_process.execFileSync.
 *
 * Exit codes:
 *   0 — success
 *   1 — hard error (gh missing, network, etc.)
 *   2 — partial failure (some writes failed)
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = "messingdev/hozan-taher";
const GH_LIMIT = 200;
const WRITE_DELAY_MS = 200;

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { mode: "dry-run", tag: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.mode = "apply";
    else if (a === "--dry-run") args.mode = "dry-run";
    else if (a === "--tag") {
      args.tag = argv[++i];
      if (!args.tag) {
        console.error("--tag requires a value");
        process.exit(1);
      }
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: link-issues.mjs [--dry-run|--apply] [--tag <prefix>]"
      );
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

// --------------------------------------------------------------------------
// gh wrappers
// --------------------------------------------------------------------------

function gh(args, { input } = {}) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: input == null ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      input,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    const stdout = err.stdout ? err.stdout.toString() : "";
    const e = new Error(
      `gh ${args.join(" ")} failed: ${err.message}\n${stderr || stdout}`
    );
    e.cause = err;
    throw e;
  }
}

function ghJSON(args, { input } = {}) {
  return JSON.parse(gh(args, { input }));
}

function listOpenIssues() {
  // exclude PRs (gh issue list already does, but be explicit)
  return ghJSON([
    "issue",
    "list",
    "--repo",
    REPO,
    "--state",
    "open",
    "--limit",
    String(GH_LIMIT),
    "--json",
    "number,title,body",
  ]);
}

function listOpenPRs() {
  return ghJSON([
    "pr",
    "list",
    "--repo",
    REPO,
    "--state",
    "open",
    "--limit",
    String(GH_LIMIT),
    "--json",
    "number,title,body,baseRefName",
  ]);
}

function fetchIssueComments(issueNumber) {
  // gh issue view ... --json comments  returns full comment bodies
  const result = ghJSON([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    REPO,
    "--json",
    "comments",
  ]);
  return result.comments || [];
}

function postIssueComment(issueNumber, body) {
  // pass via stdin to avoid argv length / quoting issues
  gh(
    [
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      REPO,
      "--body-file",
      "-",
    ],
    { input: body }
  );
}

function editPRBody(prNumber, body) {
  gh(
    ["pr", "edit", String(prNumber), "--repo", REPO, "--body-file", "-"],
    { input: body }
  );
}

// --------------------------------------------------------------------------
// Tag extraction
// --------------------------------------------------------------------------

// Issue prefix: `^\[Tag]`
const ISSUE_TAG_RE = /^\[([A-Z0-9][A-Z0-9.\-]*)\]/;

// PR inline tag: bare token like ML2.7, S3.6, F5-1, CH-3, W2-A, UX-F2a, D-1, P-2.
// Anchor the search via word boundaries; require at least one digit so we don't
// catch words like "API". Allow trailing letter (e.g. "F2a", "W2-A") and either
// `.` or `-` as the separator.
const PR_TAG_RE =
  /\b([A-Z]{1,4}(?:-[A-Z0-9]+)*\d+[A-Za-z]?(?:[.\-]\d+[A-Za-z]?)?)\b/g;

function extractIssueTag(title) {
  const m = title.match(ISSUE_TAG_RE);
  return m ? m[1].toUpperCase() : null;
}

function extractPRTags(title) {
  const tags = new Set();
  // Strip optional conventional-commit prefix like `feat(scope):` so it doesn't
  // accidentally yield tag-like tokens. We use the whole title for matching
  // anyway, but stripping helps avoid matching the scope itself.
  const stripped = title.replace(/^[a-z]+(\([^)]+\))?:\s*/i, "");
  let m;
  PR_TAG_RE.lastIndex = 0;
  while ((m = PR_TAG_RE.exec(stripped)) !== null) {
    tags.add(m[1].toUpperCase());
  }
  return [...tags];
}

// --------------------------------------------------------------------------
// Linking logic
// --------------------------------------------------------------------------

const CLOSES_RE = /\b(?:closes|fixes|resolves)\s+#(\d+)/gi;

function bodyClosesIssue(body, issueNumber) {
  if (!body) return false;
  CLOSES_RE.lastIndex = 0;
  let m;
  while ((m = CLOSES_RE.exec(body)) !== null) {
    if (Number(m[1]) === issueNumber) return true;
  }
  return false;
}

function commentAlreadyTracksPR(comments, prNumber) {
  const needle = `tracked by PR #${prNumber}`;
  return comments.some((c) => (c.body || "").toLowerCase().includes(needle));
}

function buildIssueTrackingComment(pr) {
  return `Tracked by PR #${pr.number} (${pr.title}) — base: \`${pr.baseRefName}\`. Will auto-close on merge if PR body references this issue.`;
}

function buildPRBodyWithCloses(existingBody, issueNumbers) {
  const refs = issueNumbers.map((n) => `Closes #${n}`).join(", ");
  const trimmed = (existingBody || "").replace(/\s+$/, "");
  if (!trimmed) return refs;
  return `${trimmed}\n\n---\n${refs}\n`;
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const apply = args.mode === "apply";
  const filterTag = args.tag ? args.tag.toUpperCase() : null;

  console.log(
    `link-issues: mode=${args.mode}${filterTag ? ` tag=${filterTag}` : ""}`
  );

  let issues, prs;
  try {
    [issues, prs] = [listOpenIssues(), listOpenPRs()];
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  console.log(`fetched: ${issues.length} open issues, ${prs.length} open PRs`);

  // tag → { issues: [...], prs: [...] }
  const map = new Map();
  for (const iss of issues) {
    const tag = extractIssueTag(iss.title);
    if (!tag) continue;
    if (filterTag && tag !== filterTag) continue;
    if (!map.has(tag)) map.set(tag, { issues: [], prs: [] });
    map.get(tag).issues.push(iss);
  }
  for (const pr of prs) {
    const tags = extractPRTags(pr.title);
    for (const tag of tags) {
      if (filterTag && tag !== filterTag) continue;
      if (!map.has(tag)) continue; // only care about tags that have an open issue
      map.get(tag).prs.push(pr);
    }
  }

  // Counters + report rows
  let linkedNeeded = 0;
  let alreadyLinked = 0;
  let prBodyUpdatesNeeded = 0;
  let prBodyAlreadyHasCloses = 0;
  const writeFailures = [];
  const reportRows = [];

  for (const [tag, group] of [...map.entries()].sort()) {
    if (group.issues.length === 0 || group.prs.length === 0) continue;

    for (const pr of group.prs) {
      const issueNumbersForPR = group.issues.map((i) => i.number);

      // ----- PR side: ensure body has Closes #N for each tagged issue -----
      const missingCloses = issueNumbersForPR.filter(
        (n) => !bodyClosesIssue(pr.body, n)
      );
      if (missingCloses.length === 0) {
        prBodyAlreadyHasCloses++;
        reportRows.push({
          tag,
          prNumber: pr.number,
          prTitle: pr.title,
          issueNumbers: issueNumbersForPR,
          action: "pr-body-already-has-closes",
        });
      } else {
        prBodyUpdatesNeeded++;
        reportRows.push({
          tag,
          prNumber: pr.number,
          prTitle: pr.title,
          issueNumbers: missingCloses,
          action: apply ? "pr-body-updated" : "pr-body-needs-update",
        });
        if (apply) {
          try {
            const newBody = buildPRBodyWithCloses(pr.body, missingCloses);
            editPRBody(pr.number, newBody);
            await sleep(WRITE_DELAY_MS);
          } catch (err) {
            writeFailures.push({ kind: "pr-body", pr: pr.number, error: err.message });
          }
        }
      }

      // ----- Issue side: each tagged issue gets one tracking comment per PR -----
      for (const iss of group.issues) {
        let comments;
        try {
          comments = fetchIssueComments(iss.number);
        } catch (err) {
          writeFailures.push({
            kind: "issue-comments-read",
            issue: iss.number,
            error: err.message,
          });
          continue;
        }

        if (commentAlreadyTracksPR(comments, pr.number)) {
          alreadyLinked++;
          reportRows.push({
            tag,
            prNumber: pr.number,
            issueNumber: iss.number,
            action: "issue-already-tracked",
          });
          continue;
        }

        // Also skip if the issue body itself already mentions tracked by PR #N
        if ((iss.body || "").toLowerCase().includes(`tracked by pr #${pr.number}`)) {
          alreadyLinked++;
          reportRows.push({
            tag,
            prNumber: pr.number,
            issueNumber: iss.number,
            action: "issue-body-already-tracks",
          });
          continue;
        }

        linkedNeeded++;
        reportRows.push({
          tag,
          prNumber: pr.number,
          issueNumber: iss.number,
          action: apply ? "issue-comment-posted" : "issue-comment-needed",
        });

        if (apply) {
          try {
            postIssueComment(iss.number, buildIssueTrackingComment(pr));
            await sleep(WRITE_DELAY_MS);
          } catch (err) {
            writeFailures.push({
              kind: "issue-comment-post",
              issue: iss.number,
              pr: pr.number,
              error: err.message,
            });
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------------
  // Console summary
  // ------------------------------------------------------------------------

  const verb = apply ? "Linked" : "Would link";
  console.log("");
  console.log(`${verb}: ${linkedNeeded} issue→PR pairs`);
  console.log(`Skipped (already linked): ${alreadyLinked}`);
  console.log(`PR body updates ${apply ? "applied" : "needed"}: ${prBodyUpdatesNeeded}`);
  console.log(`PR body already has Closes: ${prBodyAlreadyHasCloses}`);

  if (writeFailures.length) {
    console.log("");
    console.log(`Failures: ${writeFailures.length}`);
    for (const f of writeFailures) {
      console.log(`  - ${JSON.stringify(f)}`);
    }
  }

  // ------------------------------------------------------------------------
  // Markdown report
  // ------------------------------------------------------------------------

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = `/tmp/link-audit-${ts}.md`;
  const lines = [];
  lines.push(`# link-issues audit — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`- repo: ${REPO}`);
  lines.push(`- mode: ${args.mode}`);
  if (filterTag) lines.push(`- tag filter: ${filterTag}`);
  lines.push(`- open issues fetched: ${issues.length}`);
  lines.push(`- open PRs fetched: ${prs.length}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- ${verb}: ${linkedNeeded} issue→PR pairs`);
  lines.push(`- Skipped (already linked): ${alreadyLinked}`);
  lines.push(
    `- PR body updates ${apply ? "applied" : "needed"}: ${prBodyUpdatesNeeded}`
  );
  lines.push(`- PR body already has Closes: ${prBodyAlreadyHasCloses}`);
  lines.push(`- Write failures: ${writeFailures.length}`);
  lines.push("");
  lines.push("## Per-tag breakdown");
  lines.push("");
  for (const [tag, group] of [...map.entries()].sort()) {
    if (group.issues.length === 0 || group.prs.length === 0) continue;
    lines.push(`### \`${tag}\``);
    lines.push("");
    lines.push(
      `- Issues: ${group.issues.map((i) => `#${i.number}`).join(", ")}`
    );
    lines.push(`- PRs: ${group.prs.map((p) => `#${p.number}`).join(", ")}`);
    lines.push("");
  }

  lines.push("## Actions");
  lines.push("");
  lines.push("| Tag | Issue | PR | Action |");
  lines.push("|---|---|---|---|");
  for (const r of reportRows) {
    const issueCell = r.issueNumber
      ? `#${r.issueNumber}`
      : Array.isArray(r.issueNumbers)
        ? r.issueNumbers.map((n) => `#${n}`).join(", ")
        : "—";
    const prCell = r.prNumber ? `#${r.prNumber}` : "—";
    lines.push(`| ${r.tag} | ${issueCell} | ${prCell} | ${r.action} |`);
  }

  if (writeFailures.length) {
    lines.push("");
    lines.push("## Failures");
    lines.push("");
    for (const f of writeFailures) {
      lines.push(`- \`${JSON.stringify(f)}\``);
    }
  }

  writeFileSync(reportPath, lines.join("\n") + "\n");
  console.log("");
  console.log(`Report: ${reportPath}`);

  if (writeFailures.length > 0) process.exit(2);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
