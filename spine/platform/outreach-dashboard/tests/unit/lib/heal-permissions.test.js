// HXX9 — Heal-action permission boundary tests.
//
// Each heal strategy has scope-bounded permissions. Default-deny.
// canPerform(strategy, operation, scope) → boolean
// auditPermission(strategy, operation, scope, params) → { allowed, reason, audit_log }

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  HEAL_PERMISSIONS,
  canPerform,
  auditPermission,
} from '../../../src/lib/heal-permissions.js'

describe('HXX9 — HEAL_PERMISSIONS table', () => {
  it('defines mailbox_heal with expected actions/scopes/blocked', () => {
    expect(HEAL_PERMISSIONS.mailbox_heal.actions).toEqual(
      expect.arrayContaining(['pause', 'resume', 'reset_breaker'])
    )
    expect(HEAL_PERMISSIONS.mailbox_heal.scopes).toEqual(['mailbox'])
    expect(HEAL_PERMISSIONS.mailbox_heal.blocked).toEqual(
      expect.arrayContaining(['drop_campaign', 'delete_db_row', 'modify_creds', 'rotate_secrets'])
    )
  })

  it('defines cron_heal with expected actions/scopes/blocked', () => {
    expect(HEAL_PERMISSIONS.cron_heal.actions).toEqual(
      expect.arrayContaining(['restart_cron', 'log_stall'])
    )
    expect(HEAL_PERMISSIONS.cron_heal.scopes).toEqual(['cron'])
    expect(HEAL_PERMISSIONS.cron_heal.blocked).toEqual(
      expect.arrayContaining(['mutate_db_schema', 'drop_table', 'modify_mailbox'])
    )
  })

  it('defines engine_heal with expected actions/scopes/blocked', () => {
    expect(HEAL_PERMISSIONS.engine_heal.actions).toEqual(
      expect.arrayContaining(['restart_engine', 'reset_supervisor'])
    )
    expect(HEAL_PERMISSIONS.engine_heal.scopes).toEqual(['engine'])
    expect(HEAL_PERMISSIONS.engine_heal.blocked).toEqual(
      expect.arrayContaining(['modify_mailbox_creds', 'alter_campaign'])
    )
  })

  it('defines proxy_heal with expected actions/scopes/blocked', () => {
    expect(HEAL_PERMISSIONS.proxy_heal.actions).toEqual(
      expect.arrayContaining(['rotate_proxy', 'refresh_pool'])
    )
    expect(HEAL_PERMISSIONS.proxy_heal.scopes).toEqual(['proxy'])
    expect(HEAL_PERMISSIONS.proxy_heal.blocked).toEqual(
      expect.arrayContaining(['mutate_anti_trace_config', 'change_relay_endpoint'])
    )
  })
})

describe('HXX9 — canPerform allowed cases', () => {
  it('1. mailbox_heal can pause mailbox → allowed', () => {
    expect(canPerform('mailbox_heal', 'pause', 'mailbox')).toBe(true)
  })

  it('4. cron_heal can restart_cron → allowed', () => {
    expect(canPerform('cron_heal', 'restart_cron', 'cron')).toBe(true)
  })

  it('7. engine_heal can restart_engine → allowed', () => {
    expect(canPerform('engine_heal', 'restart_engine', 'engine')).toBe(true)
  })

  it('9. proxy_heal can rotate_proxy → allowed', () => {
    expect(canPerform('proxy_heal', 'rotate_proxy', 'proxy')).toBe(true)
  })

  it('mailbox_heal can resume mailbox → allowed', () => {
    expect(canPerform('mailbox_heal', 'resume', 'mailbox')).toBe(true)
  })

  it('mailbox_heal can reset_breaker mailbox → allowed', () => {
    expect(canPerform('mailbox_heal', 'reset_breaker', 'mailbox')).toBe(true)
  })

  it('proxy_heal can refresh_pool proxy → allowed', () => {
    expect(canPerform('proxy_heal', 'refresh_pool', 'proxy')).toBe(true)
  })

  it('engine_heal can reset_supervisor engine → allowed', () => {
    expect(canPerform('engine_heal', 'reset_supervisor', 'engine')).toBe(true)
  })

  it('cron_heal can log_stall cron → allowed', () => {
    expect(canPerform('cron_heal', 'log_stall', 'cron')).toBe(true)
  })
})

