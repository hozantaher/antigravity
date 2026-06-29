import { useEffect } from 'react'

// Lightweight global keyboard-shortcut binder.
//
// Each binding: { key, mod?, ctrl?, meta?, shift?, alt?, handler, when? }.
// - `mod` matches Ctrl on Windows/Linux OR Cmd on macOS so a single binding
//   covers both platforms without duplicating config.
// - `when` is an optional predicate; returning false short-circuits.
// - Handlers are skipped while typing in inputs/textareas/contentEditable so
//   the shortcut doesn't clobber normal typing. A binding can set
//   `allowInForm: true` to opt back in (e.g., Esc in a search field).

function isTypingInEditable(el) {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return false
}

function matches(ev, b) {
  if (ev.key.toLowerCase() !== String(b.key).toLowerCase()) return false
  const wantMod = !!b.mod
  const gotMod = ev.ctrlKey || ev.metaKey
  if (wantMod !== gotMod) return false
  if (b.ctrl != null && ev.ctrlKey !== b.ctrl) return false
  if (b.meta != null && ev.metaKey !== b.meta) return false
  if (b.shift != null && ev.shiftKey !== b.shift) return false
  if (b.alt != null && ev.altKey !== b.alt) return false
  return true
}

export function useKeyboardShortcuts(bindings, opts = {}) {
  const enabled = opts.enabled !== false
  useEffect(() => {
    if (!enabled) return
    const onKey = (ev) => {
      for (const b of bindings) {
        if (!matches(ev, b)) continue
        if (typeof b.when === 'function' && !b.when(ev)) continue
        if (!b.allowInForm && isTypingInEditable(ev.target)) continue
        ev.preventDefault()
        b.handler(ev)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bindings, enabled])
}
