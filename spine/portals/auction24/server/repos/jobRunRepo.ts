import { db } from '../utils/db'
import { captureServerError } from '../utils/observability'

export interface JobRun {
  id: string
  job: string
  startedAt: number
  finishedAt: number | null
  ok: boolean | null
  counts: Record<string, unknown> | null
  error: string | null
}

interface JobRunRow {
  id: string
  job: string
  startedAt: Date
  finishedAt: Date | null
  ok: boolean | null
  counts: Record<string, unknown> | null
  error: string | null
}

const rowToJobRun = (r: JobRunRow): JobRun => ({
  id: r.id,
  job: r.job,
  startedAt: r.startedAt.getTime(),
  finishedAt: r.finishedAt ? r.finishedAt.getTime() : null,
  ok: r.ok,
  counts: r.counts,
  error: r.error,
})

// Only a plain object goes into the counts jsonb; a skip sentinel string / number / undefined → null.
const asCounts = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

// Wrap a scheduled job: record a start row, then stamp finish + counts (or error). Recording is
// best-effort — a logging failure must never mask the job's real outcome — and the original result
// is returned / the original error re-thrown so the cron's HTTP status (scheduler retry) is unchanged.
export const withJobRun = async <T>(job: string, fn: () => Promise<T>): Promise<T> => {
  let runId: string | undefined
  try {
    const row = await db.insertInto('jobRuns').values({ job }).returning('id').executeTakeFirst()
    runId = row?.id
  } catch (e) {
    captureServerError(e, { area: 'jobRun.start', tags: { job } })
  }

  const finish = async (ok: boolean, counts: Record<string, unknown> | null, error: string | null) => {
    if (!runId) return
    try {
      await db
        .updateTable('jobRuns')
        .set({ finishedAt: new Date(), ok, counts, error })
        .where('id', '=', runId)
        .execute()
    } catch (e) {
      captureServerError(e, { area: 'jobRun.finish', tags: { job } })
    }
  }

  try {
    const result = await fn()
    await finish(true, asCounts(result), null)
    return result
  } catch (e) {
    await finish(false, null, e instanceof Error ? e.message : String(e))
    throw e
  }
}

export const listRecentJobRuns = async (limit = 50): Promise<JobRun[]> => {
  const rows = await db.selectFrom('jobRuns').selectAll().orderBy('startedAt', 'desc').limit(limit).execute()
  return rows.map(r => rowToJobRun(r as JobRunRow))
}

// Latest run per job — the health summary. distinctOn(job) keeps the newest row per job because
// the order leads with job then started_at desc.
export const listLatestJobRunPerJob = async (): Promise<JobRun[]> => {
  const rows = await db
    .selectFrom('jobRuns')
    .selectAll()
    .distinctOn('job')
    .orderBy('job')
    .orderBy('startedAt', 'desc')
    .execute()
  return rows.map(r => rowToJobRun(r as JobRunRow))
}
