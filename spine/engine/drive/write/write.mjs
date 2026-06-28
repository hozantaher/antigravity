// Write-driver — human-gated, audited operation of OUR portal account. Every write needs an explicit
// approval AND records an audit entry; an unapproved write never executes. create/edit are an
// idempotent upsert-by-our-ref; delete removes. No live portal traffic in the PoC (ADR 0002, drive).
import { append } from '../../platform/audit/audit.mjs'

export function write(state, op, { approved, account } = {}) {
  if (!approved) return { ok: false, reason: 'no approval — write refused', state }
  const audit = append(state.audit || [], { asset: op.ref, account, action: `write.${op.kind}`, result: 'ok' })
  const listings = applyOp(state.listings || {}, op)
  return { ok: true, state: { ...state, listings, audit } }
}

function applyOp(listings, op) {
  const next = { ...listings }
  if (op.kind === 'delete') delete next[op.ref]
  else next[op.ref] = { ...(next[op.ref] || {}), ...op.fields } // create+edit = idempotent upsert by our ref
  return next
}
