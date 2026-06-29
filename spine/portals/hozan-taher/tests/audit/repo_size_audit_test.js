#!/usr/bin/env node
/**
 * repo_size_audit_test.js — Enforce repository tarball size limit.
 *
 * Walks the filesystem from repo root, skips .git and .railwayignore patterns,
 * and fails if total size exceeds 1GB. Purpose: prevent "45GB worktrees tarball"
 * incidents during Railway deployment.
 *
 * Baseline: 0 violations. This test MUST NOT be disabled.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "../..");
const RAILWAYIGNORE_PATH = path.join(REPO_ROOT, ".railwayignore");
const SIZE_LIMIT_BYTES = 1024 * 1024 * 1024; // 1GB
const DESCRIPTION = "repo_size_audit_test";

// Parse .railwayignore patterns
function parseRailwayIgnore() {
  if (!fs.existsSync(RAILWAYIGNORE_PATH)) {
    throw new Error(
      `[${DESCRIPTION}] FATAL: .railwayignore not found at ${RAILWAYIGNORE_PATH}`
    );
  }
  const content = fs.readFileSync(RAILWAYIGNORE_PATH, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

// Simple glob-style pattern matcher
function matchesPattern(filePath, pattern) {
  const relPath = path.relative(REPO_ROOT, filePath);
  // Simple: if pattern contains /, require exact prefix; otherwise match basename
  if (pattern.includes("/")) {
    return relPath.startsWith(pattern) || relPath.startsWith(pattern + "/");
  }
  // Basename match for patterns like "*.log", ".DS_Store", "node_modules/"
  if (pattern.startsWith("*.")) {
    return path.basename(filePath).endsWith(pattern.substring(1));
  }
  if (pattern.endsWith("/")) {
    return path.basename(filePath) === pattern.slice(0, -1);
  }
  return path.basename(filePath) === pattern;
}

function shouldIgnore(filePath, ignorePatterns) {
  if (filePath === path.join(REPO_ROOT, ".git")) {
    return true;
  }
  return ignorePatterns.some((p) => matchesPattern(filePath, p));
}

function walkDir(dir, ignorePatterns, callback) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (shouldIgnore(fullPath, ignorePatterns)) {
      continue;
    }
    if (entry.isDirectory()) {
      walkDir(fullPath, ignorePatterns, callback);
    } else if (entry.isFile()) {
      callback(fullPath);
    }
  }
}

// Main test
async function run() {
  const ignorePatterns = parseRailwayIgnore();
  let totalBytes = 0;
  const violations = [];

  walkDir(REPO_ROOT, ignorePatterns, (filePath) => {
    try {
      const stats = fs.statSync(filePath);
      totalBytes += stats.size;
    } catch (err) {
      // Skip inaccessible files
    }
  });

  const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
  const limitMB = SIZE_LIMIT_BYTES / (1024 * 1024);

  console.log(`[${DESCRIPTION}] Total size: ${totalMB}MB (limit: ${limitMB}MB)`);

  if (totalBytes > SIZE_LIMIT_BYTES) {
    violations.push(
      `Repo size ${totalMB}MB exceeds 1GB limit. Run: rm -rf .claude/worktrees && git clean -fd`
    );
  }

  if (violations.length > 0) {
    console.error(`\nVIOLATIONS (${violations.length}):`);
    violations.forEach((v, i) => {
      console.error(`  ${i + 1}. ${v}`);
    });
    process.exit(1);
  }

  console.log(`[${DESCRIPTION}] PASS`);
  process.exit(0);
}

run().catch((err) => {
  console.error(`[${DESCRIPTION}] FATAL:`, err.message);
  process.exit(1);
});
