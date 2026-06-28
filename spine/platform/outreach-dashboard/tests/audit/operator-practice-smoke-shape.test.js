// @linkage-allowed: discipline ratchet — checks scripts/operator-practice/smoke.sh shape
/**
 * OP1.6 — audit for the one-command operator practice smoke runner.
 *
 * Goal: catch silent regressions where someone removes a phase
 * (boot / provision / seed) or breaks env knob plumbing. Real
 * integration runs in the mail-lab CI workflow (#261).
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../../..')
const SMOKE = join(REPO_ROOT, 'scripts/operator-practice/smoke.sh')

describe('OP1.6 — smoke.sh shape', () => {
  // 1. Exists + executable.
  it('smoke.sh exists + executable', () => {
    expect(existsSync(SMOKE)).toBe(true)
    expect(statSync(SMOKE).mode & 0o111).toBeGreaterThan(0)
  })

  const sh = readFileSync(SMOKE, 'utf8')

  // 2. set -euo pipefail (discipline).
  it('uses set -euo pipefail', () => {
    expect(sh).toMatch(/set -euo pipefail/)
  })

  // 3. Has all 4 phases (sanity, boot, provision, seed).
  it('has 4 phases', () => {
    expect(sh).toMatch(/phase 0\/4 — fixture sanity/)
    expect(sh).toMatch(/phase 1\/4 — Mail Lab health/)
    expect(sh).toMatch(/phase 2\/4 — operator mailbox/)
    expect(sh).toMatch(/phase 3\/4 — seed/)
    expect(sh).toMatch(/phase 4\/4 — ready/)
  })

  // 4. Distinct exit codes (1..5).
  it('has 5 distinct exit codes documented', () => {
    expect(sh).toMatch(/Exit codes:/)
    for (const code of ['1', '2', '3', '4', '5']) {
      expect(sh, `code ${code} undocumented`).toMatch(new RegExp(`^#\\s+${code}\\s+`, 'm'))
    }
  })

  // 5. Honors COUNT env knob.
  it('honors COUNT env / positional', () => {
    expect(sh).toMatch(/COUNT="\$\{1:-\$\{COUNT:-\d+\}\}"/)
  })

  // 6. Honors MAILBOX env knob.
  it('honors MAILBOX env / positional', () => {
    expect(sh).toMatch(/MAILBOX="\$\{2:-\$\{MAILBOX:-/)
  })

  // 7. Honors LAB_API + LAB_API_KEY.
  it('honors LAB_API + LAB_API_KEY', () => {
    expect(sh).toMatch(/LAB_API:?-/)
    expect(sh).toMatch(/LAB_API_KEY:?-/)
  })

  // 8. Honors LAB_IMAP_HOST + LAB_IMAP_PORT (matches seed-replies.sh).
  it('honors LAB_IMAP_HOST + LAB_IMAP_PORT', () => {
    expect(sh).toMatch(/LAB_IMAP_HOST/)
    expect(sh).toMatch(/LAB_IMAP_PORT/)
  })

  // 9. Honors DASHBOARD_URL for next-step printing.
  it('honors DASHBOARD_URL', () => {
    expect(sh).toMatch(/DASHBOARD_URL/)
  })

  // 10. Has SKIP_BOOT escape hatch.
  it('has SKIP_BOOT escape hatch', () => {
    expect(sh).toMatch(/SKIP_BOOT/)
  })

  // 11. Has SKIP_PROVISION escape hatch.
  it('has SKIP_PROVISION escape hatch', () => {
    expect(sh).toMatch(/SKIP_PROVISION/)
  })

  // 12. Calls curl with --max-time bound (no hang).
  it('curl health check has bounded timeout', () => {
    expect(sh).toMatch(/curl.*--max-time/)
  })

  // 13. Boot phase has bounded retry loop.
  it('healthz wait is bounded retry loop', () => {
    expect(sh).toMatch(/seq 1 \d+/)
    expect(sh).toMatch(/sleep 2/)
  })

  // 14. Detects existing mailbox via 200 status check.
  it('detects existing mailbox via HTTP 200', () => {
    expect(sh).toMatch(/STATUS=/)
    expect(sh).toMatch(/v1\/mailbox/)
    expect(sh).toMatch(/200/)
  })

  // 15. Provision uses POST /v1/mailbox with required fields.
  it('provision POSTs address + password to /v1/mailbox', () => {
    expect(sh).toMatch(/POST.*\/v1\/mailbox/)
    expect(sh).toMatch(/\\"address\\":\\"\$\{MAILBOX\}\\"/)
    expect(sh).toMatch(/\\"password\\":\\"\$\{PASSWORD\}\\"/)
  })

  // 16. Seed phase invokes seed-replies.mjs with --source placeholder.
  it('seed phase invokes seed-replies.mjs with placeholder source', () => {
    expect(sh).toMatch(/seed-replies\.mjs/)
    expect(sh).toMatch(/--source placeholder/)
  })

  // 17. Final phase prints dashboard URL.
  it('final phase prints dashboard URL', () => {
    expect(sh).toMatch(/open \$\{DASHBOARD_URL\}\/replies/)
  })

  // 18. Final phase shows reset command.
  it('final phase shows clear-inbox reset command', () => {
    expect(sh).toMatch(/clear-inbox\.sh/)
    expect(sh).toMatch(/I-KNOW-THIS-WIPES-INBOX/)
  })

  // 19. Final phase shows replay-campaign example.
  it('final phase shows replay-campaign example', () => {
    expect(sh).toMatch(/replay-campaign\.sh/)
    expect(sh).toMatch(/--accel/)
  })

  // 20. die() helper has trap-friendly exit code argument.
  it('die() supports custom exit code', () => {
    expect(sh).toMatch(/die\s*\(\s*\)/)
    expect(sh).toMatch(/exit\s+"\$\{2:-1\}"/)
  })

  // 21. Refuses if no fixtures present (exit 5).
  it('exits 5 when no placeholder fixtures', () => {
    expect(sh).toMatch(/no placeholder fixtures/)
    expect(sh).toMatch(/\b5$|" 5$/m)
  })

  // 22. Refuses if mail-lab up.sh missing (exit 1).
  it('exits 1 when mail-lab up.sh missing', () => {
    expect(sh).toMatch(/Mail Lab boot script not found/)
  })
})
