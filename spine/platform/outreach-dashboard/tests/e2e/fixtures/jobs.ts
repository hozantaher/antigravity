// Mock fixtures for the runJob async-BFF pattern (jobs-flow.spec.ts).
//
// Contract being mocked:
//   POST /api/mailboxes/bulk-check → 202 { job_id, total }
//   GET  /api/jobs/:id             → polling response, eventually status='done'
//   GET  /api/mailboxes            → list of fixture mailboxes (so the table hydrates)

import type { Page, Route } from '@playwright/test'

export const JOB_ID = 'job-test-fixture-0001'

export interface MailboxFixture {
  id: string
  email: string
  smtp_host: string
  smtp_port: number
  imap_host: string
  imap_port: number
  status: string
}

export const MAILBOXES_FIXTURE: MailboxFixture[] = [
  {
    id: 'mb-1',
    email: 'one@test.internal',
    smtp_host: 'smtp.test.internal',
    smtp_port: 587,
    imap_host: 'imap.test.internal',
    imap_port: 993,
    status: 'active',
  },
  {
    id: 'mb-2',
    email: 'two@test.internal',
    smtp_host: 'smtp.test.internal',
    smtp_port: 587,
    imap_host: 'imap.test.internal',
    imap_port: 993,
    status: 'active',
  },
]

export interface InstallJobMocksOptions {
  total: number
  pollSteps?: number
}

export async function installJobMocks(
  page: Page,
  { total, pollSteps = 2 }: InstallJobMocksOptions,
): Promise<void> {
  let pollCount = 0

  await page.route('**/api/mailboxes', async (route: Route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback()
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mailboxes: MAILBOXES_FIXTURE }),
    })
  })

  await page.route('**/api/mailboxes/bulk-check', async (route: Route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback()
      return
    }
    pollCount = 0
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: JOB_ID, total }),
    })
  })

  await page.route(`**/api/jobs/${JOB_ID}`, async (route: Route) => {
    pollCount++
    const done = pollCount >= pollSteps
    const current = done ? total : Math.min(pollCount, total)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job_id: JOB_ID,
        status: done ? 'done' : 'running',
        progress: { current, total },
        ok_count: done ? total : current,
      }),
    })
  })
}
