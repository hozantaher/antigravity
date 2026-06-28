import { useCallback, useEffect, useState } from 'react'
import { DEFAULTS } from '../lib/filterSerializer.js'

// localStorage-backed named filter snapshots (Sprint 4.1).
//
// A preset stores everything that shapes the result set — filter values and
// sort — but NOT `offset`, which resets on apply like it does for every other
// filter change. Presets are shared across tabs via the `storage` event so a
// save in one tab shows up in the dropdown of another without a reload.

const STORAGE_KEY = 'companies.filterPresets.v1'

// Keys that belong in a preset. `offset` intentionally excluded — it's a
// pagination cursor, not a filter. `sort`/`dir` are included because saved
// views usually imply an ordering ("top unverified by score DESC").
const PRESET_KEYS = Object.keys(DEFAULTS).filter(k => k !== 'offset')

function safeParse(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    // Corrupted JSON — treat as empty. Log so the bad value is discoverable.
    // eslint-disable-next-line no-console
    console.warn('[useFilterPresets] corrupted presets JSON, resetting:', e?.message || e)
    return []
  }
}

function readPresets() {
  if (typeof window === 'undefined') return []
  try {
    return safeParse(window.localStorage.getItem(STORAGE_KEY))
  } catch (e) {
    // Private mode / disabled storage — return empty, surface in console.
    // eslint-disable-next-line no-console
    console.warn('[useFilterPresets] localStorage read failed:', e?.message || e)
    return []
  }
}

function writePresets(list) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch (e) {
    // Quota exceeded / private mode — presets are best-effort, but log so
    // callers can diagnose "save clicked but preset didn't appear".
    // eslint-disable-next-line no-console
    console.warn('[useFilterPresets] localStorage write failed:', e?.message || e)
  }
}

function pickPresetSlice(filters) {
  const out = {}
  for (const k of PRESET_KEYS) {
    if (k in filters) out[k] = filters[k]
  }
  return out
}

function newId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function useFilterPresets() {
  const [presets, setPresets] = useState(readPresets)

  // Cross-tab sync: other tabs rewriting the key should update our state.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (e) => {
      if (e.key !== STORAGE_KEY) return
      setPresets(safeParse(e.newValue))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const save = useCallback((name, filters) => {
    const trimmed = String(name ?? '').trim()
    if (!trimmed) return null
    const slice = pickPresetSlice(filters)
    const preset = { id: newId(), name: trimmed, createdAt: Date.now(), filters: slice }
    setPresets(prev => {
      // Upsert by name so re-saving a named view doesn't spawn duplicates.
      const existingIdx = prev.findIndex(p => p.name === trimmed)
      const next = existingIdx >= 0
        ? prev.map((p, i) => i === existingIdx ? { ...p, filters: slice, createdAt: preset.createdAt } : p)
        : [...prev, preset]
      writePresets(next)
      return next
    })
    return preset
  }, [])

  const remove = useCallback((id) => {
    setPresets(prev => {
      const next = prev.filter(p => p.id !== id)
      writePresets(next)
      return next
    })
  }, [])

  const rename = useCallback((id, name) => {
    const trimmed = String(name ?? '').trim()
    if (!trimmed) return
    setPresets(prev => {
      const next = prev.map(p => p.id === id ? { ...p, name: trimmed } : p)
      writePresets(next)
      return next
    })
  }, [])

  // Returns a patch object suitable for useCompanyFilters.setFilters(patch).
  // Merges preset values onto DEFAULTS so a preset saved before a new filter
  // was introduced still clears fields the caller didn't persist.
  const toPatch = useCallback((id) => {
    const p = presets.find(x => x.id === id)
    if (!p) return null
    const patch = {}
    for (const k of PRESET_KEYS) {
      patch[k] = k in p.filters ? p.filters[k] : DEFAULTS[k]
    }
    return patch
  }, [presets])

  return { presets, save, remove, rename, toPatch }
}

export const __test = { PRESET_KEYS, STORAGE_KEY, pickPresetSlice }
