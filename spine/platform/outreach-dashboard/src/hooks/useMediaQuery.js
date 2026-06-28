import { useEffect, useState } from 'react'

/**
 * Subscribe to a CSS media query and re-render on change. SSR/jsdom-safe:
 * returns `false` when matchMedia is unavailable (e.g. older test env), and
 * uses the modern addEventListener('change') API with a removeListener
 * fallback for Safari < 14.
 *
 * @param {string} query e.g. '(min-width: 1100px)'
 * @returns {boolean} whether the query currently matches
 */
export function useMediaQuery(query) {
  const get = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false

  const [matches, setMatches] = useState(get)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange() // sync in case the query changed between render and effect
    if (mql.addEventListener) mql.addEventListener('change', onChange)
    else mql.addListener(onChange) // Safari < 14
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange)
      else mql.removeListener(onChange)
    }
  }, [query])

  return matches
}
