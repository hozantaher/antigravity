// Audit — append-only action trail. Each entry carries asset+account+action+result and chains by
// hash (sha256 of prev+body), so editing or removing a past record breaks verify(). The human-gate
// and drift both read it; without it the gate on write is toothless (ADR 0002, platform pillar).
import { createHash } from 'node:crypto'
const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)

export function append(log, { asset, account, action, result }) {
  if (!asset || !account || !action || !result) throw new Error('audit entry missing a required field')
  const prev = log.length ? log[log.length - 1].hash : 'genesis'
  const body = { asset, account, action, result, prev }
  return [...log, { ...body, hash: h(prev + JSON.stringify(body)) }]
}

export function verify(log) {
  let prev = 'genesis'
  for (const e of log) {
    const { hash, ...body } = e
    if (body.prev !== prev || h(prev + JSON.stringify(body)) !== hash) return false
    prev = hash
  }
  return true
}
