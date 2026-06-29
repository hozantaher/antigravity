// HXX2 — Counterfactual heal validation.
// Compares "heal applied" vs "heal NOT applied" via ShadowRunner; classifies
// the metric delta as net_positive / net_negative / no_op / indeterminate.

export const COUNTERFACTUAL_VERDICTS = Object.freeze({
  NET_POSITIVE:  'net_positive',
  NET_NEGATIVE:  'net_negative',
  NO_OP:         'no_op',
  INDETERMINATE: 'indeterminate',
})

export function classifyDelta(delta, epsilon = 1) {
  if (!Number.isFinite(delta)) return COUNTERFACTUAL_VERDICTS.INDETERMINATE
  if (delta > epsilon) return COUNTERFACTUAL_VERDICTS.NET_POSITIVE
  if (delta < -epsilon) return COUNTERFACTUAL_VERDICTS.NET_NEGATIVE
  return COUNTERFACTUAL_VERDICTS.NO_OP
}

export function evaluateCounterfactual({ shadowRunner, primaryFn, shadowFn, metric, epsilon = 1 } = {}) {
  if (typeof primaryFn !== 'function') throw new Error('evaluateCounterfactual: primaryFn required')
  if (typeof shadowFn !== 'function')  throw new Error('evaluateCounterfactual: shadowFn required')
  if (typeof metric !== 'function')    throw new Error('evaluateCounterfactual: metric required')

  let primaryState, shadowState
  try {
    primaryState = primaryFn()
    shadowState  = shadowFn()
  } catch (e) {
    return {
      verdict: COUNTERFACTUAL_VERDICTS.INDETERMINATE,
      delta: NaN,
      primary: NaN,
      shadow: NaN,
      primaryState: null,
      shadowState: null,
      error: e?.message || String(e),
    }
  }

  let primary, shadow
  try {
    primary = metric(primaryState)
    shadow  = metric(shadowState)
  } catch (e) {
    return {
      verdict: COUNTERFACTUAL_VERDICTS.INDETERMINATE,
      delta: NaN,
      primary: NaN,
      shadow: NaN,
      primaryState,
      shadowState,
      error: e?.message || String(e),
    }
  }

  if (!Number.isFinite(primary) || !Number.isFinite(shadow)) {
    return {
      verdict: COUNTERFACTUAL_VERDICTS.INDETERMINATE,
      delta: NaN,
      primary, shadow, primaryState, shadowState,
    }
  }

  const delta = primary - shadow
  return {
    verdict: classifyDelta(delta, epsilon),
    delta, primary, shadow, primaryState, shadowState,
  }
}
