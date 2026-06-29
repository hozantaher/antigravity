import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

// Backs the DoD criterion i18n/key-completeness (i18n:check). Project policy (CLAUDE.md): all 12
// locales are held complete — a new key goes into every file. This asserts that strictly: every
// locale must contain the full union of keys seen across all locales. Missing keys = a drift.
const LOCALES_DIR = join(process.cwd(), 'features/platform/i18n/locales')

const flatten = (obj: unknown, prefix = ''): string[] => {
  if (obj === null || typeof obj !== 'object') return prefix ? [prefix] : []
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? flatten(v, key) : [key]
  })
}

const loadKeys = (code: string): Set<string> =>
  new Set(flatten(parse(readFileSync(join(LOCALES_DIR, `${code}.yml`), 'utf8'))))

describe('i18n key-completeness across all locales', () => {
  const codes = readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith('.yml'))
    .map((f) => f.replace('.yml', ''))
  const union = new Set(codes.flatMap((c) => [...loadKeys(c)]))

  it('has all 12 locales present', () => {
    expect(codes.length).toBe(12)
  })

  it.each(codes)('locale %s contains every key in the union', (code) => {
    const keys = loadKeys(code)
    const missing = [...union].filter((k) => !keys.has(k)).sort()
    expect(missing, `${code} missing ${missing.length} key(s)`).toEqual([])
  })
})
