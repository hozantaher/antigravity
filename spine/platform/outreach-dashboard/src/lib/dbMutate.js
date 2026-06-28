// DB write wrapper: logs + surfaces failures instead of swallowing them.
//
// Replaces the ~23 instances of `.catch(() => {})` on pool.query() UPDATE/INSERT
// statements across server.js (see project memory "Schránky quality debt").
//
// Two modes:
//   dbMutate(promise, meta)         — awaits, logs on failure, RE-THROWS.
//                                      Use when caller wants to surface error
//                                      to HTTP response / client toast.
//   dbMutateDetached(promise, meta) — logs on failure, NEVER throws.
//                                      Use for fire-and-forget background work
//                                      (audit writes, cache priming). Failures
//                                      still land in the ring buffer below.
//
// /api/health/write-errors exposes the ring buffer so operators can see what
// silently failed in the last N writes without tailing stderr.

const WRITE_FAILURE_CAP = 100
const writeFailures = []

function recordFailure(meta, err) {
  const entry = {
    ts: new Date().toISOString(),
    label: meta.label || 'unknown',
    target: meta.target ?? null,
    error: err?.message || String(err),
    code: err?.code || null,
  }
  writeFailures.unshift(entry)
  if (writeFailures.length > WRITE_FAILURE_CAP) writeFailures.length = WRITE_FAILURE_CAP
  const targetPart = entry.target !== null ? ` target=${entry.target}` : ''
  console.error(`[db-write-fail] ${entry.label}${targetPart}: ${entry.error}`)
}

export async function dbMutate(promise, meta = {}) {
  try {
    return await promise
  } catch (err) {
    recordFailure(meta, err)
    throw err
  }
}

export async function dbMutateDetached(promise, meta = {}) {
  try {
    return await promise
  } catch (err) {
    recordFailure(meta, err)
    return null
  }
}

export function getWriteFailures() {
  return writeFailures.slice()
}

export function clearWriteFailures() {
  writeFailures.length = 0
}
