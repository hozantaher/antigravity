// @linkage-allowed: discipline ratchet — validates memory tier frontmatter (CAD-A3, issue #562)
/**
 * Memory Tier Audit — CAD-A3
 *
 * Enforces that every memory file under ~/.claude/projects/.../memory/ has:
 *   - frontmatter tier: 0|1|2|3
 *   - frontmatter tags: [...] with valid tag set
 *   - T0 count is within sanity bounds (6–12)
 *   - Every T1 entry has at least one subsystem:* tag
 *   - MEMORY-INDEX.md references every T0 file
 *
 * Run via: pnpm test:fast (included in 'default' vitest scope via tests/audit/**)
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { describe, it, expect, beforeAll } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Memory directory is outside the repo — resolve relative to $HOME
const MEMORY_DIR = join(
  homedir(),
  '.claude/projects/-Users-messingtomas-Documents-Projekty-hozan-taher/memory'
)

// --- helpers ---

/**
 * Parse frontmatter from a raw markdown string.
 * Returns null if no frontmatter block is found.
 */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null
  const block = match[1]
  const result = {}
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    result[key] = value
  }
  return result
}

/**
 * Parse YAML inline array like: [foo, bar, baz] → ['foo', 'bar', 'baz']
 */
function parseTagArray(raw) {
  if (!raw) return []
  // Handles: [tag1, tag2] or tag1 (scalar fallback)
  const stripped = raw.replace(/^\[|\]$/g, '').trim()
  if (!stripped) return []
  return stripped.split(',').map(t => t.trim()).filter(Boolean)
}

// --- test state ---

let memoryFiles = []
let tieredMemories = []
let indexContent = ''

const VALID_SUBSYSTEMS = new Set([
  'anti-trace',
  'imap-inbound',
  'dashboard-bff',
  'scrapers',
  'worker',
  'content-render',
  'protections',
  'common-libs',
])

