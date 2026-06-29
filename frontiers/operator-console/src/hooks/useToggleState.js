import { useState, useCallback, useEffect } from 'react'

/**
 * useToggleState — localStorage-persisted boolean toggle.
 *
 * Used by /mailboxes (U2 cleanup) to hide low-signal panels (health
 * board, filter bar, drawer Pokročilé sub-sections) behind operator
 * controls. Defaults to `false` so first-time visit shows the leanest
 * possible layout; operator can opt-in to noisier views.
 *
 * Memory: `feedback_no_magic_thresholds` (T0) — every storage key is a
 * named constant; callers pass the key explicitly so it shows up in
 * grep / search.
 *
 * @param {string}  key           localStorage key (e.g. 'mb.showHealthBoard')
 * @param {boolean} defaultValue  value when key missing or storage unavailable
 * @returns {[boolean, (next?: boolean) => void]}  current value + toggle setter
 */
export function useToggleState(key, defaultValue = false) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw == null) return defaultValue
      return raw === 'true'
    } catch {
      return defaultValue
    }
  })

  useEffect(() => {
    try { localStorage.setItem(key, String(value)) } catch { /* private mode */ }
  }, [key, value])

  const toggle = useCallback((next) => {
    setValue(prev => typeof next === 'boolean' ? next : !prev)
  }, [])

  return [value, toggle]
}

// Named storage keys (HARD RULE: feedback_no_magic_thresholds).
// Centralized so a grep `MB_LS_*` / `CD_LS_*` reveals every persisted UI toggle.
export const MB_LS_SHOW_HEALTH_BOARD = 'mb.showHealthBoard'
export const MB_LS_SHOW_FILTERS      = 'mb.showFilters'
export const MB_LS_SHOW_DIAG_DETAIL  = 'mb.drawer.showDiagDetail'
export const MB_LS_SHOW_STATS        = 'mb.drawer.showStats'

// CampaignDetail (U3 operator-focused cleanup) — every collapsible card on
// the page persists its open/closed state per-operator so the layout the
// operator picks stays sticky across refreshes. Defaults are conservative
// (false = collapsed) so first-time loads show the leanest possible page.
export const CD_LS_SHOW_TIMING        = 'cd.showTiming'
export const CD_LS_SHOW_SEND_WINDOW   = 'cd.showSendWindow'
export const CD_LS_SHOW_QUEUE_HEALTH  = 'cd.showQueueHealth'
export const CD_LS_SHOW_RECOVERY      = 'cd.showRecovery'

// ThreadDetail (Y3 operator-focused cleanup) — daily workflow is read inbound
// reply → classify → compose response → send. The right-rail context sidebar
// (firma/kampaň/klasifikace block) duplicates the top context bar
// (Firma + IČO + ICP + region chips + Z kampaně deep-link).
//
// AS-F3 (2026-05-19) — default state is now derived from viewport width.
// On wide displays (>= SIDEBAR_DEFAULT_OPEN_VIEWPORT_PX) the operator's Mac
// has plenty of room, so the right-rail sidebar opens by default. On
// narrower viewports it stays collapsed so the message column claims the
// full content width. Explicit persisted state (localStorage) always wins
// over the viewport-derived default.
export const TD_LS_SHOW_SIDEBAR       = 'td.showSidebar'

// AS-F3 (2026-05-19) — viewport threshold for default-open right-rail
// sidebar on /replies/:id. Named constant per HARD RULE
// feedback_no_magic_thresholds T0. 1280px matches Tailwind's `xl`
// breakpoint and Vite's default viewport assumption for desktop ops.
export const SIDEBAR_DEFAULT_OPEN_VIEWPORT_PX = 1280

/**
 * useToggleStateWithViewportDefault — variant of useToggleState whose
 * default value is derived from window width at mount time when no
 * explicit localStorage entry exists yet.
 *
 * - localStorage value present (string 'true'/'false') → that wins
 * - localStorage absent + width >= minViewportPx → defaults true
 * - localStorage absent + width <  minViewportPx → defaults false
 *
 * Once the operator toggles manually, the resulting boolean is
 * persisted to localStorage and that wins over the viewport rule on
 * subsequent reloads.
 *
 * @param {string} key           localStorage key
 * @param {number} minViewportPx viewport-width threshold (named constant)
 * @returns {[boolean, (next?: boolean) => void]}
 */
export function useToggleStateWithViewportDefault(key, minViewportPx) {
  return useToggleState(key, isWideViewport(minViewportPx))
}

function isWideViewport(minViewportPx) {
  try {
    return typeof window !== 'undefined'
      && typeof window.innerWidth === 'number'
      && window.innerWidth >= minViewportPx
  } catch {
    return false
  }
}
