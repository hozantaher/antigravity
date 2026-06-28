// Drift-detect — compare a learned step's EXPECTED result against the ACTUAL one. A broken step
// (missing/empty field, changed value, empty result) must surface as drift — never pass silently as
// success. The loop is only alive if it can notice it stopped working (ADR 0002, heal phase).
export function detectDrift(expected, actual) {
  if (actual == null) return { drift: true, reason: 'empty result' }
  for (const k of Object.keys(expected)) {
    if (!(k in actual) || actual[k] === '' || actual[k] == null) return { drift: true, reason: `missing/empty field: ${k}` }
    if (actual[k] !== expected[k]) return { drift: true, reason: `field changed: ${k}` }
  }
  return { drift: false, reason: 'matches expectation' }
}
