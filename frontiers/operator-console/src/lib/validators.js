// Lightweight, composable validators. Each returns error string or null.

export const required = (msg = 'Povinné pole') => v =>
  v == null || (typeof v === 'string' && v.trim() === '') ? msg : null

export const email = (msg = 'Neplatný e-mail') => v => {
  if (!v) return null
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : msg
}

export const url = (msg = 'Neplatná URL') => v => {
  if (!v) return null
  try { new URL(v); return null } catch { return msg }
}

export const minLen = (n, msg) => v =>
  v && v.length < n ? (msg || `Minimálně ${n} znaků`) : null

export const maxLen = (n, msg) => v =>
  v && v.length > n ? (msg || `Maximálně ${n} znaků`) : null

export const pattern = (re, msg = 'Neplatný formát') => v =>
  v && !re.test(v) ? msg : null

export const number = (msg = 'Musí být číslo') => v => {
  if (v == null || v === '') return null
  return Number.isFinite(Number(v)) ? null : msg
}

export const range = (min, max, msg) => v => {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return 'Musí být číslo'
  if (n < min || n > max) return msg || `Rozsah ${min}–${max}`
  return null
}

// Run list of validators, return first error or null.
export const compose = (...fns) => v => {
  for (const fn of fns) {
    const err = fn?.(v)
    if (err) return err
  }
  return null
}

// Validate an object against { field: validator } map.
// Returns { errors: {field: msg}, valid: boolean }.
export function validate(values, schema) {
  const errors = {}
  for (const key of Object.keys(schema)) {
    const err = schema[key](values[key])
    if (err) errors[key] = err
  }
  return { errors, valid: Object.keys(errors).length === 0 }
}
