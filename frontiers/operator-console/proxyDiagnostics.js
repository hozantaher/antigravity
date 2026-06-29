// Bucketing helpers for /api/mailboxes/:id/assign-proxy diagnostic output.
// Keys emitted by summarizeAttempts are the public UI contract (toast messages
// + downstream alert rules read these keys directly), so extending the set is
// an API change — adjust the corresponding UI + tests together.

export function classifyProbeReason(reason) {
  if (!reason) return 'unknown'
  const s = String(reason).toLowerCase()
  // socks first — "socks5 handshake" would otherwise fall into tls_fail.
  if (s.includes('socks')) return 'socks_fail'
  if (s.includes('535') || s.includes('auth') || s.includes('credentials')) return 'auth_invalid'
  if (s.includes('timeout') || s.includes('deadline')) return 'timeout'
  if (s.includes('tls') || s.includes('certificate')) return 'tls_fail'
  if (s.includes('connection') || s.includes('refused') || s.includes('reset') || s.includes('eof')) return 'conn_fail'
  return 'other'
}

export function summarizeAttempts(attempts) {
  const counts = {}
  for (const a of attempts) {
    if (a.ok) continue
    const cls = classifyProbeReason(a.reason)
    counts[cls] = (counts[cls] || 0) + 1
  }
  return counts
}
