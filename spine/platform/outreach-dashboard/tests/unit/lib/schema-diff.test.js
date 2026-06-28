import { describe, it, expect } from 'vitest'
import { quickCheck, diffManifests } from '../../../src/lib/schema-diff.js'

const col = (name, type, nullable = false) => ({ name, type, nullable })

const baseManifest = {
  manifest_hash: 'hash-A',
  tables: {
    users: { columns: [col('id', 'integer'), col('email', 'text')] },
    orders: { columns: [col('id', 'integer'), col('total', 'numeric')] },
  },
}

describe('quickCheck — hash-only fast path', () => {
  it('true only when both hashes present and equal', () => {
    expect(quickCheck({ manifest_hash: 'x' }, { manifest_hash: 'x' })).toBe(true)
    expect(quickCheck({ manifest_hash: 'x' }, { manifest_hash: 'y' })).toBe(false)
  })

  it('false when either hash is missing or non-string', () => {
    expect(quickCheck({}, { manifest_hash: 'x' })).toBe(false)
    expect(quickCheck({ manifest_hash: 'x' }, {})).toBe(false)
    expect(quickCheck(null, undefined)).toBe(false)
    expect(quickCheck({ manifest_hash: 5 }, { manifest_hash: 5 })).toBe(false)
  })
})

describe('diffManifests — structural diff', () => {
  it('identical manifests → ok with empty drift', () => {
    const { ok, drift } = diffManifests(baseManifest, baseManifest)
    expect(ok).toBe(true)
    expect(drift.addedTables).toEqual([])
    expect(drift.removedTables).toEqual([])
    expect(drift.modifiedTables).toEqual([])
    expect(drift.hashMatch).toBe(true)
  })

  it('empty / null on both sides → ok', () => {
    expect(diffManifests(null, undefined).ok).toBe(true)
    expect(diffManifests({}, {}).ok).toBe(true)
  })

  it('reordered tables and columns produce no drift (canonical compare)', () => {
    const reordered = {
      manifest_hash: 'hash-A',
      tables: {
        orders: { columns: [col('total', 'numeric'), col('id', 'integer')] },
        users: { columns: [col('email', 'text'), col('id', 'integer')] },
      },
    }
    expect(diffManifests(baseManifest, reordered).ok).toBe(true)
  })

  it('detects an added table; symmetric with removed when swapped', () => {
    const withExtra = {
      ...baseManifest,
      tables: { ...baseManifest.tables, audit: { columns: [col('id', 'integer')] } },
    }
    const fwd = diffManifests(withExtra, baseManifest).drift
    expect(fwd.addedTables).toEqual(['audit'])
    expect(fwd.removedTables).toEqual([])

    const rev = diffManifests(baseManifest, withExtra).drift
    expect(rev.addedTables).toEqual([])
    expect(rev.removedTables).toEqual(['audit'])
  })

  it('detects added/removed columns within a shared table', () => {
    const changed = {
      tables: {
        users: { columns: [col('id', 'integer'), col('phone', 'text')] }, // email→phone
        orders: baseManifest.tables.orders,
      },
    }
    const { ok, drift } = diffManifests(changed, baseManifest)
    expect(ok).toBe(false)
    const mod = drift.modifiedTables.find((t) => t.name === 'users')
    expect(mod.addedCols).toEqual(['phone'])
    expect(mod.removedCols).toEqual(['email'])
  })

  it('detects a column type / nullability change', () => {
    const changed = {
      tables: {
        users: { columns: [col('id', 'bigint'), col('email', 'text', true)] },
        orders: baseManifest.tables.orders,
      },
    }
    const mod = diffManifests(changed, baseManifest).drift.modifiedTables.find((t) => t.name === 'users')
    const ids = mod.typeChanges.map((c) => c.name)
    expect(ids).toContain('id')
    expect(ids).toContain('email')
    const idChange = mod.typeChanges.find((c) => c.name === 'id')
    expect(idChange.baseline).toBe('integer NOT NULL')
    expect(idChange.current).toBe('bigint NOT NULL')
  })

  it('drops malformed columns (no name) without crashing', () => {
    const malformed = {
      tables: {
        users: { columns: [col('id', 'integer'), { type: 'text' }, null, col('email', 'text')] },
        orders: baseManifest.tables.orders,
      },
    }
    // The malformed entries are filtered out → users matches baseline → ok.
    expect(diffManifests(malformed, baseManifest).ok).toBe(true)
  })
})
