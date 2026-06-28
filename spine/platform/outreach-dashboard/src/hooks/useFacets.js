import { useEffect, useState } from 'react'

// Cached by the server for 30s; we keep a module-level snapshot so repeated
// mounts (drawer open/close, route toggles) don't re-fetch within the window.
let _snap = null        // { value, fetchedAt }
const TTL_MS = 30_000
const subs = new Set()
let inflight = null

function broadcast() {
  for (const fn of subs) fn(_snap?.value ?? null)
}

async function fetchFacets() {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const r = await fetch('/api/companies/facets')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const value = await r.json()
      _snap = { value, fetchedAt: Date.now() }
      broadcast()
    } catch (e) {
      // Facets are a UX nice-to-have — keep last snapshot so filter counts
      // don't disappear on a transient network blip. Log for observability
      // so the silent fall-back stays visible in devtools.
      // eslint-disable-next-line no-console
      console.warn('[useFacets] fetch failed, keeping last snapshot:', e?.message || e)
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function refreshFacets() {
  _snap = null
  return fetchFacets()
}

export function useFacets() {
  const [value, setValue] = useState(_snap?.value ?? null)

  useEffect(() => {
    subs.add(setValue)
    const stale = !_snap || Date.now() - _snap.fetchedAt > TTL_MS
    if (stale) fetchFacets()
    return () => { subs.delete(setValue) }
  }, [])

  return value
}
