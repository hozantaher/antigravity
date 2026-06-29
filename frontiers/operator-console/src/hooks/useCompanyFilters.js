import { useCallback, useMemo, useRef, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  DEFAULTS,
  parseFilters,
  serializeFilters,
  toServerQuery as toServerQueryPure,
  hasActiveFilters as hasActiveFiltersPure,
  activeFilterKeys,
} from '../lib/filterSerializer.js'

// Per-key debounce in ms. 0 = immediate. Debounced writes use replace history.
const DEBOUNCE_MS = {
  q: 300,
  scoreMin: 200,
  scoreMax: 200,
  emailConfidenceMin: 200,
}

// Keys whose change should reset offset (pagination) back to 0.
const RESET_OFFSET_ON_CHANGE = new Set(Object.keys(DEFAULTS).filter(k => k !== 'offset'))

export function useCompanyFilters() {
  const [params, setParams] = useSearchParams()
  const timers = useRef(new Map())

  // Clear timers on unmount so pending updates don't hit an unmounted tree.
  useEffect(() => () => {
    for (const t of timers.current.values()) clearTimeout(t)
    timers.current.clear()
  }, [])

  // params is a fresh URLSearchParams on every render — memoize via string key
  // so downstream memos (toServerQuery, callers' useEffect deps) stay stable.
  const paramsKey = params.toString()
  const filters = useMemo(() => parseFilters(new URLSearchParams(paramsKey)), [paramsKey])

  // Use functional setParams so commits stack on the freshest URL state.
  // This matters for MemoryRouter (tests) where window.location doesn't update
  // and for rapid successive writes that must not overwrite each other.
  const applyChange = useCallback((key, value) => {
    const debounce = DEBOUNCE_MS[key] ?? 0
    const replace = debounce > 0

    const commit = () => {
      setParams(prev => {
        const current = parseFilters(prev)
        const next = { ...current, [key]: value }
        if (RESET_OFFSET_ON_CHANGE.has(key)) next.offset = 0
        return serializeFilters(next)
      }, { replace })
    }

    if (debounce > 0) {
      clearTimeout(timers.current.get(key))
      timers.current.set(key, setTimeout(commit, debounce))
    } else {
      clearTimeout(timers.current.get(key))
      timers.current.delete(key)
      commit()
    }
  }, [setParams])

  const setFilter = useCallback((key, value) => {
    applyChange(key, value)
  }, [applyChange])

  const setFilters = useCallback((patch) => {
    setParams(prev => {
      const current = parseFilters(prev)
      const next = { ...current, ...patch }
      const touchesNonOffset = Object.keys(patch).some(k => RESET_OFFSET_ON_CHANGE.has(k))
      if (touchesNonOffset) next.offset = 0
      return serializeFilters(next)
    }, { replace: false })
  }, [setParams])

  const clearFilter = useCallback((key) => {
    applyChange(key, DEFAULTS[key])
  }, [applyChange])

  const clearAll = useCallback(() => {
    for (const t of timers.current.values()) clearTimeout(t)
    timers.current.clear()
    setParams(prev => {
      const current = parseFilters(prev)
      return serializeFilters({ ...DEFAULTS, sort: current.sort, dir: current.dir })
    }, { replace: false })
  }, [setParams])

  // Flush any pending debounced write immediately (for blur / Enter).
  const flush = useCallback(() => {
    for (const [key, timer] of timers.current.entries()) {
      clearTimeout(timer)
      timers.current.delete(key)
    }
  }, [])

  const hasActive = useMemo(() => hasActiveFiltersPure(filters), [filters])
  const active = useMemo(() => activeFilterKeys(filters), [filters])

  const toServerQuery = useCallback((opts) => toServerQueryPure(filters, opts), [filters])

  return {
    filters,
    setFilter,
    setFilters,
    clearFilter,
    clearAll,
    flush,
    hasActive,
    active,
    toServerQuery,
  }
}
