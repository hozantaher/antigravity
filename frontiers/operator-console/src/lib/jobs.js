// In-memory job tracker for async BFF operations.
//
// Replaces the fire-and-forget IIFE pattern — e.g. /api/mailboxes/bulk-check
// used to `res.json({ok:true})` BEFORE starting the work, leaving the UI with
// a fake instant-success toast (see project memory "Schránky quality debt").
//
// Shape:
//   job = { id, label, status, progress:{current,total}, error, result,
//           created_at, updated_at, started_at, finished_at }
//   status: 'queued' | 'running' | 'done' | 'failed'
//
// Endpoints wired in server.js:
//   POST /api/mailboxes/bulk-check → 202 { job_id } + createJob+runJob
//   GET  /api/jobs/:id             → current status
//
// TTL: 10 min after finish (long enough for UI polling, short enough to bound mem).

const JOBS_TTL_MS = 10 * 60 * 1000
const jobs = new Map()
let jobCounter = 0

function newId() {
  jobCounter += 1
  return `job-${Date.now().toString(36)}-${jobCounter.toString(36)}`
}

function nowISO() {
  return new Date().toISOString()
}

export function createJob(label, meta = {}) {
  const id = newId()
  const job = {
    id,
    label,
    status: 'queued',
    progress: { current: 0, total: 0 },
    error: null,
    result: null,
    meta,
    created_at: nowISO(),
    updated_at: nowISO(),
    started_at: null,
    finished_at: null,
  }
  jobs.set(id, job)
  return job
}

export function updateJob(id, patch) {
  const job = jobs.get(id)
  if (!job) return null
  Object.assign(job, patch, { updated_at: nowISO() })
  return job
}

export function getJob(id) {
  return jobs.get(id) || null
}

export function listJobs() {
  return Array.from(jobs.values()).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
}

// Run an async function as a tracked job. The fn receives helpers to report
// progress and result. Returns the job metadata (id + initial state).
//
//   const job = runJob('bulk-check', async ({ setProgress, setResult }) => {
//     for (let i=0; i<ids.length; i++) {
//       await doWork(ids[i])
//       setProgress(i+1, ids.length)
//     }
//     setResult({ checked: ids.length })
//   })
//   res.status(202).json({ job_id: job.id })
export function runJob(label, fn, meta = {}) {
  const job = createJob(label, meta)
  updateJob(job.id, { status: 'running', started_at: nowISO() })
  const ctx = {
    setProgress: (current, total) => updateJob(job.id, { progress: { current, total } }),
    setResult: (result) => updateJob(job.id, { result }),
  }
  Promise.resolve()
    .then(() => fn(ctx))
    .then(() => updateJob(job.id, { status: 'done', finished_at: nowISO() }))
    .catch(err => {
      console.error(`[job-fail] ${label}: ${err?.message || err}`)
      updateJob(job.id, {
        status: 'failed',
        error: err?.message || String(err),
        finished_at: nowISO(),
      })
    })
  return job
}

// GC: purge finished jobs older than TTL. Unref'd so it doesn't keep the
// event loop alive in tests.
const gcTimer = setInterval(() => {
  const now = Date.now()
  for (const [id, job] of jobs) {
    const finishedAt = job.finished_at ? Date.parse(job.finished_at) : null
    if (finishedAt && now - finishedAt > JOBS_TTL_MS) jobs.delete(id)
  }
}, 60_000)
gcTimer.unref?.()

export function __resetJobsForTest() {
  jobs.clear()
  jobCounter = 0
}
