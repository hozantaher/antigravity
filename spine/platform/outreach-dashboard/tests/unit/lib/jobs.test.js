import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createJob, updateJob, getJob, runJob, listJobs, __resetJobsForTest } from '../../../src/lib/jobs'

beforeEach(() => {
  __resetJobsForTest()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createJob / getJob / updateJob', () => {
  it('creates a queued job with progress 0/0', () => {
    const job = createJob('bulk-check', { ids: [1, 2, 3] })
    expect(job.status).toBe('queued')
    expect(job.progress).toEqual({ current: 0, total: 0 })
    expect(job.meta).toEqual({ ids: [1, 2, 3] })
    expect(job.id).toMatch(/^job-/)
  })

  it('getJob returns null for unknown id', () => {
    expect(getJob('nope')).toBeNull()
  })

  it('updateJob merges patch + bumps updated_at', async () => {
    const job = createJob('x')
    const before = job.updated_at
    await new Promise(r => setTimeout(r, 2))
    const updated = updateJob(job.id, { status: 'running' })
    expect(updated.status).toBe('running')
    expect(updated.updated_at > before).toBe(true)
  })
})

describe('runJob', () => {
  it('transitions queued → running → done on success', async () => {
    const job = runJob('sum', async ({ setProgress, setResult }) => {
      setProgress(0, 2)
      setProgress(1, 2)
      setProgress(2, 2)
      setResult({ total: 42 })
    })
    await vi.waitFor(() => expect(getJob(job.id).status).toBe('done'))
    const final = getJob(job.id)
    expect(final.progress).toEqual({ current: 2, total: 2 })
    expect(final.result).toEqual({ total: 42 })
    expect(final.finished_at).toBeTruthy()
    expect(final.error).toBeNull()
  })

  it('transitions to failed on thrown error', async () => {
    const job = runJob('bad', async () => {
      throw new Error('oops')
    })
    await vi.waitFor(() => expect(getJob(job.id).status).toBe('failed'))
    expect(getJob(job.id).error).toBe('oops')
    expect(getJob(job.id).finished_at).toBeTruthy()
  })

  it('running job has started_at before finished_at', async () => {
    const job = runJob('t', async () => {})
    await vi.waitFor(() => expect(getJob(job.id).status).toBe('done'))
    const j = getJob(job.id)
    expect(Date.parse(j.started_at)).toBeLessThanOrEqual(Date.parse(j.finished_at))
  })
})

describe('listJobs', () => {
  it('returns jobs sorted newest-first', async () => {
    createJob('a')
    await new Promise(r => setTimeout(r, 2))
    createJob('b')
    await new Promise(r => setTimeout(r, 2))
    createJob('c')
    const all = listJobs()
    expect(all.map(j => j.label)).toEqual(['c', 'b', 'a'])
  })
})
