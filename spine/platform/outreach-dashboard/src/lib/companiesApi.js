// Stale-response discard for /api/companies fetches. Each caller gets a
// token; a newer call supersedes older ones, and any in-flight response
// from a superseded call is discarded rather than racing into state.
//
// We tried AbortController originally but jsdom's AbortSignal is not
// accepted by Node's undici fetch under vitest ("Expected signal to be
// an instance of AbortSignal"), breaking tests. Token-based discard is
// simpler, works in both environments, and solves the same race.

const tokens = new Map()

async function doFetch(path, qs, callerKey) {
  const token = Symbol(callerKey)
  tokens.set(callerKey, token)
  try {
    const r = await fetch(path + '?' + qs)
    if (tokens.get(callerKey) !== token) return { aborted: true }
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } catch (e) {
    if (tokens.get(callerKey) !== token) return { aborted: true }
    throw e
  } finally {
    if (tokens.get(callerKey) === token) tokens.delete(callerKey)
  }
}

export function fetchCompanies(qs, { callerKey = 'default' } = {}) {
  return doFetch('/api/companies', qs, callerKey)
}

export function fetchCompaniesCount(qs, { callerKey = 'count' } = {}) {
  return doFetch('/api/companies/count', qs, callerKey)
}
