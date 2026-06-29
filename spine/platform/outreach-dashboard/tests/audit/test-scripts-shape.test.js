// @linkage-allowed: discipline ratchet — checks package.json + docs shape
/**
 * Audit test for #70 + #69 — pnpm test default flipped to TEST_SCOPE=all.
 *
 * Goal: prevent silent regression where someone changes `pnpm test` to
 * narrow scope without renaming aliases. Also verifies the docs match.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../../..')
const DASHBOARD_DIR = join(REPO_ROOT, 'features/platform/outreach-dashboard')

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
function readText(path) {
  return readFileSync(path, 'utf8')
}

describe('test scripts shape (#70 + #69)', () => {
  const pkg = readJSON(join(DASHBOARD_DIR, 'package.json'))
  const dashClaude = readText(join(DASHBOARD_DIR, 'CLAUDE.md'))
  const rootReadme = readText(join(REPO_ROOT, 'README.md'))
  const rootClaude = readText(join(REPO_ROOT, 'CLAUDE.md'))

  // 1. `pnpm test` runs full scope (TEST_SCOPE=all).
  it('test script runs TEST_SCOPE=all', () => {
    expect(pkg.scripts.test).toContain('TEST_SCOPE=all')
  })

  // 2. `pnpm test:fast` exists for tight inner-loop.
  it('test:fast script exists', () => {
    expect(pkg.scripts['test:fast']).toBeDefined()
  })

  // 3. test:fast is the narrow scope (no TEST_SCOPE=all).
  it('test:fast does not set TEST_SCOPE=all', () => {
    expect(pkg.scripts['test:fast']).not.toContain('TEST_SCOPE=all')
  })

  // 4. test:fast still invokes vitest run.
  it('test:fast invokes vitest run', () => {
    expect(pkg.scripts['test:fast']).toMatch(/vitest run/)
  })

  // 5. test:full kept for back-compat (alias for full).
  it('test:full still runs TEST_SCOPE=all', () => {
    expect(pkg.scripts['test:full']).toContain('TEST_SCOPE=all')
  })

  // 6. test:contract uses TEST_SCOPE=contract.
  it('test:contract scopes correctly', () => {
    expect(pkg.scripts['test:contract']).toContain('TEST_SCOPE=contract')
  })

  // 7. test:integration uses TEST_SCOPE=integration.
  it('test:integration scopes correctly', () => {
    expect(pkg.scripts['test:integration']).toContain('TEST_SCOPE=integration')
  })

  // 8. Dashboard CLAUDE.md documents new shape (mentions TEST_SCOPE=all).
  it('dashboard CLAUDE.md mentions TEST_SCOPE=all on pnpm test', () => {
    // Match either inline or in the explanatory paragraph
    expect(dashClaude).toMatch(/pnpm test\s+#\s+full|TEST_SCOPE=all/)
  })

  // 9. Root README has Running tests section.
  it('root README has Running tests section', () => {
    expect(rootReadme).toMatch(/^## Running tests$/m)
  })

  // 10. Root README mentions pnpm test = full scope.
  it('root README documents the default flip', () => {
    expect(rootReadme).toMatch(/Default flipped|pnpm test.*Full|TEST_SCOPE=all/)
  })

  // 11. Root CLAUDE.md cross-references README#running-tests.
  it('root CLAUDE.md points to README#running-tests', () => {
    expect(rootClaude).toMatch(/README\.md#running-tests/i)
  })

  // 12. Root CLAUDE.md documents the flip.
  it('root CLAUDE.md mentions the flip', () => {
    expect(rootClaude).toMatch(/since #70|TEST_SCOPE=all/)
  })

  // 13. test:all alias preserved (was equivalent before flip).
  it('test:all preserved as alias', () => {
    expect(pkg.scripts['test:all']).toContain('TEST_SCOPE=all')
  })

  // 14. test and test:full now produce identical commands (back-compat).
  it('test and test:full identical (back-compat alias)', () => {
    expect(pkg.scripts.test).toBe(pkg.scripts['test:full'])
  })

  // 15. test and test:fast differ (the whole point of the flip).
  it('test and test:fast differ', () => {
    expect(pkg.scripts.test).not.toBe(pkg.scripts['test:fast'])
  })
})
