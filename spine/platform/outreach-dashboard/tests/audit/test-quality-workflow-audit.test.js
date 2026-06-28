// A8 — adversarial CI workflow audit.
// Validates structure of .github/workflows/test-quality.yml so misconfig
// can't quietly disable the ratchet.
//
// @linkage-allowed: discipline ratchet — reads workflow YAML directly

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const WF = resolve(__dirname, '../../../../../.github/workflows/test-quality.yml')

describe('test-quality.yml — workflow contract', () => {
  it('T-1: workflow file exists', () => {
    expect(existsSync(WF)).toBe(true)
  })

  const yml = existsSync(WF) ? readFileSync(WF, 'utf8') : ''

  it('T-2: triggers on pull_request', () => {
    expect(yml).toMatch(/pull_request:/)
  })

  it('T-3: triggers on weekly schedule', () => {
    expect(yml).toMatch(/schedule:/)
    expect(yml).toMatch(/cron:\s*'?\d/)
  })

  it('T-4: has hallucination-score job', () => {
    expect(yml).toMatch(/hallucination-score:/)
  })

  it('T-5: runs test-prod-linkage script', () => {
    expect(yml).toMatch(/test-prod-linkage\.mjs/)
  })

  it('T-6: runs assertion-density script', () => {
    expect(yml).toMatch(/assertion-density\.mjs/)
  })

  it('T-7: runs inverted-fault transform', () => {
    expect(yml).toMatch(/inverted-fault-harness\.mjs/)
  })

  it('T-8: aggregates score with hallucination-score.mjs', () => {
    expect(yml).toMatch(/hallucination-score\.mjs/)
  })
})
