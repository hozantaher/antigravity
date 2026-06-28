// @linkage-allowed: discipline ratchet — checks ML3.4 toxiproxy overlay shape
/**
 * ML3.4 — audit test for the mail-lab chaos overlay.
 *
 * Goal: prevent silent regression where someone removes a toxic from
 * the chaos.sh control surface or breaks the compose overlay's port
 * mapping (which would silently bypass chaos in tests).
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../../..')
const COMPOSE = join(REPO_ROOT, 'infra/docker/mail-lab-chaos.yml')
const SCRIPT = join(REPO_ROOT, 'scripts/mail-lab/chaos.sh')

describe('mail-lab chaos overlay (#ML3.4)', () => {
  const composeYaml = existsSync(COMPOSE) ? readFileSync(COMPOSE, 'utf8') : ''
  const script = existsSync(SCRIPT) ? readFileSync(SCRIPT, 'utf8') : ''

  // ── Compose file ──────────────────────────────────────────────────

  it('compose overlay file exists', () => {
    expect(existsSync(COMPOSE)).toBe(true)
  })

  it('declares mail-lab-toxiproxy service', () => {
    expect(composeYaml).toMatch(/^\s*mail-lab-toxiproxy:/m)
  })

  it('uses pinned toxiproxy image (no @latest)', () => {
    expect(composeYaml).toMatch(/image:\s*ghcr\.io\/shopify\/toxiproxy:\d+\.\d+\.\d+/)
    expect(composeYaml).not.toMatch(/toxiproxy:latest/)
  })

  it('exposes toxiproxy admin API port (28474:8474)', () => {
    expect(composeYaml).toMatch(/28474:8474/)
  })

  it('exposes proxied SMTP plain (29025)', () => {
    expect(composeYaml).toMatch(/29025/)
  })

  it('exposes proxied SMTPS (29465)', () => {
    expect(composeYaml).toMatch(/29465/)
  })

  it('exposes proxied SMTP submission (29587)', () => {
    expect(composeYaml).toMatch(/29587/)
  })

  it('exposes proxied IMAPS (29993)', () => {
    expect(composeYaml).toMatch(/29993/)
  })

  it('has healthcheck on toxiproxy', () => {
    expect(composeYaml).toMatch(/healthcheck:/)
    expect(composeYaml).toMatch(/8474\/version/)
  })

  it('depends on mail-lab-seznam being started', () => {
    expect(composeYaml).toMatch(/mail-lab-seznam:/)
    expect(composeYaml).toMatch(/condition:\s*service_started/)
  })

  it('has bootstrap sidecar that pre-registers proxies', () => {
    expect(composeYaml).toMatch(/mail-lab-toxiproxy-bootstrap:/)
  })

  it('bootstrap waits for toxiproxy healthy before running', () => {
    expect(composeYaml).toMatch(/condition:\s*service_healthy/)
  })

  it('bootstrap registers all 4 proxy upstreams', () => {
    expect(composeYaml).toMatch(/seznam-smtp:29025:mail-lab-seznam:25/)
    expect(composeYaml).toMatch(/seznam-smtps:29465:mail-lab-seznam:465/)
    expect(composeYaml).toMatch(/seznam-submission:29587:mail-lab-seznam:587/)
    expect(composeYaml).toMatch(/seznam-imaps:29993:mail-lab-seznam:993/)
  })

  it('bootstrap is restart=no (one-shot)', () => {
    expect(composeYaml).toMatch(/restart:\s*"no"/)
  })

  // ── chaos.sh script ───────────────────────────────────────────────

  it('chaos.sh exists', () => {
    expect(existsSync(SCRIPT)).toBe(true)
  })

  it('chaos.sh is executable', () => {
    expect(statSync(SCRIPT).mode & 0o111).toBeGreaterThan(0)
  })

  it('chaos.sh uses set -euo pipefail', () => {
    expect(script).toMatch(/set -euo pipefail/)
  })

  it('chaos.sh supports add command', () => {
    expect(script).toMatch(/^\s*add\)/m)
  })

  it('chaos.sh supports remove command', () => {
    expect(script).toMatch(/^\s*remove\)/m)
  })

  it('chaos.sh supports list command', () => {
    expect(script).toMatch(/^\s*list\)/m)
  })

  it('chaos.sh supports clear command', () => {
    expect(script).toMatch(/^\s*clear\)/m)
  })

  it('chaos.sh supports all 6 toxic types', () => {
    for (const toxic of ['latency', 'bandwidth', 'slow_close', 'reset_peer', 'timeout', 'slicer']) {
      expect(script).toMatch(new RegExp(`${toxic}\\)`))
    }
  })

  it('chaos.sh supports --proxy flag', () => {
    expect(script).toMatch(/--proxy/)
  })

  it('chaos.sh supports --direction flag', () => {
    expect(script).toMatch(/--direction/)
  })

  it('chaos.sh has distinct exit codes (1 unreachable, 2 unknown, 3 args)', () => {
    expect(script).toMatch(/exit "?\$\{?2.*1/) // toxiproxy unreachable
    expect(script).toMatch(/unknown toxic.*2/)
    expect(script).toMatch(/requires .*3/)
  })

  it('chaos.sh checks toxiproxy reachability before mutating', () => {
    expect(script).toMatch(/check_toxiproxy/)
  })

  it('chaos.sh references all 4 proxy names', () => {
    expect(script).toMatch(/seznam-smtp/)
    expect(script).toMatch(/seznam-smtps/)
    expect(script).toMatch(/seznam-submission/)
    expect(script).toMatch(/seznam-imaps/)
  })

  it('chaos.sh TOXIPROXY env var is overridable', () => {
    expect(script).toMatch(/TOXIPROXY:?-/)
  })
})
