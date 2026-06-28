// SHARED-1 — SLO helpers.
// Pure functions for percentile bounds, convergence, monotonicity,
// state-trace oscillation. Used by HX5/HXX3/HXX5/HX3.

export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('percentile: values cannot be empty')
  }
  if (p < 0 || p > 100) {
    throw new Error(`percentile: p must be in range [0, 100], got ${p}`)
  }
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]
  // Linear interpolation between closest ranks (NIST method).
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]
  const frac = rank - lo
  return sorted[lo] + frac * (sorted[hi] - sorted[lo])
}

export function assertPercentile(values, p, bound) {
  const actual = percentile(values, p)
  if (actual > bound) {
    throw new Error(
      `SLO bound exceeded: P${p}=${actual.toFixed(2)} > ${bound} (${values.length} samples)`
    )
  }
}

export function assertHistogramBounded(values, bounds) {
  // bounds = { p50, p90, p99, p999 } — any subset.
  const checks = []
  if (bounds.p50  != null) checks.push([50,  bounds.p50])
  if (bounds.p90  != null) checks.push([90,  bounds.p90])
  if (bounds.p99  != null) checks.push([99,  bounds.p99])
  if (bounds.p999 != null) checks.push([99.9, bounds.p999])
  for (const [p, bound] of checks) {
    const actual = percentile(values, p)
    if (actual > bound) {
      throw new Error(`Histogram p${p} exceeded: ${actual.toFixed(2)} > ${bound}`)
    }
  }
}

export function assertConvergence(seq, opts) {
  const { window = 5, maxVariance = 0.1 } = opts || {}
  if (!Array.isArray(seq) || seq.length < window) {
    throw new Error(`assertConvergence: sequence too short (${seq?.length}) for window=${window}`)
  }
  // Check that the rolling variance over the LAST `window` samples is below maxVariance.
  const tail = seq.slice(-window)
  const mean = tail.reduce((a, b) => a + b, 0) / tail.length
  const variance = tail.reduce((acc, v) => acc + (v - mean) ** 2, 0) / tail.length
  if (variance > maxVariance) {
    throw new Error(
      `Sequence diverges or oscillates: tail variance ${variance.toFixed(4)} > maxVariance ${maxVariance}`
    )
  }
}

export function assertMonotonic(seq, direction = 'increasing') {
  if (!Array.isArray(seq) || seq.length < 2) return
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1]
    const curr = seq[i]
    let ok = true
    switch (direction) {
      case 'increasing':       ok = curr > prev; break
      case 'non-decreasing':   ok = curr >= prev; break
      case 'decreasing':       ok = curr < prev; break
      case 'non-increasing':   ok = curr <= prev; break
      default: throw new Error(`unknown direction: ${direction}`)
    }
    if (!ok) {
      throw new Error(`Monotonic ${direction} violated at index ${i}: ${prev} → ${curr}`)
    }
  }
}

export function assertNoStateOscillation(trace, maxVisits) {
  if (!Array.isArray(trace) || trace.length === 0) return
  const counts = new Map()
  for (const s of trace) {
    counts.set(s, (counts.get(s) || 0) + 1)
  }
  for (const [state, n] of counts) {
    if (n > maxVisits) {
      throw new Error(
        `State oscillation: '${state}' visited ${n}× > maxVisits=${maxVisits}`
      )
    }
  }
}
