// I3 — heal-api-guards tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { guardedHealAction, _resetBudget } from '../../../src/lib/heal-api-guards.js'

const ORIG_THROW = process.env.INVARIANT_THROW

beforeEach(() => {
  process.env.INVARIANT_THROW = '1'
  _resetBudget()
})

afterEach(() => {
  if (ORIG_THROW === undefined) delete process.env.INVARIANT_THROW
  else process.env.INVARIANT_THROW = ORIG_THROW
  _resetBudget()
})

describe('I3 — guardedHealAction', () => {
  it('happy path: permission ok, budget ok, action runs', async () => {
    const r = await guardedHealAction({
      strategy: 'mailbox_heal',
      operation: 'pause',
      scope: 'mailbox',
      entity_id: 1,
      action: async () => ({ paused: true }),
    })
    expect(r.allowed).toBe(true)
    expect(r.result).toEqual({ paused: true })
  })

  it('permission denied: drop_campaign on mailbox_heal', async () => {
    const r = await guardedHealAction({
      strategy: 'mailbox_heal',
      operation: 'drop_campaign',
      scope: 'mailbox',
      entity_id: 1,
      action: async () => ({}),
    })
    expect(r.allowed).toBe(false)
    expect(r.denied_reason).toBeTruthy()
  })

  it('budget exhaustion after 30 calls per entity', async () => {
    let okCount = 0
    let deniedCount = 0
    for (let i = 0; i < 35; i++) {
      const r = await guardedHealAction({
        strategy: 'mailbox_heal',
        operation: 'pause',
        scope: 'mailbox',
        entity_id: 1,
        action: async () => ({ ok: true }),
      })
      if (r.allowed && !r.error) okCount++
      else if (r.denied_reason === 'budget_exhausted') deniedCount++
    }
    expect(okCount).toBe(30)
    expect(deniedCount).toBe(5)
  })

  it('different entities get independent budget', async () => {
    for (let i = 0; i < 30; i++) {
      await guardedHealAction({
        strategy: 'mailbox_heal', operation: 'pause', scope: 'mailbox',
        entity_id: 1, action: async () => ({}),
      })
    }
    const r = await guardedHealAction({
      strategy: 'mailbox_heal', operation: 'pause', scope: 'mailbox',
      entity_id: 2, action: async () => ({ ok: true }),
    })
    expect(r.allowed).toBe(true)
    expect(r.result).toEqual({ ok: true })
  })

  it('action throws → captured in error field, allowed=true', async () => {
    const r = await guardedHealAction({
      strategy: 'cron_heal',
      operation: 'restart_cron',
      scope: 'cron',
      entity_id: 'fullCheck',
      action: async () => { throw new Error('boom') },
    })
    expect(r.allowed).toBe(true)
    expect(r.error).toMatch(/boom/)
    expect(r.result).toBeUndefined()
  })

  it('action returns undefined → invariant throws (post-condition)', async () => {
    await expect(guardedHealAction({
      strategy: 'mailbox_heal',
      operation: 'pause',
      scope: 'mailbox',
      entity_id: 99,
      action: async () => undefined,
    })).rejects.toThrow(/returned undefined/i)
  })

  it('missing strategy throws (pre-condition)', async () => {
    await expect(guardedHealAction({
      operation: 'pause', scope: 'mailbox', entity_id: 1,
      action: async () => ({}),
    })).rejects.toThrow(/strategy required/i)
  })

  it('missing action throws (pre-condition)', async () => {
    await expect(guardedHealAction({
      strategy: 'mailbox_heal', operation: 'pause', scope: 'mailbox', entity_id: 1,
    })).rejects.toThrow(/action.*async/i)
  })

  it('engine_heal can restart_engine but not modify_mailbox_creds', async () => {
    const ok = await guardedHealAction({
      strategy: 'engine_heal', operation: 'restart_engine', scope: 'engine',
      entity_id: 'sender', action: async () => ({ restarted: true }),
    })
    expect(ok.allowed).toBe(true)

    const denied = await guardedHealAction({
      strategy: 'engine_heal', operation: 'modify_mailbox_creds', scope: 'engine',
      entity_id: 'sender', action: async () => ({}),
    })
    expect(denied.allowed).toBe(false)
  })

  it('proxy_heal can rotate_proxy but not mutate_anti_trace_config', async () => {
    const ok = await guardedHealAction({
      strategy: 'proxy_heal', operation: 'rotate_proxy', scope: 'proxy',
      entity_id: 'pool', action: async () => ({ rotated: true }),
    })
    expect(ok.allowed).toBe(true)

    const denied = await guardedHealAction({
      strategy: 'proxy_heal', operation: 'mutate_anti_trace_config', scope: 'proxy',
      entity_id: 'pool', action: async () => ({}),
    })
    expect(denied.allowed).toBe(false)
  })

  it('unknown strategy → denied', async () => {
    const r = await guardedHealAction({
      strategy: 'mystery_heal', operation: 'pause', scope: 'mailbox',
      entity_id: 1, action: async () => ({}),
    })
    expect(r.allowed).toBe(false)
  })
})