describe('HXX9 — canPerform denied cases (default-deny)', () => {
  it('2. mailbox_heal cannot drop_campaign → denied', () => {
    expect(canPerform('mailbox_heal', 'drop_campaign', 'mailbox')).toBe(false)
  })

  it('3. mailbox_heal cannot modify_creds → denied', () => {
    expect(canPerform('mailbox_heal', 'modify_creds', 'mailbox')).toBe(false)
  })

  it('mailbox_heal cannot delete_db_row → denied', () => {
    expect(canPerform('mailbox_heal', 'delete_db_row', 'mailbox')).toBe(false)
  })

  it('mailbox_heal cannot rotate_secrets → denied', () => {
    expect(canPerform('mailbox_heal', 'rotate_secrets', 'mailbox')).toBe(false)
  })

  it('5. cron_heal cannot mutate_db_schema → denied', () => {
    expect(canPerform('cron_heal', 'mutate_db_schema', 'cron')).toBe(false)
  })

  it('6. cron_heal cannot drop_table → denied', () => {
    expect(canPerform('cron_heal', 'drop_table', 'cron')).toBe(false)
  })

  it('cron_heal cannot modify_mailbox → denied', () => {
    expect(canPerform('cron_heal', 'modify_mailbox', 'cron')).toBe(false)
  })

  it('8. engine_heal cannot modify_mailbox_creds → denied', () => {
    expect(canPerform('engine_heal', 'modify_mailbox_creds', 'engine')).toBe(false)
  })

  it('engine_heal cannot alter_campaign → denied', () => {
    expect(canPerform('engine_heal', 'alter_campaign', 'engine')).toBe(false)
  })

  it('10. proxy_heal cannot mutate_anti_trace_config → denied', () => {
    expect(canPerform('proxy_heal', 'mutate_anti_trace_config', 'proxy')).toBe(false)
  })

  it('proxy_heal cannot change_relay_endpoint → denied', () => {
    expect(canPerform('proxy_heal', 'change_relay_endpoint', 'proxy')).toBe(false)
  })
})

describe('HXX9 — canPerform unknown inputs default-deny', () => {
  it('11. Unknown strategy → denied (default-deny)', () => {
    expect(canPerform('nonexistent_heal', 'pause', 'mailbox')).toBe(false)
  })

  it('12. Unknown operation → denied', () => {
    expect(canPerform('mailbox_heal', 'unknown_op', 'mailbox')).toBe(false)
  })

  it('13. Unknown scope → denied', () => {
    expect(canPerform('mailbox_heal', 'pause', 'unknown_scope')).toBe(false)
  })

  it('20. Default behavior: empty inputs default-deny', () => {
    expect(canPerform('', '', '')).toBe(false)
    expect(canPerform(null, null, null)).toBe(false)
    expect(canPerform(undefined, undefined, undefined)).toBe(false)
  })

  it('Numeric/boolean inputs default-deny (type safety)', () => {
    expect(canPerform(123, 'pause', 'mailbox')).toBe(false)
    expect(canPerform('mailbox_heal', true, 'mailbox')).toBe(false)
    expect(canPerform('mailbox_heal', 'pause', {})).toBe(false)
  })
})

describe('HXX9 — Cross-strategy denial', () => {
  it('14. mailbox_heal cannot perform cron_heal actions', () => {
    expect(canPerform('mailbox_heal', 'restart_cron', 'cron')).toBe(false)
    expect(canPerform('mailbox_heal', 'restart_cron', 'mailbox')).toBe(false)
    expect(canPerform('mailbox_heal', 'log_stall', 'cron')).toBe(false)
  })

  it('cron_heal cannot perform mailbox_heal actions', () => {
    expect(canPerform('cron_heal', 'pause', 'mailbox')).toBe(false)
    expect(canPerform('cron_heal', 'pause', 'cron')).toBe(false)
  })

  it('engine_heal cannot perform proxy_heal actions', () => {
    expect(canPerform('engine_heal', 'rotate_proxy', 'proxy')).toBe(false)
    expect(canPerform('engine_heal', 'rotate_proxy', 'engine')).toBe(false)
  })

  it('proxy_heal cannot perform engine_heal actions', () => {
    expect(canPerform('proxy_heal', 'restart_engine', 'engine')).toBe(false)
  })

  it('23. Strategy not allowed to elevate scope: mailbox_heal cannot heal system scope', () => {
    expect(canPerform('mailbox_heal', 'pause', 'system')).toBe(false)
    expect(canPerform('mailbox_heal', 'pause', 'cron')).toBe(false)
    expect(canPerform('mailbox_heal', 'pause', 'engine')).toBe(false)
    expect(canPerform('mailbox_heal', 'pause', 'proxy')).toBe(false)
  })
})

