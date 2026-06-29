import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

// Bind a single search param to a useState-like API.
// Defaults are treated as "absent" — stripped from the URL so links stay clean.
export function useUrlState(key, defaultValue = '', opts = {}) {
  const { parse = v => v, serialize = v => String(v), replace = true } = opts
  const [params, setParams] = useSearchParams()

  const raw = params.get(key)
  const value = raw == null ? defaultValue : parse(raw)

  const setValue = useCallback((next) => {
    setParams(prev => {
      const np = new URLSearchParams(prev)
      const resolved = typeof next === 'function' ? next(np.has(key) ? parse(np.get(key)) : defaultValue) : next
      const s = serialize(resolved)
      if (resolved === defaultValue || resolved == null || s === '') np.delete(key)
      else np.set(key, s)
      return np
    }, { replace })
  }, [key, defaultValue, serialize, parse, replace, setParams])

  return [value, setValue]
}

// Bind a JSON-ish payload (object) to the query string using multiple keys.
// Skipped keys when value equals the default.
export function useUrlStateMap(schema, opts = {}) {
  const { replace = true } = opts
  const [params, setParams] = useSearchParams()

  const values = useMemo(() => {
    const out = {}
    for (const key of Object.keys(schema)) {
      const { default: def = '', parse = v => v } = schema[key]
      const raw = params.get(key)
      out[key] = raw == null ? def : parse(raw)
    }
    return out
  }, [params, schema])

  const setValues = useCallback((patch) => {
    setParams(prev => {
      const np = new URLSearchParams(prev)
      const resolved = typeof patch === 'function' ? patch(values) : patch
      for (const key of Object.keys(resolved)) {
        if (!schema[key]) continue
        const { default: def = '', serialize = v => String(v) } = schema[key]
        const v = resolved[key]
        const s = v == null ? '' : serialize(v)
        if (v === def || v == null || s === '') np.delete(key)
        else np.set(key, s)
      }
      return np
    }, { replace })
  }, [schema, setParams, values, replace])

  return [values, setValues]
}
