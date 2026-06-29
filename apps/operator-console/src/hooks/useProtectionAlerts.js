import { useCallback, useMemo, useState } from 'react'
import { useResource } from './useResource.js'

const DEFAULT_INTERVAL_MS = 30_000

function parseAlerts(raw) {
  return Array.isArray(raw?.alerts) ? raw.alerts : []
}

/**
 * useProtectionAlerts — polls GET /api/protections/alerts, exposes
 * critical/warning counts, and POSTs acknowledgements.
 *
 * Built on useResource (4-state: idle|loading|ok|error). `ackError` is
 * exposed explicitly so the UI can show why an ack failed instead of
 * silently no-op'ing the way the previous `await fetch(...).catch(...)`
 * implementation did.
 */
export function useProtectionAlerts(intervalMs = DEFAULT_INTERVAL_MS) {
  const resource = useResource('/api/protections/alerts', {
    pollMs: intervalMs && intervalMs > 0 ? intervalMs : 0,
    parse: parseAlerts,
    initialData: [],
  })

  const alerts = resource.data ?? []
  const [ackError, setAckError] = useState(null)

  const ack = useCallback(async (id) => {
    setAckError(null)
    try {
      const res = await fetch(`/api/protections/alerts/${id}/ack`, { method: 'POST' })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    } catch (e) {
      const msg = e?.message || String(e)
      setAckError(msg)
      throw e
    }
    await resource.refresh()
  }, [resource.refresh])

  const { criticalCount, warnCount } = useMemo(() => ({
    criticalCount: alerts.filter(a => a.severity === 'critical' && a.status === 'open').length,
    warnCount: alerts.filter(a => a.severity === 'warning' && a.status === 'open').length,
  }), [alerts])

  return {
    alerts,
    criticalCount,
    warnCount,
    // Preserve legacy boolean shape: only `true` during initial load.
    loading: resource.status === 'idle' || resource.status === 'loading',
    error: resource.status === 'error' ? resource.error : null,
    status: resource.status,
    refresh: resource.refresh,
    ack,
    ackError,
  }
}
