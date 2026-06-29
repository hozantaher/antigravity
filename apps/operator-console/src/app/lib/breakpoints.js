// breakpoints.js — single source of truth for responsive thresholds (S0).
//
// Per HARD RULE feedback_no_magic_thresholds: every responsive threshold is a
// NAMED constant here, not a magic number scattered across CSS/JS. CSS @media
// rules can't read JS custom properties, so the density DECISION lives here
// (JS, testable) and the density STYLING keys off `[data-density]` in
// tokens.css. See docs/initiatives/2026-06-24-laptop-responsivity-density.md.
//
// Mobile-first convention: a threshold is the MAX width/height at which the
// "smaller" branch applies.

export const BP_PHONE = 640    // ≤ phone
export const BP_TABLET = 1024  // ≤ tablet
export const BP_LAPTOP = 1440  // ≤ this width  → laptop band → auto-compact
export const BP_SHORT = 820    // ≤ this height → short screen → auto-compact

// The media query that decides auto-compact: laptop-narrow OR short. A comma is
// OR in media queries, so this matches when EITHER holds. The operator's
// 1366×768 trips both; 1440×900 trips the width; a big desktop trips neither.
export const COMPACT_MEDIA_QUERY = `(max-width: ${BP_LAPTOP}px), (max-height: ${BP_SHORT}px)`

export const DENSITY_AUTO = 'auto'
export const DENSITY_COMPACT = 'compact'
export const DENSITY_COMFORTABLE = 'comfortable'

// Resolve the effective density from the stored preference + a viewport probe.
// pref === 'auto' (or anything unknown) → derive from the viewport; an explicit
// 'compact' / 'comfortable' always wins.
export function resolveDensity(pref, viewportIsCompact) {
  if (pref === DENSITY_COMPACT || pref === DENSITY_COMFORTABLE) return pref
  return viewportIsCompact ? DENSITY_COMPACT : DENSITY_COMFORTABLE
}

// True when the current window is in the auto-compact band. Guarded for SSR /
// test environments without matchMedia.
export function viewportIsCompact() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(COMPACT_MEDIA_QUERY).matches
}
