// Dead code regression — knip output must not exceed baseline. Catches
// orphaned files/exports added by partial refactors. Reduce baseline by
// deleting + updating reports/dead/baseline.summary.json.

import { describe, it, expect, beforeAll } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const baselinePath = join(import.meta.dirname, '../reports/dead/baseline.summary.json')
let HAS_KNIP = false
try { execSync('pnpm exec knip --version', { stdio: 'ignore' }); HAS_KNIP = true } catch {}

const HAS_BASELINE = existsSync(baselinePath)
const baseline = HAS_BASELINE ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {}
const CAN_RUN = HAS_KNIP && HAS_BASELINE

function runKnip() {
  let out
  try {
    out = execSync('pnpm exec knip --reporter json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (e) {
    out = e.stdout || ''
  }
  let d
  try { d = JSON.parse(out) } catch { return { files: 0, exports: 0, deps: 0, unlisted: 0 } }
  return {
    files:    d.issues?.filter(i => i.files?.length).length || 0,
    exports:  d.issues?.reduce((s, i) => s + (i.exports?.length || 0), 0) || 0,
    deps:     d.issues?.reduce((s, i) => s + (i.dependencies?.length || 0), 0) || 0,
    unlisted: d.issues?.reduce((s, i) => s + (i.unlisted?.length || 0), 0) || 0,
  }
}

const describeFn = CAN_RUN ? describe : describe.skip

describeFn('Dead code: knip ≤ baseline (no regressions)', () => {
  let cur
  beforeAll(() => { cur = runKnip() })
  for (const k of ['files', 'exports', 'deps', 'unlisted']) {
    it(`${k} ≤ baseline`, () => {
      expect(cur[k], `dead-code ${k} regression`).toBeLessThanOrEqual(baseline[k])
    })
  }
})
