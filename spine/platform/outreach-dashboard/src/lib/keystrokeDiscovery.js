/**
 * Keystroke discovery tracking — manages localStorage state for inline
 * keystroke badge visibility.
 *
 * Rank 4 (inline keystroke hints) feature: show faint keystroke badges
 * inline with affordances, then fade them after the operator uses that
 * key once per session (localStorage).
 */

const STORAGE_KEY = 'replies_keystroke_badges_used'
const SESSION_STORAGE_KEY = 'replies_keystroke_discovery_session'

/**
 * Returns true if the keystroke badge should be visible for the given key.
 * @param {string} key - The keystroke key (e.g., 'p', 'n', 'j', 'k')
 * @returns {boolean}
 */
export function shouldShowKeystrokeBadge(key) {
  if (typeof localStorage === 'undefined') return true
  const used = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  return !used[key.toLowerCase()]
}

/**
 * Mark a keystroke as used, which hides the badge for future renders.
 * @param {string} key - The keystroke key (e.g., 'p', 'n', 'j', 'k')
 */
export function markKeystrokeUsed(key) {
  if (typeof localStorage === 'undefined') return
  const used = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  used[key.toLowerCase()] = true
  localStorage.setItem(STORAGE_KEY, JSON.stringify(used))
}

/**
 * Reset all keystroke badges (for testing or explicit reset).
 */
export function resetKeystrokeBadges() {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(STORAGE_KEY)
}

/**
 * Check if any keystroke badge is still visible in the current session.
 * Used to decide whether to show the '?' discoverability cue.
 * @returns {boolean}
 */
export function hasVisibleKeystrokeBadges() {
  if (typeof localStorage === 'undefined') return true
  const used = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  // Return true if the object is empty (no keys marked as used yet)
  return Object.keys(used).length === 0
}
