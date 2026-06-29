// Desktop horizontal-scroll affordance shared by the gallery thumbnail strip and the
// recommendations rail: a `track` element ref, left/right "can scroll" flags kept in sync
// with the scrollport, and a page-wise scroll. Callers wire their own extra triggers
// (e.g. scroll the active thumb into view) and call updateArrows() after content changes.
export const useScrollArrows = () => {
  const track = ref<HTMLElement>()
  const canLeft = ref(false)
  const canRight = ref(false)

  const updateArrows = () => {
    const el = track.value
    if (!el) return
    canLeft.value = el.scrollLeft > 1
    canRight.value = Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth - 1
  }

  const scrollByPage = (dir: number) => {
    const el = track.value
    if (!el) return
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' })
  }

  useEventListener(track, 'scroll', updateArrows, { passive: true })
  useResizeObserver(track, updateArrows)

  return { track, canLeft, canRight, updateArrows, scrollByPage }
}
