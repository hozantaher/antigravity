// HARD RULE (2026-05-14): outreach-dashboard runs LOCALLY only — no Railway hosting.
// Memory: feedback_outreach_dashboard_local_only (T0).
// Past: Z4 tear-down 2026-05-14 — Railway service deleted, Dockerfile + railway.toml deleted.
// This ratchet ensures no agent re-adds them.

import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')

const BANNED_FILES = [
  'Dockerfile',
  'railway.toml',
  'railway.json',
  'Procfile',
  'fly.toml',
]

describe('HARD RULE: outreach-dashboard local-only — no Railway hosting artifacts', () => {
  for (const f of BANNED_FILES) {
    it(`${f} must NOT exist in features/platform/outreach-dashboard/`, () => {
      const p = resolve(ROOT, f)
      const exists = existsSync(p)
      expect(exists, `Found ${f} — HARD RULE v3: outreach-dashboard is local-only. ` +
        `Memory: feedback_outreach_dashboard_local_only (T0). ` +
        `If you need a UI-server deploy target, propose it as a NEW dashboard service in a separate repo path.`).toBe(false)
    })
  }
})
