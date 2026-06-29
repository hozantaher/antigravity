import type { Item } from '~/models'
import { deeplLocales } from '~/utils'

// The locales DeepL can fill automatically (cz/de/en/fr/nl/pl/ru/ua). ar/hr/me/rs are unsupported
// by DeepL and stay manual. Single source of truth is utils/index.ts deeplLocales.
export const ENRICHABLE_LOCALES = Object.keys(deeplLocales)

// Master opt-in flag (parity with recoEnabled/stripeEnabled). Off → the cron is a no-op.
export const isEnrichEnabled = (): boolean => useRuntimeConfig().public.enrichEnabled === true

// A per-locale slot counts as "filled" for a non-blank string (description) or a non-empty array
// (highlights) — so the same gap logic covers both maps.
export const isLocaleFilled = (value: unknown): boolean =>
  typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) ? value.length > 0 : false

// The source locale to translate FROM: the first locale that actually has content.
export const pickSourceLocale = (map: Record<string, unknown> | null | undefined): string | undefined => {
  if (!map) return undefined
  return ['cz', 'en', ...ENRICHABLE_LOCALES].find(l => isLocaleFilled(map[l]))
}

// True when a per-locale map has a source locale but at least one enrichable locale is still empty.
const hasTranslationGap = (map: Record<string, unknown> | null | undefined): boolean => {
  const src = pickSourceLocale(map)
  return !!src && !!map && ENRICHABLE_LOCALES.some(l => l !== src && !isLocaleFilled(map[l]))
}

// True when the sweep has deterministic, auto-fillable work on this item:
//  - a VIN is set but vehicle specs are still empty (→ VIN decode), or
//  - a description OR highlights map has a source locale but an enrichable locale is empty (→ DeepL).
// Only ever fills empties, so it goes false once everything's populated.
export const itemNeedsEnrichment = (item: Item): boolean =>
  (!!item.vin?.trim() && !item.specs?.manufacturer) ||
  hasTranslationGap(item.description) ||
  hasTranslationGap(item.highlights)
