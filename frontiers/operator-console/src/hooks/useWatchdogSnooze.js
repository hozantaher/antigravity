// Persistent snooze state for Watchdog alerts.
// Key: 'watchdog:snoozed:v1'
// Value: { [alertKey]: snoozedUntilTimestamp }
//
// alertKey = stable hash of (check_name, target, severity) that survives
// page refresh and navigation.  We use a simple join because the fields
// are all ASCII slugs — no collision risk in practice.

import { useState, useCallback } from 'react'

const LS_KEY = 'watchdog:snoozed:v1'

export const SNOOZE_DURATIONS = {
  '1h':        60 * 60 * 1000,
  '4h':        4 * 60 * 60 * 1000,
  'end_of_day': null,   // computed at call time
  'permanent':  null,   // year 2099
}

// Derive a stable string key from an alert event object.
export function alertKey(ev) {
  const target = ev.target ?? ev.mailbox ?? ''
  return `${ev.check_name}::${target}::${ev.severity}`
}

// Compute the timestamp (ms since epoch) for the given duration option.
export function snoozeUntil(option) {
  const now = Date.now()
  if (option === '1h')  return now + 60 * 60 * 1000
  if (option === '4h')  return now + 4 * 60 * 60 * 1000
  if (option === 'end_of_day') {
    const d = new Date()
    d.setHours(23, 59, 59, 999)
    return d.getTime()
  }
  if (option === 'permanent') {
    return new Date('2099-01-01T00:00:00.000Z').getTime()
  }
  throw new Error(`Unknown snooze option: ${option}`)
}

// Read raw map from localStorage, returning {} on any failure.
function readRaw() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

// Write map back, ignoring errors (private/incognito mode etc.).
function writeRaw(map) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(map))
  } catch {
    // best-effort
  }
}

// Return the map pruned of all expired entries.
export function pruneExpired(map, now = Date.now()) {
  const result = {}
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === 'number' && v > now) {
      result[k] = v
    }
  }
  return result
}

// ---------- hook ----------

export function useWatchdogSnooze() {
  // Initialise from localStorage, pruning stale entries.
  const [snoozeMap, setSnoozeMap] = useState(() => pruneExpired(readRaw()))

  // Persist + update state atomically.
  const persist = useCallback((updater) => {
    setSnoozeMap(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      const pruned = pruneExpired(next)
      writeRaw(pruned)
      return pruned
    })
  }, [])

  // Add a snooze for an event with a duration option.
  const snooze = useCallback((ev, option) => {
    const key = alertKey(ev)
    const until = snoozeUntil(option)
    persist(prev => ({ ...prev, [key]: until }))
  }, [persist])

  // Remove a snooze.
  const unsnooze = useCallback((ev) => {
    const key = alertKey(ev)
    persist(prev => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [persist])

  // Check if an event is currently snoozed.
  const isSnoozed = useCallback((ev) => {
    const until = snoozeMap[alertKey(ev)]
    if (typeof until !== 'number') return false
    return until > Date.now()
  }, [snoozeMap])

  // Milliseconds remaining on a snoozed alert (0 if not snoozed).
  const remainingMs = useCallback((ev) => {
    const until = snoozeMap[alertKey(ev)]
    if (typeof until !== 'number') return 0
    return Math.max(0, until - Date.now())
  }, [snoozeMap])

  // Prune expired entries (call on render / on timer).
  const pruneNow = useCallback(() => {
    persist(prev => pruneExpired(prev))
  }, [persist])

  return { snoozeMap, snooze, unsnooze, isSnoozed, remainingMs, pruneNow }
}
