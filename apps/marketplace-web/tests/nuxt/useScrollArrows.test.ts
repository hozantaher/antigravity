import { describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useScrollArrows } from '~/features/platform/design-system/logic/useScrollArrows'

type Arrows = ReturnType<typeof useScrollArrows>
type Layout = { scrollLeft?: number; clientWidth?: number; scrollWidth?: number }

// useScrollArrows wires VueUse useEventListener/useResizeObserver, which register cleanup against
// the active effect scope. Run inside one so that wiring has a scope to attach to (and tears down
// cleanly), without paying the full mountSuspended Nuxt-app setup cost.
const inScope = (): Arrows => {
  const scope = effectScope()
  const arrows = scope.run(() => useScrollArrows())
  return arrows as Arrows
}

// A real happy-dom element (so VueUse's addEventListener/ResizeObserver.observe work) whose
// layout metrics are forced — happy-dom does not compute scrollLeft/clientWidth/scrollWidth.
const layoutEl = (layout: Layout): HTMLElement => {
  const el = document.createElement('div')
  for (const [key, value] of Object.entries(layout)) {
    Object.defineProperty(el, key, { value, configurable: true, writable: true })
  }
  el.scrollBy = vi.fn()
  return el
}

describe('useScrollArrows', () => {
  it('exposes the track ref and flags default to false', () => {
    const a = inScope()
    expect(a.track.value).toBeUndefined()
    expect(a.canLeft.value).toBe(false)
    expect(a.canRight.value).toBe(false)
  })

  it('updateArrows is a no-op when there is no element', () => {
    const a = inScope()
    a.track.value = undefined
    a.updateArrows()
    expect(a.canLeft.value).toBe(false)
    expect(a.canRight.value).toBe(false)
  })

  it('sets both flags true when scrolled in the middle of an overflowing track', () => {
    const a = inScope()
    a.track.value = layoutEl({ scrollLeft: 50, clientWidth: 100, scrollWidth: 400 })
    a.updateArrows()
    expect(a.canLeft.value).toBe(true)
    expect(a.canRight.value).toBe(true)
  })

  it('clears left flag at the start and right flag at the end', () => {
    const a = inScope()

    // At the very start: scrollLeft 0 -> canLeft false; far from end -> canRight true
    a.track.value = layoutEl({ scrollLeft: 0, clientWidth: 100, scrollWidth: 400 })
    a.updateArrows()
    expect(a.canLeft.value).toBe(false)
    expect(a.canRight.value).toBe(true)

    // At the very end: scrolled all the way -> canLeft true, canRight false
    a.track.value = layoutEl({ scrollLeft: 300, clientWidth: 100, scrollWidth: 400 })
    a.updateArrows()
    expect(a.canLeft.value).toBe(true)
    expect(a.canRight.value).toBe(false)
  })

  it('does not flag scroll at the 1px tolerance boundary', () => {
    const a = inScope()
    // scrollLeft === 1 is not > 1 -> canLeft false; ceil(1+100)=101 not < 101-1=100 -> canRight false
    a.track.value = layoutEl({ scrollLeft: 1, clientWidth: 100, scrollWidth: 101 })
    a.updateArrows()
    expect(a.canLeft.value).toBe(false)
    expect(a.canRight.value).toBe(false)
  })

  it('scrollByPage is a no-op when there is no element', () => {
    const a = inScope()
    a.track.value = undefined
    expect(() => a.scrollByPage(1)).not.toThrow()
  })

  it('scrollByPage scrolls one page-width (80%) in the given direction', () => {
    const a = inScope()
    const el = layoutEl({ clientWidth: 100 })
    a.track.value = el

    a.scrollByPage(1)
    expect(el.scrollBy).toHaveBeenCalledWith({ left: 80, behavior: 'smooth' })

    a.scrollByPage(-1)
    expect(el.scrollBy).toHaveBeenLastCalledWith({ left: -80, behavior: 'smooth' })
  })
})
