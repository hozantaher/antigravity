/**
 * AO (2026-05-18) — verify tokens-claude.css declares the Signal Desktop
 * brand surface + bridges the legacy --bg/--surface/--accent/--text
 * tokens so the rest of the dashboard adopts the Signal aesthetic
 * without rewriting every consumer.
 *
 * This is a static-file lint, not a runtime check. Replaces the AN2
 * Anthropic warm-cream + terracotta + Source Serif assertions after
 * operator pivoted to Signal Desktop on 2026-05-18.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TOKENS_PATH = path.resolve(
  __dirname,
  '../../../src/styles/tokens-claude.css',
)

const css = readFileSync(TOKENS_PATH, 'utf8')

describe('tokens-claude.css — Signal Desktop palette', () => {
  it('declares the clinical near-white page background --c-bg', () => {
    // Signal Desktop uses pure white #FFFFFF, no warmth.
    expect(css).toMatch(/--c-bg:\s*#FFFFFF/)
  })

  it('declares the Signal blue accent --c-accent', () => {
    // #2C6BED — Signal Desktop cobalt blue.
    expect(css).toMatch(/--c-accent:\s*#2C6BED/)
  })

  it('declares the strong-blue hover variant --c-accent-strong', () => {
    expect(css).toMatch(/--c-accent-strong:\s*#1F58CC/)
  })

  it('declares the cool gray border --c-border', () => {
    expect(css).toMatch(/--c-border:\s*#E5E5EA/)
  })

  it('declares the Inter display font stack (NO serif)', () => {
    expect(css).toMatch(/--c-font-display:\s*'Inter'/)
    // Make sure Source Serif is not present anywhere in the tokens file.
    expect(css).not.toMatch(/Source Serif/)
  })

  it('declares the Inter body font stack', () => {
    expect(css).toMatch(/--c-font-body:\s*'Inter'/)
  })

  it('declares the 22px sans page-title type scale', () => {
    expect(css).toMatch(/--c-text-page-title:\s*22px/)
  })

  it('declares the 32px dense page padding (Signal density)', () => {
    expect(css).toMatch(/--c-pad-page:\s*32px/)
  })

  it('declares the Signal-style 18px bubble radius', () => {
    expect(css).toMatch(/--c-radius-bubble:\s*18px/)
  })

  it('declares the 8px card radius', () => {
    expect(css).toMatch(/--c-radius-card:\s*8px/)
  })

  it('declares the flat shadow tokens (no card shadow, soft hover)', () => {
    expect(css).toMatch(/--c-shadow-card:\s*none/)
    expect(css).toMatch(/--c-shadow-hover:\s*0 1px 2px/)
  })

  it('declares the Signal-blue focus ring', () => {
    expect(css).toMatch(/--c-shadow-focus:\s*0 0 0 3px rgba\(44,\s*107,\s*237/)
  })
})

describe('tokens-claude.css — legacy token bridge', () => {
  it('overrides --bg to point at the Signal near-white page bg', () => {
    expect(css).toMatch(/--bg:\s*var\(--c-bg\)/)
  })

  it('overrides --accent to point at the Signal blue accent', () => {
    expect(css).toMatch(/--accent:\s*var\(--c-accent\)/)
  })

  it('overrides --text to point at the near-black neutral text', () => {
    expect(css).toMatch(/--text:\s*var\(--c-text\)/)
  })

  it('overrides --border to point at the cool gray border', () => {
    expect(css).toMatch(/--border:\s*var\(--c-border\)/)
  })

  it('overrides --font-display + --font-body so legacy consumers inherit Inter', () => {
    expect(css).toMatch(/--font-display:\s*var\(--c-font-display\)/)
    expect(css).toMatch(/--font-body:\s*var\(--c-font-body\)/)
  })
})

describe('tokens-claude.css — body baseline', () => {
  it('sets the body background to the near-white surface', () => {
    expect(css).toMatch(/body\s*{[^}]*background:\s*var\(--c-bg\)/)
  })

  it('sets the body font-family to the Inter body stack', () => {
    expect(css).toMatch(/body\s*{[^}]*font-family:\s*var\(--c-font-body\)/)
  })

  it('headings default to Inter sans (no serif)', () => {
    expect(css).toMatch(/h1,\s*h2,\s*h3,\s*h4\s*{[^}]*font-family:\s*var\(--c-font-display\)/)
  })
})

describe('main.jsx — imports tokens-claude.css after index.css (specificity wins)', () => {
  it('imports tokens-claude.css from src/main.jsx', () => {
    const MAIN_PATH = path.resolve(__dirname, '../../../src/main.jsx')
    const main = readFileSync(MAIN_PATH, 'utf8')
    expect(main).toMatch(/import\s+['"]\.\/styles\/tokens-claude\.css['"]/)
    // The Claude tokens file MUST come AFTER index.css so the bridge
    // declarations win specificity.
    const indexIdx = main.indexOf('./index.css')
    const claudeIdx = main.indexOf('./styles/tokens-claude.css')
    expect(indexIdx).toBeGreaterThan(-1)
    expect(claudeIdx).toBeGreaterThan(indexIdx)
  })
})
