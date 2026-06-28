// Ratchet — src/app/pages/*.jsx must respect the 800 LOC ceiling.
//
// Coding-style rule (~/.claude/rules/common/coding-style.md): 800 max LOC per file.
// Currently 6 pages over the ceiling; tracked here with explicit allowlist that can
// only SHRINK. Operator can split pages incrementally; this ratchet prevents new
// pages from creeping over without explicit allowlist entry.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const PAGES_ROOT = resolve(__dirname, '../../src/app/pages')
const CEILING = 800

// One-way allowlist — pages currently exceeding ceiling. Each entry must
// shrink over time as splits land. Adding NEW entries requires sprint approval.
// LOC measured as `wc -l` (line count including blank lines + closing braces).
// Empty — every dashboard page is under the 800 LOC ceiling (orchestrators stay
// lean; heavy surfaces split into src/app/components/). Entries may only shrink.
const ALLOWLIST = {}

const ALLOWLIST_NAMES = Object.keys(ALLOWLIST)

describe('AJ ratchet: page LOC ceiling 800', () => {
  const entries = readdirSync(PAGES_ROOT, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.jsx'))
    .map(d => d.name)

  for (const name of entries) {
    const path = join(PAGES_ROOT, name)
    // Match `wc -l` semantics (count newlines, not split-length which is N+1).
    const text = readFileSync(path, 'utf8')
    const loc = text.length === 0 ? 0 : (text.match(/\n/g) || []).length
    const allowed = ALLOWLIST[name]

    if (allowed) {
      it(`${name} is on allowlist; must shrink from ${allowed.loc} (sprint ${allowed.sprint})`, () => {
        expect(loc, `${name} grew from ${allowed.loc} → ${loc}. Allowlist entries may only SHRINK; ` +
          `if it must grow, add a sprint plan to reduce it.`).toBeLessThanOrEqual(allowed.loc)
      })
    } else {
      it(`${name} is under 800 LOC ceiling`, () => {
        expect(loc, `${name} is ${loc} LOC (> ${CEILING}). Either split into sub-components, or ` +
          `add to ALLOWLIST in ${__filename} with a sprint plan to reduce it.`).toBeLessThanOrEqual(CEILING)
      })
    }
  }

  it('allowlist entries all still exist (stale entries fail)', () => {
    for (const name of ALLOWLIST_NAMES) {
      const path = join(PAGES_ROOT, name)
      let exists = false
      try { readFileSync(path); exists = true } catch {}
      expect(exists, `Allowlist references ${name} but file does not exist; remove from allowlist.`).toBe(true)
    }
  })
})
