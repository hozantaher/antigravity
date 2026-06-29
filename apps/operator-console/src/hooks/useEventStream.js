import { useEffect, useRef } from 'react'

// Thin EventSource wrapper for the BFF's SSE surfaces:
//   GET /api/replies/stream  → `reply_inserted` (replies.js F1)
//   GET /api/threads/stream  → `inbound`        (threads.js)
//
// Registers a listener per named event, tears the connection down on unmount /
// url change. EventSource reconnects natively on a dropped stream, so the page
// keeps receiving live events without us re-implementing backoff; callers ALSO
// keep a polling fallback for the case the stream never establishes (a proxy
// that doesn't pass SSE through). The error event is swallowed — a flaky stream
// must never spam the operator-strict smoke gate (feedback_smoke_gate_operator_strict)
// nor the console.
//
// `events` must be a STABLE array reference (module-level constant) or the
// effect re-subscribes every render. Pass null/'' as url, or enabled:false, to
// disable (e.g. before a reply is selected).

export function useEventStream(url, { events = ['message'], onEvent, enabled = true } = {}) {
  const onRef = useRef(onEvent)
  onRef.current = onEvent

  useEffect(() => {
    if (!enabled || !url || typeof EventSource === 'undefined') return undefined
    let es
    try {
      es = new EventSource(url)
    } catch {
      return undefined
    }
    const bound = events.map((type) => {
      const fn = (e) => {
        let data = null
        try { data = e?.data ? JSON.parse(e.data) : null } catch { data = null }
        onRef.current?.(type, data, e)
      }
      es.addEventListener(type, fn)
      return [type, fn]
    })
    const onErr = () => { /* native EventSource retries; swallow to keep console clean */ }
    es.addEventListener('error', onErr)

    return () => {
      bound.forEach(([type, fn]) => es.removeEventListener(type, fn))
      es.removeEventListener('error', onErr)
      es.close()
    }
  }, [url, enabled, events])
}
