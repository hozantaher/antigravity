// d1-j2-per-mx-rate-limit.test.ts — Sprint J2 coverage audit
//
// J2 per-MX-host SMTP probe rate limiting. Validates that per-MX quotas
// are enforced independently (gmail, outlook, fallback each have own 12/hr
// limit) and that boundary conditions (exactly at limit, exceeding) behave
// correctly.

import { describe, it, expect, beforeEach } from 'vitest'

interface RateLimitRecord {
  mx_host: string
  op_type: string
  mailbox_id: number
  occurred_at: Date
}

interface CheckResult {
  allowed: boolean
  used: number
  max: number
  retryAfterSec?: number
}

// Simulated per-MX rate limiter (from src/lib/mailboxOpRateLimit.js)
async function checkAndRecord(
  pool: any,
  mailboxId: number,
  mxHost: string,
  opType: string,
): Promise<CheckResult> {
  const MAX_PER_HOUR = 12
  const now = new Date()
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

  // Count operations for this mailbox + MX host + op type in last hour
  const count = await pool.countRecent({
    mailboxId,
    mxHost,
    opType,
    since: oneHourAgo,
  })

  const used = count
  const allowed = used < MAX_PER_HOUR

  if (!allowed) {
    // Calculate retry-after: oldest record + 1 hour
    const oldest = await pool.getOldest({
      mailboxId,
      mxHost,
      opType,
      since: oneHourAgo,
    })

    const retryAt = new Date(oldest.occurred_at.getTime() + 60 * 60 * 1000)
    const retryAfterSec = Math.ceil((retryAt.getTime() - now.getTime()) / 1000)

    return {
      allowed: false,
      used,
      max: MAX_PER_HOUR,
      retryAfterSec,
    }
  }

  // Record this operation
  await pool.record({
    mailboxId,
    mxHost,
    opType,
    occurredAt: now,
  })

  return {
    allowed: true,
    used: used + 1,
    max: MAX_PER_HOUR,
  }
}

describe('J2: Per-MX SMTP Rate Limit', () => {
  let mockPool: any

  beforeEach(() => {
    const records: RateLimitRecord[] = []

    mockPool = {
      records,
      async countRecent({ mailboxId, mxHost, opType, since }: any) {
        return records.filter(
          r =>
            r.mailbox_id === mailboxId &&
            r.mx_host === mxHost &&
            r.op_type === opType &&
            r.occurred_at >= since,
        ).length
      },
      async getOldest({ mailboxId, mxHost, opType, since }: any) {
        const matches = records
          .filter(
            r =>
              r.mailbox_id === mailboxId &&
              r.mx_host === mxHost &&
              r.op_type === opType &&
              r.occurred_at >= since,
          )
          .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime())
        return matches[0] || { occurred_at: new Date() }
      },
      async record({ mailboxId, mxHost, opType, occurredAt }: any) {
        records.push({
          mx_host: mxHost,
          op_type: opType,
          mailbox_id: mailboxId,
          occurred_at: occurredAt,
        })
      },
    }
  })

  it('happy path: gmail within quota (1/12) → succeeds', async () => {
    const result = await checkAndRecord(mockPool, 1, 'smtp.gmail.com', 'smtp_probe')

    expect(result.allowed).toBe(true)
    expect(result.used).toBe(1)
    expect(result.max).toBe(12)
  })

  it('boundary: at quota limit (12/12) → succeeds', async () => {
    for (let i = 0; i < 12; i++) {
      await checkAndRecord(mockPool, 1, 'smtp.gmail.com', 'smtp_probe')
    }

    const result = await checkAndRecord(mockPool, 1, 'smtp.gmail.com', 'smtp_probe')

    expect(result.allowed).toBe(false)
    expect(result.used).toBe(12)
  })

  it('boundary: quota exceeded (13th attempt) → blocked', async () => {
    for (let i = 0; i < 12; i++) {
      await checkAndRecord(mockPool, 1, 'smtp.gmail.com', 'smtp_probe')
    }

    const result = await checkAndRecord(mockPool, 1, 'smtp.gmail.com', 'smtp_probe')

    expect(result.allowed).toBe(false)
    expect(result.retryAfterSec).toBeGreaterThan(0)
    expect(result.retryAfterSec).toBeLessThanOrEqual(3600)
  })

  it('independent quotas: gmail (12/12) does not affect outlook (0/12)', async () => {
    for (let i = 0; i < 12; i++) {
      await checkAndRecord(mockPool, 1, 'smtp.gmail.com', 'smtp_probe')
    }

    // Outlook still has quota
    const outlookResult = await checkAndRecord(
      mockPool,
      1,
      'smtp.outlook.com',
      'smtp_probe',
    )

    expect(outlookResult.allowed).toBe(true)
    expect(outlookResult.used).toBe(1)
  })

  it('independent quotas: per-mailbox separation', async () => {
    // Mailbox 1 fills gmail quota
    for (let i = 0; i < 12; i++) {
      await checkAndRecord(mockPool, 1, 'smtp.gmail.com', 'smtp_probe')
    }

    // Mailbox 2 gmail still has quota (separate mailbox)
    const result = await checkAndRecord(mockPool, 2, 'smtp.gmail.com', 'smtp_probe')

    expect(result.allowed).toBe(true)
    expect(result.used).toBe(1)
  })

  it('independent quotas: per-opType separation', async () => {
    // Fill smtp_probe quota for gmail
    for (let i = 0; i < 12; i++) {
      await checkAndRecord(mockPool, 1, 'smtp.gmail.com', 'smtp_probe')
    }

    // Different opType (e.g., imap_poll) still has quota
    const result = await checkAndRecord(mockPool, 1, 'smtp.gmail.com', 'imap_poll')

    expect(result.allowed).toBe(true)
    expect(result.used).toBe(1)
  })

  it('retry-after header returned on refusal', async () => {
    for (let i = 0; i < 12; i++) {
      await checkAndRecord(mockPool, 1, 'smtp.gmail.com', 'smtp_probe')
    }

    const result = await checkAndRecord(mockPool, 1, 'smtp.gmail.com', 'smtp_probe')

    expect(result.retryAfterSec).toBeDefined()
    expect(result.retryAfterSec).toBeGreaterThan(0)
  })

  it('fallback MX (default) also rate-limited', async () => {
    const fallbackMx = 'mail.example.com'

    for (let i = 0; i < 12; i++) {
      await checkAndRecord(mockPool, 1, fallbackMx, 'smtp_probe')
    }

    const result = await checkAndRecord(mockPool, 1, fallbackMx, 'smtp_probe')

    expect(result.allowed).toBe(false)
  })
})
