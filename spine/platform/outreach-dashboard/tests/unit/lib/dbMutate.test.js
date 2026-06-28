import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { dbMutate, dbMutateDetached, getWriteFailures, clearWriteFailures } from '../../../src/lib/dbMutate'

beforeEach(() => {
  clearWriteFailures()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('dbMutate', () => {
  it('resolves through on success and does not record failure', async () => {
    const result = await dbMutate(Promise.resolve({ rowCount: 1 }), { label: 'x' })
    expect(result).toEqual({ rowCount: 1 })
    expect(getWriteFailures()).toHaveLength(0)
  })

  it('records + re-throws on failure', async () => {
    const err = Object.assign(new Error('dup'), { code: '23505' })
    await expect(dbMutate(Promise.reject(err), { label: 'insert-mb', target: 42 })).rejects.toThrow('dup')
    const failures = getWriteFailures()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ label: 'insert-mb', target: 42, error: 'dup', code: '23505' })
    expect(console.error).toHaveBeenCalled()
  })

  it('preserves FIFO ring buffer order (newest first)', async () => {
    for (let i = 0; i < 3; i++) {
      await dbMutate(Promise.reject(new Error(`e${i}`)), { label: `l${i}` }).catch(() => {})
    }
    const failures = getWriteFailures()
    expect(failures.map(f => f.label)).toEqual(['l2', 'l1', 'l0'])
  })

  it('caps ring buffer at 100 entries', async () => {
    for (let i = 0; i < 110; i++) {
      await dbMutate(Promise.reject(new Error('e')), { label: 'x' }).catch(() => {})
    }
    expect(getWriteFailures()).toHaveLength(100)
  })
})

describe('dbMutateDetached', () => {
  it('returns promise that resolves to null on failure (never throws)', async () => {
    const result = await dbMutateDetached(Promise.reject(new Error('boom')), { label: 'bg' })
    expect(result).toBeNull()
    expect(getWriteFailures()[0]).toMatchObject({ label: 'bg', error: 'boom' })
  })

  it('returns resolved value on success', async () => {
    const result = await dbMutateDetached(Promise.resolve('ok'), { label: 'bg' })
    expect(result).toBe('ok')
    expect(getWriteFailures()).toHaveLength(0)
  })
})
