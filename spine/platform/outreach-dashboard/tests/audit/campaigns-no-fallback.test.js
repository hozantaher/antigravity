// campaigns-no-fallback.test.js — Sprint C1 audit ratchet (issue #1254)
//
// Background: the BFF used to silently fall back to a direct-DB write
// when the Go orchestrator was unreachable on POST /api/campaigns, /run,
// and /pause. That broke the single-source-of-truth invariant —
// campaign_contacts stayed empty after a fallback create, audit log got
// two divergent paths for the same state change. Sprint C1 deleted the
// fallback in favour of HTTP 503 when Go is down.
//
// This test prevents the pattern from regressing: the three handlers
// must not contain `UPDATE campaigns SET status` outside the Go-proxy
// branch. The bulk pause endpoint (PATCH /api/campaigns/bulk-pause or
// similar) uses `UPDATE campaigns SET status` legitimately; we whitelist
// it by matching the surrounding context.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CAMPAIGNS_JS = join(__dirname, '..', '..', 'src', 'server-routes', 'campaigns.js')

describe('AR (campaigns-no-fallback) — no UPDATE campaigns SET status in /run /pause', () => {
  it('campaigns.js has no fallback UPDATE inside the /run handler', () => {
    const source = readFileSync(CAMPAIGNS_JS, 'utf8')

    // Locate the /run handler by its route declaration and follow to the
    // closing of its outer try/catch. Any UPDATE campaigns SET status
    // within that block is a fallback regression.
    const runMatch = source.match(
      /app\.post\(['"]\/api\/campaigns\/:id\/run['"][\s\S]*?(?=\n\s*app\.(?:post|get|put|patch|delete)\(['"])/,
    )
    expect(runMatch, '/run handler not found — regex needs update').toBeTruthy()
    const runBody = runMatch[0]
    const offendingMatches = runBody.match(/UPDATE\s+campaigns\s+SET\s+status\s*=\s*['"]running['"]/i)
    if (offendingMatches) {
      throw new Error(
        `Found UPDATE campaigns SET status='running' inside the /run handler. ` +
        `Sprint C1 removed the silent-fallback path; restoring it breaks the ` +
        `single-source-of-truth invariant. If you need the orchestrator path ` +
        `to be optional, return 503 from the BFF instead.`,
      )
    }
  })

  it('campaigns.js has no fallback UPDATE inside the /pause handler', () => {
    const source = readFileSync(CAMPAIGNS_JS, 'utf8')
    const pauseMatch = source.match(
      /app\.post\(['"]\/api\/campaigns\/:id\/pause['"][\s\S]*?(?=\n\s*app\.(?:post|get|put|patch|delete)\(['"])/,
    )
    expect(pauseMatch, '/pause handler not found — regex needs update').toBeTruthy()
    const pauseBody = pauseMatch[0]
    const offendingMatches = pauseBody.match(/UPDATE\s+campaigns\s+SET\s+status\s*=\s*['"]paused['"](?!\s+WHERE\s+id\s*=\s*ANY)/i)
    if (offendingMatches) {
      throw new Error(
        `Found UPDATE campaigns SET status='paused' inside the /pause handler. ` +
        `Sprint C1 removed the silent-fallback path. Return 503 when Go is ` +
        `unreachable instead of bypassing the orchestrator.`,
      )
    }
  })

  it('campaigns.js POST /api/campaigns has no fallback INSERT path', () => {
    const source = readFileSync(CAMPAIGNS_JS, 'utf8')
    // Find the POST /api/campaigns handler (not /:id/...). Anchor on the
    // literal that doesn't include `:id`. The next router line ends it.
    const createMatch = source.match(
      /app\.post\(['"]\/api\/campaigns['"][\s\S]*?(?=\n\s*app\.(?:post|get|put|patch|delete)\(['"])/,
    )
    expect(createMatch, 'POST /api/campaigns handler not found').toBeTruthy()
    const createBody = createMatch[0]
    // Forbid the legacy fallback INSERT — there should be no direct
    // INSERT INTO campaigns inside this handler. The Go path uses pool
    // only to SELECT the freshly-created row.
    const insertMatch = createBody.match(/INSERT\s+INTO\s+campaigns\s*\(/i)
    if (insertMatch) {
      throw new Error(
        `Found INSERT INTO campaigns inside POST /api/campaigns handler. ` +
        `Sprint C1 removed the legacy direct-DB create. Forward to the ` +
        `Go orchestrator (which owns enrollment) or return 503.`,
      )
    }
  })
})
