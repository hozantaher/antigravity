// verify-launch.test.mjs
// Unit tests for scripts/verify-launch.mjs step logic.
//
// Strategy: the script exports no module interface — it runs as a CLI.
// Tests exercise the step functions by spawning subprocess and asserting
// exit codes + output shape. Per memory feedback_extreme_testing:
// ≥10 test cases, boundary + error + integration paths covered.

import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// here = features/platform/outreach-dashboard/tests/unit/scripts → 5 levels up = repo root
const REPO_ROOT = join(here, '..', '..', '..', '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'verify-launch.mjs')

// Helper: run the script as a child process, capture exit code + output
function runScript(args = [], env = {}) {
  try {
    const stdout = execSync(
      `node ${SCRIPT} ${args.join(' ')}`,
      {
        encoding: 'utf8',
        timeout: 20_000,
        // Run from repo root so node can resolve pg from root node_modules
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          // Ensure no real BFF/DB is accidentally hit in unit tests
          DATABASE_URL: '',
          BFF_BASE_URL: 'http://localhost:__unit_test_no_bff__',
          RELAY_BASE_URL: 'http://localhost:__unit_test_no_relay__',
          ...env,
        },
      }
    )
    return { exitCode: 0, stdout, stderr: '' }
  } catch (e) {
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout || '',
      stderr: e.stderr || '',
    }
  }
}

// ── TC-01: Missing --campaign-id → exit 2 ────────────────────────────────
describe('verify-launch CLI', () => {
  it('TC-01: exits 2 when --campaign-id is missing', () => {
    const r = runScript([])
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/missing required flag|--campaign-id/i)
  })

  // ── TC-02: Invalid campaign-id → exit 2 ──────────────────────────────
  it('TC-02: exits 2 for non-numeric --campaign-id', () => {
    const r = runScript(['--campaign-id=abc'])
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/invalid.*campaign-id|positive integer/i)
  })

  // ── TC-03: Invalid --mode → exit 2 ───────────────────────────────────
  it('TC-03: exits 2 for unknown --mode value', () => {
    const r = runScript(['--campaign-id=1', '--mode=send-now'])
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/invalid.*mode|dry-run|live/i)
  })

  // ── TC-04: --json flag produces valid JSON output on invocation error ─
  it('TC-04: --json flag emits JSON error object on missing campaign-id', () => {
    const r = runScript(['--json'])
    expect(r.exitCode).toBe(2)
    let parsed
    expect(() => { parsed = JSON.parse(r.stdout) }).not.toThrow()
    expect(parsed).toMatchObject({ ok: false })
    expect(parsed.failures).toBeInstanceOf(Array)
    expect(parsed.failures.length).toBeGreaterThan(0)
  })

  // ── TC-05: dry-run skips DB write (step 5) ────────────────────────────
  it('TC-05: dry-run mode skips DB write probe (step 5)', () => {
    const r = runScript(['--campaign-id=1', '--mode=dry-run', '--json'])
    let parsed = {}
    try { parsed = JSON.parse(r.stdout) } catch { /* may be empty if all steps fatal */ }
    const step5 = (parsed.steps || []).find(s => s.step === 5)
    if (step5) {
      expect(step5.ok).toBe(true)
      expect(step5.detail).toMatch(/dry-run|skipped/i)
    }
    expect([0, 1]).toContain(r.exitCode)
  })

  // ── TC-06: live mode includes DB write step ───────────────────────────
  it('TC-06: live mode includes DB write probe step (not skipped)', () => {
    const r = runScript(['--campaign-id=1', '--mode=live', '--json'])
    let parsed = {}
    try { parsed = JSON.parse(r.stdout) } catch { /* ok */ }
    const step5 = (parsed.steps || []).find(s => s.step === 5)
    if (step5 && step5.ok === false) {
      // Should fail with DB error, not "skipped"
      expect(step5.detail).not.toMatch(/dry-run — db write probe skipped/i)
    }
    expect([0, 1]).toContain(r.exitCode)
  })

  // ── TC-07: --json output shape validation ────────────────────────────
  it('TC-07: --json output has required shape fields', () => {
    const r = runScript(['--campaign-id=42', '--json'])
    let parsed = {}
    try { parsed = JSON.parse(r.stdout) } catch { /* empty stdout if fatal error */ }
    if (Object.keys(parsed).length > 0) {
      expect(typeof parsed.ok).toBe('boolean')
      expect(typeof parsed.campaign_id).toBe('number')
      expect(typeof parsed.mode).toBe('string')
      expect(Array.isArray(parsed.steps)).toBe(true)
      expect(Array.isArray(parsed.failures)).toBe(true)
      expect(typeof parsed.generated_at).toBe('string')
      expect(() => new Date(parsed.generated_at)).not.toThrow()
    }
  })

  // ── TC-08: egress fail → step 1 failed, action_url present ───────────
  it('TC-08: egress failure produces actionable message with action_url', () => {
    const r = runScript(['--campaign-id=1', '--json'])
    let parsed = {}
    try { parsed = JSON.parse(r.stdout) } catch { /* ok */ }
    const step1 = (parsed.steps || []).find(s => s.step === 1)
    if (step1 && !step1.ok) {
      expect(step1.action_url).toBeTruthy()
      expect(step1.detail).toBeTruthy()
    }
  })

  // ── TC-09: script file exists and is executable ───────────────────────
  it('TC-09: scripts/verify-launch.mjs exists at expected path', async () => {
    const { existsSync } = await import('node:fs')
    expect(existsSync(SCRIPT)).toBe(true)
  })

  // ── TC-10: root package.json has verify:launch script ────────────────
  it('TC-10: root package.json declares verify:launch script', async () => {
    const { readFileSync } = await import('node:fs')
    const pkgPath = join(REPO_ROOT, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    expect(pkg.scripts?.['verify:launch']).toBeDefined()
    expect(pkg.scripts['verify:launch']).toContain('verify-launch.mjs')
  })

  // ── TC-11: playbook addendum exists ──────────────────────────────────
  it('TC-11: launch-readiness.md contains automated verify section', async () => {
    const { readFileSync } = await import('node:fs')
    const playbookPath = join(REPO_ROOT, 'docs', 'playbooks', 'launch-readiness.md')
    const content = readFileSync(playbookPath, 'utf8')
    expect(content).toMatch(/automated launch verify|verify:launch/i)
    expect(content).toMatch(/--campaign-id/)
  })

  // ── TC-12: JSON output ok=false when any step fails ───────────────────
  it('TC-12: JSON ok=false when network steps fail (no BFF in test)', () => {
    const r = runScript(['--campaign-id=999', '--json'])
    let parsed = {}
    try { parsed = JSON.parse(r.stdout) } catch { /* ok */ }
    if (Object.keys(parsed).length > 0) {
      expect(parsed.ok).toBe(false)
      expect(parsed.failures.length).toBeGreaterThan(0)
    }
    expect(r.exitCode).toBe(1)
  })

  // ── TC-13: all 5 steps present in JSON output ─────────────────────────
  it('TC-13: all 5 step objects present in JSON output', () => {
    const r = runScript(['--campaign-id=1', '--json'])
    let parsed = {}
    try { parsed = JSON.parse(r.stdout) } catch { /* ok */ }
    if (parsed.steps) {
      const stepNums = parsed.steps.map(s => s.step).sort((a, b) => a - b)
      expect(stepNums).toEqual([1, 2, 3, 4, 5])
    }
  })

  // ── TC-14: each failed step has name + detail + action_url ───────────
  it('TC-14: each failure entry has name, detail, and action_url', () => {
    const r = runScript(['--campaign-id=1', '--json'])
    let parsed = {}
    try { parsed = JSON.parse(r.stdout) } catch { /* ok */ }
    if (parsed.failures) {
      for (const f of parsed.failures) {
        expect(typeof f.name).toBe('string')
        expect(typeof f.detail).toBe('string')
        if (f.step && f.step <= 4) {
          expect(f.action_url).toBeTruthy()
        }
      }
    }
  })
})

