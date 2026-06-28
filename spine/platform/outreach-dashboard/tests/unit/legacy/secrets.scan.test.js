// @linkage-allowed: discipline ratchet — scans files dynamically (not via static imports)
// Secret scanner — sweeps the dashboard source tree for hardcoded credentials.
// Goal: catch keys/passwords/tokens before they land in git.
// Scope: source files only (skips node_modules, dist, reports, .env*).

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOT = join(import.meta.dirname, '..')
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', 'coverage',
  'reports', 'playwright-report', 'test-results', '.pnpm-store',
  '.vite', '.cache', 'mutation-runs', '.stryker-tmp',
])

// Test files use fixture credentials by design — only scan them for
// real high-entropy keys, not the generic password pattern.
function isTestFile(path) {
  return /\.(?:test|spec|fuzz|props|contracts|scan|lint)\.(?:m?[jt]s|[jt]sx)$/.test(path)
}
const SKIP_FILES = new Set([
  '.env', '.env.local', '.env.example',
  'pnpm-lock.yaml', 'package-lock.json',
])
const SCAN_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.json', '.yaml', '.yml', '.md', '.html', '.css',
])

// Patterns: name → { regex, allowFiles?: Set<string>, allowSnippets?: RegExp[] }.
// Each pattern tuned to minimize false positives.
const PATTERNS = {
  'aws-access-key':         { re: /\bAKIA[0-9A-Z]{16}\b/ },
  'aws-secret-key':         { re: /aws_secret_access_key\s*[=:]\s*['"][A-Za-z0-9/+=]{40}['"]/i },
  'github-token':           { re: /\bghp_[A-Za-z0-9]{36,}\b/ },
  'github-token-legacy':    { re: /\bgho_[A-Za-z0-9]{36,}\b/ },
  'gitlab-token':           { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  'slack-bot-token':        { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  'stripe-live-key':        { re: /\bsk_live_[A-Za-z0-9]{20,}\b/ },
  'stripe-test-key':        { re: /\bsk_test_[A-Za-z0-9]{20,}\b/ },
  'openai-key':             { re: /\bsk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}\b/ },
  'anthropic-key':          { re: /\bsk-ant-(?:api|admin)\d+-[A-Za-z0-9_-]{50,}\b/ },
  'google-api-key':         { re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  'private-key-block':      { re: /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PGP)\s+PRIVATE\s+KEY-----/ },
  'jwt-token':              { re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  'pg-url-with-password':   { re: /\bpostgres(?:ql)?:\/\/[^:\s'"]+:[^@\s'"]+@[^/\s'"]+/ },
  'mysql-url-with-password':{ re: /\bmysql:\/\/[^:\s'"]+:[^@\s'"]+@[^/\s'"]+/ },
  'mongo-url-with-password':{ re: /\bmongodb(?:\+srv)?:\/\/[^:\s'"]+:[^@\s'"]+@[^/\s'"]+/ },
  // Generic catch — quoted password=… literal that looks like a real value (>=8 chars, mixed).
  'generic-password':       { re: /\b(?:password|passwd|pwd)\s*[:=]\s*['"]([^'"\s]{8,})['"]/i },
}

// Per-finding allowlist for known-safe placeholders.
const ALLOW_SNIPPETS = [
  /YOUR_API_KEY/i,
  /your[_-]password/i,
  /<password>/i,
  /\$\{[A-Z_]+\}/,           // ${ENV_VAR}
  /process\.env\./,
  /xxxxxxxx/i,
  /placeholder/i,
  /example\.com/i,
  /test\.internal/i,
  /\bdummy\b/i,
  /\bfoo\b|\bbar\b|\bbaz\b/i,
  /classifyEmail|classifySmtp|classifyIcp/, // false positives in classify-* code
  /secret-user:secret-pass@secret-host/,   // test fixture in structural-invariants.test.ts
]

function shouldScan(path) {
  const idx = path.lastIndexOf('.')
  if (idx === -1) return false
  return SCAN_EXTS.has(path.slice(idx))
}

function* walk(dir) {
  for (const ent of readdirSync(dir)) {
    if (SKIP_DIRS.has(ent) || SKIP_FILES.has(ent)) continue
    if (ent.startsWith('.env')) continue
    if (ent === 'secrets.scan.test.js') continue // self — contains intentional probe
    const full = join(dir, ent)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      yield* walk(full)
    } else if (st.isFile() && shouldScan(full) && st.size < 1_500_000) {
      yield full
    }
  }
}

function scanFile(path) {
  const src = readFileSync(path, 'utf8')
  const findings = []
  const testFile = isTestFile(path)
  // Health probe scripts use a fixed test password that's not actually a secret.
  const isHealthScript = /\/scripts\/health\./.test(path)
  for (const [name, { re }] of Object.entries(PATTERNS)) {
    // Skip generic password matches in test fixtures + health scripts.
    if (name === 'generic-password' && (testFile || isHealthScript)) continue
    const m = src.match(re)
    if (!m) continue
    const snippet = m[0].slice(0, 160)
    if (ALLOW_SNIPPETS.some(s => s.test(snippet))) continue
    // Collect line number.
    const idx = src.indexOf(m[0])
    const line = src.slice(0, idx).split('\n').length
    findings.push({ pattern: name, line, snippet: snippet.slice(0, 80) + (snippet.length > 80 ? '…' : '') })
  }
  return findings
}

describe('secret scan — no hardcoded credentials in source tree', () => {
  it('source tree is clean', () => {
    const offenders = []
    for (const f of walk(ROOT)) {
      const issues = scanFile(f)
      if (issues.length === 0) continue
      const rel = relative(ROOT, f)
      for (const i of issues) {
        offenders.push(`${rel}:${i.line}  [${i.pattern}]  ${i.snippet}`)
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `Hardcoded secrets found (${offenders.length}):\n  ` +
        offenders.join('\n  ') +
        `\n\nFix: move to env vars + .env (which is gitignored). ` +
        `If a placeholder is intentional, add it to ALLOW_SNIPPETS.`
      )
    }
    expect(offenders).toEqual([])
  })

  it('detects a probe secret when injected (positive control)', () => {
    // This proves the scanner actually fires — without this test a regression
    // that breaks all patterns would silently pass.
    const probe = `const k = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"`
    const issues = []
    for (const [name, { re }] of Object.entries(PATTERNS)) {
      if (re.test(probe)) issues.push(name)
    }
    expect(issues).toContain('github-token')
  })
})
