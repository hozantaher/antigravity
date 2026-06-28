import { useState, useEffect } from 'react'

/**
 * Fetch a single operator setting value by key.
 * Falls back to provided default if fetch fails or key is missing.
 *
 * @param {string} key - Setting key (e.g. 'brand_label')
 * @param {string} fallback - Default value if fetch fails or key missing
 * @returns {string} - Setting value or fallback
 */
export function useOperatorSetting(key: string, fallback: string): string {
  const [value, setValue] = useState<string>(fallback)

  useEffect(() => {
    if (!key) {
      setValue(fallback)
      return
    }

    let isMounted = true

    fetch(`/api/operator-settings`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((settings: Array<{ key: string; value: string }>) => {
        if (!isMounted) return
        const found = settings.find((s) => s.key === key)
        setValue(found?.value ?? fallback)
      })
      .catch(() => {
        if (isMounted) setValue(fallback)
      })

    return () => {
      isMounted = false
    }
  }, [key, fallback])

  return value
}
