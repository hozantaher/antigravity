import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '~/server/utils/db'
import { withJobRun, listLatestJobRunPerJob, listRecentJobRuns } from '~/server/repos/jobRunRepo'
import { writeAudit } from '~/server/repos/auditRepo'

const RUN = !!process.env.POSTGRES_URL

const cleanup = async () => {
  await db.deleteFrom('jobRuns').where('job', 'like', 'itest-%').execute()
  await db.deleteFrom('auditLog').where('entity', 'like', 'itest-%').execute()
}

describe.skipIf(!RUN)('jobRunRepo + auditRepo (Postgres)', () => {
  beforeAll(cleanup)
  afterAll(cleanup)

  it('records a successful job run with counts', async () => {
    const res = await withJobRun('itest-job-ok', async () => ({ processed: 3, sold: 1 }))
    expect(res).toEqual({ processed: 3, sold: 1 })
    const latest = (await listLatestJobRunPerJob()).find(r => r.job === 'itest-job-ok')
    expect(latest?.ok).toBe(true)
    expect(latest?.counts).toEqual({ processed: 3, sold: 1 })
    expect(latest?.finishedAt).toBeTypeOf('number')
  })

  it('records a failed job run and re-throws', async () => {
    await expect(
      withJobRun('itest-job-fail', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const latest = (await listLatestJobRunPerJob()).find(r => r.job === 'itest-job-fail')
    expect(latest?.ok).toBe(false)
    expect(latest?.error).toContain('boom')
    expect(latest?.counts).toBeNull()
  })

  it('lists recent runs newest first', async () => {
    await withJobRun('itest-job-ok', async () => ({ n: 1 }))
    const recent = await listRecentJobRuns(50)
    const mine = recent.filter(r => r.job.startsWith('itest-'))
    expect(mine.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < mine.length; i++) {
      const prev = mine[i - 1]!
      const cur = mine[i]!
      expect(prev.startedAt).toBeGreaterThanOrEqual(cur.startedAt)
    }
  })

  it('writes an audit row with jsonb after-snapshot', async () => {
    await writeAudit({ actorId: null, action: 'itest.audit', entity: 'itest-entity', entityId: 'x1', after: { a: 1 } })
    const row = await db.selectFrom('auditLog').selectAll().where('entity', '=', 'itest-entity').executeTakeFirst()
    expect(row?.action).toBe('itest.audit')
    expect(row?.entityId).toBe('x1')
    expect(row?.after).toEqual({ a: 1 })
  })
})
