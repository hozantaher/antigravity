// @linkage-allowed: discipline ratchet — checks OP2.1 / OP2.2 / OP2.4
/**
 * OP2 — brutal coverage for time-accelerated replay tooling:
 *   - arrival-curve.mjs (OP2.1)
 *   - replay-campaign.sh (OP2.2)
 *   - clear-inbox.{mjs,sh} (OP2.4)
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../../..')
const ARRIVAL = join(REPO_ROOT, 'scripts/operator-practice/arrival-curve.mjs')
const REPLAY = join(REPO_ROOT, 'scripts/mail-lab/replay-campaign.sh')
const CLEAR_NODE = join(REPO_ROOT, 'scripts/operator-practice/clear-inbox.mjs')
const CLEAR_BASH = join(REPO_ROOT, 'scripts/mail-lab/clear-inbox.sh')

let arrivalMod, clearMod
beforeAll(async () => {
  arrivalMod = await import(ARRIVAL)
  clearMod = await import(CLEAR_NODE)
})

describe('OP2.1 — arrival-curve.mjs (file)', () => {
  // 1. File exists + executable.
  it('arrival-curve.mjs exists + executable', () => {
    expect(existsSync(ARRIVAL)).toBe(true)
    expect(statSync(ARRIVAL).mode & 0o111).toBeGreaterThan(0)
  })

  // 2. Zero npm deps (pure node:* imports).
  it('uses node:* imports only', () => {
    const src = readFileSync(ARRIVAL, 'utf8')
    const importLines = src.split('\n').filter((l) => /^\s*import\s/.test(l))
    for (const line of importLines) {
      const m = line.match(/from\s+['"]([^'"]+)['"]/)
      if (!m) continue
      const ok = m[1].startsWith('node:') || m[1].startsWith('.') || m[1].startsWith('/')
      expect(ok, `forbidden: ${m[1]}`).toBe(true)
    }
  })
})

describe('OP2.1 — arrival-curve primitives', () => {
  // 3. deterministicRandom in [0,1).
  it('deterministicRandom returns [0, 1)', () => {
    for (let i = 0; i < 50; i++) {
      const r = arrivalMod.deterministicRandom('seed', i)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThan(1)
    }
  })

  // 4. Determinism.
  it('deterministicRandom deterministic', () => {
    expect(arrivalMod.deterministicRandom('s', 1)).toBe(arrivalMod.deterministicRandom('s', 1))
  })

  // 5. Different seeds → different outputs.
  it('different seeds → different outputs', () => {
    const a = arrivalMod.deterministicRandom('a', 0)
    const b = arrivalMod.deterministicRandom('b', 0)
    expect(a).not.toBe(b)
  })

  // 6. pickDelayHours boundary at 0.
  it('pickDelayHours at r=0 returns 0', () => {
    const buckets = [{ upToHours: 1, share: 0.1 }, { upToHours: 24, share: 1 }]
    expect(arrivalMod.pickDelayHours(buckets, 0)).toBe(0)
  })

  // 7. pickDelayHours boundary at near-1.
  it('pickDelayHours at r→1 returns max', () => {
    const buckets = [{ upToHours: 1, share: 0.1 }, { upToHours: 24, share: 1 }]
    expect(arrivalMod.pickDelayHours(buckets, 0.999999)).toBeLessThanOrEqual(24)
  })

  // 8. pickCategory returns valid category.
  it('pickCategory returns string from weights', () => {
    const w = { interested: 0.5, ooo: 0.5 }
    const cat = arrivalMod.pickCategory(w, 0.3)
    expect(['interested', 'ooo']).toContain(cat)
  })
})

describe('OP2.1 — generateCurve', () => {
  // 9. Returns N items.
  it('returns campaignSize items', () => {
    const c = arrivalMod.generateCurve({ campaignSize: 17, durationH: 24 })
    expect(c.length).toBe(17)
  })

  // 10. Sorted by delay_ms ascending.
  it('sorted ascending by delay_ms', () => {
    const c = arrivalMod.generateCurve({ campaignSize: 50, durationH: 24 })
    for (let i = 1; i < c.length; i++) {
      expect(c[i].delay_ms).toBeGreaterThanOrEqual(c[i - 1].delay_ms)
    }
  })

  // 11. Each entry has required fields.
  it('entries have delay_ms + fixture_category + index', () => {
    const c = arrivalMod.generateCurve({ campaignSize: 5, durationH: 24 })
    for (const e of c) {
      expect(e).toHaveProperty('delay_ms')
      expect(e).toHaveProperty('fixture_category')
      expect(e).toHaveProperty('index')
    }
  })

  // 12. Deterministic with same seed.
  it('same seed → identical output', () => {
    const a = arrivalMod.generateCurve({ campaignSize: 10, durationH: 24, seed: 's' })
    const b = arrivalMod.generateCurve({ campaignSize: 10, durationH: 24, seed: 's' })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  // 13. Different seeds → different output.
  it('different seed → different output', () => {
    const a = arrivalMod.generateCurve({ campaignSize: 10, durationH: 24, seed: 'a' })
    const b = arrivalMod.generateCurve({ campaignSize: 10, durationH: 24, seed: 'b' })
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  // 14. Respects durationH cap (no entry > durationH * 1h).
  it('all delays <= durationH * 3600 * 1000', () => {
    const c = arrivalMod.generateCurve({ campaignSize: 50, durationH: 1 })
    for (const e of c) {
      expect(e.delay_ms).toBeLessThanOrEqual(60 * 60 * 1000)
    }
  })

  // 15. Throws on invalid campaignSize.
  it('throws on campaignSize <= 0', () => {
    expect(() => arrivalMod.generateCurve({ campaignSize: 0, durationH: 24 })).toThrow()
    expect(() => arrivalMod.generateCurve({ campaignSize: -5, durationH: 24 })).toThrow()
  })

  // 16. Throws on invalid durationH.
  it('throws on durationH <= 0', () => {
    expect(() => arrivalMod.generateCurve({ campaignSize: 10, durationH: 0 })).toThrow()
  })

  // 17. Categories sampled from CATEGORIES set.
  it('categories from valid set', () => {
    const c = arrivalMod.generateCurve({ campaignSize: 100, durationH: 24 })
    const cats = ['interested', 'not-interested', 'ooo', 'wrong-person', 'spam', 'ambiguous']
    for (const e of c) expect(cats).toContain(e.fixture_category)
  })
})

describe('OP2.2 — replay-campaign.sh', () => {
  // 18. File exists + executable.
  it('replay-campaign.sh exists + executable', () => {
    expect(existsSync(REPLAY)).toBe(true)
    expect(statSync(REPLAY).mode & 0o111).toBeGreaterThan(0)
  })

  const bash = readFileSync(REPLAY, 'utf8')

  // 19. set -euo pipefail.
  it('uses set -euo pipefail', () => {
    expect(bash).toMatch(/set -euo pipefail/)
  })

  // 20. Supports --accel flag.
  it('supports --accel', () => {
    expect(bash).toMatch(/--accel/)
    expect(bash).toMatch(/ACCEL=/)
  })

  // 21. Supports --dry-run.
  it('supports --dry-run', () => {
    expect(bash).toMatch(/--dry-run/)
    expect(bash).toMatch(/DRY_RUN=/)
  })

  // 22. Refuses missing positional args.
  it('refuses missing positional args', () => {
    expect(bash).toMatch(/-z\s+"\$CURVE"/)
    expect(bash).toMatch(/-z\s+"\$MAILBOX"/)
  })

  // 23. Sleep is acceleration-aware.
  it('sleep computation divides gap by accel', () => {
    // Post self-review (#268): SLEEP_MS computed via awk in milliseconds,
    // slept via node setTimeout (portable across BSD/GNU/busybox).
    expect(bash).toMatch(/awk.*g\s*\/\s*a/)
  })

  // 23a. Uses portable node setTimeout instead of bash sleep (HIGH fix).
  it('uses node setTimeout for portable fractional sleep', () => {
    expect(bash).toMatch(/setTimeout/)
    expect(bash).not.toMatch(/^\s*sleep\s+"\$SLEEP_S"/m)
  })

  // 23b. Validates mailbox to prevent shell injection (CRITICAL fix).
  it('validates mailbox against injection chars', () => {
    expect(bash).toMatch(/\^\[a-zA-Z0-9\._@\+\-\]\+\$/)
  })

  // 23c. Passes curve path via env var, not string interpolation (CRITICAL fix).
  it('passes curve path via env var, not shell interpolation', () => {
    expect(bash).toMatch(/CURVE_PATH=.*node -e/)
    expect(bash).toMatch(/process\.env\.CURVE_PATH/)
  })

  // 24. Honors LAB_IMAP_HOST + PORT env.
  it('passes LAB_IMAP_HOST + LAB_IMAP_PORT to seed-replies', () => {
    expect(bash).toMatch(/LAB_IMAP_HOST/)
    expect(bash).toMatch(/LAB_IMAP_PORT/)
  })

  // 25. Refuses non-dry-run without password.
  it('refuses non-dry-run without password', () => {
    expect(bash).toMatch(/--password.*LAB_OPERATOR_PASSWORD/i)
  })
})

describe('OP2.4 — clear-inbox', () => {
  // 26. Both entrypoints exist + executable.
  it('clear-inbox node + bash exist + executable', () => {
    expect(existsSync(CLEAR_NODE)).toBe(true)
    expect(existsSync(CLEAR_BASH)).toBe(true)
    expect(statSync(CLEAR_NODE).mode & 0o111).toBeGreaterThan(0)
    expect(statSync(CLEAR_BASH).mode & 0o111).toBeGreaterThan(0)
  })

  // 27. parseArgs defaults.
  it('parseArgs returns sane defaults', () => {
    const a = clearMod.parseArgs(['node', 'x'])
    expect(a.host).toBe('localhost')
    expect(a.port).toBe(25993)
    expect(a.tls).toBe(true)
    expect(a.folder).toBe('INBOX')
  })

  // 28. parseArgs honors --confirm.
  it('parseArgs honors --confirm', () => {
    const a = clearMod.parseArgs(['node', 'x', '--confirm', 'X'])
    expect(a.confirm).toBe('X')
  })

  // 29. HARD_CONFIRM exported.
  it('exports HARD_CONFIRM constant', () => {
    expect(clearMod.HARD_CONFIRM).toMatch(/I-KNOW-THIS-WIPES-INBOX/)
  })

  // 30. IMAPSession class exported.
  it('exports IMAPSession class', () => {
    expect(typeof clearMod.IMAPSession).toBe('function')
  })

  // 31. IMAPSession tags increment.
  it('IMAPSession tag numbering increments', () => {
    const s = new clearMod.IMAPSession({ host: 'x', port: 0, tls: false, mailbox: '', password: '' })
    expect(s._nextTag()).toBe('A0001')
    expect(s._nextTag()).toBe('A0002')
  })

  // 32. Bash wrapper uses set -euo pipefail.
  it('bash wrapper uses set -euo pipefail', () => {
    const b = readFileSync(CLEAR_BASH, 'utf8')
    expect(b).toMatch(/set -euo pipefail/)
  })

  // 33. Bash wrapper exposes LAB_IMAP_HOST + LAB_IMAP_PORT.
  it('bash wrapper honors LAB_IMAP_HOST + LAB_IMAP_PORT', () => {
    const b = readFileSync(CLEAR_BASH, 'utf8')
    expect(b).toMatch(/LAB_IMAP_HOST/)
    expect(b).toMatch(/LAB_IMAP_PORT/)
  })

  // 34. Bash wrapper requires positional mailbox.
  it('bash wrapper requires positional mailbox', () => {
    const b = readFileSync(CLEAR_BASH, 'utf8')
    expect(b).toMatch(/MAILBOX="\$1"/)
  })

  // 35. Source explicitly enforces hard-confirm safety gate.
  it('clear-inbox.mjs enforces --confirm safety gate', () => {
    const src = readFileSync(CLEAR_NODE, 'utf8')
    expect(src).toMatch(/HARD_CONFIRM|safety gate/i)
  })
})
