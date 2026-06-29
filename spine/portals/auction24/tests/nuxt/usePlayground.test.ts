import { describe, expect, it } from 'vitest'

import { usePlayground, PG_SECTIONS, PG_SECTION_KEY } from '~/features/platform/design-system/logic/usePlayground'

describe('PG_SECTIONS', () => {
  it('exposes the section nav with unique ids and required fields', () => {
    expect(PG_SECTIONS.length).toBeGreaterThan(0)
    const ids = PG_SECTIONS.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const section of PG_SECTIONS) {
      expect(typeof section.id).toBe('string')
      expect(typeof section.label).toBe('string')
      expect(section.icon).toMatch(/^heroicons-outline:/)
    }
  })

  it('starts with foundations as the first section', () => {
    expect(PG_SECTIONS[0]!.id).toBe('foundations')
  })
})

describe('PG_SECTION_KEY', () => {
  it('is a unique injection symbol', () => {
    expect(typeof PG_SECTION_KEY).toBe('symbol')
    expect(PG_SECTION_KEY.toString()).toBe('Symbol(pg-section)')
  })
})

describe('usePlayground', () => {
  it('returns the four state refs with their defaults', () => {
    const { surface, viewport, query, showMeta } = usePlayground()
    expect(surface.value).toBe('gray')
    expect(viewport.value).toBe('full')
    expect(query.value).toBe('')
    expect(showMeta.value).toBe(true)
  })

  it('shares state across calls via useState keys', () => {
    const first = usePlayground()
    first.surface.value = 'dark'
    first.viewport.value = 'mobile'
    first.query.value = 'button'
    first.showMeta.value = false

    const second = usePlayground()
    expect(second.surface.value).toBe('dark')
    expect(second.viewport.value).toBe('mobile')
    expect(second.query.value).toBe('button')
    expect(second.showMeta.value).toBe(false)
  })

  it('accepts every surface and viewport variant', () => {
    const { surface, viewport } = usePlayground()
    for (const value of ['white', 'gray', 'dark'] as const) {
      surface.value = value
      expect(surface.value).toBe(value)
    }
    for (const value of ['mobile', 'tablet', 'full'] as const) {
      viewport.value = value
      expect(viewport.value).toBe(value)
    }
  })
})