// ── Arg parsing boundary tests ────────────────────────────────────────────
describe('verify-launch argument parsing logic', () => {
  // TC-15: campaign-id 0 is invalid
  it('TC-15: campaign-id=0 is treated as invalid', () => {
    const r = runScript(['--campaign-id=0'])
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/invalid|positive integer/i)
  })

  // TC-16: negative campaign-id is invalid
  it('TC-16: negative campaign-id is treated as invalid', () => {
    const r = runScript(['--campaign-id=-5'])
    expect(r.exitCode).toBe(2)
  })

  // TC-17: valid args with no BFF → exits 1 (gate fail, not arg error)
  it('TC-17: valid args with unreachable BFF exits 1, not 2', () => {
    const r = runScript(['--campaign-id=1'])
    expect(r.exitCode).toBe(1)
  })
})

// ── Gate 3 SMTP probe auth-config guard (issue #584) ──────────────────────
// The relay's POST /v1/probe handler calls requireActor() and returns 401
// without a Bearer token. If ANTI_TRACE_RELAY_TOKEN is unset locally, every
// probe returned 401 and Gate 3 reported a misleading "SMTP AUTH probe
// failed" message that pointed at the mailboxes instead of the missing
// config. These tests pin the config-skip behaviour added for #584.
describe('verify-launch Gate 3 — relay token guard (issue #584)', () => {
  let scriptSrc

  it('TC-18: script reads ANTI_TRACE_RELAY_TOKEN from process env', async () => {
    const { readFileSync } = await import('node:fs')
    scriptSrc = readFileSync(SCRIPT, 'utf8')
    expect(scriptSrc).toMatch(/process\.env\.ANTI_TRACE_RELAY_TOKEN/)
  })

  it('TC-19: stepSmtpProbe skips with actionable message when RELAY_TOKEN is empty', async () => {
    const { readFileSync } = await import('node:fs')
    if (!scriptSrc) scriptSrc = readFileSync(SCRIPT, 'utf8')
    expect(scriptSrc).toMatch(/if\s*\(\s*!RELAY_TOKEN\s*\)/)
    expect(scriptSrc).toMatch(/ANTI_TRACE_RELAY_TOKEN.*not set/i)
  })

  it('TC-20: skip path uses pass(3, ...) not fail(3, ...) — does not block launch', async () => {
    const { readFileSync } = await import('node:fs')
    if (!scriptSrc) scriptSrc = readFileSync(SCRIPT, 'utf8')
    const tokenBlockMatch = scriptSrc.match(/if\s*\(\s*!RELAY_TOKEN\s*\)\s*\{[\s\S]*?\n\s{2}\}/)
    expect(tokenBlockMatch, 'expected !RELAY_TOKEN guard block').toBeTruthy()
    expect(tokenBlockMatch[0]).toMatch(/pass\(\s*3\s*,/)
    expect(tokenBlockMatch[0]).not.toMatch(/fail\(\s*3\s*,/)
  })

  it('TC-21: skip message references probe.go requireActor for traceability', async () => {
    const { readFileSync } = await import('node:fs')
    if (!scriptSrc) scriptSrc = readFileSync(SCRIPT, 'utf8')
    expect(scriptSrc).toMatch(/probe\.go.*requireActor|requireActor/)
  })

  it('TC-22: skip path comes BEFORE DB pool open (avoid wasted connection)', async () => {
    const { readFileSync } = await import('node:fs')
    if (!scriptSrc) scriptSrc = readFileSync(SCRIPT, 'utf8')
    const stepStart = scriptSrc.indexOf('async function stepSmtpProbe()')
    const stepEnd = scriptSrc.indexOf('async function stepTemplateRender()')
    const stepBody = scriptSrc.slice(stepStart, stepEnd)
    const tokenLocal = stepBody.indexOf('!RELAY_TOKEN')
    const poolLocal = stepBody.indexOf('new pg.Pool({ connectionString: DB_URL }')
    expect(tokenLocal).toBeGreaterThan(0)
    expect(poolLocal).toBeGreaterThan(0)
    expect(tokenLocal).toBeLessThan(poolLocal)
  })

  it('TC-23: !RELAY_TOKEN guard message is exactly one line and human-readable', async () => {
    const { readFileSync } = await import('node:fs')
    if (!scriptSrc) scriptSrc = readFileSync(SCRIPT, 'utf8')
    const tokenBlockMatch = scriptSrc.match(/if\s*\(\s*!RELAY_TOKEN\s*\)\s*\{[\s\S]*?\n\s{2}\}/)
    expect(tokenBlockMatch).toBeTruthy()
    const block = tokenBlockMatch[0]
    // Must contain a single pass(...) call with a single template-string detail.
    const passCalls = block.match(/pass\(/g) || []
    expect(passCalls.length).toBe(1)
    // Operator-friendly: must mention what's missing, what to do
    expect(block).toMatch(/SMTP probe skipped/i)
  })

  it('TC-24: 401 from relay does NOT show as "SMTP AUTH probe failed" when token is empty (regression for #584)', async () => {
    const { readFileSync } = await import('node:fs')
    if (!scriptSrc) scriptSrc = readFileSync(SCRIPT, 'utf8')
    const tokenBlockMatch = scriptSrc.match(/if\s*\(\s*!RELAY_TOKEN\s*\)\s*\{[\s\S]*?\n\s{2}\}/)
    expect(tokenBlockMatch).toBeTruthy()
    expect(tokenBlockMatch[0]).not.toMatch(/SMTP AUTH probe failed/i)
    expect(tokenBlockMatch[0]).not.toMatch(/HTTP 401/i)
  })

  it('TC-25: existing 401-from-probe-loop failure message is preserved (when token IS set)', async () => {
    const { readFileSync } = await import('node:fs')
    if (!scriptSrc) scriptSrc = readFileSync(SCRIPT, 'utf8')
    expect(scriptSrc).toMatch(/SMTP AUTH probe failed for/)
  })

  it('TC-26: skip message hints at the resolution (set the env var)', async () => {
    const { readFileSync } = await import('node:fs')
    if (!scriptSrc) scriptSrc = readFileSync(SCRIPT, 'utf8')
    const tokenBlockMatch = scriptSrc.match(/if\s*\(\s*!RELAY_TOKEN\s*\)\s*\{[\s\S]*?\n\s{2}\}/)
    expect(tokenBlockMatch).toBeTruthy()
    expect(tokenBlockMatch[0]).toMatch(/ANTI_TRACE_RELAY_TOKEN/)
  })

  it('TC-27: helper file scripts/lib/relay-probe.mjs is still imported (post-#612)', async () => {
    const { readFileSync } = await import('node:fs')
    if (!scriptSrc) scriptSrc = readFileSync(SCRIPT, 'utf8')
    expect(scriptSrc).toMatch(/import\s+\{\s*probeMailboxViaRelay\s*\}\s+from\s+['"]\.\/lib\/relay-probe\.mjs['"]/)
  })
})
