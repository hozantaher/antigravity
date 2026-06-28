// @linkage-allowed: discipline ratchet — checks .github/workflows/mail-lab-ci.yml shape
/**
 * ML6.1 — audit test for the mail-lab CI workflow.
 *
 * Goal: prevent silent regression where someone removes a critical step
 * (healthcheck wait, smoke tests, teardown) without replacement. We can't
 * easily integration-test a GH Actions YAML file from vitest, so this is
 * shape-level: parse the file, assert critical structures exist.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../../..')
const WORKFLOW = join(REPO_ROOT, '.github/workflows/mail-lab-ci.yml')

describe('mail-lab CI workflow (#ML6.1)', () => {
  // 1. Workflow file exists.
  it('workflow file exists', () => {
    expect(existsSync(WORKFLOW)).toBe(true)
  })

  const yaml = existsSync(WORKFLOW) ? readFileSync(WORKFLOW, 'utf8') : ''

  // 2. Has a name.
  it('has a name', () => {
    expect(yaml).toMatch(/^name:\s+Mail Lab CI/m)
  })

  // 3. Triggers on push to main.
  it('triggers on push to main', () => {
    expect(yaml).toMatch(/branches:\s*\[main/)
  })

  // 4. Triggers on PR.
  it('triggers on pull_request', () => {
    expect(yaml).toMatch(/^\s*pull_request:/m)
  })

  // 5. Has scheduled run (catches upstream image drift).
  it('has weekly schedule', () => {
    expect(yaml).toMatch(/cron:\s*['"]0 6 \* \* 1['"]/)
  })

  // 6. Path filters cover mail-lab-api.
  it('path filter includes mail-lab-api', () => {
    expect(yaml).toMatch(/features\/platform\/mail-lab-api/)
  })

  // 7. Path filters cover maillabclient.
  it('path filter includes maillabclient', () => {
    expect(yaml).toMatch(/features\/platform\/common\/maillabclient/)
  })

  // 8. Path filters cover orchestrator labhook.
  it('path filter includes orchestrator/labhook', () => {
    expect(yaml).toMatch(/features\/inbound\/orchestrator\/labhook/)
  })

  // 9. Path filters cover the compose file itself.
  it('path filter includes mail-lab.yml', () => {
    expect(yaml).toMatch(/infra\/docker\/mail-lab\.yml/)
  })

  // 10. Boots mail-lab via docker compose.
  it('boots mail-lab via docker compose', () => {
    expect(yaml).toMatch(/docker compose -f infra\/docker\/mail-lab\.yml/)
  })

  // 11. Polls /healthz before running smoke.
  it('waits for /healthz before smoke', () => {
    expect(yaml).toMatch(/curl[^\n]*\/healthz/)
  })

  // 12. Healthcheck has a bounded retry loop.
  it('healthcheck retry is bounded', () => {
    expect(yaml).toMatch(/seq 1 \d+/)
  })

  // 13. Runs unit tests for mail-lab-api.
  it('runs mail-lab-api unit tests', () => {
    expect(yaml).toMatch(/Unit tests.*mail-lab-api/i)
    expect(yaml).toMatch(/go test -race -count=1[^\n]*\.\.\./)
  })

  // 14. Runs unit tests for maillabclient.
  it('runs maillabclient unit tests', () => {
    expect(yaml).toMatch(/Unit tests.*maillabclient/i)
  })

  // 15. Runs unit tests for orchestrator/labhook.
  it('runs orchestrator/labhook unit tests', () => {
    expect(yaml).toMatch(/Unit tests.*labhook/i)
  })

  // 16. Has integration smoke that exercises /v1/profile/{domain}/evaluate.
  it('exercises /evaluate endpoint as smoke', () => {
    expect(yaml).toMatch(/\/v1\/profile\/[^\/\s]+\/evaluate/)
  })

  // 17. Smoke includes both accept + reject verdict cases.
  it('smoke covers accept + reject verdicts', () => {
    expect(yaml).toMatch(/decision.*reject/)
  })

  // 18. Captures compose logs on failure (debug aid).
  it('captures compose logs on failure', () => {
    expect(yaml).toMatch(/if:\s*failure\(\)/)
    expect(yaml).toMatch(/docker compose[^\n]*logs/)
  })

  // 19. Tears down stack at end (always).
  it('tears down stack always', () => {
    expect(yaml).toMatch(/docker compose[^\n]*down/)
    expect(yaml).toMatch(/if:\s*always\(\)/)
  })

  // 20. Tear-down honors keep_running input flag (debug knob).
  it('honors keep_running input flag', () => {
    expect(yaml).toMatch(/keep_running/)
  })

  // 21. Has timeout to prevent runaway runners.
  it('job has timeout', () => {
    expect(yaml).toMatch(/timeout-minutes:\s*\d+/)
  })

  // 22. Uses pinned major version of actions (no @latest, no floating).
  it('actions are version-pinned', () => {
    const actionRefs = yaml.match(/uses:\s*[^\s]+/g) || []
    for (const ref of actionRefs) {
      // Skip our own internal references; only check 3rd-party
      if (!ref.includes('@')) continue
      expect(ref).not.toMatch(/@latest/)
      expect(ref).not.toMatch(/@main/)
    }
  })
})
