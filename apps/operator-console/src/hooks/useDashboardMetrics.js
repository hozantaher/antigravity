// KT-A11 — live dashboard metrics hook.
//
// Three-state lifecycle:
//   'connecting' — initial mount, no payload yet (UI shows skeleton).
//   'live'       — SSE connection open, snapshot updating in place.
//   'polling'    — SSE failed >=3x in a row, fell back to 30s polling.
//
// Returns: { status, globals, campaigns, error, lastUpdatedAt }.
//
// Design contract:
//   * SSE endpoint = /api/dashboard/metrics-stream, polling = /api/dashboard/metrics.
//   * Exponential retry on transient SSE failures (2s, 4s, 8s) before falling
//     back to polling. Fatal (4xx) errors bypass retry and surface error.
//   * Polling tick = 30s (matches design 3.3).
//   * Hook owns no global state. Snapshot lives in component-local React state;
//     callers can lift via useStore wrap if persistence across routes is needed.
//   * EventSource cannot set custom headers, so the BFF auth layer accepts
//     `?token=<api-key>` as fallback (see authMiddleware.js). The hook does
//     NOT inline the token — apps that run with auth enabled must pass it via
//     the `token` option (typically read from a frontend env var on dev,
//     undefined in prod where BFF and SPA share an origin/proxy).

import { useEffect, useRef, useState, useCallback } from 'react'

const DEFAULT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000]
const POLLING_INTERVAL_MS = 30_000
const STREAM_PATH = '/api/dashboard/metrics-stream'
const POLLING_PATH = '/api/dashboard/metrics'

export function useDashboardMetrics(options = {}) {
  const {
    token,
    enabled = true,
    sseFactory,           // test seam: (url) => fakeEventSource
    fetchImpl,            // test seam: replaces global fetch
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, // test seam for fast retries
    pollingIntervalMs = POLLING_INTERVAL_MS,
  } = options

  const [status, setStatus] = useState('connecting')
  const [snapshot, setSnapshot] = useState(null)
  const [error, setError] = useState(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null)

  // Mutable refs survive render churn without re-triggering the effect.
  const esRef = useRef(null)
  const retryRef = useRef(0)
  const pollIntervalRef = useRef(null)
  const retryTimerRef = useRef(null)

  const url = useCallback(
    (base) => (token ? `${base}?token=${encodeURIComponent(token)}` : base),
    [token],
  )

  const cleanup = useCallback(() => {
    if (esRef.current) {
      try { esRef.current.close() } catch { /* */ }
      esRef.current = null
    }
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [])

  const startPolling = useCallback(() => {
    cleanup()
    setStatus('polling')
    const fetcher = fetchImpl || globalThis.fetch
    const tick = async () => {
      try {
        const res = await fetcher(url(POLLING_PATH))
        if (!res.ok) {
          if (res.status >= 400 && res.status < 500) {
            setError(`auth_or_client_${res.status}`)
            cleanup()
            return
          }
          throw new Error(`${res.status} ${res.statusText}`)
        }
        const json = await res.json()
        setSnapshot(json)
        setError(null)
        setLastUpdatedAt(new Date())
      } catch (err) {
        setError(err?.message || String(err))
      }
    }
    tick()
    pollIntervalRef.current = setInterval(tick, pollingIntervalMs)
  }, [cleanup, fetchImpl, url, pollingIntervalMs])

  const connectStream = useCallback(() => {
    const ESCtor = sseFactory || (typeof EventSource !== 'undefined' ? EventSource : null)
    if (!ESCtor) {
      // Environment lacks EventSource — fall straight to polling.
      startPolling()
      return
    }
    cleanup()
    setStatus('connecting')
    let es
    try {
      es = sseFactory ? sseFactory(url(STREAM_PATH)) : new ESCtor(url(STREAM_PATH))
    } catch (err) {
      setError(err?.message || 'sse_init_failed')
      startPolling()
      return
    }
    esRef.current = es

    const handleSnapshot = (evt) => {
      try {
        const data = JSON.parse(evt.data)
        if (data && (data.globals || data.campaigns)) {
          setSnapshot(data)
        }
        setError(null)
        setLastUpdatedAt(new Date())
        retryRef.current = 0
        setStatus('live')
      } catch (parseErr) {
        // Bad JSON — log and ignore; we still consider connection alive.
        setError(`parse_${parseErr?.message || 'failed'}`)
      }
    }

    es.addEventListener('snapshot', handleSnapshot)
    es.addEventListener('tick', handleSnapshot)
    es.addEventListener('hello', () => {
      // hello implies aggregator not ready; stay in connecting until snapshot.
    })

    es.onopen = () => {
      retryRef.current = 0
      // Do NOT flip to 'live' yet — wait for first snapshot.
    }
    es.onerror = () => {
      try { es.close() } catch { /* */ }
      esRef.current = null
      retryRef.current += 1
      if (retryRef.current >= retryDelaysMs.length) {
        startPolling()
        return
      }
      const delay = retryDelaysMs[retryRef.current - 1]
      retryTimerRef.current = setTimeout(() => connectStream(), delay)
    }
  }, [cleanup, sseFactory, startPolling, url, retryDelaysMs])

  useEffect(() => {
    if (!enabled) {
      cleanup()
      return undefined
    }
    connectStream()
    return cleanup
  }, [enabled, connectStream, cleanup])

  return {
    status,
    globals: snapshot?.globals || null,
    campaigns: snapshot?.campaigns || [],
    meta: snapshot?.meta || null,
    error,
    lastUpdatedAt,
  }
}
