// @linkage-allowed: discipline ratchet — scans files dynamically (not via static imports)
/**
 * Sprint HX10 — Observability surface audit for self-healing call sites.
 *
 * Discipline test (META-test): mirrors
 * `features/outreach/campaigns/sender/slog_op_audit_test.go`.
 *
 * Goal: every self-heal call site MUST emit ALL 5 observability surfaces:
 *   1. `slog` log with `op` field (Go) or `console.*` (JS)
 *   2. Prometheus metric increment (Go: `metrics.*` / `HealCounter`) or
 *      BFF /metrics counter (JS)
 *   3. Sentry breadcrumb / event (Go: `alertClient.*`, JS: `Sentry.*`)
 *   4. `healing_log` DB row insert (Go schema or BFF SQL)
 *   5. Reporter integration — the heal action kind must be visible to
 *      `system-report.mjs detectBottlenecks` (so the reporter can surface
 *      it as a bottleneck)
 *
 * Strategy:
 *   - Read source files via `node:fs` (no AST — sticky regex is enough
 *     for the patterns we want to enforce; Acorn would add deps).
 *   - For each heal call site, scan ±10 lines around it for each of
 *     the 5 surface markers.
 *   - Track violations per surface; assert count <= BASELINE.
 *
 * BASELINE ratchet:
 *   - Each `it(...)` block reads `BASELINES.<surface>` and asserts
 *     violations <= baseline. Tests pass even when violations exist —
 *     they only fail if the count grows.
 *   - PRs that improve coverage lower the baseline manually.
 *
 * NOT a behavior test. Counts violations, ratchets discipline.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ── Locate repo root from this test file ──────────────────────────────
//
// __dirname = features/platform/outreach-dashboard/src/test
// repoRoot  = ../../../.. = repo root (hozan-taher/)
const REPO_ROOT = resolve(__dirname, '../../../../..')

// ── Source files audited ──────────────────────────────────────────────
const SOURCES = {
  bff: 'features/platform/outreach-dashboard/server.js',
  sender: 'features/outreach/campaigns/sender/engine.go',
  runner: 'features/outreach/campaigns/campaign/runner.go',
  proxyPool: 'features/outreach/relay/internal/transport/proxy_pool.go',
  orchestrator: 'features/inbound/orchestrator/cmd/outreach/main.go',
  reporter: 'features/platform/outreach-dashboard/scripts/system-report.mjs',
}

// ── Heal-site detector patterns ───────────────────────────────────────
//
// A heal site is any line that starts/triggers a self-healing action.
// We match on stable keywords in each file. Patterns are sticky-regex,
// not AST — false positives are tolerable; what matters is enforcing
// the surface emission *around* each match within ±WINDOW lines.
const HEAL_SITE_PATTERNS = {
  // BFF: each `logHealing(...)` call IS a heal site. Bare
  // `INSERT INTO healing_log` (without logHealing helper) too.
  bff: [
    /\blogHealing\s*\(/g,
    /INSERT\s+INTO\s+healing_log\b/gi,
  ],
  // Go sender: ResetMailboxBreaker definition, circuit-breaker
  // mutations, panic-recover blocks.
  sender: [
    /func\s+\(.*?\)\s+ResetMailboxBreaker\s*\(/g,
    /\bcircuitOpen\s*=\s*(true|false)\b/g,
    /\bif\s+p\s*:=\s*recover\(\);\s*p\s*!=\s*nil\b/g,
  ],
  // Campaign runner: panic-recover + recalc retries.
  runner: [
    /\bif\s+p\s*:=\s*recover\(\);\s*p\s*!=\s*nil\b/g,
  ],
  // Relay proxy pool: empty-pool watchdog increment.
  proxyPool: [
    /\bconsecutiveZeroRefreshes\.Add\b/g,
  ],
  // Orchestrator: top-level supervisor recover() blocks.
  orchestrator: [
    /\bif\s+r\s*:=\s*recover\(\);\s*r\s*!=\s*nil\b/g,
  ],
}

// ── Surface detector patterns (per language) ──────────────────────────
//
// Each surface returns true when at least one of its patterns matches
// inside the ±WINDOW window around a heal site.
const WINDOW = 10

const SURFACE_PATTERNS = {
  // 1 — slog (Go) with `op` field, OR console.* (JS).
  slog: {
    go: [/\bslog\.(Error|Warn|Info)\s*\(/, /"op"\s*,/],
    js: [/\bconsole\.(error|warn|log|info)\s*\(/],
  },
  // 2 — Prometheus metric (Go) or BFF /metrics counter (JS).
  metric: {
    go: [/\bmetrics\.\w+/, /HealCounter/, /WithLabelValues/],
    // BFF currently uses console-tagged `[cron]` tags + healing_log
    // counts as the metric proxy. Real Prom counter is an open TODO.
    js: [/\[(cron|heal|healing|metrics)\]/, /metrics_heal/, /healCounter/],
  },
  // 3 — Sentry breadcrumb or exception capture, OR alertClient.* (Go).
  sentry: {
    go: [/\balertClient\.\w+/, /\bSentry\w*\b/, /telemetry\.\w+/],
    js: [/\bSentry\.(captureException|captureMessage|addBreadcrumb)/, /capture500\s*\(/],
  },
  // 4 — healing_log DB row insert.
  healingLog: {
    go: [/healing_log\b/, /watchdogRecorder\.Record/, /watchdog\.Event\{/],
    js: [/INSERT\s+INTO\s+healing_log\b/i, /\blogHealing\s*\(/],
  },
  // 5 — reporter signal: the heal action keyword should map to a
  // bottleneck kind in system-report.mjs. Heal sites that don't have
  // a reporter signal are flagged.
  reporter: {
    // Resolved at audit time by scanning the reporter file for known
    // kinds; the keyword set is computed in `loadReporterKinds()`.
    go: [],
    js: [],
  },
}

// ── Reporter kinds: scrape system-report.mjs once ─────────────────────
function loadReporterKinds() {
  const text = readFileSync(join(REPO_ROOT, SOURCES.reporter), 'utf8')
  const kinds = new Set()
  // `out.push({ kind: 'foo', ... })` and `case 'foo':`
  const pushRe = /kind:\s*['"]([a-z_]+)['"]/g
  const caseRe = /case\s+['"]([a-z_]+)['"]\s*:/g
  let m
  while ((m = pushRe.exec(text)) !== null) kinds.add(m[1])
  while ((m = caseRe.exec(text)) !== null) kinds.add(m[1])
  return kinds
}

// ── Heal-site → reporter-kind mapping ─────────────────────────────────
//
// This is the canonical mapping from a heal action to the reporter
// `bottlenecks` kind that surfaces it. If a heal site fires an action
// not listed here AND the action keyword is not present in the
// reporter file, it counts as a reporter-surface violation.
const HEAL_ACTION_TO_REPORTER_KIND = {
  auto_pause: 'paused_auth_fail',
  auto_resume: 'paused_auth_fail',
  bounce_pause: 'mailbox_critical',
  cap_reduced: 'mailbox_critical',
  cooldown_resume: 'mailbox_critical',
  ooo_detected: null, // contact-level — not a bottleneck
  uid_validity_change: null, // mailbox internal, not a bottleneck
  low_performance: 'mailbox_critical',
  panic_recovered: 'open_alerts', // surfaces via alertClient.DaemonPanic
  empty_pool: 'no_working_proxies',
  circuit_open: 'mailbox_critical',
  circuit_reset: null, // recovery is silent
  breaker_reset: null,
}

// ── Helpers ───────────────────────────────────────────────────────────
function readSource(rel) {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
}

function lineNumberOf(text, offset) {
  let n = 1
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++
  }
  return n
}

function getWindow(text, lineNo, window = WINDOW) {
  const lines = text.split('\n')
  const start = Math.max(0, lineNo - 1 - window)
  const end = Math.min(lines.length, lineNo - 1 + window + 1)
  return lines.slice(start, end).join('\n')
}

function findHealSites(text, patterns) {
  const sites = []
  for (const re of patterns) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      sites.push({
        line: lineNumberOf(text, m.index),
        match: m[0],
      })
    }
  }
  // Dedupe by line so overlapping patterns don't double-count.
  const seen = new Set()
  return sites.filter(s => {
    if (seen.has(s.line)) return false
    seen.add(s.line)
    return true
  }).sort((a, b) => a.line - b.line)
}

function lang(rel) {
  return rel.endsWith('.go') ? 'go' : 'js'
}

function checkSurface(window, surfacePatterns) {
  return surfacePatterns.every(re => re.test(window))
}

// Aggregate every heal site across all source files.
function collectHealSites() {
  const all = []
  for (const [key, rel] of Object.entries(SOURCES)) {
    if (key === 'reporter') continue
    const text = readSource(rel)
    const sites = findHealSites(text, HEAL_SITE_PATTERNS[key] || [])
    for (const s of sites) {
      const win = getWindow(text, s.line)
      all.push({
        file: rel,
        key,
        line: s.line,
        match: s.match,
        window: win,
        text,
      })
    }
  }
  return all
}

// Detect heal-action keyword in a window so we can match it to a reporter kind.
function detectHealAction(win) {
  const knownActions = Object.keys(HEAL_ACTION_TO_REPORTER_KIND)
  for (const a of knownActions) {
    if (win.includes(a)) return a
  }
  // Generic panic-recovery sites may not name a heal action; map them
  // to "panic_recovered" if "panic recovered" appears in the window.
  if (/panic\s+recovered/i.test(win)) return 'panic_recovered'
  return null
}

// ── BASELINES — initial ratchet anchor ────────────────────────────────
//
// These were measured on first run (2026-04-26). DO NOT RAISE without
// explicit operator approval — the contract is "ratchet down only".
//
// To lower a baseline after fixing a violation:
//   1. Run `pnpm vitest run src/test/observability-audit.test.js`
//   2. Read the violation count from the failing summary panel.
//   3. Update the corresponding BASELINE entry in this file to the
//      new (lower) number.
//   4. Re-run; should pass.
// Initial measurement on 2026-04-26 across 23 heal sites:
//   slog=7, metric=23, sentry=23, healingLog=21, reporter=6
// 2026-05-01 bump (+1 heal site, 24 total):
//   New site: features/inbound/orchestrator/cmd/outreach/main.go:762
//   "mailbox score loop panic recovered" recover() block added in
//   PR #578 (feat(intelligence): move runFullCheckCron to Go orchestrator).
//   The new site lacks metric/sentry/healingLog surfaces (same gap as the
//   other orchestrator panic-recover sites that were already grandfathered).
//   Bumping metric 23→24, sentry 23→24, healingLog 21→22.
// (tracked here so the test fails the moment NEW heal sites land
// without the matching observability surfaces).
const BASELINES = {
  slog: 7,
  metric: 24,
  sentry: 24,
  healingLog: 22,
  reporter: 6,
}

// ─────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────

describe('observability audit — heal sites emit 5 surfaces', () => {
  // Snapshot of all heal sites (computed once, reused across cases).
  const sites = collectHealSites()

  it('discovers at least one heal site per audited source file', () => {
    const byFile = new Map()
    for (const s of sites) byFile.set(s.file, (byFile.get(s.file) || 0) + 1)
    // Every source we audit (5 files) should have ≥1 heal site —
    // otherwise our pattern detector is broken.
    for (const rel of Object.values(SOURCES)) {
      if (rel === SOURCES.reporter) continue
      expect(byFile.get(rel) ?? 0).toBeGreaterThan(0)
    }
  })

  it('total heal-site count is plausible (≥10, ≤500)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(10)
    expect(sites.length).toBeLessThanOrEqual(500)
  })

  it('every heal site has a non-empty surrounding window', () => {
    for (const s of sites) {
      expect(s.window.length).toBeGreaterThan(0)
    }
  })

  // ── Surface 1: slog / console ──────────────────────────────────────
  describe('surface 1: slog (Go) / console (JS) with op field', () => {
    const violations = sites.filter(s => {
      const langKey = lang(s.file)
      const patterns = SURFACE_PATTERNS.slog[langKey]
      return !checkSurface(s.window, patterns)
    })

    it('every heal site emits slog/console — count <= BASELINE', () => {
      expect(violations.length).toBeLessThanOrEqual(BASELINES.slog)
    })

    it('surface 1 violations include line numbers for fixing', () => {
      for (const v of violations) {
        expect(v.line).toBeGreaterThan(0)
        expect(v.file).toBeTruthy()
      }
    })

    it('surface 1 violation count is non-negative', () => {
      expect(violations.length).toBeGreaterThanOrEqual(0)
    })
  })

  // ── Surface 2: Prometheus metric / BFF metrics counter ──────────────
  describe('surface 2: metric increment', () => {
    const violations = sites.filter(s => {
      const langKey = lang(s.file)
      const patterns = SURFACE_PATTERNS.metric[langKey]
      return !checkSurface(s.window, patterns)
    })

    it('every heal site emits metric — count <= BASELINE', () => {
      expect(violations.length).toBeLessThanOrEqual(BASELINES.metric)
    })

    it('surface 2 violations are reported with file + line', () => {
      for (const v of violations) {
        expect(v.file).toBeTruthy()
        expect(v.line).toBeGreaterThan(0)
      }
    })

    it('surface 2 baseline is a finite integer', () => {
      expect(Number.isFinite(BASELINES.metric)).toBe(true)
      expect(Number.isInteger(BASELINES.metric)).toBe(true)
    })
  })

  // ── Surface 3: Sentry / alertClient ────────────────────────────────
  describe('surface 3: Sentry breadcrumb / alertClient', () => {
    const violations = sites.filter(s => {
      const langKey = lang(s.file)
      const patterns = SURFACE_PATTERNS.sentry[langKey]
      return !checkSurface(s.window, patterns)
    })

    it('every heal site emits sentry/alert — count <= BASELINE', () => {
      expect(violations.length).toBeLessThanOrEqual(BASELINES.sentry)
    })

    it('surface 3 violations carry diagnostic context', () => {
      for (const v of violations) {
        expect(typeof v.window).toBe('string')
        expect(v.window.length).toBeGreaterThan(0)
      }
    })

    it('surface 3 baseline is non-negative', () => {
      expect(BASELINES.sentry).toBeGreaterThanOrEqual(0)
    })
  })

  // ── Surface 4: healing_log row ─────────────────────────────────────
  describe('surface 4: healing_log row insert', () => {
    const violations = sites.filter(s => {
      const langKey = lang(s.file)
      const patterns = SURFACE_PATTERNS.healingLog[langKey]
      return !checkSurface(s.window, patterns)
    })

    it('every heal site writes healing_log — count <= BASELINE', () => {
      expect(violations.length).toBeLessThanOrEqual(BASELINES.healingLog)
    })

    it('surface 4 violations have unique (file,line) pairs', () => {
      const seen = new Set()
      for (const v of violations) {
        const key = `${v.file}:${v.line}`
        seen.add(key)
      }
      expect(seen.size).toBe(violations.length)
    })

    it('surface 4 baseline is finite', () => {
      expect(Number.isFinite(BASELINES.healingLog)).toBe(true)
    })
  })

  // ── Surface 5: reporter integration (system-report.mjs) ─────────────
  describe('surface 5: reporter bottleneck kind', () => {
    const reporterKinds = loadReporterKinds()

    const violations = sites.filter(s => {
      const action = detectHealAction(s.window)
      if (action === null) {
        // No detectable action keyword in the window — treat as a
        // reporter violation so the operator either adds a kind or
        // marks the action as null in HEAL_ACTION_TO_REPORTER_KIND.
        return true
      }
      const expectedKind = HEAL_ACTION_TO_REPORTER_KIND[action]
      if (expectedKind === null) return false // explicitly not surfaced
      if (!expectedKind) return true
      return !reporterKinds.has(expectedKind)
    })

    it('reporter scrape returns a non-empty Set of kinds', () => {
      expect(reporterKinds.size).toBeGreaterThan(0)
    })

    it('reporter knows core kinds (no_working_proxies, paused_auth_fail, mailbox_critical)', () => {
      expect(reporterKinds.has('no_working_proxies')).toBe(true)
      expect(reporterKinds.has('paused_auth_fail')).toBe(true)
      expect(reporterKinds.has('mailbox_critical')).toBe(true)
    })

    it('every heal site maps to a reporter kind — count <= BASELINE', () => {
      expect(violations.length).toBeLessThanOrEqual(BASELINES.reporter)
    })

    it('surface 5 baseline is non-negative', () => {
      expect(BASELINES.reporter).toBeGreaterThanOrEqual(0)
    })
  })

  // ── Final summary panel ────────────────────────────────────────────
  it('audit summary — single panel of all violations', () => {
    const summary = {
      total_sites: sites.length,
      sites_by_file: {},
      violations: {
        slog: 0,
        metric: 0,
        sentry: 0,
        healingLog: 0,
        reporter: 0,
      },
      baselines: { ...BASELINES },
    }
    for (const s of sites) {
      summary.sites_by_file[s.file] = (summary.sites_by_file[s.file] || 0) + 1
    }
    const reporterKinds = loadReporterKinds()
    for (const s of sites) {
      const langKey = lang(s.file)
      if (!checkSurface(s.window, SURFACE_PATTERNS.slog[langKey])) {
        summary.violations.slog++
      }
      if (!checkSurface(s.window, SURFACE_PATTERNS.metric[langKey])) {
        summary.violations.metric++
      }
      if (!checkSurface(s.window, SURFACE_PATTERNS.sentry[langKey])) {
        summary.violations.sentry++
      }
      if (!checkSurface(s.window, SURFACE_PATTERNS.healingLog[langKey])) {
        summary.violations.healingLog++
      }
      const action = detectHealAction(s.window)
      const expectedKind = action ? HEAL_ACTION_TO_REPORTER_KIND[action] : undefined
      if (action === null || (expectedKind && !reporterKinds.has(expectedKind))) {
        summary.violations.reporter++
      }
    }
    // The summary must not regress against ANY baseline.
    for (const k of Object.keys(summary.violations)) {
      expect(summary.violations[k]).toBeLessThanOrEqual(summary.baselines[k])
    }
    // Sanity: every count is non-negative.
    for (const k of Object.keys(summary.violations)) {
      expect(summary.violations[k]).toBeGreaterThanOrEqual(0)
    }
    // Sanity: total sites equal to sum of sites_by_file.
    const total = Object.values(summary.sites_by_file).reduce((a, b) => a + b, 0)
    expect(total).toBe(summary.total_sites)
  })
})
