// A5 — prod-snapshot-capture: sanitize + filename + load tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  sanitize,
  endpointToFilename,
  loadSnapshot,
  listSnapshots,
} from '../../../scripts/prod-snapshot-capture.mjs'

let TMP

beforeEach(() => {
  TMP = join(tmpdir(), `snap-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(TMP, { recursive: true })
})

afterEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
})

describe('sanitize — unstable field replacement', () => {
  it('T-1: replaces id with placeholder', () => {
    const r = sanitize({ id: 42, name: 'foo' })
    expect(r.id).toBe('<sanitized:id>')
    expect(r.name).toBe('foo')
  })

  it('T-2: replaces created_at + updated_at', () => {
    const r = sanitize({ created_at: '2026-04-26T10:00:00Z', updated_at: '2026-04-26T11:00:00Z' })
    expect(r.created_at).toContain('sanitized:created_at')
    expect(r.updated_at).toContain('sanitized:updated_at')
  })

  it('T-3: replaces ISO-timestamp values even on unknown keys', () => {
    const r = sanitize({ some_date: '2026-04-26T10:00:00Z' })
    expect(r.some_date).toContain('sanitized:iso-timestamp')
  })

  it('T-4: keeps stable scalars unchanged', () => {
    const r = sanitize({ name: 'foo', count: 42, active: true })
    expect(r).toEqual({ active: true, count: 42, name: 'foo' })
  })

  it('T-5: recurses into nested objects', () => {
    const r = sanitize({ user: { id: 1, name: 'x' } })
    expect(r.user.id).toContain('sanitized')
    expect(r.user.name).toBe('x')
  })

  it('T-6: recurses into arrays', () => {
    const r = sanitize([{ id: 1 }, { id: 2 }])
    expect(r[0].id).toContain('sanitized')
    expect(r[1].id).toContain('sanitized')
  })

  it('T-7: handles null safely', () => {
    expect(sanitize(null)).toBe(null)
  })

  it('T-8: scalar input passes through', () => {
    expect(sanitize(42)).toBe(42)
    expect(sanitize('hi')).toBe('hi')
  })

  it('T-9: sorts keys for stable serialization', () => {
    const r = sanitize({ b: 1, a: 2 })
    expect(Object.keys(r)).toEqual(['a', 'b'])
  })

  it('T-10: ran_at + duration_ms + pid + last_send_at sanitized', () => {
    const r = sanitize({ ran_at: '...', duration_ms: 100, pid: 99, last_send_at: '...' })
    expect(r.ran_at).toContain('sanitized')
    expect(r.duration_ms).toContain('sanitized')
    expect(r.pid).toContain('sanitized')
    expect(r.last_send_at).toContain('sanitized')
  })
})

describe('endpointToFilename', () => {
  it('T-11: simple path → underscored basename', () => {
    expect(endpointToFilename('/api/health')).toBe('api__health.json')
  })

  it('T-12: nested path slashes → double-underscore', () => {
    expect(endpointToFilename('/api/health/system')).toBe('api__health__system.json')
  })

  it('T-13: query string preserved as suffix', () => {
    expect(endpointToFilename('/api/synthetic-runs?limit=10')).toBe('api__synthetic-runs__limit-10.json')
  })

  it('T-14: leading slash stripped', () => {
    expect(endpointToFilename('/api/x')).not.toMatch(/^_/)
  })

  it('T-15: multiple query params handled', () => {
    expect(endpointToFilename('/api/foo?a=1&b=2')).toBe('api__foo__a-1-b-2.json')
  })
})

describe('loadSnapshot + listSnapshots', () => {
  it('T-16: loadSnapshot returns null when file missing', () => {
    const r = loadSnapshot('/api/missing', TMP)
    expect(r).toBe(null)
  })

  it('T-17: loadSnapshot returns parsed JSON when file exists', () => {
    const file = join(TMP, endpointToFilename('/api/health'))
    writeFileSync(file, JSON.stringify({ endpoint: '/api/health', shape: { ok: true } }))
    const r = loadSnapshot('/api/health', TMP)
    expect(r.endpoint).toBe('/api/health')
    expect(r.shape).toEqual({ ok: true })
  })

  it('T-18: listSnapshots returns json files only', () => {
    writeFileSync(join(TMP, 'a.json'), '{}')
    writeFileSync(join(TMP, 'b.json'), '{}')
    writeFileSync(join(TMP, 'c.txt'), 'noise')
    const list = listSnapshots(TMP)
    expect(list.sort()).toEqual(['a.json', 'b.json'])
  })

  it('T-19: listSnapshots returns empty when dir missing', () => {
    const list = listSnapshots(join(TMP, 'no-such-subdir'))
    expect(list).toEqual([])
  })

  it('T-20: round-trip preserves sanitized shape', () => {
    const data = { id: 1, name: 'x', created_at: '2026-04-26T10:00:00Z' }
    const sanitized = sanitize(data)
    const file = join(TMP, endpointToFilename('/api/round-trip'))
    writeFileSync(file, JSON.stringify({ endpoint: '/api/round-trip', shape: sanitized }))
    const loaded = loadSnapshot('/api/round-trip', TMP)
    expect(loaded.shape).toEqual(sanitized)
    expect(loaded.shape.id).toContain('sanitized')
  })
})
