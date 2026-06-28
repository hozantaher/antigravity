/**
 * B2 audit — assert that index.css ships a sticky-thead rule for
 * .table-wrap so every list page in the dashboard gets a sticky
 * column header without further per-page wiring.
 *
 * TDD anchor for Sprint B2: this file goes RED until index.css gets
 * the rule. Implementation is pure CSS; a runtime DOM test is
 * unreliable because jsdom doesn't compute `position: sticky`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CSS_PATH = resolve(__dirname, '../../src/index.css')
const css = readFileSync(CSS_PATH, 'utf8')

describe('Sprint B2 — sticky table header', () => {
  it('declares position: sticky on .table-wrap thead', () => {
    // We expect a single rule that applies sticky positioning to thead
    // inside any .table-wrap. The selector may be slightly different
    // (e.g. .table-wrap > table > thead) but it must exist.
    const stickyRule = css.match(/\.table-wrap[^{}]*thead[^{}]*\{[^}]*position\s*:\s*sticky/i)
    expect(stickyRule).not.toBeNull()
  })

  it('pins the sticky thead to top: 0', () => {
    const topRule = css.match(/\.table-wrap[^{}]*thead[^{}]*\{[^}]*top\s*:\s*0/i)
    expect(topRule).not.toBeNull()
  })

  it('gives the sticky thead a background so rows do not bleed through', () => {
    // background-color or shorthand `background` — both acceptable.
    // The colour itself is var-driven; we only check that one is set.
    const bgRule = css.match(/\.table-wrap[^{}]*thead[^{}]*\{[^}]*background[^:]*:\s*[^;}\n]+/i)
    expect(bgRule).not.toBeNull()
  })

  it('sets z-index so the sticky thead floats above .row-hover-actions', () => {
    // .row-hover-actions or row-action-btn elements may have their
    // own stacking context; sticky thead needs an explicit z-index
    // to win.
    const zRule = css.match(/\.table-wrap[^{}]*thead[^{}]*\{[^}]*z-index\s*:\s*\d+/i)
    expect(zRule).not.toBeNull()
  })
})
