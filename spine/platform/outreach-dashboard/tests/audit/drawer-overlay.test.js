/**
 * C4 audit — slide-over drawer overlay class consistency.
 *
 * /contacts and /segments use `<div className="drawer-overlay">` for the
 * click-to-close backdrop, but the CSS scope only had `.drawer-bg`. The
 * overlay class went unstyled — backdrop was invisible (the click target
 * still worked, but the operator saw the page bleed through). Audit
 * locks both names to the same rule so a future cleanup PR doesn't
 * silently regress.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CSS_PATH = resolve(__dirname, '../../src/index.css')
const css = readFileSync(CSS_PATH, 'utf8')

describe('Sprint C4 — drawer overlay class scope', () => {
  it('declares .drawer-bg with position:fixed inset:0', () => {
    const m = css.match(/\.drawer-bg[^{}]*\{[^}]*position\s*:\s*fixed[^}]*inset\s*:\s*0/i)
    expect(m).not.toBeNull()
  })

  it('declares .drawer-overlay (alias used by /contacts and /segments)', () => {
    // Either as standalone selector or in a comma-list with .drawer-bg.
    const aliasOrShared = css.match(/(\.drawer-overlay|\.drawer-bg\s*,\s*\.drawer-overlay|\.drawer-overlay\s*,\s*\.drawer-bg)/)
    expect(aliasOrShared).not.toBeNull()
  })

  it('drawer overlay rule sets a tinted background so the page does not bleed through', () => {
    // We accept either: shared selector with a background, or a dedicated
    // .drawer-overlay block with a background. Pick the most permissive
    // regex that catches both.
    const m = css.match(/\.drawer-overlay[^{}]*\{[^}]*background[^:]*:\s*[^;}\n]+/i)
      || css.match(/(\.drawer-bg\s*,\s*\.drawer-overlay|\.drawer-overlay\s*,\s*\.drawer-bg)[^{}]*\{[^}]*background[^:]*:\s*[^;}\n]+/i)
    expect(m).not.toBeNull()
  })

  it('drawer overlay z-index sits below .drawer panel z-index', () => {
    // Ensures click-to-close works (overlay on top of page content) and
    // drawer panel sits on top of overlay (panel z > overlay z).
    const overlayZ = css.match(/(\.drawer-bg|\.drawer-overlay)[^{}]*\{[^}]*z-index\s*:\s*(\d+)/i)
    // Match `.drawer {` (word boundary won't do — `\b` allows `.drawer-bg`).
    // Anchor on whitespace/brace right after `.drawer`.
    const panelZ = css.match(/^\.drawer[\s{][^{}]*\{[^}]*z-index\s*:\s*(\d+)/im)
    expect(overlayZ).not.toBeNull()
    expect(panelZ).not.toBeNull()
    if (overlayZ && panelZ) {
      expect(Number(panelZ[1])).toBeGreaterThan(Number(overlayZ[2]))
    }
  })
})