describe('HXX9 — auditPermission audit log', () => {
  it('15. Audit log includes strategy + operation + scope + timestamp + decision', () => {
    const result = auditPermission('mailbox_heal', 'pause', 'mailbox', { mailbox_id: 42 })
    expect(result.allowed).toBe(true)
    expect(result.audit_log.strategy).toBe('mailbox_heal')
    expect(result.audit_log.operation).toBe('pause')
    expect(result.audit_log.scope).toBe('mailbox')
    expect(result.audit_log.decision).toBe('allowed')
    expect(typeof result.audit_log.timestamp).toBe('string')
    // ISO 8601
    expect(result.audit_log.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('16. Audit log records denial with reason', () => {
    const result = auditPermission('mailbox_heal', 'drop_campaign', 'mailbox', {})
    expect(result.allowed).toBe(false)
    expect(result.audit_log.decision).toBe('denied')
    expect(typeof result.reason).toBe('string')
    expect(result.reason.length).toBeGreaterThan(0)
    expect(result.audit_log.reason).toBe(result.reason)
  })

  it('Denial reasons differ for unknown strategy vs blocked op vs unknown scope', () => {
    const r1 = auditPermission('nonexistent_heal', 'pause', 'mailbox', {})
    const r2 = auditPermission('mailbox_heal', 'drop_campaign', 'mailbox', {})
    const r3 = auditPermission('mailbox_heal', 'pause', 'unknown_scope', {})
    const r4 = auditPermission('mailbox_heal', 'unknown_op', 'mailbox', {})
    expect(r1.reason).not.toBe(r2.reason)
    expect(r2.reason).not.toBe(r3.reason)
    expect(r3.reason).not.toBe(r4.reason)
  })

  it('17. Audit log captures params (e.g. mailbox_id) for forensics', () => {
    const result = auditPermission('mailbox_heal', 'pause', 'mailbox', {
      mailbox_id: 7,
      reason: 'breaker_open',
      operator: 'system',
    })
    expect(result.audit_log.params).toEqual({
      mailbox_id: 7,
      reason: 'breaker_open',
      operator: 'system',
    })
  })

  it('Empty params still produce a valid audit log', () => {
    const result = auditPermission('mailbox_heal', 'pause', 'mailbox', {})
    expect(result.audit_log.params).toEqual({})
  })

  it('Missing params object treated as empty', () => {
    const result = auditPermission('mailbox_heal', 'pause', 'mailbox')
    expect(result.audit_log.params).toEqual({})
  })
})

describe('HXX9 — Independent multi-instance', () => {
  it('22. Two strategies can both heal independent scopes (e.g. mailbox_heal mb=1 + mailbox_heal mb=2 simultaneously)', () => {
    const r1 = auditPermission('mailbox_heal', 'pause', 'mailbox', { mailbox_id: 1 })
    const r2 = auditPermission('mailbox_heal', 'pause', 'mailbox', { mailbox_id: 2 })
    expect(r1.allowed).toBe(true)
    expect(r2.allowed).toBe(true)
    expect(r1.audit_log.params.mailbox_id).toBe(1)
    expect(r2.audit_log.params.mailbox_id).toBe(2)
  })

  it('Different strategies operate on their own scopes independently', () => {
    const r1 = auditPermission('mailbox_heal', 'pause', 'mailbox', { mailbox_id: 1 })
    const r2 = auditPermission('cron_heal', 'restart_cron', 'cron', { cron: 'campaign-fire' })
    const r3 = auditPermission('proxy_heal', 'rotate_proxy', 'proxy', { proxy_id: 'eu-1' })
    expect(r1.allowed).toBe(true)
    expect(r2.allowed).toBe(true)
    expect(r3.allowed).toBe(true)
  })
})

describe('HXX9 — Prototype pollution resistance', () => {
  it('21. Permission cannot be bypassed with prototype-pollution params', () => {
    const evilParams = JSON.parse('{"__proto__": {"allow": true}, "mailbox_id": 1}')
    const result = auditPermission('mailbox_heal', 'drop_campaign', 'mailbox', evilParams)
    expect(result.allowed).toBe(false)
    expect(result.audit_log.decision).toBe('denied')
    // Ensure no Object.prototype pollution leaked in.
    expect({}.allow).toBeUndefined()
  })

  it('Prototype pollution via constructor key does not bypass deny', () => {
    const evilParams = { constructor: { prototype: { allow: true } } }
    const result = auditPermission('mailbox_heal', 'modify_creds', 'mailbox', evilParams)
    expect(result.allowed).toBe(false)
  })

  it('Strategy name "__proto__" is denied', () => {
    expect(canPerform('__proto__', 'pause', 'mailbox')).toBe(false)
    expect(canPerform('constructor', 'pause', 'mailbox')).toBe(false)
    expect(canPerform('toString', 'pause', 'mailbox')).toBe(false)
  })
})

describe('HXX9 — Audit log JSON-serializability', () => {
  it('24. Audit log entries are JSON-serializable (no functions, no circular refs)', () => {
    const allowed = auditPermission('mailbox_heal', 'pause', 'mailbox', { mailbox_id: 1 })
    const denied = auditPermission('mailbox_heal', 'drop_campaign', 'mailbox', { mailbox_id: 1 })
    // Round-trip MUST succeed.
    expect(() => JSON.stringify(allowed)).not.toThrow()
    expect(() => JSON.stringify(denied)).not.toThrow()
    const re1 = JSON.parse(JSON.stringify(allowed))
    const re2 = JSON.parse(JSON.stringify(denied))
    expect(re1.audit_log.strategy).toBe('mailbox_heal')
    expect(re2.audit_log.decision).toBe('denied')
  })

  it('Audit log contains no function values', () => {
    const result = auditPermission('mailbox_heal', 'pause', 'mailbox', { mailbox_id: 1 })
    function hasFn(obj) {
      if (obj === null || typeof obj !== 'object') return typeof obj === 'function'
      return Object.values(obj).some((v) => typeof v === 'function' || (v && typeof v === 'object' && hasFn(v)))
    }
    expect(hasFn(result)).toBe(false)
  })
})

describe('HXX9 — Property tests', () => {
  it('18. Property: canPerform never returns true for an operation in `blocked` array', () => {
    const strategies = Object.keys(HEAL_PERMISSIONS)
    fc.assert(
      fc.property(
        fc.constantFrom(...strategies),
        fc.nat(),
        (strategy, idx) => {
          const cfg = HEAL_PERMISSIONS[strategy]
          if (cfg.blocked.length === 0) return true
          const op = cfg.blocked[idx % cfg.blocked.length]
          // Even if scope is in scopes, blocked op must always deny.
          for (const scope of cfg.scopes) {
            if (canPerform(strategy, op, scope)) return false
          }
          return true
        }
      ),
      { numRuns: 200 }
    )
  })

  it('19. Property: canPerform returns true iff (operation IN actions AND scope IN scopes AND op NOT IN blocked)', () => {
    const strategies = Object.keys(HEAL_PERMISSIONS)
    fc.assert(
      fc.property(
        fc.constantFrom(...strategies),
        fc.string(),
        fc.string(),
        (strategy, op, scope) => {
          const cfg = HEAL_PERMISSIONS[strategy]
          const expected =
            cfg.actions.includes(op) &&
            cfg.scopes.includes(scope) &&
            !cfg.blocked.includes(op)
          return canPerform(strategy, op, scope) === expected
        }
      ),
      { numRuns: 200 }
    )
  })

  it('Property: 200 random (strategy, operation) pairs respect HEAL_PERMISSIONS table', () => {
    const strategies = Object.keys(HEAL_PERMISSIONS)
    const allOps = [
      ...new Set(
        strategies.flatMap((s) => [
          ...HEAL_PERMISSIONS[s].actions,
          ...HEAL_PERMISSIONS[s].blocked,
        ])
      ),
    ]
    fc.assert(
      fc.property(
        fc.constantFrom(...strategies),
        fc.constantFrom(...allOps),
        fc.constantFrom('mailbox', 'cron', 'engine', 'proxy', 'system', 'unknown'),
        (strategy, op, scope) => {
          const cfg = HEAL_PERMISSIONS[strategy]
          const expected =
            cfg.actions.includes(op) &&
            cfg.scopes.includes(scope) &&
            !cfg.blocked.includes(op)
          return canPerform(strategy, op, scope) === expected
        }
      ),
      { numRuns: 200 }
    )
  })

  it('Property: 200 random params shapes → audit log always JSON-stringifiable', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('mailbox_heal', 'cron_heal', 'engine_heal', 'proxy_heal'),
        fc.string(),
        fc.string(),
        fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null))),
        (strategy, op, scope, params) => {
          const result = auditPermission(strategy, op, scope, params)
          try {
            JSON.stringify(result)
            return true
          } catch {
            return false
          }
        }
      ),
      { numRuns: 200 }
    )
  })
})
