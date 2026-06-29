// 24-hour ring buffer for proxy-pool working-count samples. One sample per
// 5-min tick = 288 slots. In-memory only — a BFF restart drops history, which
// is acceptable: the sparkline exists to answer "is the pool trending up, flat,
// or down over the last day?" and a quick restart just shortens the window.
//
// Pure module; no DB, no HTTP. The ticker in server.js calls recordSample()
// and the endpoint reads via snapshot(). Keeping it pure lets the tests drive
// the ring without mocking time or HTTP.

const SLOT_MS = 5 * 60 * 1000
const WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_SAMPLES = Math.floor(WINDOW_MS / SLOT_MS) // 288

const samples = []

export function recordSample({ working, totalCandidates, timestamp } = {}) {
  const ts = timestamp instanceof Date ? timestamp.getTime() : (timestamp || Date.now())
  samples.push({
    ts,
    working: Math.max(0, Number(working) || 0),
    total_candidates: Math.max(0, Number(totalCandidates) || 0),
  })
  // Trim by count first (cheap); then drop anything older than window.
  while (samples.length > MAX_SAMPLES) samples.shift()
  const cutoff = ts - WINDOW_MS
  while (samples.length && samples[0].ts < cutoff) samples.shift()
}

export function snapshot() {
  return {
    samples: samples.map(s => ({ ts: new Date(s.ts).toISOString(), working: s.working, total_candidates: s.total_candidates })),
    count: samples.length,
    window_ms: WINDOW_MS,
    slot_ms: SLOT_MS,
    stats: computeStats(samples),
  }
}

function computeStats(arr) {
  if (!arr.length) return { min: 0, max: 0, avg: 0, current: 0 }
  let sum = 0, min = Infinity, max = -Infinity
  for (const s of arr) {
    sum += s.working
    if (s.working < min) min = s.working
    if (s.working > max) max = s.working
  }
  return {
    min,
    max,
    avg: Math.round((sum / arr.length) * 10) / 10,
    current: arr[arr.length - 1].working,
  }
}

export function reset() { samples.length = 0 }

export const POOL_TREND_CONSTANTS = { SLOT_MS, WINDOW_MS, MAX_SAMPLES }
