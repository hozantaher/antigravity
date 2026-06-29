import { useEffect, useState, useCallback, useRef } from 'react'

// 4-state fetch hook. Replaces the `.catch(() => {})` + null-as-loading
// pattern that was the dominant source of silent-fail UI across the Mailboxes
// page (see project memory "Schránky quality debt" 2026-04-21).
//
// Returns:
//   status:    'idle' | 'loading' | 'ok' | 'error'
//   data:      parsed JSON on 'ok', else initialData
//   error:     string on 'error', else null
//   loadedAt:  Date of last successful load, else null
//   refresh:   () => Promise<void> — force a reload
//
// Options:
//   pollMs:      number (default 0, no polling)
//   enabled:     gate initial + interval loads (default true)
//   parse:       (raw) => data — optional transform
//   initialData: seed value (default null)
//   pauseHidden: skip polls while document.hidden (default true)
//
// Usage:
//   const pool = useResource('/api/proxy-pool', { pollMs: 30_000 })
//   if (pool.status === 'error') return <ErrorBadge msg={pool.error}/>
//   if (pool.status === 'loading' && !pool.data) return <Skeleton/>
//   return <PoolHealth data={pool.data}/>

// Module-level in-flight coalescing map: URL → Promise.
// Prevents concurrent identical requests from different hook instances
// (rapid SPA nav remounts) all racing to the same endpoint simultaneously.
// TTL is short — just long enough to absorb burst remounts on route flips.
const COALESCE_TTL_MS = 300
const _inFlight = new Map() // url → { promise, expiresAt }
// NOTE (2026-05-29 integration fix): coalescedFetch must NOT bind a caller's
// AbortController signal into the shared promise. Doing so coupled every
// coalesced waiter to the FIRST caller's signal — under React StrictMode the
// mount→cleanup→remount cycle aborts that signal, then the legitimate remount
// awaits the already-aborted shared promise, hits AbortError, and silently
// leaves status='loading' forever (every useResource page hung). Cancellation
// is handled purely by the per-hook incrementing token (loadTokenRef), which
// drops stale state updates without killing the in-flight request. The 300ms
// dedup window remains the primary rapid-nav 429 guard (the abort added only
// ~6% on the monkey 429 benchmark — not worth the stuck-loading regression).
function coalescedFetch(url) {
  const now = Date.now()
  const entry = _inFlight.get(url)
  if (entry && entry.expiresAt > now) {
    return entry.promise
  }
  const promise = fetch(url)
  _inFlight.set(url, { promise, expiresAt: now + COALESCE_TTL_MS })
  // Clean up map entry once the fetch settles so aborted entries don't stick.
  promise.then(
    () => { if (_inFlight.get(url)?.promise === promise) _inFlight.delete(url) },
    () => { if (_inFlight.get(url)?.promise === promise) _inFlight.delete(url) }
  )
  return promise
}

// Named constants — no magic numbers (feedback_no_magic_thresholds T0).
const COALESCE_WINDOW_MS = COALESCE_TTL_MS

export { COALESCE_WINDOW_MS }

// HTTP status codes that should resolve to empty initialData rather than
// setting status='error'. 404 is the primary case: a not-found entity from
// a search-driven URL is semantically "no results", not a crash.
// Named constant — no magic numbers (feedback_no_magic_thresholds T0).
const SILENT_STATUS_CODES_DEFAULT = [404]

export function useResource(url, options = {}) {
  const {
    pollMs = 0,
    enabled = true,
    parse,
    initialData = null,
    pauseHidden = true,
    // silentStatuses: HTTP status codes that yield empty initialData instead of error.
    // Pass [] to disable (useful when the caller wants to distinguish 404 as error).
    silentStatuses = SILENT_STATUS_CODES_DEFAULT,
  } = options

  const [status, setStatus] = useState('idle')
  const [data, setData] = useState(initialData)
  const [error, setError] = useState(null)
  const [loadedAt, setLoadedAt] = useState(null)
  // Cancellation is purely token-based: a superseded/unmounted load drops its
  // state updates via the myToken !== loadTokenRef.current guard. We do NOT
  // abort the underlying fetch — binding a caller's AbortSignal into the
  // cross-instance coalesced promise caused StrictMode mount→cleanup→remount to
  // abort the shared request and hang every consumer at status='loading'.
  // Rapid-nav 429 protection comes from coalescedFetch's 300ms dedup window.
  const loadTokenRef = useRef(0)
  const parseRef = useRef(parse)
  parseRef.current = parse

  const load = useCallback(async () => {
    const resolvedUrl = typeof url === 'function' ? url() : url
    if (!resolvedUrl || !enabled) return

    // Cancellation is token-based (loadTokenRef): a superseded load drops its
    // state updates via the myToken !== loadTokenRef.current guard below. We do
    // NOT abort the underlying fetch — aborting a coalesced shared promise was
    // the source of the StrictMode stuck-loading bug (see coalescedFetch note).
    const myToken = ++loadTokenRef.current
    setStatus(prev => (prev === 'ok' ? 'ok' : 'loading'))
    try {
      // coalescedFetch deduplicates concurrent requests for the same URL across
      // all hook instances within COALESCE_WINDOW_MS. This is the primary guard
      // against monkey-style rapid-nav triggering 4× concurrent fetches on
      // the same route.
      const res = await coalescedFetch(resolvedUrl)
      if (myToken !== loadTokenRef.current) return
      // Treat selected status codes (default: 404) as "no data" rather than an error.
      // This prevents search-garbage URLs from polluting error state and console logs.
      if (!res.ok && silentStatuses.includes(res.status)) {
        setData(initialData)
        setError(null)
        setStatus('ok')
        setLoadedAt(new Date())
        return
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const raw = await res.json()
      if (myToken !== loadTokenRef.current) return
      const next = parseRef.current ? parseRef.current(raw) : raw
      setData(next)
      setError(null)
      setStatus('ok')
      setLoadedAt(new Date())
    } catch (e) {
      if (myToken !== loadTokenRef.current) return
      // AbortError can only appear from an external fetch abort; we no longer
      // abort, but keep the guard so any host-injected abort stays silent.
      if (e?.name === 'AbortError') return
      setError(e?.message || String(e))
      setStatus('error')
    }
  }, [url, enabled])

  useEffect(() => {
    if (!enabled) return undefined
    load()
    if (!pollMs || pollMs <= 0) {
      // Bump the token on unmount so a late-arriving response drops its state
      // update (no fetch abort — see coalescedFetch note).
      return () => { loadTokenRef.current++ }
    }
    const id = setInterval(() => {
      if (pauseHidden && typeof document !== 'undefined' && document.hidden) return
      load()
    }, pollMs)
    return () => {
      clearInterval(id)
      loadTokenRef.current++
    }
  }, [load, pollMs, enabled, pauseHidden])

  return { status, data, error, loadedAt, refresh: load }
}
