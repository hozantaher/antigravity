import { createSharedComposable, useTimestamp } from '@vueuse/core'

// One 1s ticker shared by every countdown/status consumer. createSharedComposable keeps a
// single interval alive while ≥1 component uses it and disposes when the last unmounts, so a
// 24-card grid runs ONE timer instead of one per card. Consumers derive status/remaining as
// `computed` off the returned `now` ref — a cached computed only re-renders when its value
// actually changes, so terminal-state cards settle instead of ticking forever.
export const useSharedNow = createSharedComposable(() => useTimestamp({ interval: 1000 }))
