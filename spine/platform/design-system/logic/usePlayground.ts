import type { InjectionKey } from 'vue'

export type PgSurface = 'white' | 'gray' | 'dark'
export type PgViewport = 'mobile' | 'tablet' | 'full'

export interface PgSectionDef {
  id: string
  label: string
  icon: string
}

// Source of truth for section order + control-panel nav. Each <PlaygroundSection :id>
// must match an id here, in render order.
export const PG_SECTIONS: PgSectionDef[] = [
  { id: 'foundations', label: 'Foundations', icon: 'heroicons-outline:color-swatch' },
  { id: 'forms', label: 'Form controls', icon: 'heroicons-outline:pencil-alt' },
  { id: 'overlays', label: 'Overlays & feedback', icon: 'heroicons-outline:duplicate' },
  { id: 'data', label: 'Data display', icon: 'heroicons-outline:view-list' },
  { id: 'domain', label: 'Vehicle / domain', icon: 'heroicons-outline:truck' },
  { id: 'deposit', label: 'Deposit flow', icon: 'heroicons-outline:credit-card' },
  { id: 'chrome', label: 'App chrome', icon: 'heroicons-outline:template' },
  { id: 'headless', label: 'Headless UI', icon: 'heroicons-outline:cube' },
]

// A specimen reports its (search-)visibility up to its enclosing section, so the section
// can hide its heading when a filter empties it. The provided fn hands back a setter.
export type PgVisibilityReporter = () => (visible: boolean) => void
export const PG_SECTION_KEY: InjectionKey<PgVisibilityReporter> = Symbol('pg-section')

export const usePlayground = () => {
  const surface = useState<PgSurface>('pg-surface', () => 'gray')
  const viewport = useState<PgViewport>('pg-viewport', () => 'full')
  const query = useState('pg-query', () => '')
  const showMeta = useState('pg-show-meta', () => true)

  return { surface, viewport, query, showMeta }
}
