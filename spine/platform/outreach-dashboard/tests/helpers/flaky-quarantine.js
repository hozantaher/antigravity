// H7 — Flaky-test auto-quarantine logic.
// Pure functions. State stored in `flaky_quarantine.json` (managed by CI script).
//
// Decision rules:
//   - Quarantine when ≥3 fails in last 10 runs.
//   - Restore when 3 consecutive passes on a quarantined test.
//   - Window is rolling: only the most recent N runs count.

const DEFAULT_WINDOW = 10
const DEFAULT_THRESHOLD = 3
const DEFAULT_RESTORE_PASSES = 3
const MAX_HISTORY = 100

export function emptyHistory() {
  return { runs: [] }
}

export function recordRun(history, run) {
  if (!run || typeof run.ok !== 'boolean') {
    throw new Error('recordRun: run.ok must be boolean')
  }
  const next = { ...history, runs: [...(history?.runs || []), run] }
  if (next.runs.length > MAX_HISTORY) {
    next.runs = next.runs.slice(-MAX_HISTORY)
  }
  return next
}

export function rollingFailureRate(runs, window = DEFAULT_WINDOW) {
  if (!Array.isArray(runs) || runs.length === 0) return 0
  const tail = runs.slice(-window)
  const fails = tail.filter(r => !r.ok).length
  return fails / tail.length
}

export function shouldQuarantine(runs, opts = {}) {
  const window = opts.window ?? DEFAULT_WINDOW
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  if (!Array.isArray(runs) || runs.length < window) return false
  const tail = runs.slice(-window)
  const fails = tail.filter(r => !r.ok).length
  return fails >= threshold
}

export function shouldRestore(runs, opts = {}) {
  if (!opts.quarantined) return false
  const need = opts.consecutivePasses ?? DEFAULT_RESTORE_PASSES
  if (!Array.isArray(runs) || runs.length < need) return false
  const tail = runs.slice(-need)
  return tail.every(r => r.ok)
}
