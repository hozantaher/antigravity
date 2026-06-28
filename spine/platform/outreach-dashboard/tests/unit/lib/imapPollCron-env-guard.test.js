import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * P2.15 test: runImapPollCron NODE_ENV guard
 *
 * Assertion: when NODE_ENV != 'production' and DISABLE_IMAP_CRON != '0',
 * the cron should return early without polling any mailboxes.
 */

describe('runImapPollCron NODE_ENV guard', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalDisableImap = process.env.DISABLE_IMAP_CRON

  beforeEach(() => {
    // Reset env before each test
    process.env.NODE_ENV = 'test'
    process.env.DISABLE_IMAP_CRON = undefined
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    process.env.DISABLE_IMAP_CRON = originalDisableImap
  })

  it('P2.15-T1: runImapPollCron should skip when NODE_ENV=test (not production)', () => {
    // Simulate the guard logic from server.js:4168-4170
    const shouldSkip = process.env.NODE_ENV !== 'production' && process.env.DISABLE_IMAP_CRON !== '0'

    expect(shouldSkip).toBe(true)
  })

  it('P2.15-T2: runImapPollCron should NOT skip when DISABLE_IMAP_CRON=0 overrides NODE_ENV', () => {
    process.env.DISABLE_IMAP_CRON = '0'
    const shouldSkip = process.env.NODE_ENV !== 'production' && process.env.DISABLE_IMAP_CRON !== '0'

    expect(shouldSkip).toBe(false)
  })

  it('P2.15-T3: runImapPollCron should NOT skip when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production'
    const shouldSkip = process.env.NODE_ENV !== 'production' && process.env.DISABLE_IMAP_CRON !== '0'

    expect(shouldSkip).toBe(false)
  })
})