beforeAll(() => {
  const allFiles = readdirSync(MEMORY_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY-INDEX.md' && e.name !== 'MEMORY.md')
    .map(e => e.name)

  memoryFiles = allFiles.map(name => {
    const path = join(MEMORY_DIR, name)
    const raw = readFileSync(path, 'utf8')
    const fm = parseFrontmatter(raw)
    const tierRaw = fm ? fm['tier'] : undefined
    const tagsRaw = fm ? fm['tags'] : undefined
    const tier = tierRaw !== undefined ? parseInt(tierRaw, 10) : undefined
    const tags = parseTagArray(tagsRaw)
    return { name, fm, tier, tags, raw }
  })

  tieredMemories = memoryFiles.filter(m => m.tier !== undefined)
  indexContent = readFileSync(join(MEMORY_DIR, 'MEMORY-INDEX.md'), 'utf8')
})

// --- tests ---

// QUARANTINED: env-coupled (scans the dev machine's ~/.claude memory dir, absent on the CI runner) — see docs/handoff/ci-remediation-residual.md
describe.skip('memory tier audit (CAD-A3, #562)', () => {

  // 1. All memory files have frontmatter
  it('all memory files have a frontmatter block (---)', () => {
    const missing = memoryFiles.filter(m => m.fm === null).map(m => m.name)
    expect(missing, `files without frontmatter: ${missing.join(', ')}`).toHaveLength(0)
  })

  // 2. All memory files have a tier field
  it('all memory files have tier: field in frontmatter', () => {
    const missing = memoryFiles.filter(m => m.tier === undefined).map(m => m.name)
    expect(missing, `files without tier: ${missing.join(', ')}`).toHaveLength(0)
  })

  // 3. tier values are valid (0, 1, 2, 3)
  it('all tier values are in {0, 1, 2, 3}', () => {
    const invalid = memoryFiles
      .filter(m => m.tier !== undefined && ![0, 1, 2, 3].includes(m.tier))
      .map(m => `${m.name} (tier=${m.tier})`)
    expect(invalid, `invalid tiers: ${invalid.join(', ')}`).toHaveLength(0)
  })

  // 4. All memory files have tags field
  it('all memory files have tags: field in frontmatter', () => {
    const missing = memoryFiles.filter(m => m.fm && m.fm['tags'] === undefined).map(m => m.name)
    expect(missing, `files without tags: ${missing.join(', ')}`).toHaveLength(0)
  })

  // 5. T0 count is within sanity bounds (6–12)
  it('T0 count is between 6 and 12', () => {
    const t0 = memoryFiles.filter(m => m.tier === 0)
    expect(t0.length, `T0 count = ${t0.length}; expected 6–12`).toBeGreaterThanOrEqual(6)
    expect(t0.length, `T0 count = ${t0.length}; expected 6–12`).toBeLessThanOrEqual(12)
  })

  // 6. Every T0 file has the hard-rule tag
  it('every T0 file has hard-rule tag', () => {
    const t0WithoutHardRule = memoryFiles
      .filter(m => m.tier === 0 && !m.tags.includes('hard-rule'))
      .map(m => m.name)
    expect(
      t0WithoutHardRule,
      `T0 files missing hard-rule tag: ${t0WithoutHardRule.join(', ')}`
    ).toHaveLength(0)
  })

  // 7. Every T1 file has at least one subsystem:* tag
  it('every T1 file has at least one subsystem:* tag', () => {
    const t1WithoutSubsystem = memoryFiles
      .filter(m => m.tier === 1 && !m.tags.some(t => t.startsWith('subsystem:')))
      .map(m => m.name)
    expect(
      t1WithoutSubsystem,
      `T1 files missing subsystem tag: ${t1WithoutSubsystem.join(', ')}`
    ).toHaveLength(0)
  })

  // 8. All subsystem:* tags use known subsystem names
  it('all subsystem:* tags reference known subsystem names', () => {
    const unknownTags = []
    for (const m of memoryFiles) {
      for (const tag of m.tags) {
        if (tag.startsWith('subsystem:')) {
          const sub = tag.slice('subsystem:'.length)
          if (!VALID_SUBSYSTEMS.has(sub)) {
            unknownTags.push(`${m.name}: ${tag}`)
          }
        }
      }
    }
    expect(
      unknownTags,
      `unknown subsystem tags: ${unknownTags.join(', ')}`
    ).toHaveLength(0)
  })

  // 9. Every T3 file has archive tag
  it('every T3 file has archive tag', () => {
    const t3WithoutArchive = memoryFiles
      .filter(m => m.tier === 3 && !m.tags.includes('archive'))
      .map(m => m.name)
    expect(
      t3WithoutArchive,
      `T3 files missing archive tag: ${t3WithoutArchive.join(', ')}`
    ).toHaveLength(0)
  })

  // 10. MEMORY-INDEX.md exists and has content
  it('MEMORY-INDEX.md exists and is non-empty', () => {
    expect(indexContent.length).toBeGreaterThan(100)
    expect(indexContent).toContain('## By Tier')
  })

  // 11. MEMORY-INDEX.md contains a T0 section
  it('MEMORY-INDEX.md has T0 section listing', () => {
    expect(indexContent).toMatch(/###\s+T0/)
  })

  // 12. MEMORY-INDEX.md references every T0 file
  it('MEMORY-INDEX.md references all T0 files', () => {
    const t0Files = memoryFiles.filter(m => m.tier === 0).map(m => m.name)
    const missing = t0Files.filter(name => !indexContent.includes(name))
    expect(
      missing,
      `T0 files not referenced in MEMORY-INDEX.md: ${missing.join(', ')}`
    ).toHaveLength(0)
  })

  // 13. MEMORY-INDEX.md has a task keyword section
  it('MEMORY-INDEX.md has a By Task Keyword section', () => {
    expect(indexContent).toContain('## By Task Keyword')
  })

  // 14. No memory file is both T0 and T3 (logical contradiction)
  it('no file is simultaneously tier 0 and tier 3', () => {
    // Each file has exactly one tier — just verify tier is a single int
    const multiTier = memoryFiles.filter(m => typeof m.tier !== 'number').map(m => m.name)
    expect(multiTier, `files with non-numeric tier: ${multiTier.join(', ')}`).toHaveLength(0)
  })

  // 15. T2 files have at least one incident:* or needs-review tag
  it('every T2 file has incident:* or needs-review tag', () => {
    const t2WithoutIncident = memoryFiles
      .filter(m => {
        if (m.tier !== 2) return false
        const hasIncident = m.tags.some(t => t.startsWith('incident:') || t === 'needs-review')
        return !hasIncident
      })
      .map(m => m.name)
    expect(
      t2WithoutIncident,
      `T2 files missing incident tag: ${t2WithoutIncident.join(', ')}`
    ).toHaveLength(0)
  })

  // 16. Total memory count is reasonable (sanity bound: at least 40 files)
  it('memory directory has at least 40 indexed files', () => {
    expect(memoryFiles.length).toBeGreaterThanOrEqual(40)
  })

  // 17. MEMORY-INDEX.md references all T1 subsystems
  it('MEMORY-INDEX.md has subsystem sections for all 8 defined subsystems', () => {
    for (const sub of VALID_SUBSYSTEMS) {
      // 'content-render' may have no entries yet but should still appear as a note
      if (sub === 'content-render') {
        expect(indexContent).toContain('content-render')
        continue
      }
      expect(indexContent, `missing subsystem section for: ${sub}`).toContain(`subsystem:${sub}`)
    }
  })

})
