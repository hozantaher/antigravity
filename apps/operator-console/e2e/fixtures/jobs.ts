// Shared mocks for async-job BFF flows (202 + /api/jobs/:id polling).
//
// Flows covered:
//   POST /api/mailboxes/bulk-check   → 202 { job_id, total }
//   POST /api/mailboxes/import-csv   → 202 { job_id, total }
//   GET  /api/jobs/:id               → running → running → done (scripted)
//
// Usage:
//   import { installJobMocks, MAILBOXES_FIXTURE } from './fixtures/jobs'
//   await installJobMocks(page, { jobId: 'job-test-1', total: 1 })

import type { Page, Route } from '@playwright/test'

export const JOB_ID = 'job-test-1'

export const MAILBOXES_FIXTURE = [
  {
    id: 101,
    email: 'e2e-one@test.internal',
    smtp_host: 'smtp.test.internal',
    smtp_port: 587,
    imap_host: null,
    imap_port: null,
    status: 'active',
    daily_limit: 50,
    sent_today: 0,
    last_check_at: null,
    last_check_ok: null,
    health_score: 80,
  },
  {
    id: 102,
    email: 'e2e-two@test.internal',
    smtp_host: 'smtp.test.internal',
    smtp_port: 587,
    imap_host: null,
    imap_port: null,
    status: 'active',
    daily_limit: 50,
    sent_today: 0,
    last_check_at: null,
    last_check_ok: null,
    health_score: 80,
  },
]

type JobStatus = 'queued' | 'running' | 'done' | 'failed'

function buildJobPayload(id: string, status: JobStatus, current: number, total: number) {
  return {
    id,
    label: id.startsWith('job-csv') ? 'import-csv' : 'bulk-check',
    status,
    progress: { current, total },
    error: null,
    result: status === 'done' ? { imported: total, checked: total } : null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: status === 'done' ? new Date().toISOString() : null,
  }
}

// Scripts a running → running → done polling sequence.
export function makeJobPoller(jobId: string, total: number) {
  let polls = 0
  return async (route: Route) => {
    polls += 1
    // 1st poll = running/0, 2nd = running/partial, 3rd+ = done
    if (polls === 1) {
      return route.fulfill({ json: buildJobPayload(jobId, 'running', 0, total) })
    }
    if (polls === 2) {
      return route.fulfill({
        json: buildJobPayload(jobId, 'running', Math.max(1, Math.floor(total / 2)), total),
      })
    }
    return route.fulfill({ json: buildJobPayload(jobId, 'done', total, total) })
  }
}

interface InstallOpts {
  jobId?: string
  total?: number
  mailboxes?: typeof MAILBOXES_FIXTURE
}

// Installs all mocks needed for the mailboxes page + bulk-check/import-csv
// async flows against a mocked BFF. The Playwright dev server still runs Vite,
// but every /api/** request is fulfilled locally — no Railway DB required.
export async function installJobMocks(page: Page, opts: InstallOpts = {}) {
  const jobId = opts.jobId ?? JOB_ID
  const total = opts.total ?? 1
  const mailboxes = opts.mailboxes ?? MAILBOXES_FIXTURE

  // Polling endpoint — scripted state machine. Registered FIRST so that the
  // broader catch-all below never shadows it. (Playwright matches routes in
  // LIFO order; the catch-all is our lowest-priority fallback.)
  const poll = makeJobPoller(jobId, total)
  await page.route(`**/api/jobs/${jobId}`, poll)

  // Catch-all — intentionally registered EARLY so specific routes below take
  // precedence via LIFO ordering. Provides safe defaults for unrelated
  // /api/** calls so the mailboxes page has no unresolved network.
  await page.route('**/api/**', route => {
    const url = route.request().url()
    if (url.includes('/api/proxy-pool')) return route.fulfill({ json: { proxies: [], by_country: {} } })
    if (url.includes('/api/anti-trace/health')) return route.fulfill({ json: { ok: true } })
    if (url.includes('/api/health/')) return route.fulfill({ json: { ok: true } })
    return route.fulfill({ json: [] })
  })

  // Core mailbox list + health endpoints. Registered AFTER the catch-all so
  // they win via Playwright LIFO route matching.
  await page.route('**/api/mailboxes', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: mailboxes })
    return route.fulfill({ json: { ok: true } })
  })
  await page.route('**/api/mailboxes/health-summary', route =>
    route.fulfill({
      json: { total: mailboxes.length, ok: mailboxes.length, fail: 0, mailboxes },
    }),
  )
  await page.route('**/api/mailboxes/send-trends**', route =>
    route.fulfill({ json: { trends: [] } }),
  )

  // Async-job producers — both return 202 + job_id + total.
  await page.route('**/api/mailboxes/bulk-check', route =>
    route.fulfill({ status: 202, json: { job_id: jobId, total } }),
  )
  await page.route('**/api/mailboxes/import-csv', route =>
    route.fulfill({ status: 202, json: { job_id: jobId, total } }),
  )
}
