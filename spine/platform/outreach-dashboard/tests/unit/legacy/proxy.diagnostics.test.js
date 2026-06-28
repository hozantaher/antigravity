// Unit coverage for the proxy-assign diagnostic helpers introduced alongside
// the /api/mailboxes/:id/assign-proxy 503-body-shape change. Validates the
// bucketing stays stable so the UI toast + any downstream alert rules can rely
// on the summary keys (auth_invalid / timeout / tls_fail / conn_fail /
// socks_fail / other / unknown).
import { describe, it, expect } from 'vitest'
import { classifyProbeReason, summarizeAttempts } from '../../../proxyDiagnostics.js'

describe('classifyProbeReason', () => {
  it('buckets seznam 535 + "incorrect credentials" as auth_invalid', () => {
    expect(classifyProbeReason('535 5.7.8 incorrect credentials')).toBe('auth_invalid')
    expect(classifyProbeReason('authentication failed')).toBe('auth_invalid')
  })

  it('buckets timeout strings as timeout', () => {
    expect(classifyProbeReason('i/o timeout')).toBe('timeout')
    expect(classifyProbeReason('deadline exceeded')).toBe('timeout')
  })

  it('buckets TLS handshake + cert failures as tls_fail', () => {
    expect(classifyProbeReason('tls handshake failure')).toBe('tls_fail')
    expect(classifyProbeReason('bad certificate')).toBe('tls_fail')
  })

  it('buckets TCP-layer failures as conn_fail', () => {
    expect(classifyProbeReason('connection refused')).toBe('conn_fail')
    expect(classifyProbeReason('connection reset by peer')).toBe('conn_fail')
    expect(classifyProbeReason('unexpected EOF')).toBe('conn_fail')
  })

  it('buckets SOCKS5 handshake failures as socks_fail', () => {
    expect(classifyProbeReason('socks5 handshake: not supported')).toBe('socks_fail')
  })

  it('falls back to other for unknown error text', () => {
    expect(classifyProbeReason('mystery error xyz')).toBe('other')
  })

  it('returns unknown for null/empty input', () => {
    expect(classifyProbeReason(null)).toBe('unknown')
    expect(classifyProbeReason('')).toBe('unknown')
    expect(classifyProbeReason(undefined)).toBe('unknown')
  })
})

describe('summarizeAttempts', () => {
  it('counts failure attempts by class, skips successes', () => {
    const attempts = [
      { addr: 'a', ok: true, reason: null },
      { addr: 'b', ok: false, reason: '535 5.7.8 incorrect credentials' },
      { addr: 'c', ok: false, reason: '535 auth failed' },
      { addr: 'd', ok: false, reason: 'i/o timeout' },
      { addr: 'e', ok: false, reason: 'tls bad certificate' },
    ]
    expect(summarizeAttempts(attempts)).toEqual({
      auth_invalid: 2,
      timeout: 1,
      tls_fail: 1,
    })
  })

  it('returns empty object for all-success input', () => {
    expect(summarizeAttempts([{ addr: 'a', ok: true }])).toEqual({})
  })

  it('returns empty object for empty input', () => {
    expect(summarizeAttempts([])).toEqual({})
  })
})
