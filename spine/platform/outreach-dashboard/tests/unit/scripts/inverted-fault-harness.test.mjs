// A2 — inverted-fault harness: source transformer + classifier tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  invertMockFactories,
  classifyResults,
  writeShadowFile,
} from '../../../scripts/inverted-fault-harness.mjs'

let TMP

beforeEach(() => {
  TMP = join(tmpdir(), `inv-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(TMP, { recursive: true })
})

afterEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
})

describe('invertMockFactories', () => {
  it('T-1: replaces vi.mock factory with throwing one', () => {
    const src = `vi.mock('foo', () => ({ default: () => 'real' }))`
    const out = invertMockFactories(src)
    expect(out).toContain('__INVERTED_FAULT__')
    expect(out).toContain('vi.mock(')
  })

  it('T-2: preserves the mocked path string', () => {
    const src = `vi.mock('../../../src/store', () => ({}))`
    const out = invertMockFactories(src)
    expect(out).toContain("'../../../src/store'")
  })

  it('T-3: handles double-quoted paths', () => {
    const src = `vi.mock("foo", () => ({}))`
    const out = invertMockFactories(src)
    expect(out).toContain('"foo"')
    expect(out).toContain('__INVERTED_FAULT__')
  })

  it('T-4: handles backtick-quoted paths', () => {
    const src = 'vi.mock(`foo`, () => ({}))'
    const out = invertMockFactories(src)
    expect(out).toContain('`foo`')
    expect(out).toContain('__INVERTED_FAULT__')
  })

  it('T-5: leaves non-mock code unchanged', () => {
    const src = `const x = 1\nfunction f() { return 2 }`
    expect(invertMockFactories(src)).toBe(src)
  })

  it('T-6: handles multiple vi.mock calls in one file', () => {
    const src = `
      vi.mock('foo', () => ({}))
      vi.mock('bar', () => ({}))
    `
    const out = invertMockFactories(src)
    const matches = out.match(/__INVERTED_FAULT__/g)
    expect(matches.length).toBe(2)
  })

  it('T-7: preserves imports / other code surrounding the mocks', () => {
    const src = `
      import { vi } from 'vitest'
      vi.mock('foo', () => ({}))
      describe('block', () => { it('a', () => {}) })
    `
    const out = invertMockFactories(src)
    expect(out).toContain("import { vi } from 'vitest'")
    expect(out).toContain("describe('block'")
    expect(out).toContain('__INVERTED_FAULT__')
  })

  it('T-8: handles factories with nested object literals + functions', () => {
    const src = `vi.mock('foo', () => ({ default: vi.fn(), helper: () => ({ a: 1 }) }))`
    const out = invertMockFactories(src)
    expect(out).toContain('__INVERTED_FAULT__')
    // The nested () should not leak the outer parens
    expect(out).toMatch(/vi\.mock\([^)]+\)/)
  })

  it('T-9: vi.mock without factory is left intact (auto-mock)', () => {
    const src = `vi.mock('foo')`
    const out = invertMockFactories(src)
    expect(out).toContain("vi.mock('foo')")
  })

  it('T-10: handles factories spanning multiple lines', () => {
    const src = `
      vi.mock('foo', () => ({
        default: vi.fn(),
        helper: () => 42,
      }))
    `
    const out = invertMockFactories(src)
    expect(out).toContain('__INVERTED_FAULT__')
  })

  it('T-10b: preserves closing paren of vi.mock call', () => {
    const src = `vi.mock('foo', () => ({ default: vi.fn() }))`
    const out = invertMockFactories(src)
    // Output must still end with )) to balance vi.mock(
    expect(out).toMatch(/\)$/)
    // No unbalanced parens
    const opens = (out.match(/\(/g) || []).length
    const closes = (out.match(/\)/g) || []).length
    expect(opens).toBe(closes)
  })

  it('T-10c: preserves balance for multi-mock files', () => {
    const src = `
      vi.mock('a', () => ({}))
      vi.mock('b', () => ({ default: vi.fn() }))
      vi.mock('c', () => ({ x: 1, y: 2 }))
    `
    const out = invertMockFactories(src)
    const opens = (out.match(/\(/g) || []).length
    const closes = (out.match(/\)/g) || []).length
    expect(opens).toBe(closes)
  })
})

describe('classifyResults', () => {
  function mkReport(tests) {
    return {
      testResults: [
        {
          name: 'test.js',
          assertionResults: tests.map(([fullName, status]) => ({ fullName, status })),
        },
      ],
    }
  }

  it('T-11: pass→pass classifies as no-signal', () => {
    const o = mkReport([['x', 'passed']])
    const i = mkReport([['x', 'passed']])
    const r = classifyResults(o, i)
    expect(r[0]).toMatchObject({ kind: 'no-signal' })
  })

  it('T-12: pass→fail classifies as good-signal', () => {
    const o = mkReport([['x', 'passed']])
    const i = mkReport([['x', 'failed']])
    const r = classifyResults(o, i)
    expect(r[0]).toMatchObject({ kind: 'good-signal' })
  })

  it('T-13: pass→missing classifies as inconclusive', () => {
    const o = mkReport([['x', 'passed']])
    const i = mkReport([])
    const r = classifyResults(o, i)
    expect(r[0]).toMatchObject({ kind: 'inconclusive' })
  })

  it('T-14: failed-original tests are skipped from classification', () => {
    const o = mkReport([['x', 'failed']])
    const i = mkReport([['x', 'failed']])
    const r = classifyResults(o, i)
    expect(r).toEqual([])
  })

  it('T-15: handles missing reports gracefully', () => {
    expect(classifyResults({}, {})).toEqual([])
    expect(classifyResults(null, null)).toEqual([])
  })

  it('T-16: multiple tests classified independently', () => {
    const o = mkReport([['a', 'passed'], ['b', 'passed'], ['c', 'passed']])
    const i = mkReport([['a', 'passed'], ['b', 'failed'], ['c', 'failed']])
    const r = classifyResults(o, i)
    const byName = Object.fromEntries(r.map(x => [x.name.split('::').pop(), x.kind]))
    expect(byName.a).toBe('no-signal')
    expect(byName.b).toBe('good-signal')
    expect(byName.c).toBe('good-signal')
  })
})

describe('runVitestJson — integration sanity', () => {
  // We don't actually invoke vitest here (would be recursive and slow);
  // instead we verify the export surface + handle empty-file-list path.
  it('T-19: returns empty testResults for empty file list', async () => {
    const { runVitestJson } = await import('../../../scripts/inverted-fault-harness.mjs')
    const r = await runVitestJson([])
    expect(r).toHaveProperty('testResults')
    expect(r.testResults).toEqual([])
  })

  it('T-20: function signature accepts options object', async () => {
    const { runVitestJson } = await import('../../../scripts/inverted-fault-harness.mjs')
    expect(runVitestJson.length).toBeGreaterThanOrEqual(1)
    expect(typeof runVitestJson).toBe('function')
  })
})

describe('writeShadowFile', () => {
  // Use synthetic file extensions (.fixture.js / .fixture.jsx) so that even
  // if a stray file leaks under the project's tests/ root, vitest's glob
  // won't pick it up as a test file.
  it('T-17: writes inverted source to shadow path', () => {
    const original = '/Users/messingtomas/Documents/Projekty/hozan-taher/features/platform/outreach-dashboard/tests/unit/x.fixture.js'
    const src = `vi.mock('foo', () => ({}))`
    const dst = writeShadowFile(original, src, TMP)
    expect(existsSync(dst)).toBe(true)
    expect(readFileSync(dst, 'utf8')).toContain('__INVERTED_FAULT__')
  })

  it('T-18: preserves directory structure relative to ROOT', () => {
    const original = '/Users/messingtomas/Documents/Projekty/hozan-taher/features/platform/outreach-dashboard/tests/unit/components/X.fixture.jsx'
    const src = `vi.mock('foo', () => ({}))`
    const dst = writeShadowFile(original, src, TMP)
    expect(dst).toContain('tests/unit/components/X.fixture.jsx')
  })
})
