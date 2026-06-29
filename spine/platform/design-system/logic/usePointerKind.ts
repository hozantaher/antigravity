import { createSharedComposable, useMediaQuery } from '@vueuse/core'

// Pointer capability is a viewport-global fact — identical for every card — yet each ItemCard called
// useMediaQuery twice, so a 24-card grid spun up 48 MediaQueryList objects + listeners. Share one of
// each across all consumers (same pattern as useSharedNow): createSharedComposable keeps the listeners
// alive while ≥1 component uses them and disposes after the last unmounts.
export const usePointerKind = createSharedComposable(() => ({
  supportsHover: useMediaQuery('(hover: hover)'),
  isTouch: useMediaQuery('(hover: none)'),
}))
